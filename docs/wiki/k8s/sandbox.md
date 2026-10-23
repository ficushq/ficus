# Sandbox

The sandbox is an HTTP service that runs inside each sandbox pod. It provides command execution, file operations, and interactive shells. Agent intelligence stays in Ficus Core — the sandbox only executes operations.

**Source:** `packages/sandbox-server/`

## Startup Flow

The entrypoint (`sandbox/entrypoint.sh`) runs on pod creation:

1. **Source Nix environment** — loads nix profile for devbox
2. **Normalize runtime env** — sources `/opt/sandbox/runtime-env.sh` to set `/tmp`, Playwright browser cache, and Nix runtime library paths for Nix Python native wheels.
3. **Fix SSH permissions** — the `.ssh` dir is mounted from a shared PVC written by Core (possibly different UID with sysbox). Fixes ownership/permissions on startup and re-checks every 5s in background.
4. **Configure git** — sets up credential helper (if `GITHUB_TOKEN` set), user name/email
5. **Seed workspace** — copies default `devbox.json` if workspace doesn't have one
6. **Create `.ficus/.bashrc`** — shell activation script for devbox, created by Core when connecting to the pod
7. **Start sandbox** — `bun run /opt/sandbox/src/server.ts`
8. **Background: devbox install** — runs `devbox install` (fast no-op if packages are baked into image), re-sources the runtime env, then runs `.ficus/setup.sh` if present, then signals `/devbox-ready` to the server

The HTTP server starts immediately (step 7) and responds to health checks, while devbox setup completes in the background (step 8).

### Docker Daemon (Sysbox)

On server startup (`src/docker.ts`), the sandbox checks for an existing Docker socket. If none is found (sysbox mode), it starts `dockerd` in the background and waits up to 30s for it to become ready. Docker is optional — the executor functions normally without it.

## API Reference

All endpoints listen on port `50051` (configurable via `EXECUTOR_PORT`).

### `GET /healthz`

Health check for K8s probes.

**Response:**

```json
{
  "healthy": true,
  "devboxReady": false,
  "version": "0.2.0",
  "uptimeSeconds": 42
}
```

| Field           | Type    | Description                             |
| --------------- | ------- | --------------------------------------- |
| `healthy`       | boolean | Always `true` if server is responding   |
| `devboxReady`   | boolean | `true` after `devbox install` completes |
| `version`       | string  | From `EXECUTOR_VERSION` env var         |
| `uptimeSeconds` | number  | Seconds since server start              |

K8s probes use this endpoint. The **startup probe** allows up to 5 minutes for first boot (devbox install, dockerd start). Readiness and liveness probes start after the startup probe passes.

Note: `healthy: true` does not mean `devboxReady: true`. Core waits for `devboxReady` before marking the sandbox as fully ready.

### `POST /devbox-ready`

Internal endpoint called by the background entrypoint process after devbox install completes. Sets `devboxReady = true` in the health response.

### `POST /bash`

Execute a command. Returns a streaming SSE response.

**Request:**

```json
{
  "command": "echo hello",
  "cwd": "/workspace",
  "env": { "FOO": "bar" },
  "timeoutSeconds": 300,
  "sourceEnv": true,
  "activateDevbox": true
}
```

| Field            | Type   | Default      | Description                                      |
| ---------------- | ------ | ------------ | ------------------------------------------------ |
| `command`        | string | (required)   | Shell command to execute                         |
| `cwd`            | string | `/workspace` | Working directory                                |
| `env`            | object | `{}`         | Additional environment variables                 |
| `timeoutSeconds` | number | (none)       | Kill command after N seconds                     |
| `sourceEnv`      | bool   | `true`       | Source `.ficus/.env` before command              |
| `activateDevbox` | bool   | `true`       | Activate devbox shell environment before command |

**Response:** `text/event-stream` (SSE)

Each event is a JSON object:

```
data: {"stdout":"<base64>"}

data: {"stderr":"<base64>"}

data: {"exitCode":0}
```

Possible fields per event:

- `stdout` — base64-encoded stdout chunk
- `stderr` — base64-encoded stderr chunk
- `error` — error message (spawn failure, timeout)
- `exitCode` — process exit code (final event)

**Command preamble:** Before executing the command, the service prepends:

1. `source .ficus/.env` (if `sourceEnv: true` and file exists) — loads workspace secrets
2. Cached devbox shellenv exports (if `activateDevbox: true` and devbox is ready) — activates devbox packages. The shellenv output is captured once at startup (when `/devbox-ready` fires) and inlined into each command. See [local-dev-k3d.md](local-dev-k3d.md#cached-devbox-shellenv) for why this is cached instead of run per-command.
3. `/opt/sandbox/runtime-env.sh` — normalizes `TMPDIR`, Playwright's browser cache path, and Nix runtime library paths after devbox activation.

### `POST /read`

Read file contents.

**Request:**

```json
{
  "path": "src/index.ts",
  "offset": 0,
  "limit": 51200
}
```

**Response:**

```json
{
  "content": "<base64>",
  "totalSize": 12345,
  "isBinary": false
}
```

Relative paths resolve against `/workspace`. Default limit is 50KB.

### `POST /write`

Write file contents.

**Request:**

```json
{
  "path": "src/index.ts",
  "content": "<base64>",
  "createDirs": true
}
```

**Response:**

```json
{
  "bytesWritten": 1234
}
```

### `POST /list`

List directory contents.

**Request:**

```json
{
  "path": "src",
  "recursive": true,
  "maxDepth": 3
}
```

**Response:**

```json
{
  "files": [
    {
      "path": "index.ts",
      "isDirectory": false,
      "size": 1234,
      "modifiedAt": 1709827200
    }
  ]
}
```

### `POST /stat`

Check file/directory existence and metadata.

**Request:**

```json
{
  "path": "src/index.ts"
}
```

**Response:**

```json
{
  "exists": true,
  "isDirectory": false,
  "isReadable": true,
  "isWritable": true,
  "size": 1234
}
```

### `GET /download`

Raw streaming download, the large-file mirror of `POST /upload`. `POST /read` base64-encodes its window into JSON after allocating it, so it cannot serve big files (256 MiB files failed with `Out of memory`). `/download` streams bytes from disk without materializing them.

```
GET /download?path=<abs path>[&archive=tar.gz]
Range: bytes=<start>-[<end>]      (optional, one range)
```

Same auth gate and `resolvePath` policy as `/read` and `/stat`. The route takes no request body, so it is classified before any body parsing.

| Target                                          | Response                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Regular file                                    | `200` `application/octet-stream` with `Content-Length`, `Accept-Ranges: bytes`, `Last-Modified`. The body is a native file body (sendfile), never buffered                                                                                                                                                                           |
| Regular file + `Range`                          | `206` with `Content-Range: bytes <start>-<end>/<size>`. Suffix ranges (`bytes=-N`) are accepted                                                                                                                                                                                                                                      |
| Unsatisfiable, malformed or multi-range `Range` | `416` with `Content-Range: bytes */<size>`                                                                                                                                                                                                                                                                                           |
| Directory, no `archive`                         | `400` `{ "code": "is-directory" }`                                                                                                                                                                                                                                                                                                   |
| Directory + `archive=tar.gz`                    | `200` `application/gzip`, chunked: stdout of `tar -czf - -C <parent> -- <basename>`, rooted at the directory name. If tar exits non-zero after the headers went out, the stream is errored (the client sees a truncated chunked body, never a silent partial success) and the failure is logged. A client that disconnects kills tar |
| Missing path                                    | `404` `{ "code": "not-found" }`                                                                                                                                                                                                                                                                                                      |
| Rejected by path policy                         | `400` `{ "code": "path-rejected" }`                                                                                                                                                                                                                                                                                                  |
| Other failures                                  | `500` `{ "code": "download-failed" }`                                                                                                                                                                                                                                                                                                |

Every error body is JSON `{ error, code }`. Core relies on the `code` to tell the route's own `404` apart from an old bundle, which answers this unknown `GET` with plain-text `405 Method not allowed` (or `404 Not found`).

A download is a single request whose body can stream for minutes. The TCP listener's idle timeout is disabled for it (like `/bash`), and the socket-activated idle self-exit waits until no HTTP response is still being written (`server.pendingRequests`), so a long transfer is never cut off by an idle exit.

#### Core and outdated sandbox bundles

Core's workspace download (`GET /api/squads/:id/workspace/download`) streams this route's body straight to the HTTP client, forwarding `Range` and returning the box's `206`/`Content-Range`; directories download as `<name>.tar.gz`. Bun currently re-frames every streamed response body as chunked and drops `Content-Length` ([oven-sh/bun#10507](https://github.com/oven-sh/bun/issues/10507)), so Core also sends the exact body length as `X-Ficus-Content-Length`. Directory archives carry `X-Ficus-Archive: tar.gz`.

When a sandbox still runs a bundle older than `/download`, Core falls back to the base64 `/read` path only for files of **64 MiB or less** (served whole, ignoring `Range`). Larger files and all directories answer `503` with code `SANDBOX_BUNDLE_OUTDATED`. Fix it by restarting the agent's sandbox from the agent page, or recreating the squad sandbox, which picks up the current bundle.

### `GET /shell` (WebSocket)

Interactive PTY shell via WebSocket upgrade.

**Client → Server messages:**

```json
{ "spawn": { "cols": 120, "rows": 40, "cwd": "/workspace", "useDevboxRc": true } }
{ "data": "<base64>" }
{ "resize": { "cols": 200, "rows": 50 } }
{ "kill": true }
```

- `spawn` — must be the first message. Creates a PTY process. `useDevboxRc` loads `.ficus/.bashrc` for devbox activation.
- `data` — base64-encoded stdin data
- `resize` — resize the PTY
- `kill` — terminate the shell

**Server → Client messages:**

```json
{ "data": "<base64>" }
{ "exitCode": 0 }
{ "error": "Shell not spawned yet" }
```

## Path Security

All file operations go through `resolvePath()` (`src/paths.ts`) which:

1. Resolves relative paths against `/workspace`
2. Validates the resolved path is under an allowed prefix
3. Rejects paths outside allowed directories

**Allowed prefixes:** `/workspace`, `/memory`, `/home/ficus`, `/nix`, `/opt/ficus`, `/tmp`

This prevents agents from reading or writing arbitrary files on the host.

## Docker Image

The Dockerfile (`packages/sandbox-server/Dockerfile`) builds a multi-stage image:

1. **Base:** Ubuntu 24.04 with Nix, devbox, Bun
2. **Default packages:** A `devbox.json` with common tools is baked in and `devbox install` is run at build time (~2.5GB of nix packages). This makes runtime `devbox install` a fast no-op.
3. **Entrypoint:** `sandbox/entrypoint.sh`

The image does not bundle the Ficus CLI. Ficus Core copies the built CLI into the shared `ficus-core-data` volume at `cli/ficus.js` and mounts it read-only at `/usr/local/bin/ficus` when creating pods. Recreate a sandbox pod after CLI changes to pick up the newly staged file; no sandbox image rebuild/import is required for CLI-only changes.

Build with:

```bash
bun run sandbox:build:k8s
```

### Headless browser support

The sandbox supports Playwright from the default devbox/Nix Python. The image installs Ubuntu 24.04 Chromium host libraries, while `/opt/sandbox/runtime-env.sh` exposes Nix C/C++ runtime libraries (`libstdc++`, `libgcc`) to Nix Python native wheels such as `greenlet` and records discovered Nix glibc loader paths for diagnostics. Users should not set `LD_LIBRARY_PATH` manually.

Browser binaries are installed per workspace by Playwright and default to `/workspace/.cache/ms-playwright` via `PLAYWRIGHT_BROWSERS_PATH`. The runtime also sets `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` because Playwright's validator runs under the Nix/devbox loader and can falsely report the installed Ubuntu Chromium libraries as missing; the smoke test still verifies an actual Chromium launch.

For Kubernetes sandbox pods, launch Chromium with:

```python
browser = p.chromium.launch(
    headless=True,
    args=['--no-sandbox', '--disable-dev-shm-usage'],
)
```

Smoke test a built image with the default devbox/Nix Python path:

```bash
bun run sandbox:build:k8s
docker run --rm --entrypoint bash --shm-size=1g ficus-sandbox:latest /opt/sandbox/scripts/smoke-headless-browser.sh
```

To verify the publish target locally with buildx, run:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ficus-sandbox:headless-browser-test \
  -f packages/sandbox-server/Dockerfile .
```

## Environment Variables

| Variable           | Default       | Description                 |
| ------------------ | ------------- | --------------------------- |
| `EXECUTOR_PORT`    | `50051`       | HTTP server port            |
| `EXECUTOR_VERSION` | `0.2.0`       | Reported in health check    |
| `WORKSPACE_PATH`   | `/workspace`  | Primary working directory   |
| `FICUS_SANDBOX_ID` | (set by Core) | Sandbox identifier          |
| `FICUS_SQUAD_ID`   | (set by Core) | Squad identifier            |
| `FICUS_API_URL`    | (set by Core) | Core API URL for Ficus CLI  |
| `GITHUB_TOKEN`     | (optional)    | Git credential helper token |
| `GIT_USER_NAME`    | (optional)    | Git commit author name      |
| `GIT_USER_EMAIL`   | (optional)    | Git commit author email     |

## Related Docs

- [Architecture](architecture.md) — How the sandbox fits into the system
- [Deployment Guide](deployment.md) — Building and deploying the image
- [Security](security.md) — Path restrictions, network isolation

## First-class squad toolchains

Squads may declare a Ficus-managed package set and inline setup script with `ficus squad toolchain set`. Ficus realizes this isolated Devbox before squad and squad-agent sandboxes are reported ready, retains its per-sandbox lock/cache state, and reconciles a changed fingerprint without modifying the repository's `devbox.json` or `.ficus/setup.sh`. Provisioning status and safe fixed failure reasons are included in sandbox status responses.

Before each turn Core confirms the toolchain is active in the sandbox server. The server reuses its cached environment when the fingerprint is unchanged, and otherwise resolves it with a 20-second limit, below Core's 30-second request budget. A sandbox too loaded to answer in time reports "Toolchain provisioning timed out; the sandbox may be overloaded" rather than "Toolchain provisioning failed", and Core logs the underlying error for every toolchain failure.

## Sandbox and toolchain status precedence

API and CLI responses expose the raw physical lifecycle and managed toolchain state as separate dimensions. Agent-tool and web presentations use the physical lifecycle as canonical; toolchain state refines a physically `running` sandbox and is otherwise secondary diagnostic detail.

| Physical status                          | Toolchain status                            | Primary presentation                             | Secondary detail              |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| `not_found` or `failed`                  | any                                         | Down with the physical status and reason         | Last toolchain state/reason   |
| `starting` or `pending`                  | any                                         | Starting with the physical reason                | Toolchain progress/failure    |
| `terminating`, `succeeded`, or `unknown` | any                                         | Physical lifecycle state                         | Last toolchain state/reason   |
| `running`                                | `failed`                                    | Toolchain failure                                | Safe toolchain reason         |
| `running`                                | `pending`, `installing`, or `running_setup` | Toolchain progress                               | —                             |
| `running`                                | `ready` or absent                           | Ready, unless compatibility installation remains | Compatibility install message |
