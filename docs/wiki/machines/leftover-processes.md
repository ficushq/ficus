# Leftover processes

What happens to the processes an agent's command leaves running in a box after
the command itself returns, and how an agent keeps one on purpose.

## Why

Agents start dev servers and test databases in the background so their tool
call can return. When the command's shell exits, the background process is
reparented and keeps running, and before this change nothing tied it to the
agent, its flow attempt or its work stream. Worktree cleanup does not stop
processes, and it is often deferred while dependent streams build on a branch.
On one 4-core squad box, five dev servers left behind by finished streams and by
earlier attempts of active streams kept the load average near 10 for hours.

## Attribution

Every agent `bash` and `squad_bash` command carries its owner to the box:

- `owner`: the agent id (already sent for memory-kill notices, see the
  [memory model](memory-model.md#how-the-agent-hears-about-it)),
- `workStreamId` and `attemptId`: the flow attempt the agent's execution is
  working on when the command starts. Core reads it from the execution row for
  each command, because an inline handoff rebinds a running execution to its
  next attempt (`apps/core/src/services/sandbox/bash-ownership.ts`).
- `slotClaimIds`: the slot claims the agent holds when the command starts
  (active and not past their expiry), read for each command in the same file.
  A failed or slow lookup (over 2 seconds) sends none, so a command is at worst
  not tied to a claim, never tied to a wrong one.

The box server records each owned command when it is admitted
(`packages/sandbox-server/src/services/leftover-processes.ts`). Once the command
returns, whatever it left running is a leftover of that agent, stream and
attempt:

- **With workload cgroups** (VM boxes with a delegated unit): the command's own
  `workload/inv-<invocation id>` leaf holds everything it started, including a
  process that called `setsid` or daemonized.
- **Without them** (k8s, Docker, VM units provisioned before delegation): the
  command's process session does. Each command runs as its own session leader
  and its children stay in that session unless they call `setsid` themselves.
  A process that leaves the session is not attributed. This is a documented
  limitation of those runtimes.

Commands without an owner (Core's own housekeeping, managed app and monitor
launchers) are never recorded, so they are never stopped.

When a command returns, the server checks once whether it left anything running
and forgets it if not, so the record holds only commands with live leftovers.
Past 2,000 remembered commands it forgets only finished ones verified empty; a
command with a live leftover is never forgotten for space.

The record lives in the box server's memory. That is enough: restarting the
server unit (or the container) ends every process in it, and the server does
not exit for idleness while a workload leaf still has processes.

## When leftovers are stopped

Four separate triggers, each its own call (`apps/core/src/services/sandbox/leftover-processes.ts`):

| Trigger                                                 | Where it fires                                                                                              | What is stopped                                      | Boxes asked                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| A flow attempt ends (completed, returned or superseded) | `advanceFlow`, after the transition commits (`services/workflows/execution.ts`)                             | Leftovers of that stream and attempt, from any agent | The squad box and the attempt agent's own box |
| An agent goes dormant                                   | The `processes` stage of dormancy completion, before its own box is stopped (`services/agent/lifecycle.ts`) | Everything that agent left                           | The squad box                                 |
| A work stream is done or canceled                       | `workStream.done` and `workStream.canceled` handlers (`services/agents/cleanup.ts`)                         | Leftovers of that stream, from every agent           | The squad box                                 |
| A slot claim is released or expires                     | `releaseSlot` after its transaction commits; the delivery of the claim's expiry notice (`services/slots`)   | What its owner started while holding it (see below)  | The squad box and the owner's own box         |

### Slot claims

A claim ends in one of three ways, and each is covered:

- **Released** (`ficus slot release`): `releaseSlot` starts the stop in the
  background once the release has committed, so the release answers at once.
- **Expired**: a claim expires inside whichever slot transaction notices it
  first (a claim, a release, the 30 second reconciliation sweep), and each
  queues an expiry notice in the slot notification outbox. Delivering that
  notice starts the stop (`services/slots/notifications.ts`), so it runs once
  the expiry has committed, from every path, and again harmlessly if delivery
  is retried. The expiry notice tells the owner that its processes are being
  stopped and that containers are not.
- **Released by dormancy or final cleanup** of the owner: the agent-dormant
  trigger already stops everything the agent left in the squad box, and
  dormancy stops its own box, so there is no separate claim stop.

Rules for which commands a claim covers:

- A command is tied to every claim its agent held when it started. It is
  stopped once its agent holds **none** of those claims. Releasing one of two
  claims therefore leaves work started under both running while the other is
  held; the stop request carries the claims still held
  (`heldSlotClaimIds`), read when the claim ends, and the box skips commands
  tied to any of them. If those cannot be read, nothing is stopped.
- A command started **before** a claim was granted is not tied to it and is
  not stopped when it ends, even if it is still running. Claim before you start
  the work a pool protects.
- A command that is **still running** when its claim ends is not a leftover
  and is left alone, like for every trigger. What it leaves running is stopped
  by the other triggers (its attempt, the agent's dormancy, its stream).
- Only processes are stopped. Containers started through the Docker daemon
  (for example a test database from `docker compose up -d`) do not run in the
  command's leaf or session, so the owner still stops those, for example with
  `test:db:down`.
- The claim is only one more field of a command's ownership, so this works the
  same on every runtime with a box server (VM, k8s, Docker), with the same
  attribution limits described above. The host runtime has no box server and
  no automatic cleanup.

The end of a single agent turn is never a trigger. A command that is still
running (its tool call has not returned) is never a leftover.

The box sends SIGTERM to each process, waits up to 5 seconds, sends SIGKILL to
what is still running, and waits up to 2 seconds more. Each signal re-reads the
process identity first, so a reused pid is never hit. All three triggers are
best-effort: a box that is down has nothing running, a box server that predates
the route answers 404 and is skipped, and nothing here fails a flow transition,
a dormancy or a stream completion.

## What is never stopped

- Processes of another agent (every selector names an agent or a stream, and a
  stream's attempt names only its own commands).
- Core's own commands, and managed apps (`ficus deploy`), monitors and the box's
  tmux server: they are not started by an agent's command and run in their own
  leaves (`tmux-server`, `app-<id>`, `monitor-<id>`) and sessions.
- The box server and its ancestors.
- A process started with `FICUS_KEEP_RUNNING=1` in its environment, and its
  children, which inherit it. This is the opt-out for a service an agent means
  to keep:

  ```bash
  FICUS_KEEP_RUNNING=1 npm run dev >/tmp/dev.log 2>&1 &
  ```

  Use `ficus deploy` for an app that should be managed, restarted and shown as a
  deployment.

- A process whose environment the server cannot read, because its opt-out cannot
  be checked.

## How it is made visible

- **Core log:** one `leftover-processes` line per stopped group: box, reason,
  agent, stream, attempt, pids, which were killed after the grace period, which
  survived, and the command.
- **Box log:** the same line in the box server's log.
- **The owning agent:** one inbox message per cleanup, in plain words: what was
  stopped, in which box, why, and how to keep a service next time. It is a
  system message and does not wake the agent.
- **The agent's next command in that box** starts with a `[ficus] Stopped N
processes left running by an earlier command of yours ...` notice.
- **`sandbox-ps`:** a process an agent's finished command left running shows a
  `LEFT BY` column with the agent, stream and attempt (and `(kept)` when opted
  out); `--json` carries it as `startedBy`.

## Agent guidance

The `bash` and `squad_bash` tool descriptions and the workspace prompt (sandboxed
runtimes only, `LEFTOVER_PROCESS_GUIDANCE` in `apps/core/src/lib/bash-contract.ts`)
tell agents that leftovers are stopped at these moments and how to keep a
service. The host runtime has no box server and no automatic cleanup.

## Not covered

- Containers started through the Docker daemon are not processes of the
  command, so no trigger stops them.
- A process that escapes its session on a runtime without workload cgroups is
  not attributed.
