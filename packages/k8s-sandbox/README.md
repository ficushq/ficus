# Tool Executor

HTTP service that runs inside each K8s sandbox pod, providing command execution, file operations, and interactive shells for agents.

**Full documentation:** [docs/wiki/k8s/sandbox.md](../../docs/wiki/k8s/sandbox.md)

## Quick Reference

| Endpoint       | Method    | Description                       |
| -------------- | --------- | --------------------------------- |
| `GET /healthz` | GET       | Health check (K8s probes)         |
| `POST /bash`   | POST      | Command execution (SSE streaming) |
| `POST /read`   | POST      | Read file contents                |
| `POST /write`  | POST      | Write file contents               |
| `POST /list`   | POST      | List directory                    |
| `POST /stat`   | POST      | File/directory metadata           |
| `GET /shell`   | WebSocket | Interactive PTY shell             |

## Build

```bash
bun run sandbox:build:k8s    # builds tau-sandbox Docker image
```

The K8s sandbox image does not bundle the Ficus CLI. Ficus Core stages the built CLI into the shared core-data volume and mounts it read-only at `/usr/local/bin/ficus` when creating sandbox pods. Run `bun run build:cli` before starting or recreating K8s sandboxes after CLI changes; local auto-update does this without running `k3d:import`.

### Browser smoke test

The image includes native runtime libraries for Python `greenlet` and Playwright Chromium on `linux/amd64` and `linux/arm64`, but does not preinstall Playwright browser binaries. After building, run the bundled smoke test to install Playwright in a temporary venv, download Chromium, and verify a headless launch:

```bash
docker run --rm --entrypoint bash --shm-size=1g tau-sandbox:latest /opt/sandbox/scripts/smoke-headless-browser.sh
```

See [docs/wiki/k8s/sandbox.md](../../docs/wiki/k8s/sandbox.md#headless-browser-support) for Kubernetes launch flags and multi-arch build verification.

## Development

```bash
# Run locally (outside K8s)
WORKSPACE_PATH=/tmp/test-workspace bun run packages/k8s-sandbox/src/server.ts
```

## Bash invocation process ownership

Each `POST /bash` attempt is keyed by a stable invocation ID and a server-owned generation. The server starts bash as a dedicated session leader (`PID = PGID = SID`) and writes an atomic runtime record under `${FICUS_BOX_HOME:-$HOME}/.tau/runtime/bash-invocations`. Records contain only the hashed invocation ID, generation, command SHA-256 digest, PID/PGID/SID, opaque process start token, and start/terminal timestamps; commands, environment variables, output, and credentials are never persisted.

A live invocation fences duplicate acquisition. Timeout, response cancellation, explicit `POST /bash/cancel`, and server shutdown use one ownership rule: signal the exact owned groups with TERM, apply bounded KILL escalation to groups found inside the exact SID, join the leader, and scan the SID until it is empty. A new generation is admitted only after that proof. Startup reconciles every nonterminal record before admitting bash requests, covering wrapper loss, SIGKILL, and OOM where normal cleanup did not run.

An invocation ID is a fenced generation lineage, not an output attachment or an exactly-once result key. Terminal output is streamed but not persisted. If transport closes before an explicit terminal `exitCode`, Core treats the outcome as unknown and must prove `POST /bash/cancel` reports no remaining processes before a later attempt. That cleanup proves only that no predecessor remains; it does not prove that the command had no side effects, so ambiguous commands are never transparently replayed.

The server never signals PID, PGID, or SID 1. PID reuse or any mismatch between persisted identity and the inspected process is ambiguous: cleanup fails closed and no retry is authorized. Linux identity uses `/proc` state and kernel start ticks. Darwin identity uses native `proc_pidinfo` start seconds plus microseconds with `getsid`/`getpgid`; second-resolution `ps` launch text is diagnostic only and never authorizes signaling.

Terminal invocation diagnostics are retained while preserving unresolved ownership evidence. Active, cancelling, quarantined, ambiguous, and malformed evidence is never pruned. Reconciliation quarantines only the affected hashed invocation key; unrelated keys remain available while same-key retries stay fail-closed. Core cancellation requests have an independent 12-second deadline and preserve durable cancellation intent when transport cleanup cannot be proven.

### Foreground-only idle-exit contract

Work that must finish on a socket-activated VM box must remain in one foreground `/bash` request, with an explicit timeout up to 3,600 seconds. `&`, `nohup`, `setsid`, `disown`, hand-launched tmux, and one-shot monitors are unsupported durability mechanisms; they may outlive the invocation registry's owned SID and be terminated at the next idle exit.

Request admission is serialized with idle drain before body parsing or process creation. Startup reconciliation, request reservations, active/cancelling invocations, shells, and watchers all block exit without relying on `/healthz` probes. Once drain wins, new requests receive a retryable 503 and cannot spawn.

The systemd service is a non-delegated cgroup-v2 leaf with `KillMode=control-group`. Service-cgroup ownership is marked by the unit's ExecStart switch (`--service-cgroup`) — argv is owned by the root-installed unit, so `host.env`/`server.env` (systemd `EnvironmentFile=` inputs, which override `Environment=` values regardless of unit order) cannot disable the census. Immediately before a service-managed idle exit, the server reads only its own cgroup membership, logs one fixed warning with the numeric residual child count, and lets systemd clean the cgroup. It never reads or logs process IDs, commands, arguments, working directories, environments, invocation IDs, or raw census errors. If the bounded census is unavailable or malformed, exit is deferred.

## Docker authenticated executor mode

The development Docker image opts the executor into a versioned runtime contract. PID 1 writes authentication material to a root-only token file, supervises the executor and a private `0600` `socat` forwarder, and reports only non-secret protocol, capability, and named-user identity fields from `/healthz`. The forwarder scopes access to the `tau` account at the filesystem-permission layer only: it forwards raw bytes, does not filter Docker API operations, and is not an escape or privilege boundary. In socket mode, `tau` retains full Docker daemon authority, which is host-root-equivalent. Docker bash runs through the execing `su-exec tau` launcher so the process ownership identity remains the command session leader. K8s and VM launch/auth behavior is unchanged when the Docker marker is absent.
