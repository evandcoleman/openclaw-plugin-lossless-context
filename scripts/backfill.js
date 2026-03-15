#!/usr/bin/env node
/**
 * Backfill script for lossless-context plugin.
 * Reads session JSONL files and ingests messages into the vector DB.
 * 
 * Usage: node scripts/backfill.js [--sessions-dir <path>] [--db <path>] [--dry-run] [--limit <n>]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Parse args
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const sessionsDir = getArg('sessions-dir') || join(homedir(), '.openclaw/agents/main/sessions');
const dbPath = getArg('db') || join(homedir(), '.openclaw/plugins/lossless-context/messages.db');
const dryRun = hasFlag('dry-run');
const limit = parseInt(getArg('limit') || '0', 10);
const skipHeartbeats = !hasFlag('include-heartbeats');
const batchSize = 20; // Embedding batch size

// Dynamic imports for ESM
const { default: Database } = await import('better-sqlite3');
const { load: loadSqliteVec } = await import('sqlite-vec');

// OpenAI embedding call
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1';

if (!OPENAI_API_KEY && !dryRun) {
  console.error('ERROR: OPENAI_API_KEY required (or use --dry-run)');
  process.exit(1);
}

async function embedBatch(texts) {
  const res = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
    }),
  });
  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

function float32ArrayToBuffer(arr) {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

function extractContent(message) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

// Read all session files
console.log(`Sessions dir: ${sessionsDir}`);
console.log(`DB path: ${dbPath}`);
console.log(`Dry run: ${dryRun}`);
console.log('');

const files = readdirSync(sessionsDir)
  .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.'))
  .sort((a, b) => {
    // Sort by modification time, oldest first
    const aStat = statSync(join(sessionsDir, a));
    const bStat = statSync(join(sessionsDir, b));
    return aStat.mtimeMs - bStat.mtimeMs;
  });

console.log(`Found ${files.length} session files`);

// Connect to DB
let db;
if (!dryRun) {
  db = new Database(dbPath);
  loadSqliteVec(db);
  db.pragma('journal_mode = WAL');
}

// Check existing messages to avoid duplicates
const existingIds = new Set();
if (!dryRun) {
  const rows = db.prepare('SELECT id FROM messages').all();
  for (const row of rows) {
    existingIds.add(row.id);
  }
  console.log(`Existing messages in DB: ${existingIds.size}`);
}

// Collect all messages to backfill
let allMessages = [];
let skippedFiles = 0;
let heartbeatSkipped = 0;

for (const file of files) {
  const filePath = join(sessionsDir, file);
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  
  let sessionId = file.replace('.jsonl', '');
  let isHeartbeat = false;
  
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      
      // Session metadata line
      if (obj.type === 'session' && obj.id) {
        sessionId = obj.id;
        continue;
      }
      
      // Only process message entries
      if (obj.type !== 'message' || !obj.message) continue;
      
      const msg = obj.message;
      const role = msg.role;
      
      // Skip system messages
      if (role === 'system') continue;
      
      // Detect heartbeats
      const text = extractContent(msg);
      if (!text) continue;
      
      const isHb = text.includes('HEARTBEAT') || text.includes('heartbeat poll');
      if (isHb && skipHeartbeats) {
        heartbeatSkipped++;
        continue;
      }
      
      // Skip very short content (tool noise)
      if (text.length < 5) continue;
      
      const msgId = obj.id || msg.id || `backfill-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      
      if (existingIds.has(msgId)) continue;
      
      const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
      
      allMessages.push({
        id: msgId,
        sessionId,
        role: role || 'unknown',
        content: text,
        tokenCount: Math.ceil(text.length / 4),
        createdAt: timestamp,
        isHeartbeat: isHb ? 1 : 0,
      });
    } catch (e) {
      // Skip malformed lines
    }
  }
}

console.log(`\nMessages to backfill: ${allMessages.length}`);
console.log(`Heartbeats skipped: ${heartbeatSkipped}`);

if (limit > 0 && allMessages.length > limit) {
  // Take the most recent ones
  allMessages = allMessages.slice(-limit);
  console.log(`Limited to ${limit} most recent messages`);
}

if (dryRun) {
  console.log('\n=== DRY RUN - No changes made ===');
  console.log(`Would embed and store ${allMessages.length} messages`);
  
  // Show sample
  console.log('\nSample messages:');
  for (const msg of allMessages.slice(0, 5)) {
    console.log(`  [${msg.role}] ${msg.content.slice(0, 80)}...`);
  }
  process.exit(0);
}

// Batch embed and insert
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages (id, session_id, role, content, embedding, token_count, created_at, is_heartbeat, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);

// Also need to insert into the vec table
const vecInsertStmt = db.prepare(`
  INSERT INTO messages_vec (id, embedding)
  VALUES (?, ?)
`);

let embedded = 0;
let failed = 0;
const startTime = Date.now();

for (let i = 0; i < allMessages.length; i += batchSize) {
  const batch = allMessages.slice(i, i + batchSize);
  const texts = batch.map(m => m.content.slice(0, 8000)); // Truncate very long messages
  
  try {
    const embeddings = await embedBatch(texts);
    
    const txn = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const msg = batch[j];
        const embeddingBuf = float32ArrayToBuffer(embeddings[j]);
        
        insertStmt.run(
          msg.id,
          msg.sessionId,
          msg.role,
          msg.content,
          embeddingBuf,
          msg.tokenCount,
          msg.createdAt,
          msg.isHeartbeat,
        );
        
        // Insert into vec table
        try {
          vecInsertStmt.run(msg.id, embeddingBuf);
        } catch (e) {
          // May fail if message already exists (OR IGNORE on messages but not vec)
        }
      }
    });
    txn();
    
    embedded += batch.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (embedded / parseFloat(elapsed)).toFixed(1);
    process.stdout.write(`\r  Embedded ${embedded}/${allMessages.length} (${rate} msg/s, ${elapsed}s elapsed)`);
  } catch (e) {
    console.error(`\n  Batch ${i}-${i + batchSize} failed: ${e.message}`);
    failed += batch.length;
    
    // Rate limit handling
    if (e.message.includes('429')) {
      console.log('  Rate limited, waiting 30s...');
      await new Promise(r => setTimeout(r, 30000));
      i -= batchSize; // Retry this batch
    }
  }
}

console.log(`\n\nBackfill complete!`);
console.log(`  Embedded: ${embedded}`);
console.log(`  Failed: ${failed}`);
console.log(`  Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

// Verify
const count = db.prepare('SELECT count(*) as n FROM messages').get();
console.log(`  Total messages in DB: ${count.n}`);

db.close();
