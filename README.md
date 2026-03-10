# openclaw-plugin-lossless-context

> **Never forget.** Every conversation, perfectly recalled.

A context engine plugin for OpenClaw that vectorizes every message into a local SQLite database. During context assembly, it retrieves relevant historical messages via similarity search and injects them alongside the recent conversation window. **Compaction becomes fearless** — the vector store preserves everything the summary misses.

## The Problem

Long-running OpenClaw agents lose context during compaction:
- Decisions made at 2 PM get summarized away by 4 PM
- Sub-agents finish and their context evaporates  
- The longer a session runs, the more the agent "forgets"
- Critical details slip through the cracks

This is the #1 quality-of-life issue for power users.

## The Solution

`openclaw-plugin-lossless-context` is a **context engine plugin** that:

1. **Vectorizes** every message you send and receive
2. **Stores** embeddings + full content in local SQLite (no external services)
3. **Retrieves** relevant history during context assembly via similarity search
4. **Injects** recalled messages into the system prompt for seamless recall
5. **Preserves** everything — compaction can be aggressive without data loss

### Before/After

**Before:**
```
[Compaction happens]
Agent: "What did you decide about the API design?"
You: "I told you an hour ago..."
Agent: "Sorry, I don't have that context anymore."
```

**After:**
```
[Compaction happens]
Agent: [Recalled Context: "At 14:30 UTC, user decided to use REST 
       instead of GraphQL for the public API. Rationale: simpler for 
       third-party integrators."]
Agent: "Based on your earlier decision to use REST for the public API..."
```

## Quick Start

### 1. Install

```bash
npm install -g openclaw-plugin-lossless-context
```

### 2. Configure

Add to your `~/.openclaw/config.json`:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless"
    },
    "entries": {
      "openclaw-plugin-lossless-context": {
        "config": {
          "retrievalCount": 20,
          "windowShare": 0.6,
          "recencyDecayHours": 168,
          "skipHeartbeats": true,
          "maxDbSizeMb": 500,
          "minSimilarity": 0.3
        }
      }
    }
  }
}
```

You also need an embedding API key (OpenAI-compatible). Set:

```bash
export OPENAI_API_KEY="sk-..."
# Optional: customize embedding model
export EMBEDDING_MODEL="text-embedding-3-small"
export EMBEDDING_BASE_URL="https://api.openai.com/v1"
export EMBEDDING_DIMENSIONS="1536"
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

That's it! Your agent now has perfect recall.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retrievalCount` | number | `20` | Maximum number of historical messages to retrieve |
| `windowShare` | number | `0.6` | Fraction of token budget for recent window (vs retrieval) |
| `recencyDecayHours` | number | `168` | Half-life for recency decay (default: 1 week) |
| `skipHeartbeats` | boolean | `true` | Don't ingest heartbeat messages |
| `maxDbSizeMb` | number | `500` | Maximum database size before pruning old messages |
| `minSimilarity` | number | `0.3` | Minimum similarity score for retrieval (0-1) |

All fields are optional with sane defaults.

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User Message Arrives                     │
└───────────────────────────┬─────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  ingest()      │
                    │  - Embed text  │
                    │  - Store in DB │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │  SQLite + vec0 │
                    │  Vector Store  │
                    └───────┬────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                    assemble() - Build Context                │
│                                                               │
│  1. Recent window (60% of token budget)                      │
│     [msg-10, msg-11, msg-12, ...]  ← Sliding window          │
│                                                               │
│  2. Build search query from recent user messages             │
│     "How do I deploy to production?"                         │
│                                                               │
│  3. Vector search for relevant history                       │
│     [msg-3 (similarity: 0.85), msg-7 (0.78), ...]            │
│                                                               │
│  4. Apply recency decay + importance scoring                 │
│     Recent messages weighted higher, user msgs > assistant   │
│                                                               │
│  5. Format as systemPromptAddition                           │
│     "## Recalled Context                                     │
│      [2026-03-09 14:30 UTC | user]: We decided on REST..."  │
│                                                               │
│  6. Return: { messages, systemPromptAddition }               │
└───────────────────────────────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  LLM Prompt    │
                    │  (with recall) │
                    └────────────────┘
```

### Token Budget Allocation

By default, 60% of your token budget goes to the **recent window** (sliding conversation), and 40% goes to **retrieved context** from history.

Example with 100K token budget:
- Recent window: 60K tokens (last ~50 messages)
- Retrieved history: 40K tokens (top 20 relevant messages from the past)

You can tune this with `windowShare`.

### Retrieval Scoring

Messages are scored by:
```
finalScore = similarity × recencyDecay × importanceWeight
```

- **Similarity:** Cosine similarity between query and message embeddings (0-1)
- **Recency decay:** Exponential decay based on age (half-life: `recencyDecayHours`)
- **Importance weight:** User messages = 1.2, assistant = 1.0, tool results = 0.8

Only messages with `similarity >= minSimilarity` are considered.

### Database Storage

- **Location:** `~/.openclaw/state/plugins/lossless-context/messages.db`
- **Engine:** SQLite with WAL mode + `sqlite-vec` extension
- **Tables:**
  - `messages` — Full message content + metadata
  - `messages_vec` — Vector embeddings (float32[1536])
  - `sessions` — Session metadata and message counts

One database per OpenClaw installation. Portable, no cloud dependencies.

## FAQ

### How much does this cost?

Embedding costs are **very cheap**:
- Model: `text-embedding-3-small` (OpenAI)
- Cost: $0.02 per 1M tokens
- A 500-word message ≈ 625 tokens → $0.0000125 to embed

For a power user with 10K messages/month ≈ **$1-2/month** in embedding costs.

### How much storage does it use?

Rough estimates:
- 1,000 messages ≈ 50-100 MB (depends on message length)
- 10,000 messages ≈ 500 MB - 1 GB
- 100,000 messages ≈ 5-10 GB

The plugin auto-prunes when exceeding `maxDbSizeMb` (default: 500 MB).

### Does this work with existing memory search?

**Yes!** This plugin is **complementary** to OpenClaw's built-in memory search:
- **Memory search (`/mem`):** Explicitly stored facts and learnings
- **Lossless context:** Automatic recall of conversational history

Both use embeddings, but serve different purposes.

### Does it work with sub-agents?

**Yes!** The plugin hooks into the sub-agent lifecycle:
- `prepareSubagentSpawn`: Registers child session in the same DB
- `onSubagentEnded`: Optionally ingests notable child messages into parent's searchable history

Sub-agents can query the parent's history for context.

### Can I disable it temporarily?

Yes, change the slot to `"legacy"`:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

Then restart the gateway. Your vector store is preserved — switching back restores full recall.

### What if I want to delete old messages?

Decrease `maxDbSizeMb` to trigger more aggressive pruning, or manually delete the database:

```bash
rm ~/.openclaw/state/plugins/lossless-context/messages.db
```

The plugin will recreate it on next restart.

### Does this slow down the agent?

Minimal impact:
- **Embedding:** ~50-100ms per message (batched when possible)
- **Vector search:** ~10-50ms for top-20 retrieval (SQLite is fast!)
- **Total overhead:** <200ms per turn

The improved context quality **far outweighs** the latency cost.

## Contributing

PRs welcome! This is a public open-source project (MIT license).

### Development Setup

```bash
git clone https://github.com/evandcoleman/openclaw-plugin-lossless-context.git
cd openclaw-plugin-lossless-context
npm install
npm test
npm run build
```

### Project Structure

```
src/
├── index.ts          # Plugin entry point
├── engine.ts         # LosslessContextEngine implementation
├── db.ts             # SQLite + sqlite-vec wrapper
├── embeddings.ts     # Embedding service (OpenAI-compatible)
├── config.ts         # Config resolution
├── types.ts          # TypeScript types
├── *.test.ts         # Vitest tests
```

### Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run lint          # Type check
```

## License

MIT © 2026 Evan Coleman
