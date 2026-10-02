# Agents & Executions

The system uses two unified primitives for all AI work: **agents** (persistent instances) and **executions** (transient work units). These replace the previous separate systems for workflow runs, manager chats, and heartbeat runs.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     agents table                     │
│  Persistent instance — owns conversation + session   │
│  Status: live runtime states | dormant | terminated   │
│  Context: { scope } | ...                             │
└──────────────────┬───────────────────────────────────┘
                   │ 1:N
┌──────────────────▼───────────────────────────────────┐
│                  executions table                     │
│  Transient work unit — one wake-up cycle             │
│  Status: queued → running → completed/failed/...     │
│  Worker polls for queued, claims atomically          │
└──────────────────────────────────────────────────────┘
```

## Agents

An agent is a persistent instance of an agent type. It owns its identity, conversation (messages keyed by agent ID), lifecycle state, and Pi SDK session file on disk (`<HOME_DIR>/sessions/<agentId>/`). Dormant and terminated agents remain historical records; only live states may execute.

### Schema

| Column          | Type         | Description                                       |
| --------------- | ------------ | ------------------------------------------------- |
| `id`            | UUID         | Primary key                                       |
| `agent_type_id` | varchar(100) | FK → `agent_types`                                |
| `status`        | enum         | Runtime states plus `dormant` and `terminated`    |
| `context`       | JSONB        | Type-specific metadata (see below)                |
| `question_data` | JSONB        | Pending questions when `waiting-input`            |
| `session_usage` | JSONB        | Accumulated token/cost usage                      |
| `dormant_at`    | timestamp    | Audit/cutoff time for the current dormant episode |
| `terminated_at` | timestamp    | Audit time for irreversible final termination     |
| `created_at`    | timestamp    |                                                   |
| `updated_at`    | timestamp    |                                                   |

### Status States

| Status          | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `idle`          | Not executing. Waiting for next trigger.                      |
| `active`        | Currently executing (processing a message/trigger).           |
| `waiting-input` | Blocked on human input (`ask_human` tool, checkpoint review). |
| `compacting`    | Conversation is being compacted (context window management).  |
| `resetting`     | Agent session is being reset.                                 |
| `dormant`       | Stopped and recoverable. Eligible correspondence may wake it. |
| `terminated`    | Irreversibly final and read-only. New work is rejected.       |

`status` is the sole lifecycle/liveness discriminator. `dormant_at` and `terminated_at` are audit and retention timestamps, never parallel liveness flags. Code should use the shared `isLiveAgentStatus()` helper rather than infer liveness from timestamps.

### Dormancy and final termination

- **Live → dormant:** the ordinary terminate/unspawn action stops work, monitors, and personal compute; revokes tokens; makes descendants dormant; disables automatic schedules/webhooks; and retains recoverable private storage. The transition is serialized with execution admission and may wait for active work to settle. A VM stop on a temporarily non-ready machine is recorded as `stop_unverified` and leaves dormancy completion pending. The VM convergence tick either verifies the stop when that machine returns or, after a bounded outage, detaches it into an attributable, exact machine-side retirement remnant. Only a later dormancy attempt settles; wake and re-placement happen afterward. `/private` remains on the unavailable host until it returns: remnant retirement archives it under the original agent identity, and inline sole-machine retirement restores that exact recovery archive into its fresh replacement. An ordinary fresh box never restores an unrelated historical archive. If replacement preceded host recovery, the old tree is preserved in the later archive but is not silently merged into an already-running replacement.
- **Dormant → live:** explicit eligible correspondence or an explicit wake moves the agent to `idle`, rotates its resource generation, re-ensures compute, and mints a currently valid token. Housekeeping and scheduled timer ticks are non-waking. Terminated agents can never wake.
- **Dormant → terminated:** only backend retention cleanup or an explicit operator finalization performs this irreversible transition. Descendants are finalized, private data is archived, and compute/storage resources become permanently reclaimable.

Retention uses two independent settings. `AGENT_DORMANT_RETENTION_DAYS` controls how long an agent remains dormant and recoverable before final termination. `AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS` controls how long the timestamped `/private` archive remains after termination before the archive janitor purges it.

> **Lifecycle-migration upgrade behavior:** the supported forward upgrade applies the candidate migration (currently `0148_smooth_mantis`) while the old Core still serves, atomically flips the release, and then restarts services. The migration stamps `finalCleanupPending` on every historical terminated row. Worker startup and the minute-scale lifecycle convergence sweep repair late old-writer rows into canonical `terminated` state with pending final cleanup. Legacy repair, dormant retention, and final cleanup are intentionally capped at five roots/effects per minute, so that historical backlog drains gradually without creating an SSH/archive burst. Lightweight dormancy completion remains capped at 25 candidates per minute and can therefore attempt up to 25 box stops per tick. Rollback is asymmetric: an old Core does not understand `dormant` as non-live and can treat dormant rows as runnable. After any dormant row exists, rolling back is unsafe unless those rows are first drained and canonicalized. Prolonged mixed-version operation remains unsupported.
>
> **Runtime wake cost:** Docker may recreate legacy pre-generation containers once during this upgrade. Afterward, dormancy stops/removes the personal container while retaining `/private`, and every wake creates a new container rather than resuming the old one. VM agent wake currently cannot use the parked-box fast path after its lifecycle generation rotates: dormancy parks the personal box, but wake performs full placement/provisioning again. Do not assume Docker-style resume latency or VM performance parity.

### Guarded flex-worker cleanup

Use `ficus squad cleanup-agents --squad <id> --dry-run` to preview eligible workers in one squad,
then omit `--dry-run` to request cleanup. Both operations require `agents:terminate` on that squad;
a squad manager can use its existing permission only within its own squad. No administrator grant is needed.
Without `--squad`, the legacy command sweeps all squads and still requires instance-wide `system:cleanup`.

Cleanup considers only live, non-persistent flex workers. Managers, consultants, parented subagents,
and dormant/terminated records are excluded. Open work streams and protected transitional states
prevent dormancy through the existing guarded lifecycle checks. Mid-turn requests are deferred until
execution settlement, not force-stopped or reported as completed cleanup.

This is **dormancy, not hard deletion**: eligible workers stop/sleep while their history and worktrees
remain retained. Dormant workers can recover during `AGENT_DORMANT_RETENTION_DAYS` (default seven days);
final termination and private-archive retention are separate backend policies. This command does not
remove worktrees or purge historical agent rows.

The API equivalents are `POST /api/squads/:id/cleanup-agents` and the administrator-only
`POST /api/squads/cleanup-agents`, with optional `?dryRun=true`. JSON output preserves `checked`,
`terminated`, and `agents`: the legacy `terminated` field counts workers made **dormant** (or eligible
workers for a dry run), not irreversible final termination. `deferred` and `deferredAgents` separately
report accepted requests still awaiting execution settlement; dry runs do not create deferred requests.

## Agent Types

Agent types are defined as YAML files in `config/agent-types/` and synced to the `agent_types` table on startup via ConfigSync (`services/config-sync/agent-type-sync.ts`).

### Current agent types

The templates under `config/agent-types/` are the current source of truth. Each type defines its system prompt, optional model override, optional tool allow/deny lists, and human-readable name and description. Templates are synchronized to the database and may be customized or disabled in the UI.

## Agent Context

The `context` JSONB field carries type-specific metadata without polluting the schema. The unified executor reads the context to determine which code path to run (system prompt, tools, completion handler).

### Manager Agent Context

Created by the chat route when a user starts an interactive conversation.

```json
{ "scope": { "type": "manager" } }
```

or scoped to a specific entity:

```json
{ "scope": { "type": "squad", "id": "uuid" } }
```

- `scope.type` — one of `manager` (global), `squad` (squad-scoped), `heartbeat`
- `scope.id` — entity ID for non-global scopes (required for `squad` and `heartbeat`)

Agent type: always `manager`.

### Heartbeat Agent Context

Created by the heartbeat config system for scheduled wake-up agents.

```json
{ "heartbeatConfigId": "uuid" }
```

- `heartbeatConfigId` — FK to the heartbeat configuration that owns this agent

Agent type: configured per heartbeat config.

## Executions

An execution is a single wake-up cycle — the transient work unit that the worker polls for and claims.

### Schema

| Column          | Type      | Description                                                                     |
| --------------- | --------- | ------------------------------------------------------------------------------- |
| `id`            | UUID      | Primary key                                                                     |
| `agent_id`      | UUID      | FK → `agents` (cascade delete)                                                  |
| `status`        | enum      | See below                                                                       |
| `message`       | text      | Triggering message (nullable)                                                   |
| `image_ids`     | UUID[]    | Attached images (nullable)                                                      |
| `wake_eligible` | boolean   | Whether this execution may wake a dormant owner; housekeeping work sets `false` |
| `usage`         | JSONB     | Token/cost usage for this execution                                             |
| `started_at`    | timestamp |                                                                                 |
| `ended_at`      | timestamp | Nullable                                                                        |

### Status States

| Status                | Meaning                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `queued`              | Waiting for worker pickup.                                                                     |
| `waiting-maintenance` | Durably waiting for instance maintenance to end.                                               |
| `waiting-sandbox`     | The original turn is durably waiting for recoverable sandbox capacity or control-plane health. |
| `running`             | Actively executing on a worker.                                                                |
| `stopping`            | Stop signal sent, waiting for session abort.                                                   |
| `stopped`             | Execution stopped, agent returns to idle.                                                      |
| `completed`           | Finished successfully.                                                                         |
| `failed`              | Error occurred.                                                                                |

`wake_eligible` is independent of execution status. Genuine accepted correspondence and explicit lifecycle wake APIs may create wake-eligible work. Schedules, reconciliation, and other housekeeping enqueue non-waking work so they cannot keep a dormant agent alive indefinitely.

The transitional `stopping` state preserves durable intent before the API sends a best-effort `agent_control` local-event. When the hint arrives, the worker aborts the session and finalizes the status. If it is missed, the runner observes `stopping` when the turn settles; worker startup also completes stale `stopping` rows. An operator can use force-stop when an immediate hard stop is required.

### Execution transitions

`Execution.transitionTo` in `apps/core/src/entities/Execution.ts` owns the paired execution/agent updates in a database transaction. Its `TransitionOutcome` type is the current outcome catalog, including sandbox-provisioning recovery transitions added after the original refactor. The public start/complete/fail/stop/force-stop/supersede/requeue methods delegate to this boundary.

Starting uses a queued-to-running compare-and-swap and an optional transactional start guard. A lost race or guard refusal returns false without publishing a successful start. Events and provider-slot releases happen after the committed transition; failure disposition policy lives in `services/execution/failure-routing.ts`. Agent-only compaction/reset states and the durable stop request are separate from final execution settlement.

Keep future admission/pickup consolidation work in the roadmap; do not treat the original transition refactor as proof that all follow-up consolidation has landed.

## Control Flows

### Normal Completion

1. Execution: `queued → running → completed`.
2. Agent: `idle → active → idle`.

If session setup encounters a recoverable sandbox provisioning refusal, the same execution follows `running → waiting-sandbox → queued → running`. No replacement execution or prompt is created. Messages sent while waiting remain pending on the same turn, Stop ends it directly, and sandbox retries do not consume a live provider/session slot.

### Steer and Follow-Up

1. The client calls `POST /api/agents/:id/message` with `deliveryMode: 'steer' | 'follow-up'`.
2. The API transactionally persists a pending human-message row and its delivery mode.
3. `message.created` over `app_events` nudges the running worker but is not the authority.
4. `PendingInterventionQueue` drains at runner start and on `message.created`, claims the durable row, then invokes `session.pi.steer()` or `session.pi.followUp()`.
5. The execution remains `running`.

Both the initial prompt batch and live interventions carry an opaque, server-generated delivery claim ID. The patched Pi SDK retains that identity outside the model message and appends it to the session entry. Only a matching claim ID, runner generation, and execution may acknowledge a pending row; text equality, missing content, and FIFO position are never consumption evidence. The acknowledgment retains the SDK entry ID and its response group. Text-block arrays, image attachments, and decorated prompts use the same identity path.

A missed nudge does not lose the row. Settlement makes bounded requeue attempts while pending human messages remain. After that retry budget is exhausted, rows stay pending until another message wakes the agent. The `/steer` and `/follow-up` routes are deprecated compatibility surfaces; they use this same path, and neither delivery mode travels over `agent_control`.

### Stop / Continue

1. **Stop:** persist `running → stopping`, then send a best-effort `agent_control` hint. The worker aborts on receipt. If the hint is missed, the runner detects the stored intent when the turn settles, worker startup completes stale stopping rows, and force-stop remains available for an immediate hard stop.
2. **Continue:** a later normal message creates a fresh queued execution on the same agent/session.
3. The agent remains available for future work.

Stop remains quiet: after draining in-flight queue admission and persistence, the runner reconciles its claims with persisted session entries and releases unappended inputs without creating another execution. The next authorized wake opens the persisted history in a fresh SDK session and reconciles abandoned claims before claiming new work. Normal settlement uses the same reconciliation before deciding whether to retry pending work. This also repairs the crash gap between session append and DB acknowledgment, including a later SDK rejection that released the claim before acknowledgment. Reconciliation reads verified, complete JSONL entries from disk, including entries omitted from compacted model context—not the SDK's in-memory context view, which can contain failed filesystem appends. Incomplete host-identified tails are not acknowledgment receipts, even on fresh SDK reopen. Claim release uses the unique identity fence for modern claims and a lossless database timestamp snapshot for legacy claims, preserving PostgreSQL microseconds and concurrent successor claims. Healthy turns and legacy-only recovery skip the receipt file entirely. When identity claims need recovery, an asynchronous scan retains only matching receipt IDs, not transcript bodies. Settlement rechecks exact session ownership before teardown, so a delayed old runner cannot dispose a replacement after a stop timeout. Explicit queue cancellation deletes the pending rows and is never undone by recovery; late old-session events cannot acknowledge successor claims.

Delivery is **at least once**, not exactly-once model execution. An append receipt proves durable session history, not that the model completed that input. Legacy claims lacking an identity, or claims whose original session file is no longer available after reset/rotation, are conservatively retried rather than acknowledged by guessing.

### Worker restart

A deploy or restart stops the worker in this order:

1. **Drain.** The worker starts no new turns: queued executions stay queued for its successor. It also refuses new sandbox commands ("Command not started: the Ficus worker is restarting…").
2. **Grace window.** Running sandbox commands get up to 10 seconds to finish. Whatever is still running is then stopped. Its tool call fails with "Command canceled: the Ficus worker is restarting…", which tells the agent to check what the command changed and run it again. If Ficus could not confirm the command stopped, the message says so.
3. **Handoff.** Active sessions are aborted and their executions requeued with "Agent paused for a worker restart; it will resume automatically." The next worker resumes them.

### Failure

Before a model prompt is dispatched, recognized transient database connection failures
(including PostgreSQL `53300`, too many connections) requeue the same execution after
5, 15, and 45 seconds. The retry count and deadline are stored on the execution, so a
worker restart preserves the budget. Queued retries retain the original request and
release runtime capacity; user stops and newer runner claims take precedence.

After three retries, or for an ineligible error, the execution follows normal failure
handling. Provider errors, unknown setup bugs, and failures after model dispatch are
excluded from startup retries. Pi's provider retry policy remains enabled with five
retries, followed by Ficus's existing provider failover handling.

1. Execution: `running → failed`
2. Agent: `active → waiting-input` (or `idle`, depending on context)

### Waiting for Human Input (`ask_human`)

1. Agent calls `ask_human` tool → execution completes, agent goes to `waiting-input`
2. Human answers → new execution queued with answer as message, agent goes to `idle → active`

Each question has an `id`, a `type` (`text`, `select`, or `multi-select`), the `question`, and optional
`context`, `options`, `default`, and `optional` fields. Questions are usually answered from the Feed, a
notification, or a phone rather than the agent's conversation, so `context` (Markdown, up to 2,000
characters) carries the background shown beneath the question. On `text` questions, `options` are
suggested answers: the answer form shows them as chips that fill the editable answer.

## How Each Use Case Works

### Chat queue display

The chat send response and public message reads expose a derived `queued` boolean.
The existing send receipt determines whether a message started its own turn or joined
an existing execution. First prompts are `queued: false`; unconsumed interventions
are `queued: true`. The database `pending` flag continues to track runner consumption
and can still be true for an accepted first prompt. No additional disposition is
stored on the message and no schema migration is required.

The shared conversation engine keeps first prompts above their response and working
indicator. Each optimistic send has its own queue placement; a later intervention
cannot reclassify it. Saved echoes retire optimistic entries, and a confirmed queue
clear also retires point-read overlays and rejects their older in-flight updates.
Submission errors leave an existing execution's state intact. On older backends,
the hook supplies queue placement for locally submitted messages until the server
exposes the explicit field; history loaded in a fresh session retains the legacy
fallback until Core is updated.

### Manager Chat (Interactive)

1. User sends a message via `POST /api/chat`
2. Route finds or creates a manager agent (type `manager`, context `{ scope }`)
3. Creates an execution with the user's message
4. Worker picks up execution, streams response
5. Agent persists across messages — each message is a new execution on the same agent

### Squad Work (Autonomous)

1. Squad agents are spawned with specific context based on their purpose
2. Agent gets an execution queued with initial instructions
3. Worker executes → agent processes the work and responds
4. Agent persists across work sessions, maintaining conversation continuity

### Heartbeat (Scheduled)

1. Heartbeat config points to an agent (type varies, context `{ heartbeatConfigId }`)
2. Scheduler creates an execution on the agent at the scheduled time
3. Worker executes → agent decides next beat time
4. Same agent persists across beats, maintaining session continuity

## Unified Streaming

One stream endpoint per agent:

```
GET /api/agents/:id/stream
```

The worker creates one `StreamBuffer` per agent. Same SSE protocol and event types (`thinking`, `text`, `tool_start`, `tool_end`, `done`). WebSocket broadcasts go to `agents:{agentId}` topic.

## Unified Dispatch

One executor, one queue, and bounded control/intervention paths.

- The worker polls `executions WHERE status = 'queued'`.
- Authenticated HTTP `agent_control` carries only `stop`, `abort-tool`, `compact`, `reset`, and `clear-queue`.
- Steer/follow-up use durable pending-message rows plus an `app_events` nudge.
- One `activeSessions` map tracks the current session, buffer, and collector per agent.

### Queue watchdog

The worker also runs a `queue-watchdog` periodic runner every 30 seconds. It re-emits `execution.queued` for executions queued longer than 60 seconds, so missed wake notifications do not leave work idle forever. It recovers agents stuck in `compacting` or `resetting` for more than 3 minutes by calling the normal `finishCompaction()` / `finishReset()` paths, but skips agents with an in-process compact/reset operation currently tracked in session state. Operators should look for `queue-watchdog` warnings such as `Stalled queued execution ... re-emitting wake`, `Recovering agent ... stuck in compacting`, or `Session leak suspected` when diagnosing queue stalls.

The worker runner (`services/worker/`):

1. Claims execution atomically (`queued → running`)
2. Sets agent `idle → active`
3. Loads agent type config (system prompt, tools, model)
4. Loads context-specific setup from `agent.context`
5. Opens/resumes Pi SDK session (keyed by agent ID)
6. Streams events to buffer
7. On completion: marks execution `completed`, sets agent to `idle`

## Work-stream continuation recovery

The worker runs a durable `work-stream-continuation` sweep every 30 seconds, including immediately after startup. It recovers a stream only when the stream is still `active` with NO open wait, its exact current assignee is idle and live (neither dormant nor terminated), the squad is active, and the agent has no queued, running, or stopping execution. The newest execution must have completed or stopped after the current assignment cycle began, except that a narrowly classified canonical provider-transport failure with trusted work-stream provenance is also eligible. Other failed/provider-halted turns, waiting-input/compacting/resetting agents, other bound agents or owners, queued/done/canceled streams, and streams with any open wait (review, question, dependency, manual) are excluded.

A persisted ledger supplies assignment generations, expiring delivery claims, deterministic client IDs, and restart-safe retries. The existing SQL `attempt_count` column is reused as the transport-attempt counter during rolling upgrades, while the separately added normal-attempt counter defaults to zero for legacy rows. Completed or stopped evidence receives at most one contextual normal nudge per generation. If that nudge also ends normally and no work or lifecycle state changes, the owner (or squad manager fallback) receives one record-only informational notice after at least 60 seconds. This normal path leaves the stream active, opens no wait, does not park it, and requires no unblock action.

Trusted provider-transport failures have a separate budget of up to three jittered exponential-backoff continuations, with provenance rechecked at delivery. Independently started substantive progress resets only this transport streak; watchdog-created completions reset neither logical budget. Enqueue failures retain their own five-attempt delivery retry budget and open a system MANUAL WAIT only after exhaustion. Immediately before transport or delivery escalation, the worker serializes a final current-assignee execution check against execution start. An execution that starts after a watchdog wait opens silently clears that exact wait and transactionally starts a fresh generation. The worker registers this execution-start cleanup handler before queued-execution pickup and starts the periodic sweep afterward. Operators can filter logs for the `work-stream-continuation` runner name.

## Session persistence

Chat and agent conversations use file-based Pi SDK sessions stored under
`<HOME_DIR>/sessions/<agentId>/` (`~/.ficus/sessions/…` by default). Session files
are the canonical conversation state (what the LLM sees), while database
messages serve as a read cache for the web UI. The Pi SDK handles context
window management and auto-compaction automatically.

`HOME_DIR` is set in
[configuration.md](configuration.md#environment-variables-env).

## Key Files

| File                                                    | Purpose                                            |
| ------------------------------------------------------- | -------------------------------------------------- |
| `apps/core/src/db/schema.ts`                            | `agents` and `executions` table definitions        |
| `apps/core/src/services/agents/`                        | Agent CRUD and actions                             |
| `apps/core/src/services/execution/`                     | Execution CRUD, control signals, session state     |
| `apps/core/src/services/worker/`                        | Worker: polls executions, streams, control signals |
| `apps/core/src/services/config-sync/agent-type-sync.ts` | Syncs agent types from YAML templates to DB        |
| `apps/core/src/routes/agents.ts`                        | Agent HTTP routes                                  |
| `apps/core/src/routes/agent-types.ts`                   | Agent type HTTP routes                             |
| `packages/shared/src/types.ts`                          | `Agent`, `Execution`, context type definitions     |
| `config/agent-types/*.yaml`                             | Agent type template definitions                    |

## Events

All event payloads are typed in `EventMap` in `packages/shared/src/events.ts`. WebSocket topic mappings live in `packages/shared/src/ws-topics.ts`; do not maintain a duplicate partial event inventory here.

## API Endpoints

```
GET    /api/agents                     — List agents (filter by type, status)
GET    /api/agents/:id                 — Get agent details
GET    /api/agents/:id/stream          — SSE stream (proxy from worker)
GET    /api/agents/:id/active          — Get active execution
GET    /api/agents/:id/executions      — List executions
POST   /api/agents/:id/message         — Send a durable message; choose deliveryMode for steer/follow-up
POST   /api/agents/:id/steer           — Deprecated compatibility route for a steering message
POST   /api/agents/:id/follow-up       — Deprecated compatibility route for a follow-up message
POST   /api/agents/:id/stop            — Stop active execution
POST   /api/agents/:id/abort-tool      — Abort current tool
```

## Chat file attachments

Direct agent chats can upload ordinary files into the agent's tool-visible private workspace. Ficus generates references in the exact form `@/private/chat-attachments/<uuid>/<safe-name>`; these references remain editable message text and are never silently re-appended after deletion.

The private copy is available to the agent's filesystem tools and may subsequently be changed by the agent. Chat-history downloads instead serve the immutable originally uploaded bytes through an authenticated agent route. A descendant may use and download an ancestor's attachment only while both still resolve to the same sandbox. The reverse direction, siblings, and co-located system-manager agents do not receive logical API access merely because the underlying `/private` directory is physically shared. A changed sandbox binding returns a conflict rather than copying an old attachment into a new private workspace.

This feature does not provide rich document previews, directory uploads, or physical isolation between agents that intentionally share a sandbox.
