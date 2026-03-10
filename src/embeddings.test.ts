import { describe, it, expect, beforeEach, vi } from "vitest";
import { EmbeddingService } from "./embeddings.js";

// Mock fetch globally
global.fetch = vi.fn();

describe("EmbeddingService", () => {
  let service: EmbeddingService;
  
  beforeEach(() => {
    service = new EmbeddingService({
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    vi.clearAllMocks();
  });

  it("should embed a single text and return Float32Array of correct dimension", async () => {
    const mockEmbedding = Array(1536).fill(0).map((_, i) => i / 1536);
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: mockEmbedding }],
      }),
    });

    const result = await service.embed("Hello world");
    
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1536);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("should batch embed multiple texts in one call", async () => {
    const mockEmbeddings = [
      Array(1536).fill(0.1),
      Array(1536).fill(0.2),
      Array(1536).fill(0.3),
    ];
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: mockEmbeddings.map(emb => ({ embedding: emb })),
      }),
    });

    const results = await service.embedBatch(["text1", "text2", "text3"]);
    
    expect(results).toHaveLength(3);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("should return cached embedding for identical content", async () => {
    const mockEmbedding = Array(1536).fill(0.5);
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: mockEmbedding }],
      }),
    });

    const result1 = await service.embed("Same text");
    const result2 = await service.embed("Same text");
    
    expect(result1).toBe(result2); // Same reference
    expect(global.fetch).toHaveBeenCalledTimes(1); // Only one API call
  });

  it("should truncate texts exceeding max token length", async () => {
    const longText = "word ".repeat(10000); // ~50000 chars, exceeds 8191 * 4 = 32764
    const mockEmbedding = Array(1536).fill(0.1);
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: mockEmbedding }],
      }),
    });

    await service.embed(longText);
    
    const callArgs = (global.fetch as any).mock.calls[0][1];
    const body = JSON.parse(callArgs.body);
    
    // Text should be truncated
    expect(body.input[0].length).toBeLessThan(longText.length);
  });

  it("should handle empty text gracefully", async () => {
    const mockEmbedding = Array(1536).fill(0);
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: mockEmbedding }],
      }),
    });

    const result = await service.embed("");
    
    expect(result).toBeInstanceOf(Float32Array);
  });

  it("should throw on API error", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(service.embed("test")).rejects.toThrow();
  });
});
