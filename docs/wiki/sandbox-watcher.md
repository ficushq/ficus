# Sandbox Workspace Watcher

The workspace watcher runs inside sandbox pods and watches for file changes in `/workspace/`, sending updated content back to core for memory indexing.

> **On the `host` runtime the watcher runs in the core process itself**, rooted at the override-aware squad workspace, and feeds the same ingest path directly in process (one watcher per squad per machine) — see [host-runtime.md](host-runtime.md). On container/VM runtimes it runs in the sandbox pod as described below.

> **See also:** [memory/workspace-files.md](memory/workspace-files.md) covers the core-side memory source that receives and indexes these files.

## Architecture

```
Core (API)                              Sandbox Pod
┌──────────────────┐    POST /watch     ┌──────────────────────┐
│  ensureSandbox    ├──────────────────▶│  WorkspaceWatcher     │
│                   │                   │  (chokidar)           │
│                   │◀─POST /api/───────│                       │
│  WorkspaceFile    │ memory/{squad}/   │  Watches /workspace/  │
│  Source           │ workspace-files   │  3s debounce per file │
└──────────────────┘                    └──────────────────────┘
```

The watcher is a push-based system: core tells the sandbox _what_ to watch, and the sandbox pushes file content back to core whenever something changes.

## Lifecycle

### Startup

1. `ensureSquadSandbox()` provisions/verifies the sandbox pod
2. Core calls `POST /watch` on the sandbox with the squad's workspace indexing config (include/exclude globs, squadId)
3. The watcher performs an initial scan — all matching files are sent with `reconcile: true`
4. chokidar begins watching `/workspace/` for ongoing changes

### Pod Restarts

Core always calls `POST /watch` on `ensureSquadSandbox()`, so killed or recreated pods are automatically re-configured. No persistent state is needed inside the pod.

### Deduplication

`start()` deduplicates concurrent calls — if a start is already in progress, subsequent callers join the in-flight promise rather than triggering a second scan.

## Authentication

The sandbox authenticates callbacks to core using a Bearer token:

1. Reads `FICUS_PASSWORD` from the environment
2. Falls back to reading `/etc/tau/password` (K8s mounted secret volume)
3. Sends as `Authorization: Bearer <password>` on all POSTs to core
4. Uses `FICUS_API_URL` env var to construct the core callback URL (not a URL passed from core)

## File Change Events

| Event            | Behavior                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| **add/change**   | Debounced 3s per file, then content read and POSTed                                                             |
| **delete**       | Sent immediately with `content: null`                                                                           |
| **initial scan** | All matching files sent with `reconcile: true` flag (core uses this to remove docs for files no longer present) |

Individual file changes are logged at the `[watcher]` prefix.

## Safeguards

| Limit                         | Value                         |
| ----------------------------- | ----------------------------- |
| Max files per include pattern | 1,000                         |
| Max file size                 | 100KB                         |
| Binary detection              | Null bytes in first 512 bytes |

### Default Excludes

These patterns are always excluded, in addition to any user-configured excludes:

```
**/node_modules/**
**/.git/**
**/dist/**
**/build/**
**/.next/**
**/.cache/**
**/coverage/**
**/*.min.js
**/*.map
```

### Skip Reporting

Files that can't be indexed are tracked with a reason and reported back to core on scan:

| Reason               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `file_too_large`     | Exceeds 100KB                                   |
| `binary`             | Contains null bytes                             |
| `max_files_exceeded` | Pattern matched >1,000 files (excess truncated) |
| `unreadable`         | File couldn't be read (permissions, etc.)       |

Skip information is included in the reconcile payload so the UI can surface why certain files aren't indexed.

## Sandbox Endpoints

### `POST /watch`

Start or reconfigure the watcher.

```json
{
  "include": ["**/*.ts", "**/*.md"],
  "exclude": ["**/test/**"],
  "squadId": "squad_abc123"
}
```

Stops any existing watcher before starting with the new config. Returns the initial scan results (file count and skipped files).

### `GET /watch`

Returns current watcher status:

```json
{
  "active": true,
  "config": {
    "include": ["**/*.ts"],
    "exclude": [],
    "squadId": "squad_abc123"
  }
}
```

### `POST /watch/rescan`

Triggers a full re-scan and reconcile without restarting the chokidar watcher. Useful when files may have changed outside normal FS events (e.g., after a `git checkout`).

## Implementation Files

| File                                                           | Role                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/k8s-sandbox/src/services/watcher.ts`                 | `WorkspaceWatcher` class — scanning, watching, sending            |
| `apps/core/src/services/sandbox/ensure.ts`                     | Calls `POST /watch` during sandbox setup (host: `configureWatch`) |
| `apps/core/src/routes/memory.ts`                               | Core endpoint receiving file content from the sandbox             |
| `apps/core/src/services/memory/workspace-files.ts`             | Shared ingest service (HTTP route + host watcher sink)            |
| `apps/core/src/services/memory/sources/WorkspaceFileSource.ts` | Parses, chunks, and embeds received file content                  |
