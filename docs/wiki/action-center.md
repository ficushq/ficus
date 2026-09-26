# Action Center

The Action Center is the per-user list of work that currently needs attention. `GET /api/actions/pending` is authoritative for action identity, visibility, response capability, priority, and order. Clients display the returned order rather than reconstructing or re-sorting actions.

## Data flow

Question history and question attention are two different flows with different authorization:

```text
agent conversation/context
  -> canonical current-agent agents:read authorization
  -> GET /api/agent-questions/by-agent/:agentId
  -> all requested-lifecycle questions for that agent

agent-question lifecycle event
  -> durable direct attention recipients + compatible owner + authorized readers
  |
  +-> attention applied (kind not mute -> Action Center; kind = notify -> push)
  |
  +-> permission-shaped audience only, attention NOT applied
        -> targeted actions.invalidated WebSocket frame with data: {}
        -> actions + exact-question cache invalidation
        -> authoritative REST refetch
```

`PendingAction` and its action-data types live in `packages/shared/src/types.ts`. Each action has a full `id`, numeric `priority`, ISO-string `createdAt`, type-specific `data`, and `canRespond`. A visible action with `canRespond: false` remains visible and is explicitly read-only.

The `actions.invalidated` frame is only a content-free reconciliation hint. It contains no action, question, answer, agent, squad, work-stream, or recipient identifier. Core targets it to currently subscribed authenticated user sockets in the wider, permission-shaped invalidation audience described below. REST remains authoritative.

## Attention, visibility, and capability

Action Center items and push derive recipients from durable direct-attention records (consumed execution participants and attributable work-stream requesters), a compatible squadless personal owner, and every authorized reader whose ATTENTION has not silenced that source. Attention is two independent kinds per squad and per work stream — `decisions` (questions, review waits, manual waits, halted agents) and `progress` (active work in the feed, completions) — each at `mute`, `show`, or `notify`. A work stream's own levels override its squad's; with no row anywhere the effective levels are `show`/`show`, so everything a user is permitted to see is listed and nothing interrupts. An item is VISIBLE when the viewer holds `actions:read` and the relevant kind is not `mute`; it is PUSHED only when that kind is `notify`. A subscription is no longer required for visibility. Disabled and unauthorized users are filtered. `agents:read` alone never adds an Action Center item, push, or socket invalidation, and merely opening an agent's chat never subscribes anyone.

Targeted `actions.invalidated` frames use a wider, permission-shaped audience: every enabled user with `actions:read` on the affected squad, plus the question's direct recipients and compatible personal owner. Attention levels are deliberately not applied there — the frame carries no content, so over-targeting costs one refetch while under-targeting would leave a real recipient's list stale.

Chat/history visibility is deliberately separate: anyone with canonical `agents:read` on the current agent sees that agent's open questions and answered/dismissed history through the by-agent API, regardless of attention routing. Conversely, a direct attention recipient without `agents:read` receives the Action Center item but cannot read the agent's chat history. The physical `audience_resolution`/`agent_question_recipients` schema names are legacy-compatible storage for this attention-routing state.

Read permission and attention determine visibility; mutation permission determines `canRespond`. `canRespond` for `agent-question` follows canonical current-agent `agents:run` plus the addressable lifecycle/scope transaction fence. Visibility does not imply response capability. Clients consume `canRespond` rather than applying a contradictory standalone permission gate. Counts, badges, and cards therefore remain scoped to the current user.

## Action matrix

Lower priority numbers appear first. Within a priority, newer actions appear first. The server returns this final order.

| Wire type            | Priority | Exact ID                                     | Source and operation                                                                                                                                                                 |
| -------------------- | -------: | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-error`        |        0 | `agent-error:<agentId>`                      | A halted agent. Continue only the visible action with `continueHaltedActions([action.id])`.                                                                                          |
| `squad-question`     |        1 | `squad-question:<agentId>`                   | Legacy blocking agent question. Send the answer with `sendMessage(agentId, answer)`.                                                                                                 |
| `agent-question`     |        1 | `agent-question:<questionId>`                | Durable asynchronous question. Answer `questionId`, retry the saved answer when terminal delivery status is `failed`, or `DELETE /agent-questions/:id` to dismiss without answering. |
| `workstream-review`  |        2 | `workstream-review:<workStreamId>:<waitId>`  | Open review wait. Resolve that exact wait as `approved`, or `sent_back` with nonblank feedback.                                                                                      |
| `workstream-blocked` |        3 | `workstream-blocked:<workStreamId>:<waitId>` | Open manual wait. Resolve that exact wait as `cleared` with the response.                                                                                                            |

Answering, retrying, and open-question dismissal require `canRespond: true`. A visible failed-delivery notice may be acknowledged by the acting user even without response authority; Retry additionally requires `answerDelivery.canRetry`. Clients carry the full action ID and structured question or work-stream/wait fields; they do not reconstruct identities by splitting action IDs.

## Durable questions and delivery

`agent-question` represents the durable question record, not an ephemeral agent status. Answering stores the answer and its delivery generation before background delivery proceeds. A delivery that reaches terminal `failed` remains an actionable card. Retry delivers the saved answer; it does not submit a second answer.

Delivery here means **accepted agent send**, evidenced by an `accepted` chat-send receipt with message and execution identities plus the question's deduplicated agent inbox row. Inbox persistence, unread/read state, and a saved answer alone do not establish acceptance. A sweep reconciles failed rows with that evidence without sending again; explicit Retry checks for the receipt first, then uses the stable send client ID so repeated sends cannot create another agent message/execution. A failed status means confirmation may be missing, not that the agent certainly did not receive the answer. Check the conversation before Retry.

`POST /api/agent-questions/:id/dismiss-delivery-failure` with `{ "generation": number }` acknowledges only the current failed generation for the acting user after question-attention authorization. The durable `(question_id, user_id)` acknowledgement is generation-fenced: a later failed retry generation becomes visible again to that user; other users still see their own actionable notice. Duplicate acknowledgement of the same generation is idempotent. It does **not** resend, change the question's `answered` status or history, or close/open any work-stream wait. This is separate from `DELETE` on an open question. The `0190_nostalgic_nemesis` migration creates the acknowledgement table; no historical answer/receipt backfill or live repair is needed. Existing failed rows with trustworthy accepted receipts converge on the next sweep after migration.

Dismissal (`DELETE /api/agent-questions/:id`, optional `reason`) marks an open question no-longer-relevant instead of answering it: the row transitions to `dismissed`, its `question` waits close `cleared`, and the dismissal is audited (`dismissedByUserId`/`dismissedByAgentId`, `dismissalReason`). Dismissal delivers no reply, inbox message, or new notification to the asking agent. It emits the existing `agent-question.dismissed` generic lifecycle event on the established agent topics; the bridge separately sends content-free `actions.invalidated` hints to the canonical human audience, with polling as fallback. Dismissal requires canonical `agents:run` resource permission, like answering, but ignores the asking agent's termination state. A squad-bound stored owner without that permission cannot dismiss. Dismissed questions leave pending/open feeds and appear read-only in the `status=answered` terminal history bucket.

A work-stream `question` wait references this durable question. It closes through the question-answer lifecycle and has no separate caller resolution control. `squad-question` is the compatibility path for older blocking `questionData` stored on an agent.

## Work-stream wait semantics

Open waits are typed records in `work_stream_waits`; review and blocked states are not stored work-stream statuses.

| Wait type    | Meaning                                                    | Caller behavior                                                                 |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `review`     | A verdict is required.                                     | Approve or send back the exact `workStreamId` + `waitId`.                       |
| `manual`     | Operator input or an external action is required.          | Clear the exact wait with a response.                                           |
| `question`   | A durable agent question is awaiting its answer lifecycle. | Read-only in work-stream detail; answer or dismiss its `agent-question` action. |
| `dependency` | Another work stream must finish.                           | Read-only; the system satisfies it.                                             |

For checkpoint approval, review send-back, or manual clear, the wait closure and continuation-cycle reset/invalidation are durable transaction state. A completing approval durably records the terminal transition and invalidates the active continuation cycle.

Async agent-question answer delivery has its own durable generation and retry path. The later `notifyWorkStreamResponded` call used for checkpoint, send-back, and manual responses runs after the wait transaction and is **not** protected by the question-answer delivery outbox/retry contract. A separate work-stream response outbox is outside this feature and remains backlog work.

A review wait's `completesOnApproval` is part of its identity:

- `false`: a checkpoint; approval resolves the wait and work continues.
- `true`: a completing review; approval resolves the wait and completes the stream.

Concurrent waits are not interchangeable. Exact stale or contradictory targets do not fall back to sibling waits. HTTP 404/409 settlement is presented as no longer pending and triggers reconciliation.

## Mounted client surfaces and exact focus

### Web

Mounted web surfaces are:

- `/feed`, through `FeedPage` and `ActionCenterContent`;
- `/actions` and `/actions/:encodedActionId`, through `ActionsPage`;
- the desktop and bottom-navigation badge in `AppNav`.

An exact action ID focuses the exact card. A structured `waitId` is passed into work-stream detail and never falls back to a sibling wait.

### Expo

Mounted Expo surfaces are Feed cards, the Feed tab badge, squad/conversation question badges, the agent-chat pending-question indicator, and the exact work-stream detail sheet.

Expo route identity is conjunctive across `actionId`, `questionId`, `workStreamId`, and `waitId`. The Feed scrolls to and highlights the exact action without reordering server results, and reports a target stale only after authoritative reconciliation. Cross-server notification navigation first completes and verifies the paired-server switch; a failed or superseded switch aborts exact navigation.

## Refresh, realtime, and mutation behavior

React Query keys are centralized in `packages/client-core/src/queryKeys.ts`.

- Web and Expo subscribe globally to the bare `actions` WebSocket topic. An empty `actions.invalidated` frame invalidates both `actions.all` and `agentQuestions.all`.
- Every successful authenticated socket open, including reconnect, queues the same reconciliation.
- Existing `agent-question.*`, agent, and work-stream events remain compatible hints for old servers and clients.
- Both web and Expo poll pending actions every 30 seconds while mounted and foregrounded. Screen focus and pull-to-refresh are additive fallbacks.
- Bursts coalesce. Refetches use `cancelRefetch: false`, and a trailing retry preserves the final authoritative state when a hint arrives during an in-flight request.
- Background refetch retains cached cards and counts; it never renders a transient zero or empty success.
- Counts and badges share the pending-action result and preserve error markers rather than presenting failures as zero.
- Successful mutations invalidate or remove the affected authoritative caches. Failure does not optimistically remove the keyed card or clear its input/error state. Expo may refetch on settlement to recognize a stale 404/409, while a genuine server failure retains the action and form for retry.

## Compatibility

The new topic and event are additive. Older clients do not subscribe and continue using existing agent/work-stream hints and polling. New clients connected to an older Core may receive an invalid-topic response, but focus, pull-to-refresh, and the foreground poll bound staleness. Existing agent-topic broadcasts and payloads remain unchanged. `packages/client-core/src/ws.ts` automatically resubscribes after reconnect; no new client API is required.

## Key files and routes

| Path                                                     | Purpose                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/shared/src/types.ts`                           | Pending actions, action data, typed waits, and resolution contracts |
| `packages/shared/src/events.ts`                          | Content-free `actions.invalidated` event contract                   |
| `packages/shared/src/ws-topics.ts`                       | Strict bare `actions` collection topic                              |
| `apps/core/src/services/agents/actions.ts`               | Aggregation, exact IDs, priority, and server order                  |
| `apps/core/src/services/agents/questions.ts`             | Question history and attention-recipient resolution                 |
| `apps/core/src/services/agents/pending-action-policy.ts` | Per-identity attention visibility and `canRespond`                  |
| `apps/core/src/services/ws/bridge.ts`                    | Question lifecycle attention resolution                             |
| `apps/core/src/services/ws/manager.ts`                   | User-only subscription and targeted empty invalidation              |
| `apps/core/src/routes/actions.ts`                        | `GET /api/actions/pending`                                          |
| `apps/core/src/routes/work-streams.ts`                   | Exact wait resolution                                               |
| `packages/client-core/src/resources/actions.ts`          | Typed pending-action query                                          |
| `packages/client-core/src/ws.ts`                         | Socket reconnect and automatic topic resubscription                 |
| `apps/web/src/components/QueryInvalidator.tsx`           | Web action/question signal and reconnect reconciliation             |
| `apps/web/src/hooks/usePendingActions.ts`                | Web authoritative pending query and polling                         |
