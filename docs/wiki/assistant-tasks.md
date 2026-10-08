# Assistant tasks and updates

Work delegated from a saved Assistant conversation keeps running after the browser closes, and what
the delegate reports back is stored so the user can catch up later. This page describes the tracked
task lifecycle, the reporting protocol agents use, and how unread and processed state behave.

## What a task is

A task is one delegated request within an Assistant conversation. It is a tracking record around an
inbox request chain: it is not a work stream, an execution, or another coordinator. The existing
delegate (the conversation's general User Assistant, its owned squad consultant, or an explicitly
targeted agent) owns execution and follow-through through existing agents, work streams, waits, and
integrations. A new update can wake the conversation’s Assistant to summarize it; it never implies that the delegated task completed.

- The task ID is the first outgoing inbox request ID; the current request advances when the user
  answers a question (`inReplyTo` on the answer), continues, retries, or cancels it.
- An independent request without `inReplyTo` is a new task, even when it reuses the same helper.
- The label comes from the delegation label, falling back to the request's first line (80 chars).

Statuses:

| Status        | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `working`     | Accepted and in progress. Does not assert the agent is executing right now.    |
| `waiting`     | The delegate reports waiting on another agent, integration, or external event. |
| `needs-input` | The delegate needs the user's answer before dependent work continues.          |
| `completed`   | The delegate explicitly reported the task complete.                            |
| `failed`      | The delegate explicitly reported it could not complete the task.               |
| `cancelled`   | Cancellation was requested, or the delegate reported it.                       |
| `unknown`     | Historical task imported at upgrade time without lifecycle evidence.           |

Rules: an update without a status changes nothing; a report against a superseded request stays
visible but cannot change status; a terminal status is never reopened by a later `working`,
`waiting`, or `needs-input` report (a new user follow-up reopens it explicitly); idle or dormant
helpers never imply completion; a missing or terminated helper on an unfinished task is shown as
`unavailable` without rewriting its status.

## Choosing a squad

When a decision model is set up and **Assistant squad routing** is on (Settings → Decision
Providers → Features), Core may ask one decision before the Assistant reads a user chat message.
It is not asked at all (no call, no cost) for a short acknowledgement ("ok", "thanks!", "sounds
good": at most four words, all from a small acknowledgement vocabulary) or for a reply to the
Assistant's own question (its last turn ended in a question or used `ask_human`).

The one call asks two questions:

- `kind`: `new_request` (asks for work not already under way, including redoing earlier work
  somewhere else), `follow_up` (about work or a request already in this conversation), or
  `conversation` (a confirmation, thanks, brainstorming, or a question to the Assistant itself).
- `scope`: `instance` (Ficus itself: settings, admin, the instance), `general` (not tied to one
  squad's project), or one `squad_<short id>` option per active squad the user can read,
  described by the squad's name and purpose. Above 30 squads, the purpose heuristic from the
  squad suggester keeps the likeliest.

The user's message goes only in the decision's state, with the user's last four chat messages and
the Assistant's latest reply (300 characters each). The question waits at most 1.5 seconds; no
answer means no hint.

- A `new_request` whose kind and scope are both at least 60% confident is saved on the message
  (`metadata.assistantRouting`) and added to the model's copy of it as a routing hint. The
  conversation shows it as a chip under the message ("Chlea · 91%", "Not about a squad",
  "General").
- A confident `follow_up` carries the conversation's latest routing (the newest message with a
  hint, or the user's correction of it) to the model, unsaved and with no chip. With no earlier
  routing it gets nothing.
- `conversation`, and anything less confident, gets nothing.

Choosing another squad, or No squad, from the chip (`POST /api/assistant/:conversationId/routing`)
saves the correction on the message and sends the Assistant a short system message that carries
it. The Assistant's `suggest_squad` tool asks the scope question for any phrasing, and falls back
to the purpose heuristic without a decision model.

## Continuing, recovering, and cancelling

The owner can use `POST /api/assistant/:conversationId/tasks/:taskId/commands` with a durable
`clientId`, the task's `expectedRequestId`, and one operation:

- `continue`: provide a `request` and optional `mode` (`steer` by default, or `follow-up`).
- `retry`: provide a `request` describing what to retry. An unavailable owned helper can be
  replaced while the task ID, label, and prior updates remain intact. An explicitly selected
  agent is never silently replaced with a different one.
- `cancel`: provide an optional `reason`. This records cancellation and tells an available
  delegate to stop only that scope. It does not terminate a shared agent or assert that an
  external action already in flight has stopped. It does not wake dormant or terminated helpers.

Each command advances the request generation atomically with its inbox record. A stale command
receives HTTP 409 and must be reviewed against the current task; it is never silently applied to
newer work. Reusing the same `clientId` and exact input recovers the accepted receipt, even after
subsequent updates or a lost response. Reusing the ID with different input conflicts.

Independent tasks may share a delegate and steer it while it is running. Their labels and states
remain separate; continuing or cancelling one cannot finish or cancel another. Task creation,
commands, and receipt replay recheck the owner's permissions and the relevant private-agent or
squad consultant access.

## Reporting protocol

The delegate reports directly on the task it owns; the request it received names the task ID:

```bash
ficus assistant-task status TASK_UUID --request-id REQUEST_UUID --status completed -m "The comparison is finished."
ficus assistant-task get TASK_UUID
```

`POST /api/assistant-tasks/:taskId/status` accepts only the agent currently bound to the task and is
sugar over an inbox reply on the specified `requestId`, so it shares the validation, projection,
activity events, and push policy below. A report that would change a finished task is refused with
HTTP 409 (and the current task state) rather than recorded as a no-op; only a new user follow-up
reopens a task. Always pass the request ID that came with the work being reported. A stale request
ID is refused with HTTP 409; do not replace it with the newest ID to report old work. Older clients
may omit it for the original request only. The equivalent inbox form carries a validated status flag:

```bash
ficus inbox send assistant:CONVERSATION_UUID \
  "The comparison is finished. The recommended option is described below." \
  --recipient-type voice_assistant \
  --in-reply-to REQUEST_MESSAGE_UUID \
  --assistant-task-status completed
```

`--assistant-task-status` accepts `working`, `waiting`, `needs-input`, `completed`, `failed`, or
`cancelled`. It is accepted only from the agent that received the request, only for a local reply
to that saved Assistant mailbox, and is rejected (HTTP 400) for federated sends, other recipients,
and attempts to smuggle `assistantTaskStatus` or `assistantTaskId` through generic metadata. A
reply without the flag is still delivered and shown; it just leaves the tracked status unchanged.
The standing guidance lives in `config/agent-types/shared/assistant-task-reporting.md` and is
included by the User Assistant and consultant types.

## Processed versus seen

Updates retain separate delivery, summary, and visibility facts:

- `forwarded_message_id` identifies the durable inbox delivery to the conversation’s agent.
- `summarized_message_id` identifies the saved Assistant response in the exact execution and
  response group that confirmed consuming the update. Core stores this binding before publishing
  completion; a periodic reconciliation repairs interrupted attribution. `processed_at` retains
  legacy compatibility and is also set when the durable response is linked.
- `seen_at` records human acknowledgment through a visible original-update card or an explicit
  mark-read action. Summarization and speech alone never mark an update seen.

Forwarding is recoverable without a browser lease. Report context is bounded to 12,000 characters
per delivery batch; longer reports remain available through `read_task_update`. Original reports
are never truncated in storage. Source cards load by their exact IDs, independently of the latest
activity page. Every fragment of a grouped response contributes source IDs.

## Needs you

A task in `needs-input` appears in the Action Center (`GET /api/actions/pending`, type
`assistant-needs-input`) for the conversation owner only, carrying the task label, the latest needs-input report for the current request
as the question, and the conversation to answer in. It clears when the task leaves `needs-input`,
normally because the owner's answer advanced the current request. The Action Center is nudged
through the existing `actions.invalidated` frame whenever a conversation's activity changes.

“Answer in Assistant” opens the exact task's answer form in the conversation. Unanswered task
questions remain available after their updates are read or processed, including questions older
than the newest update page. Submitting replies to that task's question; it does not start an
unrelated background task. Failed sends retain the answer for retry. Ordinary `ask_human`
questions from active task agents use the same pending-question form as normal agent chats.

## Discovery and notifications

`GET /api/assistant/activity` returns owner-scoped totals plus the conversations with unread
updates or unfinished tasks, ordered by needs-input, then unread, then recency; `GET
/api/assistant/:id/activity` returns a conversation's tasks and its newest 50 updates with
pagination by sequence, plus `pendingInputs` for current unanswered task questions independent of that page. Reads never lease a mailbox, create agents, or run models. The
`assistant.activityChanged` WebSocket event (identifiers only) is delivered to the conversation
owner alone, including on the collection topic. Push notifications go only to the owner and only
for status-changing `needs-input`, `completed`, and `failed` reports on the current request; routine
progress refreshes badges without a push. See [notifications](notifications.md).

## Upgrade behavior

Existing conversations are preserved. The migration reconstructs tasks from outgoing requests and
their `inReplyTo` chains (distinct roots stay distinct), imports incoming messages as updates in
`(created_at, id)` order, and marks every reconstructed task `unknown`. Previously read messages
become both processed and seen so the rollout does not resurrect old notifications; previously
unread ones stay unread. Historical read state cannot distinguish machine consumption from human
viewing — only updates created after the upgrade carry the precise processed/seen semantics.

## Conversation execution and upgrades

`POST /api/assistant/:conversationId/agent` resolves one owner-private `assistant` agent, even
when text and voice open concurrently. Subsequent text and speech use the ordinary agent chat
API and its idempotent send, queue, retry, and maintenance semantics. The Assistant uses the fast
model tier and in-process tools; it does not provision a sandbox for conversational inference.
General `assistant-worker` delegates use the owner’s current permissions and existing sandbox
storage. Creating an owned squad consultant requires the same access as normal consultant creation.
Consultants retain their normal squad authority; read-only squad work can use the general worker.

The migration is additive: conversation IDs, legacy entries, task request generations, mailbox
identities and existing helpers remain intact. Old `system-manager` helpers and internal sandbox
names are retained for compatibility. No boxes or personal storage are deleted as part of this
upgrade. Legacy mailbox and task endpoints remain available to existing clients; the web panel
uses the new agent binding. Native mobile action links continue opening the exact web question.

The Assistant's read tools cover the same state as the UI: `read_inbox` with `view=actions` returns
the Needs you list (`GET /api/actions/pending`), `get_work` reads work streams across readable
squads with the feed's needs-human rule, and `read_activity` reads the activity feed. `list_tasks`
lists only the conversation's own delegated tasks.

Quick tools recheck current ownership and permissions. Agent/thread tools accept full UUIDs from
visible search results, so hidden candidates cannot affect prefix ambiguity. Page editors get
only `read` and `edit`; they cannot delegate or mutate catalog entries outside their draft.
