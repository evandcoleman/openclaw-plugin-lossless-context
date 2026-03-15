#!/usr/bin/env node
/**
 * Backfill memory markdown files into the lossless-context vector DB.
 * Chunks markdown files by section (## headers) and embeds each chunk.
 * 
 * Usage: node scripts/backfill-memory.js [--db <path>] [--dry-run]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const workspace = join(homedir(), '.openclaw/workspace');
const dbPath = getArg('db') || join(homedir(), '.openclaw/plugins/lossless-context/messages.db');
const dryRun = hasFlag('dry-run');
const batchSize = 20;

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
    body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

function float32ArrayToBuffer(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

/**
 * Chunk a markdown file by ## headers. Each chunk includes the header context.
 */
function chunkMarkdown(content, filename) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentHeader = filename;
  
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Save previous chunk
      if (currentChunk.length > 0) {
        const text = currentChunk.join('\n').trim();
        if (text.length > 20) {
          chunks.push({ header: currentHeader, text });
        }
      }
      currentHeader = line.replace(/^##\s+/, '');
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }
  
  // Save last chunk
  if (currentChunk.length > 0) {
    const text = currentChunk.join('\n').trim();
    if (text.length > 20) {
      chunks.push({ header: currentHeader, text });
    }
  }
  
  return chunks;
}

// Collect all memory files
const memoryDir = join(workspace, 'memory');
const memoryFiles = [];

// Main MEMORY.md
memoryFiles.push(join(workspace, 'MEMORY.md'));

// Daily logs and topic files
function collectMarkdownFiles(dir) {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectMarkdownFiles(fullPath);
      } else if (entry.endsWith('.md')) {
        memoryFiles.push(fullPath);
      }
    }
  } catch (e) {
    // Skip inaccessible dirs
  }
}
collectMarkdownFiles(memoryDir);

console.log(`Found ${memoryFiles.length} memory files`);

// Chunk all files
let allChunks = [];
for (const file of memoryFiles) {
  try {
    const content = readFileSync(file, 'utf-8');
    const filename = basename(file, '.md');
    const chunks = chunkMarkdown(content, filename);
    const stat = statSync(file);
    
    for (const chunk of chunks) {
      allChunks.push({
        id: `memory-${filename}-${Buffer.from(chunk.header).toString('base64url').slice(0, 16)}`,
        sessionId: `memory-file-${filename}`,
        role: 'memory',
        content: `[${filename}] ${chunk.header}\n${chunk.text}`,
        tokenCount: Math.ceil(chunk.text.length / 4),
        createdAt: stat.mtimeMs,
        isHeartbeat: 0,
      });
    }
  } catch (e) {
    console.error(`  Skipped ${file}: ${e.message}`);
  }
}

console.log(`Total chunks: ${allChunks.length}`);

if (dryRun) {
  console.log('\n=== DRY RUN ===');
  for (const chunk of allChunks.slice(0, 5)) {
    console.log(`  [${chunk.sessionId}] ${chunk.content.slice(0, 80)}...`);
  }
  process.exit(0);
}

// Connect to DB
const { default: Database } = await import('better-sqlite3');
const { load: loadSqliteVec } = await import('sqlite-vec');

const db = new Database(dbPath);
loadSqliteVec(db);
db.pragma('journal_mode = WAL');

// Filter out existing
const existingIds = new Set(db.prepare('SELECT id FROM messages').all().map(r => r.id));
allChunks = allChunks.filter(c => !existingIds.has(c.id));
console.log(`After dedup: ${allChunks.length} new chunks`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages (id, session_id, role, content, embedding, token_count, created_at, is_heartbeat, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);
const vecInsertStmt = db.prepare(`INSERT INTO messages_vec (id, embedding) VALUES (?, ?)`);

let embedded = 0;
const startTime = Date.now();

for (let i = 0; i < allChunks.length; i += batchSize) {
  const batch = allChunks.slice(i, i + batchSize);
  const texts = batch.map(m => m.content.slice(0, 8000));
  
  try {
    const embeddings = await embedBatch(texts);
    
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const msg = batch[j];
        const buf = float32ArrayToBuffer(embeddings[j]);
        insertStmt.run(msg.id, msg.sessionId, msg.role, msg.content, buf, msg.tokenCount, msg.createdAt, msg.isHeartbeat);
        try { vecInsertStmt.run(msg.id, buf); } catch(e) {}
      }
    })();
    
    embedded += batch.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r  Memory chunks: ${embedded}/${allChunks.length} (${elapsed}s)`);
  } catch (e) {
    console.error(`\n  Batch failed: ${e.message}`);
    if (e.message.includes('429')) {
      console.log('  Rate limited, waiting 30s...');
      await new Promise(r => setTimeout(r, 30000));
      i -= batchSize;
    }
  }
}

const count = db.prepare('SELECT count(*) as n FROM messages').get();
console.log(`\n\nMemory backfill complete! Total messages in DB: ${count.n}`);
db.close();
