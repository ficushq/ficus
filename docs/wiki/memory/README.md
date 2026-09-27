# Memory System

Ficus includes a squad-shared memory system that enables agents to persist and
retrieve knowledge across sessions. The memory vault is Obsidian-compatible
(markdown with YAML frontmatter and wikilinks).

## Key features

- **Hybrid Search**: Combines vector similarity (pgvector) and keyword matching (ILIKE) with MMR reranking for diversity
- **Obsidian-Compatible**: Standard markdown with YAML frontmatter and `[[wikilinks]]` for cross-document linking
- **Read-Only Sandbox Mount**: Memory is mounted at `/memory:ro` in sandboxes — agents must use dedicated write APIs
- **Concurrency-Safe Writes**: Advisory locks ensure atomic writes via `memory_write`, `memory_patch`, `memory_append`
- **Git/S3 Sync**: Optional synchronization with external Git repositories or S3 buckets
- **Backlink Graph**: Automatic indexing and querying of document relationships

## Memory layout

```
/memory/
├── context.md                   # essential squad context (always injected)
├── map.md                       # self-describing vault structure
├── work-log/                    # completed work records
├── decisions/                   # architecture decisions
├── patterns/                    # code patterns and conventions
├── debugging/                   # playbooks for common errors
├── runbooks/                    # operational checklists
└── _system/                     # sync state and maintenance logs
```

## Agent tools

- `memory_search` - Hybrid search with configurable weights
- `memory_get` - Read file content
- `memory_write` - Overwrite file (creates if needed)
- `memory_patch` - Exact single-match text replacement
- `memory_append` - Append content to file

## CLI commands

```bash
ficus memory search "websocket reconnect" --squad <id> --mode hybrid
ficus memory get /memory/patterns/react-query.md --squad <id>
ficus memory write /memory/decisions/auth.md --squad <id>
ficus memory patch /memory/decisions/auth.md --match "old" --replace "new" --squad <id>
ficus memory reindex --squad <id>
ficus memory sync pull --squad <id>
ficus memory sync push --squad <id>
```

## Requirements

The memory system requires **pgvector** for semantic search (auto-installed via
migration). Keyword search uses ILIKE — no additional extensions needed.
Semantic search additionally needs `OPENAI_API_KEY` for embeddings; without it
memory search falls back to keyword matching
([configuration.md](../configuration.md)).

## In this directory

| Doc                                            | What it covers                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)           | Chunking, embeddings, pgvector storage, hybrid search and reranking             |
| [`adapter-lifecycle.md`](adapter-lifecycle.md) | The indexed and live memory-source adapter contracts, for adding a new source   |
| [`memory-files.md`](memory-files.md)           | The `memory_file` source: the writable vault itself                             |
| [`workspace-files.md`](workspace-files.md)     | The `workspace_file` source: searching an agent's workspace                     |
| [`agent-threads.md`](agent-threads.md)         | The `agent_thread` source: searching past agent conversations                   |
| [`sync.md`](sync.md)                           | Git and S3 sync providers, conflict handling, sync state                        |
| [`reindex.md`](reindex.md)                     | `POST /api/memory/:squadId/reindex` — what each source does on a manual reindex |

### Sources

- [`sources/github-issue.md`](sources/github-issue.md) — GitHub issues and pull requests
- [`sources/linear-issue.md`](sources/linear-issue.md) — Linear issues (live, queried at search time)
- [`sources/slack-thread.md`](sources/slack-thread.md) — Slack threads ingested from a permalink
- [`sources/slack-canvas.md`](sources/slack-canvas.md) — Slack Canvas files (huddle notes)

### Conventions

- [`conventions/ownership-docs.md`](conventions/ownership-docs.md) — ownership documents used as routing evidence
