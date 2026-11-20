# Work stream summaries

Every active work stream carries a short, current, one-line summary of what is happening in it ("Wiring the peek card into the Feed rows"). People see it where they glance at work: the stream detail modal, the Activity page's Active work cards, the Feed, the squad Home and Work tabs (list, board and graph). Core generates and stores it; clients only display it, with the rules below, so web and mobile show the same thing.

The summary never replaces the deterministic status chips. The current step, open waits, and PR and CI state come straight from the database (`WorkStream.step`, `openWaits`, `delivery`, and the Active work card fields in [Activity work context](activity-work-context.md)); the sentence only adds the gist of what the participants are doing.

## Generation (Core)

The code is in `apps/core/src/services/stream-summaries/`: `service.ts` (pure: input selection, the refresh decision, the scheduler), `prompt.ts`, `parse.ts`, `runtime.ts` (database, events, model) and `visibility.ts`/`presentation.ts` (what the API returns).

**Model.** One one-shot call on the Lite tier through `completeWithTier`, as for [reply suggestions](reply-suggestions.md), with `purpose: 'stream-summary'` and the stream and squad as the source. Every candidate that reached a provider is recorded in the inference cost ledger as `lite:stream-summary`, so it shows in Settings → Spend as "Stream summary · Lite tier".

**Input.** Only these reach the model:

- the stream's title and current step label;
- the previous summary, so the model updates it rather than rewriting it;
- the new Activity rows since the last summary of the stream's **workflow participants** (`workflow_bindings`), counting only messages they sent: their own chat rows (lane 10). Received-message relays ("Received message from …", lanes 20 and 22), system notices (lane 21) and subagent lifecycle rows are never read. The stream owner, the squad manager and consultants are never participants; rows of the owner's id and of the `manager` and `consultant` agent types are excluded even if one were bound.

Each row is cut to 300 characters and at most 18 rows are used (the newest). Rows are the `summary` text of `squad_activity`, which never contains tool calls, tool results or thinking. A row is "new" when its `at` is later than the stored `through` cursor; the rows are read with one `LIMIT` probe of `idx_squad_activity_agent` per participant.

**Output.** The answer is untrusted. Only one plain-text line of at most 120 characters (`WORK_STREAM_SUMMARY_MAX_CHARS`) survives, after trimming wrapping quotes and a "Summary:" label. Line breaks, links, Markdown or HTML, control or bidirectional characters, an over-long line, or an empty or "none" answer are discarded whole (never cut down), and the previous summary stays. The prompt asks for at most 100 characters.

**When it refreshes.** The API process (where `registerStreamSummaries` runs, next to reply suggestions) listens for:

- `squadActivity.projected` upserts of lane 10 rows: each is one message of a participant. The agent's active stream is looked up in `workflow_bindings` (cached for a minute per agent).
- `workStream.updated`, `assigned` and `reopened`: the step may have changed.
- `workStream.done`, `canceled` and `deleted`: the stream's state is dropped.

A refresh is due when the step changed since the stored summary (or there is none yet), or when at least three new participant messages arrived (`STREAM_SUMMARY_ROW_TRIGGER`). A chat row is updated in place for each new message of the same run, so the live message count is used beside the stored row count. A step change with no new messages still refreshes when there is a previous summary to update; a first summary needs at least one message.

At most one generation per stream runs in five minutes (`STREAM_SUMMARY_MIN_INTERVAL_MS`), checked against the stored `generatedAt`, so restarts keep the interval too; due streams wait with one timer each. A look that ends before the model call (not due, throttled, no input) does not use up the interval, but the next look waits 30 seconds. At most two generations run at once instance-wide. Only `active` streams are summarized. Idle streams cause no events, so they get no timers, reads or calls, and opening a page never triggers a model call.

**Storage.** The summary is stored on the stream as `metadata.streamSummary`:

```ts
interface StoredWorkStreamSummary {
  text: string // the line
  generatedAt: string // ISO
  step: string | null // the step label it was generated for
  through: string | null // ISO `at` of the newest activity row it covers
}
```

The save is one `UPDATE` that merges the key into the metadata (recovering a double-encoded object rather than discarding it), does not touch `updated_at` (list order and "last event" must not move for a summary), and applies only while the stream is active and its stored `generatedAt` is still the one that was read, so a concurrent save never overwrites a newer one. A metadata update elsewhere that replaces the whole object can drop it; the next refresh writes it again.

**Live updates.** After a save Core emits `workStream.summaryUpdated` `{ workStreamId, squadId }` on the `workstreams` WebSocket topic (instance topic `workstreams:<id>`), delivered like `workStream.updated`. It carries no text: clients refetch the stream (the web invalidates the squad and work stream queries and Active work presence, nothing else).

## The switch

**Work stream summaries** on Settings → Features, the last page in the Work group (`/settings?section=work-features`, needs `settings:read`; `STREAM_SUMMARIES_ENABLED`, on by default). It is a work feature, so it is not under Model tiers, although it runs on the Lite tier (owner decision 2026-11-20). Settings search finds it as "Work stream summaries". While it is off the event handlers return before any database read, no model call happens, pending timers are dropped, and the API leaves saved summaries out. Turning it back on shows them again (subject to the step rule). When the Lite tier has no usable model, the page says "No Lite model is signed in" beside the switch (for viewers with `agent-types:read`, who can see the tiers).

## The API contract

The summary paraphrases participants' chat, which the Activity feed shows only to viewers with `agents:read`, so it needs the same permission: a viewer sees a stream's summary only with `workstreams:read` **and** `agents:read` in the stream's squad. `step` needs only `workstreams:read`.

- `WorkStream.step?: string | null`: the current step as a person reads it (same rule as `context.workStream.step` on Activity rows: running step names joined with `+`, `Completion-ready`, `Paused`, or null). Set by the work stream list and detail endpoints for queued and active streams only.
- `WorkStream.summary?: { text, generatedAt, step }`: present only when the switch is on, the viewer has `agents:read` in the stream's squad, the stream is `active`, and the stored summary was generated for the current `step`. The `through` cursor is never returned, and `metadata` never contains `streamSummary`.
- `ActivityWorkStreamCard.summary?: string` and `summaryGeneratedAt?: string` on `GET /api/activity/presence` and `GET /api/squads/:id/activity/presence`, under the same rules.
- Clients cannot write it: work stream create and update reject any `metadata.streamSummary` key (including a deletion with `null`, so `ficus workstream set-meta` and `unset-meta` cannot forge or remove one) with 400.

Absent means "nothing to show": clients never need to check the setting. Older servers send none of these fields.

`packages/shared/src/work-stream-summary.ts` holds the shared pieces: the types, `WORK_STREAM_SUMMARY_MAX_CHARS`, `parseStoredWorkStreamSummary`, `visibleWorkStreamSummary(summary, { status, step })` (the client-side copy of the active and step rule, for a client that learns a new step before the stream is refetched) and `workStreamDeliveryCiState(delivery)` (aggregate CI from delivery tracking, as the Active work card reports it).

## Display rules

These are the rules any client follows; the web components named after each one implement them (`apps/web/src/components/WorkStreamSummary.tsx`).

- **Only active streams.** Done and canceled streams never show a summary, a summary line or a peek card. Use `visibleWorkStreamSummary`.
- **Stale step.** When the stream moved to another step since the summary was generated, hide it until a fresh one arrives, so it never contradicts the status badges. The server already does this; repeat it on the client when the step is known.
- **Plain text.** Render the text as plain text, never Markdown.
- **Marked as generated.** The line is model output shaped by agent messages, which can carry untrusted text, so it must never read as status: the detail view and the peek card say "Generated summary" beside its age, and every other place gives it the hover text `GENERATED_SUMMARY_TITLE`.
- **Detail view.** A "Now" line at the top, under the title and above the waits: the summary, then "Generated summary · updated N min ago" from `generatedAt` (`WorkStreamNowLine`).
- **Active work cards.** Inline on every card, one line, under the step and wait line (`ActivityWorkStrip`).
- **List rows (Feed, squad Home, Work list).** Rows are unchanged by default. Hovering a row for about half a second (`WORK_STREAM_PEEK_OPEN_DELAY_MS`, 500 ms), or giving it keyboard focus, opens the **peek card**: the summary with "Generated summary · updated N min ago" (or "No summary yet."), the step with its waits ("Waiting on you: question" in the attention color when a person must act), the PR and CI line ("PR #996 · CI failing"), the participants (`agentIds`) with their activity dots, and the last update time (`updatedAt`). It is one component (`WorkStreamPeekCard` with `useWorkStreamPeek`) reused on every surface. It never takes focus on open; Escape closes it; blur and pointer leave close it after a short delay. The row's focusable element is `aria-describedby` a visually hidden description with the same facts, which is always present. Touch and pen never open it: a tap opens the detail modal as before, which shows the summary at the top.
- **"Show summaries".** A switch in each list's view or filter menu, off by default and remembered per surface (`feed`, `home`, `work`; web stores `ficus.wsSummaries.<surface>` in localStorage). On the Feed it is in the Filters popover under "View"; on the Work tab beside the filter row; on Home (no filters) in the Active section header. When on, each active row gets one muted, truncated summary line underneath.
- **Board cards (Work tab).** The summary inline on each card, clamped to two lines.
- **Graph (Work tab and Home's graph dialog).** The peek card on node hover and focus.

## Tests

- Core: `apps/core/src/services/stream-summaries/service.test.ts` (input selection, the refresh decision and throttle, output validation, the switch, the scheduler), `visibility.test.ts` (stale-step hiding, switch, parse rules) and `apps/core/src/routes/work-stream-summaries.test.ts` (DB-backed: participant rows only, the conditional save, the live event, list, detail and presence visibility).
- Web: `apps/web/src/components/WorkStreamSummary.test.tsx` (peek on hover, focus, Escape, blur and touch; the switch per surface; stale step; board card; graph; "Now" line).
- Browser (DB-free, real components and stylesheet, never run in CI): from `apps/web`, `CHROMIUM_PATH=/path/to/chromium bun scripts/check-work-stream-summaries.ts`, with optional `SCREENSHOT_DIR`, checks the peek delay and placement, the summary lines on the Feed, Work and Home lists, the board clamp and the "Now" line in light and dark, using `scripts/fixtures/work-stream-summaries.tsx`.
