import type {
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
  IngestBatchResult,
  AssembleResult,
  CompactResult,
  BootstrapResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
  AgentMessage,
} from "openclaw/plugin-sdk/context-engine";
import { MessageStore } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import type { PluginConfig } from "./types.js";

export class LosslessContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "lossless",
    name: "Lossless Context Engine",
    version: "0.1.0",
    ownsCompaction: false,
  };

  private store: MessageStore;
  private embeddings: EmbeddingService;
  private config: PluginConfig;

  constructor(store: MessageStore, embeddings: EmbeddingService, config: PluginConfig) {
    this.store = store;
    this.embeddings = embeddings;
    this.config = config;
  }

  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    // Create or update session record
    this.store.upsertSession(params.sessionId, null);
    
    return {
      bootstrapped: true,
      importedMessages: 0,
    };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const { sessionId, message, isHeartbeat } = params;

    // Skip system messages
    if (message.role === "system") {
      return { ingested: false };
    }

    // Skip heartbeats if configured
    if (isHeartbeat && this.config.skipHeartbeats) {
      return { ingested: false };
    }

    // Get message content
    const content = this.getMessageContent(message);
    if (!content) {
      return { ingested: false };
    }

    // Embed the message
    const embedding = await this.embeddings.embed(content);

    // Estimate token count (rough approximation)
    const tokenCount = Math.ceil(content.length / 4);

    // Store the message
    this.store.insertMessage({
      id: message.id,
      sessionId,
      role: message.role,
      content,
      embedding,
      tokenCount,
      createdAt: Date.now(),
      isHeartbeat: isHeartbeat ?? false,
      metadata: null,
    });

    // Update session
    this.store.incrementMessageCount(sessionId);

    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    const { sessionId, messages, isHeartbeat } = params;

    // Filter out system messages and heartbeats
    const filteredMessages = messages.filter(msg => {
      if (msg.role === "system") return false;
      if (isHeartbeat && this.config.skipHeartbeats) return false;
      return true;
    });

    if (filteredMessages.length === 0) {
      return { ingestedCount: 0 };
    }

    // Extract content from all messages
    const contents = filteredMessages.map(msg => this.getMessageContent(msg)).filter(Boolean) as string[];

    // Batch embed
    const embeddings = await this.embeddings.embedBatch(contents);

    // Store all messages
    for (let i = 0; i < filteredMessages.length; i++) {
      const msg = filteredMessages[i];
      const content = contents[i];
      const embedding = embeddings[i];
      const tokenCount = Math.ceil(content.length / 4);

      this.store.insertMessage({
        id: msg.id,
        sessionId,
        role: msg.role,
        content,
        embedding,
        tokenCount,
        createdAt: Date.now(),
        isHeartbeat: isHeartbeat ?? false,
        metadata: null,
      });

      this.store.incrementMessageCount(sessionId);
    }

    return { ingestedCount: filteredMessages.length };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const { sessionId, messages, tokenBudget = 100000 } = params;

    // Calculate window size (default to 60% of budget for recent messages)
    const windowBudget = Math.floor(tokenBudget * this.config.windowShare);
    const retrievalBudget = tokenBudget - windowBudget;

    // Take recent messages as sliding window
    let windowTokens = 0;
    const windowMessages: AgentMessage[] = [];
    const windowIds = new Set<string>();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const content = this.getMessageContent(msg);
      const msgTokens = content ? Math.ceil(content.length / 4) : 10;
      
      if (windowTokens + msgTokens > windowBudget && windowMessages.length > 0) {
        break;
      }

      windowMessages.unshift(msg);
      windowIds.add(msg.id);
      windowTokens += msgTokens;
    }

    // Build search query from recent user messages
    const recentUserMessages = windowMessages
      .filter(msg => msg.role === "user")
      .slice(-3)
      .map(msg => this.getMessageContent(msg))
      .filter(Boolean)
      .join(" ");

    let systemPromptAddition: string | undefined;
    let totalTokens = windowTokens;

    // Only do retrieval if we have a query and budget
    if (recentUserMessages && retrievalBudget > 100) {
      try {
        // Embed the query
        const queryEmbedding = await this.embeddings.embed(recentUserMessages);

        // Search for similar messages not in current window
        const results = this.store.searchSimilar(
          queryEmbedding,
          this.config.retrievalCount,
          windowIds
        );

        // Filter by minimum similarity
        const relevantResults = results.filter(
          r => r.similarity >= this.config.minSimilarity
        );

        // Apply recency decay and select top messages within budget
        const now = Date.now();
        const decayHalfLife = this.config.recencyDecayHours * 3600 * 1000;
        
        const scoredResults = relevantResults.map(r => {
          const age = now - r.message.createdAt;
          const recencyScore = Math.exp(-age / decayHalfLife);
          const importanceScore = r.message.role === "user" ? 1.2 : 1.0;
          const finalScore = r.similarity * recencyScore * importanceScore;
          
          return { ...r, score: finalScore };
        });

        scoredResults.sort((a, b) => b.score - a.score);

        // Build recalled context
        const recalledMessages: string[] = [];
        let recalledTokens = 0;

        for (const result of scoredResults) {
          const msgTokens = result.message.tokenCount ?? 50;
          if (recalledTokens + msgTokens > retrievalBudget) break;

          const timestamp = new Date(result.message.createdAt).toISOString().slice(0, 16).replace("T", " ");
          const formatted = `[${timestamp} UTC | ${result.message.role}]: ${result.message.content}`;
          
          recalledMessages.push(formatted);
          recalledTokens += msgTokens;
        }

        if (recalledMessages.length > 0) {
          systemPromptAddition = `## Recalled Context\n\nThe following are relevant messages from earlier in this conversation or previous sessions, retrieved by similarity search:\n\n${recalledMessages.join("\n\n")}`;
          totalTokens += recalledTokens;
        }
      } catch (error) {
        // If retrieval fails, continue with just the window
        console.error("Failed to retrieve historical context:", error);
      }
    }

    return {
      messages: windowMessages,
      estimatedTokens: totalTokens,
      systemPromptAddition,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
  }): Promise<CompactResult> {
    // Delegate to legacy compaction
    // The vector store preserves everything, so aggressive compaction is safe
    return {
      ok: true,
      compacted: false,
      reason: "Lossless engine delegates compaction to legacy implementation",
    };
  }

  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
    // Register child session
    this.store.upsertSession(params.childSessionKey, null);

    // Return rollback handler
    return {
      rollback: async () => {
        // Could delete the session, but it's harmless to leave it
      },
    };
  }

  async onSubagentEnded(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void> {
    // Could ingest notable child messages here
    // For now, just acknowledge the event
  }

  async dispose(): Promise<void> {
    this.store.close();
  }

  private getMessageContent(message: AgentMessage): string {
    if (typeof message.content === "string") {
      return message.content;
    }
    
    if (Array.isArray(message.content)) {
      // Extract text from content blocks
      return message.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join(" ");
    }
    
    return "";
  }
}
