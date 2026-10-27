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

- `create`: start a command with a label and optional `sandbox`, `cwd`, timeout, batch caps, and restart policy (`restart`, `restartLimit`).
- `list`: show monitors for the current agent.
- `get`: show status, restart policy/state, and recent sandbox log lines.
- `cancel`: stop a monitor owned by the current agent.

Monitors are agent-scoped and are currently wired for squad managers and squad workers.

### Choose the execution sandbox

Use `sandbox: "private"` (the default) for the agent's private box or
`sandbox: "squad"` for the shared squad box. The latter is available only when
this session permits `squad_bash`; arbitrary sandbox IDs are not accepted.
Monitors remain owned by the creating agent, with the same per-agent cap.

Choose the squad box to watch files in a squad worktree. Private VM boxes have
separate filesystems and cannot access squad worktree paths. `cwd` must exist
and be accessible inside the selected box; omitting it uses that box's work
root. A failed directory change is logged and ends the monitor with a nonzero
exit code, rather than triggering loss recovery.

For example, watch a log in the squad workspace:

```json
{
  "action": "create",
  "label": "Application errors",
  "sandbox": "squad",
  "command": "tail -F app.log | grep --line-buffered ERROR",
  "restart": "on-loss"
}
```

The target sandbox is saved at creation. Restarts, Core recovery, logs and
cancellation all use that same target.

## Defaults and caps

- Default timeout: 30 minutes; maximum: 24 hours.
- Default batch: 20 lines, 4 KiB, 750 ms debounce.
- Minimum interval between batches: 2 seconds.
- Pending in-memory output is capped at 64 KiB.
- Active monitors per agent: 3.
- Restart policy: `never`; `restartLimit` (only with `on-loss`): 5 rapid restarts, range 0–20.

The line/byte batch caps pace delivery: output beyond a single batch stays buffered and is delivered in subsequent batches (one every 2 seconds), not dropped. Output is only dropped when the 64 KiB pending buffer overflows, in which case the oldest lines are discarded and the next batch reports a `[+N lines dropped (buffer full)]` count. The full command output always remains available in the sandbox log file via `action: "get"`.

A monitor that sustainably overflows the buffer is auto-stopped once more than 500 lines have been dropped, and the agent is told to recreate it with a tighter filter — this forces selective, specific monitor commands rather than firehoses.

Monitor output (line batches and lifecycle status) is delivered to the agent as descriptive `Monitor "label" (id) …` messages that always interrupt the current turn (steer delivery), so the agent reacts to events as they land rather than only when it next stops. In the web UI these render as compact, tool-like rows (collapsed line batches that expand to show output, and color-coded terminal-status rows) — distinct from the inbox delivery card.

While an agent has monitors in `starting`, `running` or `canceling`, its web chat shows a compact “Monitoring: label · label” row beneath the header, next to the slot hold/wait rows. Each label opens that monitor's details modal. The row needs `monitors:read` for the agent's squad, is hidden for terminated or dormant agents, hides silently on read errors, and updates live from the `monitors` event topic without polling. The same list/get/logs/cancel calls are available to other clients as `client.monitors` in `@ficus/client-core`.

## Lifecycle

The worker supervisor starts a tmux session inside the monitor's own sandbox (a private agent box or the squad box). It uses the pinned tmux on Ficus's own socket (`tmux -L ficus`), whatever the box's `PATH` or devbox profile; see [Which tmux Ficus runs](deployments.md#which-tmux-ficus-runs). The launcher appends the command's output to `<work root>/.ficus/monitors/<id>/logs/current.log` and writes `exitCode` when the command ends. The supervisor keeps a live foreground stream of that log and polls the session's liveness. Output batches are delivered through the existing DB-backed steering-message path.

### Quiet monitors and stall alerts

A running monitor attached to a work stream's agent counts as supervised waiting while its process has been confirmed alive recently. Successful launches and liveness probes persist `lastConfirmedAliveAt`; they do not emit output or wake the agent. Event-only monitors can therefore remain silent for hours without causing a squad stall alert.

The confirmation expires after 150 seconds: the 15-second maximum poll interval times the five-failure retry allowance plus one poll, with another minute for exec/database latency. Failed probes do not refresh it. Pending restarts, terminal states and expired deadlines do not suppress stall detection, even if a previous confirmation is recent. After a Core restart, successful probes renew the timestamp; merely loading an old `running` row does not. Existing monitors acquire the timestamp on their next successful probe after upgrade.

The same live-monitor check also suppresses the work-stream idle nudge ("It seems like you stopped working on work stream ...") and the persistent-idle owner notice. While the stream's assignee, or one of its direct subagents, has a live monitor, the continuation sweep sends neither. This matches how a queued slot wait suppresses them. A monitor reaches `running` and records its first confirmation before the monitor tool returns, so an agent that creates a quiet monitor and ends its turn right away does not get the first nudge about 60 seconds later. Once the monitor stops counting as live (it exits, times out, is canceled, fails, is lost, passes its deadline, or its confirmation goes stale), the nudge works as before. A monitor's terminal message already wakes the agent. Provider transport retries are not idle nudges and are unaffected. Both checks use one shared predicate, `liveMonitorCondition` in `apps/core/src/services/monitors/live-monitors.ts`. The stall alert counts only the stream agents' own monitors.

This confirms that the watcher is alive, not that the watched job is making useful progress. Monitor commands should still detect and report job-specific errors or stalled progress. Provider and sandbox outage alerts remain independent.

### Delivered offset

The stream reads the log by byte offset (`tail -c +<offset+1> -F`), not from its current end. The supervisor tracks two offsets:

- **Received offset (in memory):** the end of the last complete line read. If the stream errors or ends while the monitor is active, the next successful liveness poll reopens it from this offset. Nothing is dropped and nothing is repeated, including output written during the gap.
- **Delivered offset (`monitors.log_offset`):** saved with each delivered batch. After a Core restart the stream resumes from here. Lines that were received but not yet delivered are read again rather than lost.

When a run ends, the supervisor reads any output the stream had not reached yet (at most 256 KiB), including a final line with no trailing newline. It delivers that output before the terminal message.

### Exit, loss and unavailability

Each poll checks tmux liveness first, then the `timedOut` marker, then the `exitCode` file. The launcher writes `exitCode` before its session ends, so the order makes the result unambiguous:

- **`timedOut` present: timed out** in the sandbox (see [Deadline](#deadline)). This is checked before everything else, so a run the watchdog stopped is never treated as a loss, even when no `exitCode` was written.
- **`exitCode` present: exited.** The monitor ends with that exit code. Exits never restart, whatever the code.
- **Monitor state directory missing, or no session and no `exitCode`: a loss.** The restart policy decides what happens. Treating a vanished session as still running would leave the monitor silent in `running` until its timeout.
- **tmux server unreachable** (no installed tmux can talk to it, typically a stale server of another tmux version): liveness is unknown, so this is never a loss and never relaunches. It counts as an unavailable probe, as below. If it lasts 15 minutes, the monitor fails with the specific tmux reason. A new monitor is unaffected by a stale server on the default socket: its session goes to the Ficus socket. A launch that cannot reach the Ficus server fails with the same specific reason.
- **Exec fails:** after 5 consecutive failures the sandbox counts as unreachable. The supervisor re-ensures the sandbox at most once a minute, the same way the outage recovery watch does, and waits. Unavailability alone is not a loss: the first successful probe decides whether the run survived. If the sandbox stays unreachable for 15 minutes, the monitor fails with `sandbox unavailable for 15m; gave up waiting for it to come back`.

The row is authoritative across Core processes. If another process (the API, or agent cleanup) cancels or ends the monitor, the next poll kills the tmux session and stops supervising it. It never overwrites the recorded outcome.

### Restart policy

`restart` is chosen by the agent when it creates the monitor. There is no per-command default.

- **`never` (default):** a loss fails the monitor with a clear reason, for example `failed: monitor state directory is missing (cause unknown); command was not restarted (restart: never).` A `never` monitor is never rerun on any path: loss, Core restart, or interrupted start.
- **`on-loss`:** once the sandbox is reachable, the supervisor relaunches the same command with the same id, label, cwd, session name and batch settings. The agent gets a notice like `Monitor "x" (id) restarted: monitor state directory is missing (cause unknown) (rapid restart 1/5; resets after 5m stable).` Use it only for idempotent, safe-to-rerun watchers such as `tail -F | grep` or quiet watch loops. Do not use it for one-shot or side-effecting commands.

A relaunch appends to the existing log. If the box was recreated and the log is now shorter than the delivered offset, reading starts again from byte 0.

Cancel, timeout (from Core or from the sandbox watchdog) and overload are deliberate stops: they never restart.

**Restart counting**

- Only an actual relaunch is a restart. Reattaching to a live session after a Core restart is not counted.
- Only **rapid** losses count: a loss within 5 minutes of the latest (re)launch. Once a launch stays up for 5 minutes, the rapid count resets to 0. A long-running monitor that loses its box now and then keeps restarting until its deadline, and those restarts do not count.
- Backoff between relaunches: 5s, 30s, 2m, then 5m, indexed by the rapid count. A non-rapid relaunch waits 5s.
- If the next rapid loss would exceed `restartLimit` (default 5), the monitor fails with `restart limit reached: lost N times within 5m of launch (limit L rapid restarts); last loss: ...`.
- A relaunch that cannot reach its sandbox is retried every 15s without counting. After 15 minutes it fails.
- Loss reports describe the missing state or exit code, not a verified sandbox restart. Losses are not checked against the box's own boot identity (for example `/proc` boot_id). Container runtimes share the host's boot_id, so it is not a reliable signal. The stability-window reset is the mechanism.

All of this state is stored on the monitor row so it survives Core restarts: `restart_policy`, `restart_limit`, `restart_count` (lifetime relaunches), `rapid_restart_count`, `launched_at`, `next_restart_at` (a pending relaunch), `last_restart_at`, `last_restart_reason`, and `deadline_at`.

### Deadline

The timeout is an absolute `deadline_at`, fixed at the first launch. Relaunches and Core restarts never move it. A loss detected after the deadline, or a relaunch that comes due after it, ends the monitor as `timed-out` instead of relaunching it.

The deadline is enforced in two places. Whichever fires first wins, and the agent is notified once:

- **Core:** the supervisor's timer kills the tmux session at `deadline_at`.
- **The sandbox:** the launcher runs a watchdog, so the deadline holds while Core is down or restarting. Each launch gets `FICUS_MONITOR_TIMEOUT_SECONDS`. The first launch gets the full timeout. An `on-loss` relaunch, including one after a Core restart, gets only the time left until `deadline_at`, rounded up to whole seconds. The watchdog turns this into a deadline on the sandbox's own clock, so clock skew between Core and the box cannot move it. It rechecks wall time at least every 10 seconds, so a box that was suspended notices soon after it resumes.

When the watchdog fires, it first writes the `timedOut` marker. It then sends SIGTERM to the command's process group, waits 5 seconds, and sends SIGKILL to whatever is left. The launcher records `exitCode` 124. The next poll, or the probe a recovering Core runs, finds the marker and ends the monitor as `timed-out`, with the same status and `timed out.` message as a Core timeout. Output the stream had not delivered yet is delivered first.

The watchdog is a shell watchdog, not coreutils `timeout`. Stock macOS (the host runtime) has no `timeout`, and busybox's `timeout` only signals its direct child, which leaves the rest of a pipeline running. The watchdog needs only bash, `date` and `sleep`.

**Process groups.** The launcher starts the command as a bash job-control job (`set -m`), so the command, its pipeline and everything it spawns get a new process group of their own. Every signal the launcher or watchdog sends goes to that group, never to the launcher's own group, the tmux server, other sessions or unrelated processes. Because the command is no longer in the tmux pane's process group, the launcher traps the SIGHUP from `tmux kill-session` (cancel, or a Core timeout). It stops the command's group the same way: SIGTERM, then SIGKILL after the grace period. It then exits without an `exitCode`, as before. When the command exits on its own, the launcher sends SIGHUP to the group, as the closing pane used to. If the launcher itself is killed outright, the watchdog notices within 10 seconds and stops the command without a marker, so Core sees a loss. If job control is unavailable, only the job's own process is signalled, and its children may survive; Core's timeout still applies. A process that leaves the group on purpose (`setsid`) is not covered. The command's stdin is `/dev/null`.

### Core restarts and deploys

Worker shutdown **detaches**: it clears in-memory timers, pending relaunch timers and streams. It does not touch the database or the tmux sessions, so monitors keep running in their sandboxes while Core restarts.

Explicit stops still cancel: agent or user cancel, agent cleanup (`stopAllForAgent`), and sandbox teardown (`stopAllForSandbox`). Cancel works from any Core process, because it kills the session directly and records the outcome in the row.

On startup, `recoverOnStartup` processes every active monitor:

- `canceling`: the cancel is finished.
- `starting` (Core stopped mid-start, so the agent never received an id): any launched session is killed and the monitor fails. It is not rerun.
- Past its deadline: stopped as `timed-out`.
- Relaunch pending: the relaunch is rescheduled for the remaining backoff. It was counted when the loss happened and is not counted again.
- Otherwise: reattached and probed immediately. A live session resumes streaming from the delivered offset (not a restart). A recorded exit finishes normally. A lost session follows the restart policy.

A sandbox that is not reachable yet goes through the unavailability path above; recovery does not fail it outright.

If Core is down when a deadline passes, the sandbox watchdog stops the command on time. When Core recovers, it records the monitor as `timed-out` and does not relaunch it.

## Debugging

Use `monitor` with `action: "get"` to inspect recent lines. In a sandbox shell, monitor state lives under `<work root>/.ficus/monitors/<monitorId>/` with `run.sh`, `logs/current.log` (appended across relaunches), `exitCode` (removed before each relaunch), `timedOut` (written by the deadline watchdog, also removed before each relaunch), and timestamp files.

## Management

Humans can inspect and cancel monitors, but monitor creation remains agent-owned.
This preserves the agent-tool review path for arbitrary sandbox shell commands.

Management surfaces:

- Agent chat view: open the **Monitors** tab for a squad-scoped agent.
- Squad detail: open the **Monitors** tab to see monitors across squad agents.
- Both tables show a **Restart** column (policy, relaunch count, pending relaunch). The details view adds the rapid-restart count and limit, the last restart, the deadline and the last loss reason. `ficus monitor list` shows the same column, and `ficus monitor show` prints every restart field.
- CLI:
  - `ficus monitor list --agent <agentId>`
  - `ficus monitor list --squad <squadId> --active`
  - `ficus monitor show <monitorId>`
  - `ficus monitor logs <monitorId> --tail 100`
  - `ficus monitor cancel <monitorId>`

`cancel` is an admin safety override. It stops an agent-created monitor and
marks it terminal; it does not create new sandbox execution surface area.
