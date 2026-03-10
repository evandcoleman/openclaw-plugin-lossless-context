import type { PluginConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface OpenClawPluginConfig {
  retrievalCount?: number;
  windowShare?: number;
  recencyDecayHours?: number;
  skipHeartbeats?: boolean;
  maxDbSizeMb?: number;
  minSimilarity?: number;
}

/**
 * Resolve plugin configuration by merging user config with defaults
 */
export function resolveConfig(userConfig?: OpenClawPluginConfig): PluginConfig {
  return {
    retrievalCount: userConfig?.retrievalCount ?? DEFAULT_CONFIG.retrievalCount,
    windowShare: userConfig?.windowShare ?? DEFAULT_CONFIG.windowShare,
    recencyDecayHours: userConfig?.recencyDecayHours ?? DEFAULT_CONFIG.recencyDecayHours,
    skipHeartbeats: userConfig?.skipHeartbeats ?? DEFAULT_CONFIG.skipHeartbeats,
    maxDbSizeMb: userConfig?.maxDbSizeMb ?? DEFAULT_CONFIG.maxDbSizeMb,
    minSimilarity: userConfig?.minSimilarity ?? DEFAULT_CONFIG.minSimilarity,
  };
}

/**
 * Resolve embedding configuration from OpenClaw's memory search settings
 * Falls back to environment variables or defaults
 */
export function resolveEmbeddingConfig(): {
  apiKey: string;
  model: string;
  baseUrl: string;
  dimensions: number;
} {
  // Try to get from environment variables
  const apiKey = process.env.OPENAI_API_KEY || "";
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const baseUrl = process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1";
  const dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10);

  return {
    apiKey,
    model,
    baseUrl,
    dimensions,
  };
}
