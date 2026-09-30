# Work Stream CLI Commands

The `ficus workstream` (or `ficus ws`) command provides functionality for managing work streams - units of work that can be assigned to agents within squads.

## Workflows

New work can use a squad default, `--workflow PRESET_ID`, or `--flow-content '<JSON source>'` / `--flow-stdin` (or optional `--flow` for saved files) for a saved/customized or inline source. Flow participants are created lazily. Read [Workflows, flows, and squads](../workflows.md) for authoring, parallel joins, scoped waits, pause/resume, and delivery policies. Use `ficus workstream flow/advance/finish` for flow-controlled handoffs and completion; the legacy direct assignment commands below apply to non-flow streams.

### Inspect and advance an active flow

```bash
ficus workstream flow STREAM_ID
ficus workstream advance STREAM_ID --content '{"expectedVersion":1,"attemptId":1,"action":"complete","outcome":"completed","evidence":"Tests passed"}' --request-id REQUEST_UUID
ficus workstream finish STREAM_ID --version CURRENT_VERSION
```

`flow` returns the stream's current steps, attempts, incoming handoff sources,
evidence, return requests, and version. `advance` submits an outcome or an
authorized return, delegation, or revision. `finish` checks the completion policy
once the graph is complete. All three take a **work stream ID**; `ficus ws` is an
alias for `ficus workstream`. `ficus workflow` manages reusable presets/templates.

When a transition immediately assigns work to the calling agent, its response
includes `assignments` with the attempt ID, version, and full handoff content.
Continue that assignment directly; no duplicate inbox notification is sent.
The handoff is recorded on the attempt and returned on retries of the same request
ID. Other agents, fresh sessions, and assignments deferred by waits or capacity
still receive inbox notifications when they can run.

### Rework after delivery becomes ready

CI failures, requested changes, or merge conflicts can arrive after the graph reaches
`completion-ready`. Verify that the feedback still applies to the current PR head,
then read `ficus workstream flow STREAM_ID` and submit:

```bash
ficus workstream advance STREAM_ID --stdin --request-id REQUEST_UUID <<'FICUS_COMMAND'
{
  "action": "rework",
  "expectedVersion": 4,
  "attemptId": 3,
  "feedback": "Current CI failure and the correction required"
}
FICUS_COMMAND
```

Use the current version and the latest completed attempt ID for `completion.changeEventsTo.step`
when configured, otherwise the last completed **agent** attempt. Use single-quoted
`--content` JSON for short payloads, or the quoted heredoc above for longer JSON/YAML.
Saved commands can still use `--file`; no temporary file is required.
The delivery participant or a flow manager may request rework. While final delivery
approval is open, a person who may approve delivery (`workstreams:respond` or
`workstreams:update`) may also send it back this way; the web app's **Send back** does this. It creates a tracked
attempt at that delivery step; normal outcomes can return corrections to an engineer
and repeat review. A terminal parallel branch restarts its outer fork to preserve
sibling checks and joins. History, evidence, and attempt limits remain intact.

Final delivery approval is sent back when rework starts and must be requested again.
An explicit human-approval step, manual pause, question, or unrelated wait is not
bypassed. Code-host notifications are retained behind unrelated waits and pauses,
then retried after resolution/resume; final delivery review itself does not block
CI/review feedback. For parked work, the owner receives the event and can request rework;
execution waits for normal capacity admission. There is no need to add a manual wait for native CI or PR-merge
delivery. Reuse the request ID when retrying a command; do not recreate the stream.

## Repository setup

For code-changing work, `--repository` prepares a worktree in the squad's runtime
before any workflow participant starts and attaches `metadata.git` and detected
`metadata.codeHost` together with the work stream.

```bash
ficus workstream create 'Fix configuration loading' --squad <squad-id> \
  --repository llmctl --base-branch main --workflow reviewed-coding
```

The repository must already be cloned inside the squad workspace. Paths are in
that workspace, including on remote/container runtimes. Defaults are branch
`work/<stream-id>`, path `worktrees/<stream-id>`, and remote `origin`.
`--branch`, `--worktree`, and `--git-remote` override these defaults. Missing worktree
parent directories are created inside the squad workspace. A path nested inside the
repository must be Git-ignored to keep its contents out of commits. The base is taken from the
selected remote's local default-branch ref; supply `--base-branch` if unknown.
Setup uses existing local refs and does not fetch or clone.

GitHub HTTPS and SSH remotes are detected automatically. This records repository
identity; authentication still uses the squad-authorized integration connection.
It does not connect an account, grant permissions, create a PR, or fall back to
personal credentials. Existing matching code-host metadata and account selection
are preserved; conflicting identities are rejected. Unsupported hosts need an
explicit supported adapter binding. `--from-url` is a source citation and does not
select a repository.

The same options work with `workstream update` for queued or paused streams whose
agents have never started. Setup never resets an existing branch or switches an
existing checkout. Reusing an existing worktree requires the matching repository,
path and branch. Prepared worktrees are retained if a later database operation
fails; they are never force-deleted. Git fields without `--repository` retain
their existing metadata-only behavior.

API create/update bodies accept `repository`, `gitRemote`, `worktree`, `branch`,
and `baseBranch` with the same behavior. No schema migration is required.

## Overview

```bash
ficus workstream|ws [command] [options]
```

## Commands

### list

List work streams with optional filters.

```bash
ficus workstream list [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-q, --squad <squadId>` | Filter by squad ID |
| `-t, --task <taskId>` | Filter by task ID |
| `-s, --status <status>` | Filter by status |

**Examples:**

```bash
# List all work streams
ficus workstream list

# List work streams for a specific squad
ficus workstream list --squad abc123

# List work streams for a task
ficus ws list --task task-456

# List only blocked work streams
ficus ws list --status blocked
```

---

### create

Create a new work stream using an explicit workflow or the squad default. Every new stream has a flow; legacy manual staffing flags are rejected.

```bash
ficus workstream create|new [options] <title>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `title` | Title of the work stream |

**Options:**
| Option | Description |
|--------|-------------|
| `-q, --squad <squadId>` | Squad ID to associate with |
| `-t, --task <taskId>` | Associated task ID |
| `-d, --description <desc>` | Description of the work stream |
| `--workflow <id>` | Saved workflow preset |
| `--flow-content <text>` | Inline JSON/YAML workflow source or definition |
| `--flow-stdin` | Read the source/definition from a pipe or quoted heredoc |
| `--flow <file>` | Read a saved JSON/YAML workflow source or definition |
| `-m, --message <msg>` | Handoff message (included in assignment notifications) |
| `--depends-on <wsId>` | Dependency work stream ID (can be repeated) |
| `--from-event <eventId>` | Create idempotently from an integration event's issue/PR; a replayed event returns the existing stream (`reusedFromEvent: true`) instead of a duplicate |

**Examples:**

```bash
# Create a basic work stream
ficus workstream create "Implement user authentication"

# Create with full details
ficus workstream create "Build login API" \
  --squad squad-123 \
  --task task-456 \
  --description "Implement JWT-based authentication endpoints"

# Choose an explicit flow; workers start only when their steps are reached
ficus workstream create "Build feature X" \
  --squad squad-123 --workflow planned-coding \
  -m "Start with high-level design"

# Customize a preset for this task without a temporary file
ficus workstream create "Fix bug Y" --squad squad-123 --flow-content '{"kind":"preset","id":"solo-coding","customizations":[{"op":"set-name","name":"Fix bug Y"}]}'

# Create with dependencies
ficus workstream create "Integration tests" \
  --depends-on ws-api \
  --depends-on ws-database

# Create idempotently from an integration event (e.g. an issue-assignment
# notification carrying "Event reference: <id>"); replays reuse the stream
ficus workstream create "Fix reported bug" --squad squad-123 --from-event b2b7c1d0-...
```

---

### get

Get detailed information about a work stream.

```bash
ficus workstream get|info <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID |

**Examples:**

```bash
# Get work stream details
ficus workstream get ws-123

# Using alias
ficus ws info ws-123
```

When the stream tracks any issue or pull request, `get` prints a `Tracked:`
section listing each one as `[kind] reference (label)`, where `reference` is
`owner/repo#12` for GitHub or `KEY-123` for Linear, and `label` is
`delivery PR` for the primary `codeHost.changeRequest`, `delivery` for a
tracked pull request flagged `--delivery`, or `tracked` otherwise, followed by
the observed merge state when one exists (e.g. `(delivery, merged)`). Merge
state only ever appears for pull requests — Linear has none.

---

### update

Update an existing work stream.

```bash
ficus workstream update|edit [options] <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID to update |

**Options:**
| Option | Description |
|--------|-------------|
| `-s, --status <status>` | New status |
| `--depends-on <wsId>` | Replace dependencies with these work stream IDs (can be repeated) |
| `--clear-dependencies` / `--remove-dependency` | Clear all dependencies (removes every dependency; cannot be combined with `--depends-on`) |
| `--title <title>` | New title |
| `--description <desc>` | New description |
| `--assign <agentId>` | Assign to a specific agent |
| `--unassign` | Remove current assignee |

**Examples:**

```bash
# Update title
ficus workstream update ws-123 --title "Updated title"

# Assign to an agent
ficus ws update ws-123 --assign agent-456

# Unassign current agent
ficus ws update ws-123 --unassign

# Replace the dependency list
ficus ws update ws-123 --depends-on ws-api --depends-on ws-database

# Clear all dependencies (both spellings are equivalent)
ficus ws update ws-123 --clear-dependencies
ficus ws update ws-123 --remove-dependency

# Multiple updates
ficus ws update ws-123 --title "New title" --description "Updated description"
```

---

### request-input

Open a manual wait: the work stream cannot proceed until the named actor acts.

```bash
ficus workstream request-input [options] <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID |

**Options:**
| Option | Description |
|--------|-------------|
| `-m, --message <msg>` | What input/action is needed, and from whom (required; the wait message) |
| `--actor <actor>` | Who must act: `human` (default) or `owner` |
| `-f, --file <path>` | File to include for context (can be repeated) |

**Examples:**

```bash
ficus workstream request-input ws-123 -m "Need the API key for X"
ficus workstream request-input ws-123 --actor owner -m "Hold launch until #353 passes review and the owner updates the launch source"
ficus workstream request-input ws-123 --actor owner -m "Waiting for the provider to restore the sandbox quota"
```

The actor decides who is asked to act, never whether the stream is blocked:

| Actor | Who must act | Presented as | Needs you / human notices |
|-------|--------------|--------------|---------------------------|
| `human` | The user/operator | Blocked | Yes (Action Center, push, watchers) |
| `owner` | The stream's owner agent (squad manager if none) | Waiting on Owner | No; the owner agent is woken |

Questions for a human use `ask_human`; waiting on another work stream's deliverable uses a `dependsOn` dependency, not a manual wait. Provider or third-party events use `owner`, with the message saying what the wait is for. Older servers ignore `--actor` and open a human wait.

For flow agents, this defaults to their active attempt. `--scope stream` blocks the whole stream; `--scope attempt --attempt ID` selects an active attempt explicitly. Human/operator requests default to the whole stream. Sibling attempts may continue while one is waiting.

The request is resolved with `unblock`; the resolution note goes to the current attempt that requested it, or to the legacy assignee for non-flow streams. A resolution is input, not step approval.

---

### wait-actor

Correct who must act on an open manual wait. The wait stays open and keeps blocking; nothing is closed, reopened or re-dispatched.

```bash
ficus workstream wait-actor [options] <id> <actor>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--wait <waitId>` | Manual wait to relabel (required when several manual waits are open) |
| `-m, --message <note>` | Why the actor changed |

```bash
ficus workstream wait-actor ws-123 owner --wait 1a2b3c4d -m "Held for the owner, not the user"
```

Only users with `workstreams:update` on the squad, the stream's owner agent or the squad manager may relabel; assigned workers cannot. Workflow-owned approval waits are not relabelable. Every change is appended to the wait's `actorChanges` audit trail (from, to, who, when, note). Relabeling to `human` sends the normal blocked notice.

---

### unblock

Resolve the work stream's open input request (manual wait).

```bash
ficus workstream unblock [options] <id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `-m, --message <note>` | Resolution note recorded on the cleared wait and delivered to the assignee |
| `--wait <waitId>` | Wait ID to clear (required when several manual waits are open) |

**Examples:**

```bash
ficus workstream unblock ws-123 -m "API key added to the squad secrets as X_API_KEY"
```

When more than one manual wait is open, `unblock` refuses to guess — list the
waits with `ficus workstream get ws-123` and pass `--wait <waitId>`. If `--wait`
names a wait that is already closed (for example the system cleared it when
the assignee's execution started), the command fails with a non-zero exit and
names that wait, its recorded resolution, and that the `-m` note was not
recorded — the note is never silently dropped.

---

### request-review

Open the review wait: the work is ready for someone to review. Approving the
review completes the stream by default.

```bash
ficus workstream request-review [options] <id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `-m, --message <msg>` | What to review (required; stored on the review wait) |
| `-f, --file <path>` | Artifact file to review (can be repeated) |
| `--no-complete` | Mid-work checkpoint gate: approval resolves the wait only and the stream continues |

**Examples:**

```bash
# Ready for final review — approval completes the stream
ficus workstream request-review ws-123 -m "API implementation complete, ready for review"

# Mid-work checkpoint gate — approval resolves the gate, work continues
ficus workstream request-review ws-123 -m "checkpoint: schema design" --no-complete
```

Idempotent while a review wait is already open.

---

### approve

Approve the open review wait. For a default review this completes the stream
in the same transaction; for a `--no-complete` checkpoint review it resolves
the wait only and the stream continues.

```bash
ficus workstream approve [options] <id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `-m, --message <note>` | Approval note recorded on the wait and delivered with the outcome notification (`--note` is an alias) |
| `--wait <waitId>` | Review wait ID to approve (required when several review waits are open) |

**Examples:**

```bash
ficus workstream approve ws-123

# Approval notes are the durable home for completion-time findings
ficus workstream approve ws-123 -m "Approved. Follow-ups for a future stream: tighten rate limits, add metrics"
```

---

### send-back

Close the open review wait with required feedback; the stream stays
schedulable and the closed wait counts as a review round. Alias: `reject`.

```bash
ficus workstream send-back [options] <id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `-m, --message <feedback>` | Send-back feedback (required; `--note` and `-r/--reason` are aliases) |
| `--wait <waitId>` | Review wait ID to send back (required when several review waits are open) |

**Examples:**

```bash
ficus workstream send-back ws-123 -m "Missing error handling in edge cases"
```

---

### handoff

Hand off (reassign) a work stream to another agent. Reassignment only —
opening a review is `request-review`.

```bash
ficus workstream handoff [options] <id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--to <agentId>` | Agent to hand off to (required) |
| `-m, --message <msg>` | Message explaining what was done and what's next (required) |
| `-f, --file <path>` | File to include for context (can be repeated) |

**Examples:**

```bash
ficus workstream handoff ws-123 --to agent-456 -m "Implementation complete, ready for review"
```

Message-only handoff (no `--to`) is an error — use
`ficus workstream request-review <id> -m "<msg>"` to ask for review.

---

### park

Park an admitted work stream (release its concurrency slot). Park's only
purpose is priority preemption under a full cap: free the slot of a
LOWER-priority healthy stream so a critical arrival can run. Never park a
stream because it is waiting — the scheduler's auto-park owns that.

```bash
ficus workstream park [options] <id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--preempt-running` | Discard a running turn only when genuinely abandonable; normally ask the agent to stop safely and wait for confirmation first |

---

### reopen

Reopen a done or canceled work stream: it re-enters admission (active if a
slot is free, else queued), completion is cleared, and dependency waits are
re-synced.

```bash
ficus workstream reopen <id>
```

---

### done

Mark a work stream as complete. Completing is rejected while ANY wait is open
("resolve or cancel the open waits first") — approve the review or `unblock`
the input request first.

```bash
ficus workstream done <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID to mark as done |

**Examples:**

```bash
ficus workstream done ws-123

# Rejected while a wait is open:
#   Error: Cannot mark this work stream done — resolve or cancel the open waits first (review:wait-abc)
# Fix: resolve the wait, then complete
ficus workstream approve ws-123        # a completing review approval also marks the stream done
```

---

### delete

Delete a work stream.

```bash
ficus workstream delete|rm <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID to delete |

**Examples:**

```bash
# Delete a work stream
ficus workstream delete ws-123

# Using alias
ficus ws rm ws-123
```

---

### tracked

List the issues and pull requests a work stream tracks, alongside its delivery PR.

```bash
ficus workstream tracked <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID |

**Aliases:** `links`

**Examples:**

```bash
ficus workstream tracked ws-123

# Table columns: Kind | Resource | Source | Delivery | Merge | Subscribed | URL
# Resource is owner/repo#12 for GitHub, KEY-123 for a Linear issue
# Source is one of: delivery, tracked
# Delivery is "primary" for the codeHost PR, "yes" for a tracked PR flagged
# --delivery, otherwise "-"; Merge shows the observed merge state (open,
# merged, closed) or "-" for anything without one, including every Linear
# issue (Linear has no pull requests)
# Followed by a "Subscriptions: active|no-flow|not-following|ended" footer,
# then a "Delivery: m/n pull requests merged" line when the stream has at
# least one delivery pull request, suffixed with " (complete)" once every one
# of them is merged
```

---

### track

Track an issue or pull request alongside a work stream's delivery. Identity
resolves atomically and is authorized against the squad's own integration
connection; it never grants access from the link itself.

```bash
ficus workstream track <id> [options]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID |

**Options (choose exactly one of `--event`, `--url`, `--issue`, `--pr`):**
| Option | Description |
|--------|-------------|
| `--event <eventId>` | Track the resource observed by an integration event |
| `--url <url>` | Track by code-host resource URL |
| `--issue <ref>` | Track a GitHub issue (`owner/repo#12`) or a Linear issue (`KEY-123`) |
| `--pr <ref>` | Track a GitHub pull request, e.g. `owner/repo#12` |
| `--connection <connectionId>` | Integration connection ID (`--issue`/`--pr` only) |
| `--delivery` | Count this pull request toward the work stream's delivery (only with `--url`/`--pr`) |

**Examples:**

```bash
# From the event an integration notification referenced
ficus workstream track ws-123 --event b2b7c1d0-...

# By explicit reference
ficus workstream track ws-123 --issue owner/repo#12
ficus workstream track ws-123 --issue KEY-123
ficus workstream track ws-123 --pr owner/repo#34 --connection conn-abc

# By resource URL
ficus workstream track ws-123 --url https://github.com/owner/repo/pull/34
ficus workstream track ws-123 --url https://linear.app/workspace/issue/KEY-123/slug

# Flag an additional pull request as a delivery change request: it must also
# be merged before the stream can finish
ficus workstream track ws-123 --pr owner/repo#35 --delivery
ficus workstream track ws-123 --url https://github.com/owner/repo/pull/35 --delivery
```

Tracking a PR this way never changes the work stream's primary delivery PR
(`metadata.codeHost.changeRequest`); it adds a followed resource without
affecting `pr-merge`/`pr-auto-merge` completion, unless `--delivery` flags it,
in which case `ficus workstream finish` additionally requires it to be merged.
`--delivery` combined with `--issue` or `--event` is rejected — an issue is
never a delivery change request, and an event's resource kind isn't known
until the server resolves it. Likewise, `--connection` combined with `--url`
or `--event` is rejected with `--connection applies to --issue and --pr
only` — it only ever applied to a resolved `--issue`/`--pr` reference, so
silently dropping it there would let a mistyped combination look like it
took effect. Linear has no pull requests: `--pr KEY-123` and `--delivery`
against a Linear reference or URL are both rejected with an error, and
`--issue KEY-123` resolves the issue live through the squad's Linear
connection (`409` if that connection needs revalidation, `404` if the issue
is unreadable or unknown).

---

### untrack

Stop tracking an issue or pull request on a work stream.

```bash
ficus workstream untrack <id> [options]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Work stream ID |

**Options (choose exactly one of `--url`, `--issue`, `--pr`):**
| Option | Description |
|--------|-------------|
| `--url <url>` | Untrack by code-host resource URL |
| `--issue <ref>` | Untrack a GitHub issue (`owner/repo#12`) or a Linear issue (`KEY-123`) |
| `--pr <ref>` | Untrack a GitHub pull request, e.g. `owner/repo#12` |
| `--connection <connectionId>` | Integration connection ID (`--issue`/`--pr` only) |

**Examples:**

```bash
ficus workstream untrack ws-123 --issue owner/repo#12
ficus workstream untrack ws-123 --issue KEY-123
```

Untracking the delivery PR is rejected — edit `metadata.codeHost.changeRequest`
instead of untracking it.

---

## Attention (watch)

A work stream inherits its squad's attention levels until you set its own. `decisions` covers its reviews and blockers; `progress` covers its presence in the feed and its completion notice. Levels are `mute`, `show`, or `notify`.

```bash
ficus workstream subscription STREAM_ID            # levels + whether they are inherited
ficus workstream watch STREAM_ID                   # both kinds at notify (alias of subscribe)
ficus workstream watch STREAM_ID --progress mute   # reviews still reach you, completions do not
ficus workstream unwatch STREAM_ID                 # drop the row; inherit the squad again
```

An omitted flag keeps the kind at its current EFFECTIVE level — the level stored on this stream's own row, otherwise the level inherited from the squad, otherwise the default `show`. Changing one kind never turns the other one up, so setting one flag on an inheriting stream writes a row that preserves what the other kind already did.

## Work Stream Statuses

Stored statuses are deliberately small:

| Status     | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `queued`   | Not admitted under the squad concurrency cap (or parked); no slot |
| `active`   | Admitted; holds a concurrency slot                                |
| `done`     | Work stream is complete                                           |
| `canceled` | Work stream was canceled                                          |

Everything richer is a typed OPEN WAIT record plus a derived display state
(`ws list`/`ws get` show it): `in_progress` (live execution), `in_review`,
`waiting_on_answer`, `waiting_on_dependency`, `blocked` (open manual wait),
and `idle` (active with no execution and no wait — the alarming one). Legacy
status filters (`pending`, `in_progress`, `blocked`, `review`) still map for
one release with a deprecation note.

## Common Workflows

### Basic Task Execution Flow

```bash
# 1. Create work stream for a task
ficus ws create "Implement feature X" --squad squad-123 --task task-456

# 2. Agent picks up and works on it
# (the derived state shows in_progress while an execution runs)

# 3. If stuck, agent requests input (opens a manual wait)
ficus ws request-input ws-123 -m "Need API credentials"

# 4. Manager resolves the input request (note delivered to the assignee)
ficus ws unblock ws-123 -m "API key: abc123xyz"

# 5. Agent completes and requests review
ficus ws request-review ws-123 -m "Implementation complete"

# 6. Manager approves — completes the stream in one transaction
ficus ws approve ws-123 -m "Approved. Follow-ups for a future stream: add rate-limit metrics"
```

### Managing metadata

```bash
ficus workstream set-meta <id> ledger.current.sequence 7
ficus workstream get-meta <id> ledger.current.sequence
ficus workstream unset-meta <id> ledger.current.sequence
```

`set-meta` and `unset-meta` send only the requested dot-path delta. The server recursively merges objects, deletes keys set to `null`, and serializes concurrent updates so unrelated keys are preserved. Arrays replace the whole array; changing one element requires `get-meta`, local modification, and `set-meta` of the entire array key. Concurrent writers to the same key are last-serialized-writer-wins. Empty path segments and `__proto__`, `prototype`, or `constructor` segments are rejected. `get-meta` uses one entity GET, extracts the value client-side, and reports missing paths as errors.

`set-meta <id> tracked '[...]'` is schema-validated shape-for-shape against the
[canonical tracked-resource entry](../work-streams.md#tracked-issues-and-pull-requests),
and any newly introduced entry is authorized exactly like `ficus workstream track`.
`origin` is server-managed — a hand-written `origin` on a new entry is rejected
with `400`. Prefer `ficus workstream track`/`untrack`, which resolve identity and
stamp `origin` for you instead of requiring the whole array to be rewritten.

### Code Review Workflow

```bash
# Engineer submits for review
ficus ws request-review ws-123 \
  -m "PR ready for review" \
  --file src/feature.js

# Reviewer approves (completes the stream) or sends back
ficus ws approve ws-123
# or
ficus ws send-back ws-123 -m "Need more test coverage"

# Mid-work gate that should NOT complete the stream on approval
ficus ws request-review ws-123 -m "checkpoint: schema design" --no-complete
```

### Managing Dependencies

```bash
# Create dependent work streams
ficus ws create "Design database schema" --squad s1
# Returns: ws-schema

ficus ws create "Implement data layer" --depends-on ws-schema --squad s1
# This work stream won't start until ws-schema is done
```

### Agent Coordination

```bash
# Manager creates work stream and spawns agent
ficus squad spawn engineer squad-123 --workstream ws-feature

# Agent hands off to the reviewer when done
ficus ws handoff ws-feature --to agent-reviewer -m "Feature complete, ready for review"
```

## Pause and resume

`ficus workstream pause ID --reason "Hold for review"` stops current/queued work and suppresses automatic continuation until `ficus workstream resume ID`. Pause retains the slot unless separately parked or auto-parked. Parking a paused stream does not resume it. See [the workflow guide](../workflows.md#pause-park-and-resume).

## Agent terminal observation

Agent observation is separate from **user** `subscribe` / `unsubscribe` and does not
change the owner, participants, access, or workflow authority. Only the authenticated
calling agent can register itself, for a stream in its own squad with read access.

```bash
ficus workstream create "Deliver result" --squad <squad-id> --observe terminal
ficus workstream observe <id>                     # defaults to terminal
ficus workstream observe <id> --events terminal
ficus workstream observation <id>                 # caller's observing state
ficus workstream unobserve <id>
```

Creation registers atomically before dispatch. Repeated registration and removal
are idempotent; owner handoff does not change an observation. `get` also reports
`observing` for agent callers. No arbitrary recipient or other event set is supported.

The registration is consumed on the first **delivered done** or **cancellation**,
not a finished step, PR, passed CI, completion-ready, pause, or transient failure.
Observing an already terminal stream returns a conflict and creates no watch or
retrospective notice. Reopening does not restore a consumed watch; register again
after reopening. Removal cannot recall a terminal notice already persisted.

Updates are informational inbox messages with the outcome, owner and available
result link/notes. They are context for reporting back, **not assignments or
management instructions**. The owner continues execution, blocker handling,
reconciliation and delivery. No polling or parallel orchestration is needed.
Observers who are also owners get the existing owner notice rather than a duplicate.
A watch expires even when its recipient is unavailable: deleted, dormant, stopped,
error-halted or access-revoked conversations are not revived. Eligible idle
conversations may report back. Inbox receipts provide deduplication and delivery
retries without blocking completion on a delivery failure.
