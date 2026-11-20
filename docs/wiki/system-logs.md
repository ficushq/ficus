# System log providers

`ficus system logs -c api -t 100 --no-follow` requires `system:logs`. The initial control frame reports only the selected provider and target kinds; deployment targets remain server-side.

| Provider  | Required configuration                                                                      | Access / behavior                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm2`     | `FICUS_PM2_API_NAME`, `FICUS_PM2_WORKER_NAME` (default `ficus-api`, `ficus-worker`)         | Requires `pm2`; it is the only verified fallback when no provider is configured.                                                                           |
| `systemd` | `FICUS_SYSTEMD_API_UNIT`, `FICUS_SYSTEMD_WORKER_UNIT` (default `ficus-api`, `ficus-worker`) | Requires `journalctl`; the Core user needs journal access to both units. Setup-generated installs select this provider.                                    |
| `docker`  | `FICUS_DOCKER_API_CONTAINER`, `FICUS_DOCKER_WORKER_CONTAINER`                               | Requires Docker CLI/daemon access. `docker-compose.core.yml` uses deterministic names. Socket access is effectively host-root, including read-only mounts. |
| `k8s`     | `FICUS_SYSTEM_LOG_K8S_NAMESPACE`; optional selector/container mappings                      | Requires the dedicated core-namespace `pods:list` and `pods/log:get` role. Matching replicas are snapshotted; reconnect to include later replicas.         |
| `file`    | Absolute `FICUS_LOG_FILE_API`, `FICUS_LOG_FILE_WORKER`                                      | Requires readable files; `tail -F` follows rotation. Missing paths fail rather than falling back.                                                          |

Native local launchd and systemd-user installs intentionally set `FICUS_SYSTEM_LOG_PROVIDER=file` and point both component targets at `~/.ficus/logs/ficus[-<label>]-api.log` and `~/.ficus/logs/ficus[-<label>]-worker.log`; each supervisor sends stdout and stderr to the same private component file. Hosted systemd installs remain journal-backed.

There is no auto-detection beyond the pm2 fallback: a systemd install shows "unavailable" until `FICUS_SYSTEM_LOG_PROVIDER=systemd` is present in the service environment. The setup toolkit writes it into the generated `.env`; installs created before that line existed add it to `<dest>/.env` manually and restart `ficus-api`/`ficus-worker`.

Use `docker compose -f docker-compose.core.yml up -d` for the Compose deployment. It supports one deterministic API and worker container; use the file provider where Docker socket access is not acceptable.

The current Compose file names those containers `ficus-api` and `ficus-worker`.
If an existing Compose project still runs `tau-api` and `tau-worker`, stop and
remove only that project's old API and worker containers before starting the
new definitions; otherwise the old API may retain port 3000. Keep the
PostgreSQL and Core data volumes. Do not use `down --volumes` for this change.

Query bearer tokens remain compatibility-only. First-party CLI connections send an Authorization header; browsers use a single-use ticket or HttpOnly session cookie. Use TLS and ensure proxy logs redact `token` and `ticket`.

## Web viewer

Settings → Logs (`system:logs`) shows the same stream in the browser. Connection stays manual: nothing streams until Connect. The pane fills the rest of the page and **Full screen** opens it in a window-sized dialog; Escape or **Exit full screen** returns to the page without reconnecting.

- **Wrap lines** (remembered per browser) wraps long lines with a hanging indent; turned off, each entry stays on one row and the pane scrolls sideways.
- The `[api]` and `[worker]` prefixes have their own colors and timestamps are dimmed. Errors and warnings get a red or amber bar: the dominant ANSI color when the log is colored, otherwise a guess from the text (an `error:`/`Error:`/`Failed` style start, an upper-case `ERROR`/`WARN`, a `level=` field, a stack frame or an HTTP 5xx). Production logs usually carry no level, so treat the bars as a reading aid, not a filter.
- New lines keep the pane at the bottom. Scrolling up pauses that; **Jump to latest** shows how many lines arrived meanwhile and resumes.
- Search highlights every case-insensitive match. Enter starts from the newest match and walks back, Shift+Enter and **Next** walk forward, **Previous** walks back; the active match is scrolled into view and pauses following.
- The browser keeps the newest 10,000 lines.
