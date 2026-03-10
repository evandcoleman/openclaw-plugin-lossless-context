export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  embedding: Float32Array | null;
  tokenCount: number | null;
  createdAt: number;
  isHeartbeat: boolean;
  metadata: Record<string, unknown> | null;
}

export interface SessionRecord {
  sessionId: string;
  agentId: string | null;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
}

export interface SimilarityResult {
  message: StoredMessage;
  similarity: number;
}

export interface PluginConfig {
  retrievalCount: number;
  windowShare: number;
  recencyDecayHours: number;
  skipHeartbeats: boolean;
  maxDbSizeMb: number;
  minSimilarity: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  retrievalCount: 20,
  windowShare: 0.6,
  recencyDecayHours: 168,
  skipHeartbeats: true,
  maxDbSizeMb: 500,
  minSimilarity: 0.3,
};
