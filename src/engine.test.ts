import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LosslessContextEngine } from "./engine.js";
import { MessageStore } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { DEFAULT_CONFIG } from "./types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { AgentMessage } from "openclaw/plugin-sdk/context-engine";

// Mock fetch for embedding service
global.fetch = vi.fn();

describe("LosslessContextEngine", () => {
  let engine: LosslessContextEngine;
  let store: MessageStore;
  let embeddings: EmbeddingService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-engine-${randomUUID()}.db`);
    store = new MessageStore(dbPath);
    embeddings = new EmbeddingService({
      apiKey: "test-key",
      model: "test-model",
      dimensions: 1536,
    });
    engine = new LosslessContextEngine(store, embeddings, DEFAULT_CONFIG);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await engine.dispose();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(dbPath + "-wal"); } catch {}
    try { unlinkSync(dbPath + "-shm"); } catch {}
  });

  it("should have correct engine info", () => {
    expect(engine.info.id).toBe("lossless");
    expect(engine.info.name).toBe("Lossless Context Engine");
    expect(engine.info.ownsCompaction).toBe(false);
  });

  it("should ingest user message and return ingested: true", async () => {
    const mockEmbedding = Array(1536).fill(0.1);
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: mockEmbedding }] }),
    });

    const message: AgentMessage = {
      id: "msg-1",
      role: "user",
      content: "Hello world",
    };

    const result = await engine.ingest({
      sessionId: "sess-1",
      message,
      isHeartbeat: false,
    });

    expect(result.ingested).toBe(true);
    
    // Verify it was stored
    const messages = store.getMessagesBySession("sess-1");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello world");
  });

  it("should skip system messages", async () => {
    const message: AgentMessage = {
      id: "msg-1",
      role: "system",
      content: "System prompt",
    };

    const result = await engine.ingest({
      sessionId: "sess-1",
      message,
      isHeartbeat: false,
    });

    expect(result.ingested).toBe(false);
    
    const messages = store.getMessagesBySession("sess-1");
    expect(messages).toHaveLength(0);
  });

  it("should skip heartbeat messages when configured", async () => {
    const message: AgentMessage = {
      id: "msg-1",
      role: "user",
      content: "Heartbeat check",
    };

    const result = await engine.ingest({
      sessionId: "sess-1",
      message,
      isHeartbeat: true,
    });

    expect(result.ingested).toBe(false);
  });

  it("should batch ingest multiple messages", async () => {
    const mockEmbeddings = [
      Array(1536).fill(0.1),
      Array(1536).fill(0.2),
    ];
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: mockEmbeddings.map(emb => ({ embedding: emb })),
      }),
    });

    const messages: AgentMessage[] = [
      { id: "msg-1", role: "user", content: "First message" },
      { id: "msg-2", role: "assistant", content: "Second message" },
    ];

    const result = await engine.ingestBatch({
      sessionId: "sess-1",
      messages,
      isHeartbeat: false,
    });

    expect(result.ingestedCount).toBe(2);
    
    const stored = store.getMessagesBySession("sess-1");
    expect(stored).toHaveLength(2);
  });

  it("should assemble context with recent window only when no retrieval needed", async () => {
    // Insert 3 recent messages (no embeddings needed for this test)
    const messages: AgentMessage[] = [
      { id: "msg-1", role: "user", content: "Message 1" },
      { id: "msg-2", role: "assistant", content: "Message 2" },
      { id: "msg-3", role: "user", content: "Message 3" },
    ];

    const result = await engine.assemble({
      sessionId: "sess-1",
      messages,
      tokenBudget: 100000, // Large budget
    });

    expect(result.messages).toHaveLength(3);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("should retrieve and deduplicate historical context", async () => {
    // Setup: insert old messages into DB with embeddings
    const oldEmbedding = new Float32Array(1536).fill(0.5);
    store.insertMessage({
      id: "old-1",
      sessionId: "sess-1",
      role: "user",
      content: "Old relevant message",
      embedding: oldEmbedding,
      tokenCount: 10,
      createdAt: Date.now() - 86400000, // 1 day ago
      isHeartbeat: false,
      metadata: null,
    });

    // Mock embedding for current query
    const queryEmbedding = Array(1536).fill(0.5);
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: queryEmbedding }] }),
    });

    const currentMessages: AgentMessage[] = [
      { id: "msg-1", role: "user", content: "Current message" },
    ];

    const result = await engine.assemble({
      sessionId: "sess-1",
      messages: currentMessages,
      tokenBudget: 100000,
    });

    // Should include both current and retrieved
    expect(result.messages).toHaveLength(1); // Only current window
    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain("Old relevant message");
  });

  it("should delegate compaction to legacy", async () => {
    const result = await engine.compact({
      sessionId: "sess-1",
      sessionFile: "/tmp/test.jsonl",
      force: false,
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("delegate");
  });

  it("should bootstrap from existing session", async () => {
    const result = await engine.bootstrap({
      sessionId: "sess-1",
      sessionFile: "/tmp/test.jsonl",
    });

    expect(result.bootstrapped).toBe(true);
    
    // Verify session was created
    const session = store.getSession("sess-1");
    expect(session).toBeDefined();
  });

  it("should prepare subagent spawn", async () => {
    const result = await engine.prepareSubagentSpawn({
      parentSessionKey: "parent",
      childSessionKey: "child",
    });

    expect(result).toBeDefined();
    expect(result!.rollback).toBeInstanceOf(Function);
    
    // Verify child session was registered
    const session = store.getSession("child");
    expect(session).toBeDefined();
  });

  it("should handle subagent ended event", async () => {
    await engine.onSubagentEnded({
      childSessionKey: "child",
      reason: "completed",
    });

    // Should complete without error
    expect(true).toBe(true);
  });

  it("should dispose cleanly", async () => {
    await engine.dispose();
    // Should not throw
    expect(true).toBe(true);
  });
});
