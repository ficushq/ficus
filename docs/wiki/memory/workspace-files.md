# Workspace Files

Source type: `workspace_file`

Capabilities: searchable, readable, external

Workspace files index content from a squad's sandbox workspace (`/workspace/`), making code, docs, and config files searchable through memory. Files are watched in real-time — changes are indexed automatically.

## How It Works

```
Sandbox Pod                              Core
┌─────────────────────┐                  ┌─────────────────────────┐
│  WorkspaceWatcher    │   POST /api/    │  WorkspaceFileSource    │
│  (chokidar)          │──memory/squad/──▶  index/reconcile        │
│                      │  workspace-files│                         │
│  Watches /workspace/ │                 │  Parse → Chunk → Embed  │
│  3s debounce/file    │                 │  30s debounce/squad     │
└─────────────────────┘                  └─────────────────────────┘
```

1. Core calls `POST /watch` on the sandbox with include/exclude glob patterns
2. The sandbox `WorkspaceWatcher` scans matching files and starts watching
3. On file changes, the watcher debounces (3s per file) then POSTs content to core
4. Core's `WorkspaceFileSource` parses, chunks, and embeds the content
5. On initial scan, a full reconciliation removes docs for deleted files

## Configuration

In squad settings → Workspace Indexing:

```typescript
workspacePaths: {
  include: ['src/**/*.ts', 'docs/**/*.md'],  // glob patterns relative to /workspace
  exclude: ['**/*.test.ts']                   // additional excludes
}
```

### Default Excludes

Always applied regardless of config:

```
node_modules, .git, dist, build, .next, .cache, coverage, *.min.js, *.map
```

## Limits

| Limit                         | Value | Scope                       |
| ----------------------------- | ----- | --------------------------- |
| Max files per include pattern | 1,000 | Per glob pattern, not total |
| Max file size                 | 100KB | Per file                    |

Files exceeding limits are skipped and reported in the UI with reasons:

- `file_too_large` — Exceeds 100KB
- `binary` — Binary file detected (null bytes in first 512 bytes)
- `max_files_exceeded` — Pattern matched more than 1,000 files
- `unreadable` — File couldn't be read

## Chunking

- **Markdown files** (`.md`) — Heading-based chunking with frontmatter and wikilink support
- **Everything else** — Line-based chunking (~80 lines per chunk, splits on blank lines when possible)

## Watch Lifecycle

### Startup

When a sandbox pod starts (or is recreated), core calls `GET /watch` to check status. If the watcher isn't active or the config differs, core sends `POST /watch` to start it. This handles pod restarts — the sandbox always gets its watcher configured.

### Initial Scan

The first `POST /watch` triggers a full scan. All matching files are sent to core with `reconcile: true`, which:

1. Indexes new/changed files
2. Removes documents for files no longer present
3. Reports skip reasons back to the UI

### Live Updates

After the initial scan, chokidar watches for changes:

- **File added/changed** — Debounced 3s, then sent to core
- **File deleted** — Sent immediately with `content: null`

### Rescan

`POST /watch/rescan` triggers a full re-scan without restarting the watcher. Used by the reindex endpoint when `source=workspace_file` or `source=all`.

### Status

`GET /watch` returns current watcher state:

```json
{
  "active": true,
  "config": {
    "include": ["src/**/*.ts"],
    "exclude": [],
    "squadId": "..."
  }
}
```

## Authentication

The sandbox reads `FICUS_PASSWORD` from the environment or `/etc/tau/password` (K8s mounted secret) and sends it as a `Bearer` token on all callbacks to core.

## Implementation

- Watcher: `packages/k8s-sandbox/src/services/watcher.ts`
- Source: `apps/core/src/services/memory/sources/WorkspaceFileSource.ts`
- Core endpoint: `apps/core/src/routes/memory.ts` (`POST /api/memory/:squadId/workspace-files`)
- Watch setup: `apps/core/src/services/sandbox/ensure.ts` (`configureWorkspaceWatch`)
- UI: `apps/web/src/components/squads/WorkspaceIndexingSettings.tsx`
