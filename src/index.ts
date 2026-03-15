import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LosslessContextEngine } from "./engine.js";
import { MessageStore } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { resolveConfig, resolveEmbeddingConfig } from "./config.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export default function register(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig);
  const embeddingConfig = resolveEmbeddingConfig(api.pluginConfig);

  api.registerContextEngine("lossless", () => {
    // Resolve database path within OpenClaw state directory
    const stateDir = api.runtime.state.resolveStateDir();
    const pluginDir = join(stateDir, "plugins", "lossless-context");
    
    // Ensure directory exists
    mkdirSync(pluginDir, { recursive: true });
    
    const dbPath = join(pluginDir, "messages.db");
    
    // Create store and embedding service
    const store = new MessageStore(dbPath);
    const embeddings = new EmbeddingService({
      apiKey: embeddingConfig.apiKey,
      model: embeddingConfig.model,
      baseUrl: embeddingConfig.baseUrl,
      dimensions: embeddingConfig.dimensions,
    });
    
    return new LosslessContextEngine(store, embeddings, config);
  });
}
