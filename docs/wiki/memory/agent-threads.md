# Agent Threads

Source type: `agent_thread`

Capabilities: searchable, readable, incremental

Agent threads index the conversation history of agents in a squad, making past interactions searchable alongside memory files and workspace content.

## How It Works

1. An agent execution completes (success, failure, or stopped)
2. The `execution.completed` event fires
3. The thread indexer collects all messages for that agent
4. Messages are formatted as markdown and chunked
5. Chunks are embedded and stored

## Content Format

Agent messages are converted to markdown:

```markdown
## Human:

What's the authentication flow?

---

## Assistant:

The auth flow uses JWT tokens...

---

## Human:

How are tokens refreshed?

---
```

## Event-Driven Indexing

Thread indexing is triggered automatically by execution events:

```
execution.completed → thread-indexer-events → ThreadSource.index()
execution.failed    → thread-indexer-events → ThreadSource.index()
execution.stopped   → thread-indexer-events → ThreadSource.index()
```

The entire thread is re-indexed on each execution (not just the new messages), but chunk preservation ensures only changed/new chunks are re-embedded.

## Metadata

Each thread document includes metadata:

- `agentId` — The agent whose thread this is
- `agentType` — Agent type configuration
- `workStreamIds` — Work streams the agent belongs to
- `messageCount` — Total message count

## Source ID

The source ID for thread documents is the `agentId`. Each agent has exactly one thread document — it's replaced on each re-index.

## Searchability and Reindexing

Agent threads are ingested and stored from execution lifecycle events, but **search is disabled by product decision**. The `memory_search` tool and HTTP search route both strip `agent_thread` from requests while `AGENT_THREAD_SEARCH_ENABLED` is `false` in `@ficus/shared`.

`POST /api/memory/:squadId/reindex` rejects `source=agent_thread` with `400`; `source=all` does not reindex agent threads. See [Reindexing](reindex.md) for the source matrix.

## Implementation

- Source: `apps/core/src/services/memory/sources/ThreadSource.ts`
- Event handler: `apps/core/src/services/memory/thread-indexer-events.ts`
- Orchestrator: `apps/core/src/services/memory/thread-indexer.ts`
