---
name: view-system-logs
description: 'View Ficus server system logs (API and worker) via the CLI. Requires the system:logs permission scope. Use when diagnosing server-side errors, worker failures, or runtime behavior.'
required-permission: system:logs
---

# View System Logs

## When to Use

Use this skill to inspect Ficus's own server logs — the API (core) process and
the worker process — when diagnosing server-side errors, failed background
jobs, webhook delivery issues, or unexpected runtime behavior. This skill only
appears for agents that hold the `system:logs` permission scope.

## CLI Usage

Stream system logs with `ficus system logs`:

```bash
ficus system logs                              # all components, follow live, last 500 lines
ficus system logs -c api                       # API/core logs only
ficus system logs -c worker                    # worker logs only
ficus system logs -c all -t 1000               # last 1000 lines, all components
ficus system logs --no-follow                  # one-shot tail, then exit
ficus system logs -c api -t 200 --no-follow    # snapshot of last 200 API lines
```

## Options

- `-c, --component <component>` — `api`, `worker`, or `all` (default: `all`).
- `-t, --tail <n>` — number of recent lines to load first (default: `500`,
  clamped server-side to a maximum of `5000`).
- `-f, --follow` — follow live logs (default: on).
- `--no-follow` — disable following; print the tail and exit.

## Output

Binary frames carry raw log chunks written straight to stdout; JSON control
frames report `{ type: 'info' | 'error', message }`. On a non-follow tail the
stream closes with an `info: Tail complete` message.

## How Access Is Granted

This skill is gated by `system:logs`. An admin grants it to a specific agent
with:

```bash
ficus agent scope grant <agent-id-or-name> system:logs
```

Once granted, the skill appears in that agent's available skills automatically
on its next session after the normal skill cache refresh.

## Reference

- Endpoint: `GET /ws/system/logs` (WebSocket; query params: `component`,
  `tailLines`, `follow`).
- Server-side handler: `apps/core/src/services/ws/system-logs.ts`.
- Only the logical components `api`, `worker`, and `all` are accepted; concrete
  log file paths are resolved server-side and never exposed.
