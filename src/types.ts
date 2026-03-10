// Re-export types from @mariozechner/pi-agent-core
export type { AgentMessage } from "@mariozechner/pi-agent-core";

// ContextEngine types (copied from openclaw/plugin-sdk/context-engine/types)
export type AssembleResult = {
  messages: any[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type IngestResult = {
  ingested: boolean;
};

export type IngestBatchResult = {
  ingestedCount: number;
};

export type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
};

export type SubagentSpawnPreparation = {
  rollback: () => void | Promise<void>;
};

export type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  
  bootstrap?(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;
  
  ingest(params: {
    sessionId: string;
    message: any;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;
  
  ingestBatch?(params: {
    sessionId: string;
    messages: any[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  
  assemble(params: {
    sessionId: string;
    messages: any[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;
  
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
  }): Promise<CompactResult>;
  
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
  
  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void>;
  
  dispose?(): Promise<void>;
}

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
