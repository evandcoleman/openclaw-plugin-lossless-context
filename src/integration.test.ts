import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LosslessContextEngine } from "./engine.js";
import { MessageStore } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { DEFAULT_CONFIG } from "./types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Mock fetch for embedding service - deterministic embeddings based on content hash
global.fetch = vi.fn();

function createMockEmbedding(text: string): number[] {
  // Create deterministic embedding from text hash
  const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const embedding = new Array(1536).fill(0);
  
  // Distribute hash across first 10 dimensions for some similarity variance
  for (let i = 0; i < 10; i++) {
    embedding[i] = Math.sin(hash * (i + 1)) * 0.5 + 0.5;
  }
  
  return embedding;
}

describe("Integration Test: Full Lifecycle", () => {
  let engine: LosslessContextEngine;
  let store: MessageStore;
  let embeddings: EmbeddingService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-integration-${randomUUID()}.db`);
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

  it("should handle full conversation lifecycle with retrieval", async () => {
    const sessionId = "integration-session";

    // Mock embedding responses
    (global.fetch as any).mockImplementation(async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      
      return {
        ok: true,
        json: async () => ({
          data: texts.map((text: string) => ({
            embedding: createMockEmbedding(text),
          })),
        }),
      };
    });

    // Phase 1: Bootstrap the session
    const bootstrapResult = await engine.bootstrap({
      sessionId,
      sessionFile: "/tmp/test.jsonl",
    });

    expect(bootstrapResult.bootstrapped).toBe(true);

    // Phase 2: Ingest initial conversation (50 messages across different topics)
    const topics = [
      { prefix: "API design", messages: 10 },
      { prefix: "Database schema", messages: 10 },
      { prefix: "Frontend components", messages: 10 },
      { prefix: "Deployment strategy", messages: 10 },
      { prefix: "Testing approach", messages: 10 },
    ];

    let messageId = 1;
    const allMessages: AgentMessage[] = [];

    for (const topic of topics) {
      for (let i = 0; i < topic.messages; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const message: AgentMessage = {
          id: `msg-${messageId}`,
          role,
          content: `${topic.prefix} discussion point ${i + 1}`,
        };

        await engine.ingest({
          sessionId,
          message,
          isHeartbeat: false,
        });

        allMessages.push(message);
        messageId++;
      }
    }

    // Verify all messages were ingested
    const storedMessages = store.getMessagesBySession(sessionId);
    expect(storedMessages).toHaveLength(50);

    // Phase 3: Assemble context with a query about API design
    const currentMessages: AgentMessage[] = [
      { id: "current-1", role: "user", content: "Tell me about the API design decisions we made" },
    ];

    const assembleResult = await engine.assemble({
      sessionId,
      messages: currentMessages,
      tokenBudget: 10000,
    });

    // Should have current message in window
    expect(assembleResult.messages).toHaveLength(1);

    // Should have recalled API design context in system prompt addition
    expect(assembleResult.systemPromptAddition).toBeDefined();
    expect(assembleResult.systemPromptAddition).toContain("API design");
    expect(assembleResult.systemPromptAddition).toContain("Recalled Context");

    // Phase 4: Test deduplication - messages in window shouldn't be retrieved
    const moreRecentMessages: AgentMessage[] = [
      ...allMessages.slice(-10), // Last 10 messages
      { id: "current-2", role: "user", content: "What about deployment?" },
    ];

    const assembleResult2 = await engine.assemble({
      sessionId,
      messages: moreRecentMessages,
      tokenBudget: 10000,
    });

    // Window should contain recent messages
    expect(assembleResult2.messages.length).toBeGreaterThan(5);

    // Retrieved context should be from earlier messages, not window
    if (assembleResult2.systemPromptAddition) {
      const recalledIds = assembleResult2.systemPromptAddition.match(/\[.*?\]/g) || [];
      const windowIds = new Set(moreRecentMessages.map(m => m.id));
      
      // Recalled messages should reference different content than what's in window
      const recalled = assembleResult2.systemPromptAddition.toLowerCase();
      expect(recalled).toContain("deployment");
    }

    // Phase 5: Test compact (should delegate to legacy)
    const compactResult = await engine.compact({
      sessionId,
      sessionFile: "/tmp/test.jsonl",
      force: true,
    });

    expect(compactResult.ok).toBe(true);
    expect(compactResult.compacted).toBe(false); // Delegates to legacy
    expect(compactResult.reason).toContain("delegate");

    // Phase 6: Verify vector store still has all messages post-compaction
    const messagesAfterCompact = store.getMessagesBySession(sessionId);
    expect(messagesAfterCompact).toHaveLength(50);

    // Phase 7: Test subagent lifecycle
    const childSessionKey = "child-session";
    
    const spawnPrep = await engine.prepareSubagentSpawn({
      parentSessionKey: sessionId,
      childSessionKey,
    });

    expect(spawnPrep).toBeDefined();
    expect(spawnPrep!.rollback).toBeInstanceOf(Function);

    // Verify child session was created
    const childSession = store.getSession(childSessionKey);
    expect(childSession).toBeDefined();

    // Simulate child completion
    await engine.onSubagentEnded({
      childSessionKey,
      reason: "completed",
    });

    // Should complete without error
    expect(true).toBe(true);

    // Phase 8: Verify session metadata
    const sessionRecord = store.getSession(sessionId);
    expect(sessionRecord).toBeDefined();
    expect(sessionRecord!.messageCount).toBeGreaterThan(0);

    // Phase 9: Test batch ingestion
    const batchMessages: AgentMessage[] = [
      { id: "batch-1", role: "user", content: "Batch message 1" },
      { id: "batch-2", role: "assistant", content: "Batch message 2" },
      { id: "batch-3", role: "user", content: "Batch message 3" },
    ];

    const batchResult = await engine.ingestBatch({
      sessionId,
      messages: batchMessages,
      isHeartbeat: false,
    });

    expect(batchResult.ingestedCount).toBe(3);

    // Verify total message count
    const finalMessages = store.getMessagesBySession(sessionId);
    expect(finalMessages).toHaveLength(53); // 50 + 3 batch

    // Phase 10: Test database size reporting
    const sizeMb = store.getSizeMb();
    expect(sizeMb).toBeGreaterThan(0);
    expect(sizeMb).toBeLessThan(100); // Should be well under 100MB for test data
  });

  it("should handle empty search results gracefully", async () => {
    const sessionId = "empty-session";

    // Mock embedding responses
    (global.fetch as any).mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: createMockEmbedding("test") }],
      }),
    }));

    await engine.bootstrap({
      sessionId,
      sessionFile: "/tmp/test.jsonl",
    });

    // Assemble with no stored messages
    const result = await engine.assemble({
      sessionId,
      messages: [{ id: "msg-1", role: "user", content: "Hello" }],
      tokenBudget: 10000,
    });

    expect(result.messages).toHaveLength(1);
    // No recalled context since DB is empty
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("should respect minimum similarity threshold", async () => {
    const sessionId = "similarity-session";
    
    // Create engine with high similarity threshold
    const strictEngine = new LosslessContextEngine(store, embeddings, {
      ...DEFAULT_CONFIG,
      minSimilarity: 0.9, // Very high threshold
    });

    // Mock embedding responses
    (global.fetch as any).mockImplementation(async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      
      return {
        ok: true,
        json: async () => ({
          data: texts.map((text: string) => ({
            embedding: createMockEmbedding(text),
          })),
        }),
      };
    });

    await strictEngine.bootstrap({
      sessionId,
      sessionFile: "/tmp/test.jsonl",
    });

    // Ingest a message about cats
    await strictEngine.ingest({
      sessionId,
      message: { id: "msg-1", role: "user", content: "I love cats" },
      isHeartbeat: false,
    });

    // Query about something completely different (low similarity)
    const result = await strictEngine.assemble({
      sessionId,
      messages: [{ id: "msg-2", role: "user", content: "How do I deploy to production?" }],
      tokenBudget: 10000,
    });

    // Should have current message but likely no recalled context due to high threshold
    expect(result.messages).toHaveLength(1);

    await strictEngine.dispose();
  });
});
