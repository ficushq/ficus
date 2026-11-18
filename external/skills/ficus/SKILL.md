---
name: ficus
description: Operate a Ficus instance as a manager/operator — CLI auth, the work-stream lifecycle, squad-manager coordination, answering agent questions, the personal Assistant and its delegated tasks, and the operating doctrine that avoids known failure modes. Use whenever supervising Ficus squads, unblocking/reviewing work streams, or directing work on a Ficus deployment via the `ficus` CLI.
---

# Operating Ficus (the `ficus` CLI)

## What Ficus is

A Ficus instance runs **squads** of AI agents coordinated by a squad
**manager** agent. Work is organized into **work streams**: one deliverable
each, with a priority, an optional git branch, and a **flow** that decides
which agents do which steps. You direct at the work-stream level and
communicate through the manager; the manager shapes the work and the flow
runs it.

Everything below uses the `ficus` CLI. Global flags: `--json` for
machine-readable output (parse this, not the human tables; add
`--no-truncate` when grepping table output), `--backend <label>` to select a
stored auth backend for one command.

## Installing the CLI (if `ficus` is missing)

```bash
curl -fsSL https://ficus.sh/cli/install.sh | bash
export PATH="$HOME/.ficus/bin:$PATH" # add to the shell profile too
ficus --version                      # verify
```

The installer writes the binary to `~/.ficus/bin/ficus` and bundled assets to
`~/.ficus/share`. Upgrade or reinstall later with `ficus install`. If `ficus` is
on PATH but misbehaving after an instance upgrade, run `ficus install` before
debugging further — version skew between CLI and server is a common cause.

## Auth — connecting to a live instance

`ficus auth` manages named backends (label → URL + credential). CLI auth is a
**device pairing flow**: no secrets are typed or stored by hand.

```bash
ficus auth login [label] --api-url https://<instance-host>
# The CLI prints a verification URL (and opens a browser where possible);
# a signed-in user approves the pairing there; the CLI receives a durable
# device token bound to this machine.

ficus auth list | status | switch <label> # manage multiple instances
ficus auth introspect                      # identity + effective roles/permissions
ficus auth logout [label]                  # removes the backend AND revokes the
                                           # paired device server-side
                                           # (--local-only keeps the device grant)
```

- Label defaults to the instance hostname; `--json` works on all of these.
- Verify a new backend immediately with `ficus auth introspect`.
- Device tokens survive instance upgrades and new-passkey registrations —
  pair once per machine per instance and it keeps working.

## Work streams — the core surface

A work stream is one deliverable. Its **flow** (a saved workflow preset, or an
inline definition) owns the steps, which participant does each one, review and
approval gates, rework paths, limits and the delivery policy. Agents are created
only when their step starts. Nobody routes work by reassigning the stream or
editing its status: agents submit step outcomes, and the runtime starts the next
step.

```bash
ficus ws list -q <squadId> [--json]   # outside a squad box, the squad flag is required
ficus ws get <id> [--json]            # description, metadata, open waits, derived state
ficus ws flow <id>                    # flow version, attempts, active outcomes, returns,
                                      # deliveryParticipant and delivery instructions
ficus workflow list                   # presets; ficus workflow get <presetId> for one

ficus ws create "<title>" -q <squadId> -d "<self-contained requirements>" \
    --owner <managerAgentId> \
    [--workflow <presetId> | --flow-content '<JSON source>' | --flow-stdin] \
    [--repository <checkoutPath> --branch <branch> --base-branch main] \
    [--priority <p>] [--depends-on <id>[:ready]]
```

- Omit the workflow selector to use the squad's default flow. Validate an inline
  source first with `ficus workflow resolve --squad <squadId> --content '<JSON source>'`.
- `--repository` provisions an isolated worktree and branch for the stream and
  detects the code host. Read-only work needs none.
- The description is the source of truth for scope. Workers do not see the
  conversation that produced it.

**How a flow moves.** The agent on the active step submits its outcome with
`ficus ws advance <id>` (a versioned command: `expectedVersion`, `attemptId`,
`action`, `outcome`, `evidence`), and the runtime routes the next step, returns
for rework, and waits at joins. When the graph is finished the flow is
`completion-ready`, and the delivery participant runs
`ficus ws finish <id> --version <v>`. Finish checks the delivery policy
(`completion.mode`) independently:

| Mode              | Finish succeeds when                                             |
| ----------------- | ---------------------------------------------------------------- |
| `deliverable`     | Required work is done and blocking waits are resolved            |
| `review-approval` | A human approved final delivery                                  |
| `pr-review`       | The reviewed pull request has merged or closed                   |
| `pr-merge`        | The pull request is verified merged; a human merges it           |
| `pr-auto-merge`   | The squad allows auto-merge, and the merge is verified           |
| `direct-merge`    | The squad allows it, and the commit is in the remote base branch |

A passing review or green CI is not a merge. A stream that waits on another
stream's pull request shows a delivery hold until that dependency merges.

**Waits are typed, and each has its own resolver.**

| Wait           | What it means                                                   | How it resolves                                                                                        |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| question       | An agent called `ask_human`                                     | `ficus aq answer <questionId> "<answer>"`; the answer is input, not approval                           |
| human approval | A flow gate for a person                                        | The decision controls in the web app; the chosen outcome routes the flow, and a send-back needs a note |
| typed input    | A requested file, configuration value or owner decision         | `ficus ws resolve-input <id> <waitId>` with the matching action and `expectedVersion`                  |
| dependency     | Waiting on another stream (`done`, or `ready` for stacked code) | The system clears it                                                                                   |
| manual         | A prose hold opened by a person or manager                      | `ficus ws unblock <id> -m "<what changed and what to do now>"`                                         |

A resolution note is the resumed agent's next instruction, so state what changed,
what to do now, and any new constraint.

**Other controls.** `ficus ws pause <id>` stops work until `ficus ws resume <id>`.
`ficus ws park <id>` releases the stream's slot for higher-priority work and is
never needed for a waiting stream. `ficus ws cancel <id>` stops it, and
`ficus ws reopen <id>` starts a new pass at the flow entry. A flow that reaches
its attempt limit pauses until someone runs `ficus ws raise-limit <id>`.
`ficus ws track <id> --url <issue-or-pr-url>` follows another issue or pull
request (`--delivery` makes a pull request part of delivery), and
`ficus ws watch <id>` subscribes you to updates.

Every new work stream runs a flow. The older lifecycle commands
(`request-review`, `approve`, `send-back`, `handoff`, `done`, `add-agent`) apply
only to streams created before flows, and the server refuses them on flow
streams; use the flow, waits and finish above.

**Statuses.** Stored statuses are `queued | active → done | canceled`. `queued`
means not admitted yet: the squad's concurrency cap is full, a dependency is
unmet, or a wait is open. The display state is derived: `in progress`,
`in review` (a human gate), `waiting on answer`, `waiting on <dependency>`,
`blocked` (a manual wait: read its message, which names the resume condition), or
`idle` (active with no execution and no wait, the one alarming state). Useful
JSON fields: `status`, `derivedState`, `openWaits[]` (id, type, message),
`priority` versus the effective priority in listings, `dependsOn`, and `metadata`
(`set-meta` takes dot paths).

**Priority and concurrency.** Priority is `critical | high | normal | low`
(default `normal`; `ws update --priority`). A stream inherits the highest
priority of any open stream that depends on it. The squad cap
(`ficus squad update --max-concurrent-streams N|unlimited`) bounds how many
streams hold a slot; admission is by effective priority, then age, with no
preemption. An active stream whose wait is older than the squad grace
(`ficus squad update --blocked-grace-minutes N`, default 30) is parked
automatically. Parking is never lossy, and `in review — parked` or
`waiting on <dependency>` is the system working, not a stall: resolve the wait.

## The squad manager — direct, don't micromanage

- The manager agent owns orchestration: assignment, sequencing, quality
  gates, steering messages to agents. Operate THROUGH it, not around it.
- All communication is the inbox: `ficus inbox send <recipientId> "<msg>"` —
  address the squad's manager agent directly.
- When you believe streams are stalled: **ask the manager for execution
  state before concluding anything.** Idle agents + a stale `updatedAt` is
  what deliberate queueing looks like from the outside; managers sequence
  work on purpose. Only flag when the manager confirms the active stream has
  no execution running.
- Findings/feature requests for the squad: send the manager a message with
  BINDING requirements (exact behaviors, failure semantics, test
  expectations) — managers open well-scoped streams from precise specs and
  flounder on vague ones.
- Agents move work through the flow themselves (`ficus ws advance`), and the
  runtime starts the next step. Do not hand work between agents by message or
  reassignment; if the process is wrong, have the manager revise the flow.

### Message delivery: steer vs follow-up

`ficus inbox send` has two delivery modes, and choosing wrong has real
consequences:

- `--steer` (the default) **interrupts the recipient immediately**, mid-turn.
- `--follow-up` queues until the recipient's **whole turn ends** (the agent
  goes idle) — not merely its current step. An agent mid-implementation
  will finish EVERYTHING it is doing before a follow-up is delivered.

Use steer for anything that must shape in-flight work — a spec change, a
stop-what-you're-doing, a correction to instructions the agent is actively
executing. Use follow-up only for messages that can safely wait until the
agent is completely done (post-completion feedback, next-task context).
Sending a mid-build spec change as a follow-up means the agent builds the
whole thing to the old spec first.

## Your inbox, agent questions, and the Action Center

You have an inbox too — check it when supervising:

```bash
ficus inbox list                     # your unread messages (agents report here)
ficus inbox read <messageIds...>     # mark read; read-all to clear
ficus inbox count                    # quick unread check
ficus inbox download <attachmentId> --out <path>
ficus action list                    # pending actions requiring human/operator attention
```

Agents that hit a decision they can't make **ask an async question and keep
working** (their status shows `waiting-input` when truly halted). These
surface in the Action Center and via:

```bash
ficus aq list <agentId>              # an agent's open questions
ficus aq answer <id> "<answer>"      # delivered to the agent, which wakes it
```

Answer questions promptly and decisively — a precise answer with the
constraint spelled out beats a fast vague one; the agent resumes with your
text as its instruction. If an agent seems stuck in `waiting-input`, check
`ficus aq list` before nudging it through the manager.

## The Assistant — a user's personal agent

The **Assistant** is the chat panel a user opens from anywhere in the web
app, and the same conversation is used for voice. Each saved conversation is
backed by one owner-private agent of type `assistant`. It is just an agent,
so every `ficus agent` command works on it. It runs on the fast model tier
with in-process tools (read work, the Needs-you list, activity, search,
navigate) and has **no sandbox and no CLI**. Its authority is its owner's
current permissions.

Anything its quick tools can't see, it **delegates** as a tracked task:

- **General worker** (type `assistant-worker`): the Assistant's _main
  delegate_. It has the owner's permissions, a sandbox, and the full `ficus`
  CLI. Instance-wide work belongs here: users, roles and access, secrets,
  settings, integrations, and anything spanning squads, even when a squad is
  named.
- **Squad consultant**: only for work that needs one squad's expertise,
  code, or workspace. Consultants are squad-scoped and can't read accounts or
  roles.

A task is a tracking record, not a work stream. The delegate reports
`working | waiting | needs-input | completed | failed | cancelled`, and each
report wakes the Assistant to summarize it. `continue_task` keeps a task on
the same delegate; moving it means cancel and delegate again. Details:
`docs/wiki/assistant-tasks.md`.

```bash
ficus search "<words from the question>" --kind assistant_conversation   # owner's own conversations, with each one's agentId
ficus agent list -t assistant          # Assistant agents, newest activity first
ficus agent list -t assistant-worker   # the general workers they delegate to
ficus agent messages <agentId>         # the whole conversation, incl. delegate updates
ficus agent worker-log <agentId>       # its tool calls (delegate_task, continue_task, …)
ficus chat -a <assistantAgentId> "<message>"   # say something in that conversation
```

A conversation id is not an agent id: take `agentId` from the search result
for the `agent` commands. Bare `ficus chat "<msg>"` talks to your own
system-manager chat, **not** a saved Assistant conversation.

**If you are the delegate**, the request names a task ID and a request ID.
Report on exactly that request, and never on a newer one to cover old work:

```bash
ficus assistant-task status <taskId> --request-id <requestId> --status completed -m "<result>"
ficus assistant-task get <taskId>
```

**Reviewing an Assistant conversation** (when you maintain Ficus) is usually
instruction work. For
each wrong turn (asked instead of acting, delegated to a squad instead of the
general worker, claimed something it didn't do), find the prompt or tool
description that caused it: `config/agent-types/assistant.yaml`,
`config/agent-types/assistant-worker.yaml`, and the tool descriptions in
`apps/core/src/tools/assistant.ts`. Fix that first. Missing capabilities are
a separate item.

## Operating doctrine (learned the hard way)

1. **Precise wait messages are gold.** When asking a squad to do risky
   work, require them to block with wait messages that name the exact resume
   condition, and write your own `unblock`, `aq answer` and gate decision
   notes the same way.
2. **Don't infer stalls from timestamps** (see manager section). Real
   incidents have come from misreading deliberate sequencing as death.
3. **Infrastructure-shaped failures deserve an infrastructure check first.**
   If agents report sandbox-unavailable, socket-closed, or
   timeout-with-no-output errors, ask the manager about machine health
   before blaming the code.
4. **Push-before-risky:** before instance restarts or upgrades, have agents
   push their branches; recovery machinery restores boxes, not uncommitted
   scratch work.
5. **State teardown ownership for every resource you hand a squad** — who
   deletes it, when — or it will linger forever.
6. **Editing a work stream's description notifies nobody.** Amending a
   spec after agents picked the stream up silently changes the source of
   truth out from under them — always `--steer` the assignee with a summary
   of what changed and a pointer to re-read the description.
7. **Ownership notices fire only at creation.** An ownerless stream routes
   to the squad manager automatically on current versions (older cores left
   it silently unowned — pass `--owner` explicitly if unsure), but setting
   the owner later via `ws update --owner` sends no notice: message the new
   owner yourself or the stream sits invisible.
