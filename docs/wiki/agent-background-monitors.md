# Agent Background Monitors

Background monitors let squad agents observe long-lived sandbox commands and receive batched stdout as steering messages without blocking the current turn.

Do not use a monitor to detach a one-shot build, generation, migration, or test that must complete. Run completion-critical work as one foreground Bash invocation with a timeout up to 3,600 seconds. A monitor is safe because its Ficus supervisor owns it and keeps a live foreground log stream; it is not evidence that arbitrary `&`, `nohup`, `setsid`, `disown`, or hand-launched tmux processes survive box idle exit.

Use selective, event-driven commands that stay quiet until an actionable event occurs (completion, error, readiness, state transition, failure, or another condition that needs attention):

```bash
tail -F app.log | grep --line-buffered ERROR
while true; do make test 2>&1 | grep --line-buffered FAIL; sleep 10; done
```

Avoid polling loops that print status every interval, because they spam monitor batches. If polling is needed, loop silently and print only at a terminal or actionable state:

```bash
# Noisy: emits every 60 seconds.
while true; do echo "still running"; sleep 60; done

# Quiet: emits only when attention is needed.
while true; do
  if job_done; then echo "complete"; exit 0; fi
  if job_failed; then echo "failed"; exit 1; fi
  sleep 60
done
```

## Tool

The `monitor` tool supports:

- `create`: start a command with a label and optional `cwd`, timeout, batch caps, and delivery mode.
- `list`: show monitors for the current agent.
- `get`: show status and recent sandbox log lines.
- `cancel`: stop a monitor owned by the current agent.

Monitors are agent-scoped and are currently wired for squad managers and squad workers.

## Defaults and caps

- Default timeout: 30 minutes; maximum: 24 hours.
- Default batch: 20 lines, 4 KiB, 750 ms debounce.
- Minimum interval between batches: 2 seconds.
- Pending in-memory output is capped at 64 KiB.
- Active monitors per agent: 3.

The line/byte batch caps pace delivery: output beyond a single batch stays buffered and is delivered in subsequent batches (one every 2 seconds), not dropped. Output is only dropped when the 64 KiB pending buffer overflows, in which case the oldest lines are discarded and the next batch reports a `[+N lines dropped (buffer full)]` count. The full command output always remains available in the sandbox log file via `action: "get"`.

A monitor that sustainably overflows the buffer is auto-stopped once more than 500 lines have been dropped, and the agent is told to recreate it with a tighter filter — this forces selective, specific monitor commands rather than firehoses.

Monitor output (line batches and lifecycle status) is delivered to the agent as descriptive `Monitor "label" (id) …` messages that always interrupt the current turn (steer delivery), so the agent reacts to events as they land rather than only when it next stops. In the web UI these render as compact, tool-like rows (collapsed line batches that expand to show output, and color-coded terminal-status rows) — distinct from the inbox delivery card.

## Lifecycle

The worker supervisor starts a tmux session inside the squad sandbox and maintains a live foreground stream of `/workspace/.tau/monitors/<id>/logs/current.log`. Output batches are delivered via the existing DB-backed steering-message path. Monitors are canceled during agent cleanup and worker shutdown. On startup, active monitor records are recovered when their tmux session still exists; otherwise they are marked failed.

## Debugging

Use `monitor` with `action: "get"` to inspect recent lines. In a sandbox shell, monitor state lives under `/workspace/.tau/monitors/<monitorId>/` with `run.sh`, `logs/current.log`, `exitCode`, and timestamp files.

## Management

Humans can inspect and cancel monitors, but monitor creation remains agent-owned.
This preserves the agent-tool review path for arbitrary sandbox shell commands.

Management surfaces:

- Agent chat view: open the **Monitors** tab for a squad-scoped agent.
- Squad detail: open the **Monitors** tab to see monitors across squad agents.
- CLI:
  - `ficus monitor list --agent <agentId>`
  - `ficus monitor list --squad <squadId> --active`
  - `ficus monitor show <monitorId>`
  - `ficus monitor logs <monitorId> --tail 100`
  - `ficus monitor cancel <monitorId>`

`cancel` is an admin safety override. It stops an agent-created monitor and
marks it terminal; it does not create new sandbox execution surface area.
