import { createHash } from "node:crypto";

export interface EmbeddingServiceConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

export class EmbeddingService {
  private cache = new Map<string, Float32Array>();
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private dimensions: number;

  constructor(config: EmbeddingServiceConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.dimensions = config.dimensions ?? 1536;
  }

  async embed(text: string): Promise<Float32Array> {
    // Check cache first
    const hash = this.contentHash(text);
    const cached = this.cache.get(hash);
    if (cached) return cached;

    // Truncate if needed
    const truncated = this.truncate(text, 8191);

    // Call API
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: [truncated],
        model: this.model,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const embedding = new Float32Array(data.data[0].embedding);

    // Cache and return
    this.cache.set(hash, embedding);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Check which texts are cached
    const results: Float32Array[] = new Array(texts.length);
    const needEmbedding: { index: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const hash = this.contentHash(texts[i]);
      const cached = this.cache.get(hash);
      if (cached) {
        results[i] = cached;
      } else {
        needEmbedding.push({ index: i, text: texts[i] });
      }
    }

    // If all cached, return early
    if (needEmbedding.length === 0) {
      return results;
    }

    // Batch API call (max 100 at a time)
    const truncated = needEmbedding.map(({ text }) => this.truncate(text, 8191));

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: truncated,
        model: this.model,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Fill in results and cache
    for (let i = 0; i < needEmbedding.length; i++) {
      const { index, text } = needEmbedding[i];
      const embedding = new Float32Array(data.data[i].embedding);
      results[index] = embedding;
      
      const hash = this.contentHash(text);
      this.cache.set(hash, embedding);
    }

    return results;
  }

  private contentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  private truncate(text: string, maxTokens: number): string {
    // Rough approximation: 1 token ≈ 4 characters
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
  }
}
