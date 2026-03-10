import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import type { StoredMessage, SessionRecord, SimilarityResult } from "./types.js";
import { statSync } from "node:fs";

export class MessageStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    
    // Enable WAL mode for better concurrency
    this.db.pragma("journal_mode = WAL");
    
    // Load sqlite-vec extension
    loadSqliteVec(this.db);
    
    // Initialize schema
    this.createTables();
  }

  private createTables(): void {
    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        token_count INTEGER,
        created_at INTEGER NOT NULL,
        is_heartbeat INTEGER DEFAULT 0,
        metadata TEXT
      );
    `);

    // Vector table for embeddings
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[1536]
      );
    `);

    // Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT,
        created_at INTEGER,
        last_active_at INTEGER,
        message_count INTEGER DEFAULT 0
      );
    `);

    // Indexes for efficient queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
    `);
  }

  insertMessage(message: StoredMessage): void {
    // Insert into messages table
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, embedding, token_count, created_at, is_heartbeat, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const embeddingBlob = message.embedding ? Buffer.from(message.embedding.buffer) : null;
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;

    stmt.run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      embeddingBlob,
      message.tokenCount,
      message.createdAt,
      message.isHeartbeat ? 1 : 0,
      metadataJson
    );

    // Insert into vector table if embedding exists
    if (message.embedding) {
      const vecStmt = this.db.prepare(`
        INSERT INTO messages_vec (id, embedding)
        VALUES (?, ?)
      `);
      vecStmt.run(message.id, embeddingBlob);
    }
  }

  getMessagesBySession(sessionId: string): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(sessionId) as any[];
    return rows.map(this.rowToMessage);
  }

  searchSimilar(queryEmbedding: Float32Array, limit: number, excludeIds: Set<string>): SimilarityResult[] {
    const queryBlob = Buffer.from(queryEmbedding.buffer);
    
    // Build exclusion clause
    const excludeClause = excludeIds.size > 0 
      ? `AND m.id NOT IN (${Array.from(excludeIds).map(() => '?').join(', ')})`
      : '';

    const sql = `
      SELECT 
        m.*,
        1 - vec_distance_cosine(v.embedding, ?) as similarity
      FROM messages_vec v
      INNER JOIN messages m ON v.id = m.id
      WHERE v.embedding IS NOT NULL ${excludeClause}
      ORDER BY similarity DESC
      LIMIT ?
    `;

    const params = [queryBlob, ...Array.from(excludeIds), limit];
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      message: this.rowToMessage(row),
      similarity: row.similarity,
    }));
  }

  upsertSession(sessionId: string, agentId: string | null): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, agent_id, created_at, last_active_at, message_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(session_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        last_active_at = excluded.last_active_at
    `);
    stmt.run(sessionId, agentId, now, now);
  }

  incrementMessageCount(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET message_count = message_count + 1,
          last_active_at = ?
      WHERE session_id = ?
    `);
    stmt.run(Date.now(), sessionId);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE session_id = ?
    `);
    const row = stmt.get(sessionId) as any;
    
    if (!row) return undefined;
    
    return {
      sessionId: row.session_id,
      agentId: row.agent_id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      messageCount: row.message_count,
    };
  }

  getSizeMb(): number {
    try {
      const stats = statSync(this.db.name);
      return stats.size / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  pruneOldMessages(maxSizeMb: number): void {
    // Check current size
    if (this.getSizeMb() <= maxSizeMb) return;

    // Delete oldest low-importance messages (tool results, heartbeats)
    // Keep user and assistant messages longer
    const stmt = this.db.prepare(`
      DELETE FROM messages
      WHERE id IN (
        SELECT id FROM messages
        WHERE role NOT IN ('user', 'assistant')
        ORDER BY created_at ASC
        LIMIT 100
      )
    `);
    stmt.run();

    // Also delete from vector table
    const vecStmt = this.db.prepare(`
      DELETE FROM messages_vec
      WHERE id NOT IN (SELECT id FROM messages)
    `);
    vecStmt.run();
  }

  listTables(): string[] {
    const stmt = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `);
    const rows = stmt.all() as any[];
    return rows.map(row => row.name);
  }

  close(): void {
    this.db.close();
  }

  private rowToMessage(row: any): StoredMessage {
    let embedding: Float32Array | null = null;
    if (row.embedding) {
      const buffer = Buffer.from(row.embedding);
      embedding = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    }

    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        metadata = null;
      }
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      embedding,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      isHeartbeat: row.is_heartbeat === 1,
      metadata,
    };
  }
}
