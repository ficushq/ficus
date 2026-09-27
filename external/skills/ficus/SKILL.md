---
name: ficus
description: Operate a Ficus instance as a manager/operator — CLI auth, the work-stream lifecycle, squad-manager coordination, answering agent questions, and the operating doctrine that avoids known failure modes. Use whenever supervising Ficus squads, unblocking/reviewing work streams, or directing work on a Ficus deployment via the `ficus` CLI.
---

# Operating Ficus (the `ficus` CLI)

## What Ficus is

A Ficus instance runs **squads** of AI agents (typical crew: architect,
engineer, reviewer, coordinated by a squad **manager** agent). Work is
organized into **work streams** — durable units with a lifecycle, a
priority, an assignee, a dedicated agent crew, and a git branch. You direct
at the work-stream level and communicate through the manager; the manager
orchestrates the agents.

Everything below uses the `ficus` CLI. Global flags: `--json` for
machine-readable output (parse this, not the human tables; add
`--no-truncate` when grepping table output), `--backend <label>` to select a
stored auth backend for one command.

## Installing the CLI (if `ficus` is missing)

```bash
curl -fsSL https://ficus.sh/cli/install.sh | bash
export PATH="$HOME/.tau/bin:$PATH"   # add to the shell profile too
ficus --version                      # verify
```

The installer writes the binary to `~/.tau/bin/ficus` and bundled assets to
`~/.tau/share`. Upgrade or reinstall later with `ficus install`. If `ficus` is
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

```bash
ficus ws list -q <squadId> [--json]  # outside a squad box, the squad flag is required
ficus ws get <id> [--json]           # shows the crew and each agent's live status
ficus ws create "<title>" -q <squadId> -d "<description>" \
    --agents architect,engineer,reviewer --assign-index 1 \
    --branch <branch> --base-branch main \
    [--priority <p>] [--depends-on <id>] -m "<kickoff message>"
ficus ws request-review <id> -m "<what to review>" [--no-complete]
                                     # open the review wait; approval completes the
                                     # stream by default. --no-complete = mid-work
                                     # checkpoint gate: approval resolves the gate
                                     # only and work continues
ficus ws approve <id> [-m "<note>"]  # close the open review wait; completes the
                                     # stream unless the wait was --no-complete.
                                     # The note is recorded on the wait and
                                     # DELIVERED (durable home for follow-ups)
ficus ws send-back <id> -m "<fb>"    # close the review wait with feedback (a
                                     # review round); never completes anything —
                                     # always safe
ficus ws request-input <id> -m "<why>" # open a manual wait: the stream needs an
                                     # answer/action from the owner or operator
ficus ws unblock <id> -m "<answer>"  # resolve the manual wait; the note is
                                     # delivered to the assignee as its next
                                     # instruction
ficus ws handoff <id> --to <agentId> -m "<context>" [-f <file>]...
                                     # reassignment ONLY (bound-agent phase
                                     # transitions). It never opens a review
                                     # wait — that's request-review
ficus ws park <id>                   # intentional preemption ONLY: release the
                                     # slot for higher-priority work. Never park
                                     # a waiting stream — open waits already
                                     # exclude it from scheduling
ficus ws done <id>                   # complete directly — REJECTED while any
                                     # wait is open (except via approve on the
                                     # final review wait)
ficus ws reopen <id>                 # take a done/canceled stream back through
                                     # admission (queued/active)
ficus ws cancel <id>                 # cancel + stop assigned executions
ficus ws add-agent <id> <types...>   # spawn+bind extra agents; remove-agent to unbind
ficus ws watch <id>                  # subscribe to lifecycle updates
```

Stored statuses are just `queued | active → done | canceled`. `queued` means
not admitted under the squad's concurrency cap (or parked back into the
queue) — visible, ordered, and auto-admitted when a slot frees, its
dependencies are done, AND it has no open wait. Everything richer is a typed
OPEN WAIT record (`dependency | question | review | manual`) plus a DERIVED
display: `in progress` (live execution), `in review`, `waiting on answer`,
`waiting on <dep>`, `blocked`, or `idle` (active with no execution and no
wait — the one alarming state).

When more than one wait of a type is open, the sugar verbs require
`--wait <waitId>` — `ficus ws get <id>` prints each open wait's id (checkpoint
review waits are marked). JSON fields worth knowing: `status` +
`derivedState`, `openWaits[]` (id, type, message, completesOnApproval,
openedAt — why it's waiting; often a precise statement of the resume
condition), `reviewRounds` (closed review waits) on detail,
`priority` (stored) vs the computed effective priority shown in listings,
`handoffMessage` (the assignee's latest substantive report), `dependsOn`,
`assigneeAgentId`, `metadata` (free-form; `set-meta` supports dot paths).

**Priority & concurrency.** Streams carry a priority (`critical | high |
normal | low`, default `normal`; set at creation or `ws update --priority`).
Effective priority is computed with **blocker boosting**: a stream inherits
the max priority of every open stream that depends on it, so a low-priority
flake fix blocking a high-priority feature schedules as high (`ws list`
annotates when stored and effective differ). `dependsOn` writes reject
cycles. The squad-level cap (`ficus squad update --max-concurrent-streams
N|unlimited`) bounds how many streams may hold a slot (= have runnable
sandboxes) at once; creation under a full cap lands in `queued` with the
crew bound but boxes stopped — only sandboxes consume resources, agent rows
are free. Admission order is effective priority, then age. There is NO
preemption — a critical arrival goes to the queue head and the manager
decides whether to `park` something to make room. Parking is never lossy:
files stay in place and the stream re-enters the queue at its effective
priority. AUTO-PARK: an active stream with an open wait older than the squad
grace (`ficus squad update --blocked-grace-minutes N`, default 30, 0 =
immediate) is parked automatically — no exemptions, review waits included. A
parked-with-wait display (`in review — parked`, `waiting on <dep>`) is the
system working, not a stall: do NOT "fix" it; resolve the wait.

**Reading blocked correctly:** a `blocked` display means _waiting on
something named in the open manual wait's message_ — operator input, a
resource grant, or a deliberate hold. It does NOT mean stalled or broken.
Read the wait message; it usually tells you exactly whether you're the
unblocker.

**Every wait resolves through its typed verb** — `unblock` for manual
waits, `approve`/`send-back` for review waits (there is no generic
`respond`). A good resolution note states: what changed, what the stream
should do now, and any new constraints — the resumed agent reads it as its
next instruction, and notes ride the wait record, so they are never lost.
Blocking questions (`ask_human` with `blocking: true`) open a question wait
that the answer (`ficus aq answer`) clears automatically. This is THE path for
"an agent needs a human decision to continue": the worker asks, the stream
shows `waiting on answer`, you answer once, and the worker resumes with your
answer as its next instruction. A manual wait whose message is a question, or
an inbox message asking you to decide something, is the wrong shape — answer
it, then tell the manager the worker should have asked a blocking `ask_human`.
Managers never block on a question: they ask asynchronously and keep
coordinating.

**PR streams: the completing review wait is a MERGE gate, not an LGTM.**
Approving a review wait with `completesOnApproval` (the default) completes
the stream in the same transaction — so for a stream whose deliverable is a
PR, the final review wait must represent "the PR is merged", and whoever
resolves it must check the wait's stated condition is actually met before
approving. The working convention: the bound reviewer creates the PR, gets
it reviewed on GitHub, and opens the completing review wait only at (or
explicitly gated on) the merge; GitHub webhook events tell the reviewer the
PR merged, and the reviewer resolves the wait — closing the stream —
themselves. Pre-merge quality gates are `request-review --no-complete`
checkpoints. As an operator: reply to PR feedback on GitHub; touch the
stream's completing wait only when its condition holds (send-back is always
safe). Approving an "awaiting CI/merge" wait early completes the stream
under the reviewer and forces a reopen — the exact churn this rule exists
to prevent.

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
- Handoffs carry the phase chain: workers hand off to the next bound agent
  with `ficus ws handoff <id> --to <agentId> -m "<context>"` (and `-f` file
  attachments reviewable in the UI). Opening a verdict review wait is a
  separate act (`request-review`) — never a handoff side effect.

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
ficus inbox download <attachmentId> -o <path>
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

## Operating doctrine (learned the hard way)

1. **Precise wait messages are gold.** When asking a squad to do risky
   work, require them to block with wait messages that name the exact resume
   condition — and write your own `unblock`/`approve` and `aq answer`
   messages the same way.
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
