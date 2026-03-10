import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MessageStore } from "./db.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

describe("MessageStore", () => {
  let store: MessageStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-${randomUUID()}.db`);
    store = new MessageStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(dbPath + "-wal"); } catch {}
    try { unlinkSync(dbPath + "-shm"); } catch {}
  });

  it("should create tables on init", () => {
    // Tables should exist after construction
    const tables = store.listTables();
    expect(tables).toContain("messages");
    expect(tables).toContain("sessions");
  });

  it("should insert and retrieve a message", () => {
    const embedding = new Float32Array(1536).fill(0.1);
    store.insertMessage({
      id: "msg-1",
      sessionId: "sess-1",
      role: "user",
      content: "Hello world",
      embedding,
      tokenCount: 3,
      createdAt: Date.now(),
      isHeartbeat: false,
      metadata: null,
    });

    const messages = store.getMessagesBySession("sess-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello world");
  });

  it("should find similar messages by vector search", () => {
    const base = new Float32Array(1536).fill(0.0);
    // Insert two messages with different embeddings
    const emb1 = new Float32Array(base);
    emb1[0] = 1.0;
    store.insertMessage({
      id: "msg-1", sessionId: "sess-1", role: "user",
      content: "About cats", embedding: emb1,
      tokenCount: 2, createdAt: Date.now(), isHeartbeat: false, metadata: null,
    });

    const emb2 = new Float32Array(base);
    emb2[1] = 1.0;
    store.insertMessage({
      id: "msg-2", sessionId: "sess-1", role: "user",
      content: "About dogs", embedding: emb2,
      tokenCount: 2, createdAt: Date.now(), isHeartbeat: false, metadata: null,
    });

    // Search with query similar to msg-1
    const query = new Float32Array(base);
    query[0] = 0.9;
    const results = store.searchSimilar(query, 5, new Set());
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].message.content).toBe("About cats");
  });

  it("should exclude IDs from search results", () => {
    const emb = new Float32Array(1536).fill(0.1);
    store.insertMessage({
      id: "msg-1", sessionId: "sess-1", role: "user",
      content: "Excluded", embedding: emb,
      tokenCount: 1, createdAt: Date.now(), isHeartbeat: false, metadata: null,
    });

    const results = store.searchSimilar(emb, 5, new Set(["msg-1"]));
    expect(results).toHaveLength(0);
  });

  it("should track session metadata", () => {
    store.upsertSession("sess-1", "agent-main");
    store.incrementMessageCount("sess-1");
    store.incrementMessageCount("sess-1");

    const session = store.getSession("sess-1");
    expect(session).toBeDefined();
    expect(session!.messageCount).toBe(2);
  });

  it("should report database size", () => {
    const sizeMb = store.getSizeMb();
    expect(sizeMb).toBeGreaterThanOrEqual(0);
  });
});
