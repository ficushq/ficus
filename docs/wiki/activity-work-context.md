# Activity work context, Active work and cleanup

The Activity feed (the global `/activity` page and each squad's Activity tab) tells a reader which work stream each agent row belongs to, offers the active work streams behind an "Active work" pill above the feed, and hides duplicate rows by default. Everything a client renders comes from the server in the existing responses; clients make no request per row or per card. Web and mobile share this contract. The row preview format is described separately in [Inline Activity previews](activity-previews.md).

## Row context

`SquadActivityItem` (and `GlobalSquadActivityItem`, which extends it) carries two optional, additive fields (`packages/shared/src/squad-activity.ts`):

```ts
interface ActivityWorkStreamContext {
  id: string
  number: number // instance-wide reference, #1352
  title: string
  squadId: string
  status: WorkStreamStatus
  step: string | null // "Implement"; see below
}

interface ActivityRowContext {
  workStream?: ActivityWorkStreamContext
  purpose?: string
}

interface SquadActivityItem {
  // existing fields …
  context?: ActivityRowContext // rows whose ref.type is 'agent' only
  senderActivityId?: string // received-message rows only; see Cleanup
}
```

Rules:

- `context.workStream` is set only when the row's agent (the `ref.agentId` of an agent row, which for received messages is the recipient) is a **workflow-bound participant** of a stream in the same squad (`workflow_bindings`). The stream owner, the squad manager and consultants are never bound, so their rows never carry a stream. Rows of finished streams' participants keep their stream with step `Done` or `Canceled`.
- `context.purpose` is the agent's purpose from `set_agent_purpose` (`agents.metadata.purpose`), trimmed and capped at 200 characters.
- Clients show the stream when present (`#1352 Floating agent windows · Implement`), otherwise the purpose, otherwise only the agent type label. `activityRowContextLabel(item)` produces that line, with the step passed through `activityStepLabel` so a step named `implement` reads `Implement` like the rest. The web feed renders it as a small line above the row's text in the summary column; the stream part opens the stream in place, like other stream links (modified clicks keep the link's navigation).
- `step` is the display name of each running workflow step (several are joined with `+`), `Completion-ready` or `Paused` when no step runs, `Done` or `Canceled` for finished streams, and null when the stream has no activated flow. A step without a display name uses its id with the first letter capitalized.
- Permissions follow the rest of the feed: `workStream` requires `workstreams:read` in the row's squad, and `purpose` requires `agents:read`. Absent fields mean "nothing the viewer may see", never an error.

Context is joined at read time, never materialized: a stream's title and step change constantly. Reading a step means reading the flow run's stored state, so `loadWorkStreamSteps` first reads only run versions and caches step facts per run version in process; unchanged runs are not read again. `apps/core/src/services/squad-activity/row-context.ts` loads it for a whole page in three batched queries (agents with bindings, flow step names, sender runs) after the page is authorized, for both `GET /api/squads/:id/activity` and `GET /api/activity`. Live `squadActivity.projected` events for agent rows carry the same fields: the broadcaster loads them once per event and reduces them per subscriber with the same rules (`redactActivityEvent`). A failed context load still delivers the row without context.

## Work stream filter

Both activity routes accept `workStreamId=<uuid>`. The filter keeps the stream's own rows (`squad_activity.work_stream_id`: creation, waits, handoffs, PR and issue events) and every row of its bound participants (their chat, received messages, notices and subagent activity). A squad where the viewer lacks `workstreams:read` contributes nothing to a filtered page. Participant rows are not time-bounded: an agent's rows from before it was bound to the stream also appear. Flow participants are created for one stream, so in practice these are the same agent's earlier steps in that stream. The filter is part of the cursor digest only when set, so cursors issued without it stay valid, and a filtered cursor cannot be replayed without the filter. Older servers ignore the parameter; clients should only offer the filter when the presence response includes `streams`.

The per-squad tab cannot tell from a pushed live row whether it belongs to the filtered stream, so while the filter is on it refetches the head on each live event instead of overlaying the row.

## Active work

`GET /api/activity/presence` gains an optional `streams` array, and the new `GET /api/squads/:id/activity/presence` (`squads:read`; 403 when the identity cannot read the squad's activity) returns the same `SquadActivityPresence` shape for one squad:

```ts
interface ActivityWorkStreamCard {
  id: string
  number: number
  squadId: string
  title: string
  status: WorkStreamStatus // queued or active
  step: string | null // same rule as row context
  waits: Array<{ type: WorkStreamWaitType; needsYou: boolean }> // display precedence first
  needsYou: boolean // same rule as needsYouCount
  pullRequest: { number: number; url?: string; repository: string; state: 'open' | 'merged' | 'closed' } | null
  ci: 'passing' | 'failing' | 'pending' | null
  deliveryLabel: string | null // "Awaiting CI", "Review Pull Request", …
  workingAgentIds: string[] // bound participants with status active
  lastEventAt: string // ISO
  summary?: string | null // the stream's one-line summary; see work-stream-summaries.md
  summaryGeneratedAt?: string // ISO, present with summary
  derivedState?: WorkStreamDerivedState // same value as WorkStream.derivedState; absent from older servers
}
```

- Cards cover exactly the streams `streamCount` counts: queued and active streams in squads where the viewer has `workstreams:read`, minus streams whose progress the viewer muted. They are ordered by `needsYou` first, then newest `lastEventAt`, and capped at `ACTIVITY_WORK_STREAM_CARD_LIMIT` (12, twice what the strip shows); `streamCount` still counts every stream.
- `waits[].type` is the display type (`workStreamWaitDisplayType`, so a workflow approval gate reads `review`); `needsYou` uses `workStreamWaitNeedsHuman`, the per-wait half of `workStreamNeedsHumanAttention`.
- `pullRequest` comes from the stream's code-host binding (`resolveCodeHostReference`) with the state observed by delivery tracking. `ci` and `deliveryLabel` come only from the server's delivery presentation (`delivery.explanation.gates.checksState` and `codeHostReason`), so they are null before a flow reaches completion-ready. An individual successful CI run is never reported as passing.
- `workingAgentIds` is empty unless the viewer has `agents:read` in the stream's squad.
- `summary` is the stream's one-line summary, only while the instance switch is on and it was generated for the card's `step` ([Work stream summaries](work-stream-summaries.md)).
- `derivedState` is the derived state presence already computes for `needsYou` (`computeDerivedStates`), so it costs no extra read. It lets a client show a paused stream as paused even when its flow is not (a stream-level pause).
- `lastEventAt` is the later of the stream's `updatedAt` and its bound participants' newest retained Activity row (participants' rows only with `agents:read`). The participant lookup is one `LIMIT 1` probe of `idx_squad_activity_agent` per participant (`workStreamLastEventsSql`). The stream's own rows are not read: no index orders them by time, and the events that matter (PR and CI notices, handoffs) also reach a participant's inbox.

Each card has exactly one display state, `activityWorkStreamCardState(card)` (shared), in precedence order: `needs-you` (the card's `needsYou`), `working` (a participant runs now), `paused` (`derivedState` is `paused` or the step is `Paused`), `waiting` (open waits, or a review, answer, dependency, delivery or blocked state), `queued`, otherwise `idle`. `ACTIVITY_WORK_STREAM_CARD_STATE_LABELS` names them.

Activity is the agent stream; the Feed is the work overview (owner decision 2026-11-20). So the web does not list the streams on Activity by default. The presence line above the feed reads "N working · N waiting on you · Active work 7 ▾": the counts come from presence (`workingCount`, `needsYouCount`), and the pill (`apps/web/src/components/squads/ActivityWorkPicker.tsx`) opens a searchable list of the cards built on the shared `Picker`. The list starts with "All activity" (no filter). Each stream then shows its state marker (working pulses blue, waiting on you is solid, waiting on something else is a hollow ring, paused is a pause glyph, queued and idle are quiet dots), "#number title", the state and step with the PR and CI ("Waiting on you: review · Implement · PR #996 · CI failing"), and the generated summary on a quieter line when there is one. The search field takes focus on open and matches the number, title, state line and summary; ArrowDown moves into the list, Enter or a click chooses. When the server counted more streams than it returned, a last "All N active streams" option opens the squad's Work tab (or the Feed when cards span several squads). The pill shows the stream count, and its accessible name adds the chosen stream ("Active work, 7 streams, showing #1394"). With no cards (older servers, or no active streams) the pill is replaced by the plain "N active streams" count.

Choosing a stream sets the work stream filter and opens the details panel (`ActivityWorkStreamDetails.tsx`) between the presence line and the feed: the full title and summary (never clamped; the summary marked "Generated summary · updated N min ago"), the state, step, who is working now, the PR link with CI and delivery labels, the last event, and "Open work stream" and "Open chat" links with Clear. The links reuse the feed's own href and in-place open: a plain click opens the stream or chat dialog, modified clicks keep the link (the chat link is an agent chat href, so Shift- or Alt/Option-click opens a floating window). The chat is with the participant working now, else the participant with the newest row in the filtered feed. Participant names come from the squad roster on the squad tab and from the rows already loaded on the global page; no request is made for them. "All activity" in the list, or Clear in the panel, removes the filter.

While the feed is filtered to one stream, agent rows of that stream drop their context line (the panel says it once). A row whose preview the server clipped (its last span is `…`) and whose source is a chat message (`ref.messageId` with `view: 'chat'`) gets a "Show more" button: it loads that one message (`GET /api/agents/:id/messages/:messageId`, cached and never refetched) and renders it in place; the rest of the row still opens its source. Mid-step a chat row shows text that has no message yet and links the previous message, so the client shows the full text only when the message's time matches the row's, and otherwise points to the chat. Received-message rows keep their 512-character preview without expansion.

Presence costs several queries, so clients refetch it only for live rows that can change a card (`ACTIVITY_PRESENCE_ROW_KINDS`: work stream, wait, handoff, PR and issue rows), debounced. Agent status changes already refresh it through the agents topic (`QueryInvalidator` invalidates the `presence` prefix, which covers the squad key), and a 30-second poll covers the rest. Chat steps and messages refresh only the feed. Presence also sorts and caps the cards before reading their steps, so a request reads at most 12 flow runs, and none whose version is cached. The pill, its list and the details panel read only the presence response and the loaded rows; per-agent presence chips remain out of scope (operator decision 2026-08-27).

## Cleanup and "Show everything"

The default view removes three kinds of noise. The **Show everything** switch in the filter toolbar turns all of it off.

1. **Relayed sender rows.** An agent-to-agent message produces the recipient's "Received message from …" row (lane 20, or 22 for subagent reports) and, usually, the sender's own chat row for the run that sent it. The server sets `senderActivityId` on the received row to that chat row's id (`10:<executionId>`): the sender's execution that was running when the inbox message was created, for same-squad senders, and only for viewers with `agents:read`. Clients call `hideRelayedSenderRows(shownRows)` with exactly the rows the view shows after every filter: the sender row is hidden while at least one received row naming it is shown (any of several recipients is enough), and it stays when the received row is filtered out or belongs to a squad the viewer cannot see, so a message never disappears. A sender row more than `RELAYED_SENDER_ROW_SLACK_MS` (60 seconds) newer than the newest matching received row is kept, because the sender has moved on to something new (a step's message row lands after its tool calls finish, hence the slack).
2. **CI, auto-merge and PR lifecycle notices.** System notices whose subject Core writes for CI results (`CI <state>: …`), pull request auto-merge changes (`GitHub pull request auto merge enabled|disabled: …`) and pull request merged/closed (`Pull request merged|closed: …`), optionally prefixed by `Parked work stream event: `, are materialized with `quiet_eligible = false`. The default (non-verbose) query omits them; the Active work card carries the stream's PR and CI state, and the PR's own row carries merged/closed. `verbose=true` returns them. Existing rows change when the repair rewrites them (the hourly sweep covers 48 hours; older retained rows keep their previous flag until a wider `activity:repair` window runs). This needs no migration.
3. **The squad chip.** The global feed shows the squad column only while the shown rows span more than one squad.

"Show everything" sends `verbose=true` and skips `hideRelayedSenderRows`. The per-squad live overlay accepts non-quiet rows only while it is on.

## Mobile reuse

Mobile adopts these fields through the packed shared and client-core packages (see [Native adoption](activity-previews.md#native-adoption)). `packages/client-core` exposes `listSquadActivity`/`listGlobalActivity` with `verbose` and `workStreamId`, `getGlobalActivityPresence`, `getSquadActivityPresence`, and `queryKeys.activity.squadPresence`. The shared helpers `activityRowContextLabel`, `activityStepLabel`, `activityWorkStreamCardState`, `ACTIVITY_WORK_STREAM_CARD_STATE_LABELS`, `hideRelayedSenderRows`, `workStreamWaitNeedsHuman` and `ACTIVITY_WORK_STREAM_CARD_LIMIT` keep the rules identical across clients. Every new field is optional, so older clients ignore them and newer clients must tolerate their absence from older servers.
