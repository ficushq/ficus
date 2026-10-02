# Work-stream status presentation

Status is a read-only projection, not permission to advance, resume, approve, or merge work. Stored `done` alone means delivery is complete. A completed implementation (`completion-ready`) does **not** mean delivered.

## Shared contract

`WorkStream.delivery` is an optional, server-owned `WorkStreamDeliveryPresentation`. It is separate from the reserved metadata delivery-observation ledger. Clients must use `selectWorkStreamPresentationState`, not infer gates from metadata or PR existence.

| Delivery kind | Display/action label      | Semantic role | Human attention | Native bucket |
| ------------- | ------------------------- | ------------- | --------------- | ------------- |
| `approval`    | Approve Delivery          | review        | yes             | needsYou      |
| `review`      | Review Pull Request       | review        | yes             | needsYou      |
| `merge`       | Merge Pull Request        | review        | yes             | needsYou      |
| `external`    | Awaiting Code Host        | externalWait  | no              | externalWait  |
| `setup`       | Delivery Setup Required   | attention     | no              | blocked       |
| `failure`     | Delivery Changes Required | danger        | no              | blocked       |

Precedence: terminal stored status, explicit pause, explicit waits (review > question > dependency > manual), execution failure, recognized delivery fact, then ordinary execution/queue/idle derivation. The exact workflow-owned manual delivery-approval wait is identified by `approvalWaitId` and presented as approval; unrelated manual waits remain blockers. No wait is changed or synthesized by presentation.

An explicit `openWaits: []` still clears stale wait-derived states. Delivery is an independent positive fact, so it survives `[]`. Omitted waits retain older-server compatibility. Unknown future delivery kinds are ignored. Older clients may retain their historical rendering; the stored status and existing derived-state vocabulary remain unchanged.

Core loads flow, binding, policy and routed integration evidence in batch, without provider HTTP calls in serializers. Only activated completion-ready flows participate. Missing binding/routing or mismatched branches are setup problems. Unknown provider evidence and individual successful CI runs are external waits, not proof that required checks or reviews passed. PR events must match the configured provider/repository/number/connection and observed head. Late CI for another head cannot establish the current PR head. Current conflict, failing CI, closed PR and changes-requested evidence remain alarming. A positive aggregate GitHub `mergeable_state=clean` snapshot permits a merge label for human-merge policy; auto-merge policy stays external unless squad policy requires its documented human fallback. Additional designated delivery PRs participate too. Actual completion still uses the existing live provider verification and workflow guards.

### Delivery explanation

`WorkStreamDeliveryPresentation.explanation` is optional, additive and server-owned. It is published only for `setup` and `external`, and carries facts the classifier already used. Omitted fields mean unknown: clients fail soft to the generic label and must not infer them from metadata.

- `setupReason`: `unbound` (no bound delivery PR), `not-following-changes` (bound, but the flow does not follow code-host changes), `branch-mismatch` (with `branchMismatch` stream/PR branch pairs), or `direct-merge-facts` (missing binding, full commit SHA or base branch).
- `pullRequests`: every designated delivery PR, primary first, with its observed state. It is open unless a merge or close was positively observed; states are matched by repository and number.
- `gates`: merge state, checks rollup, review decision, draft and pending human review for the deciding PR. Live pending check events outrank an older rollup. A stale snapshot contributes only draft to the explanation, and a merged PR contributes none.

Web derives the `external` pill from these facts in order: all PRs merged → “PR merged — finalizing delivery”; draft → generic; pending checks → “Awaiting CI”; required or pending human review → “Awaiting review”; blocked merge → “Blocked by branch protection”; open PRs → “Awaiting merge of #N” (at most three numbers, then “+N more”); otherwise “Awaiting Code Host”. The detail modal's setup callout explains the setup reason, names its next step (for example the exact `ficus workstream set-meta` bind command), and adds a branch-protection note only as supporting evidence.

### Asynchronous provider evidence

Designated PRs in activated, completion-ready delivery flows refresh a presentation-only snapshot through the existing leased, budgeted GitHub polling runner. These watches retain the runner's active polling cadence (60–120 seconds), including when verified webhooks suppress ordinary fallback watches. A poll that runs out of the shared per-tick request budget is released unchanged and retried on the next tick rather than backed off as a provider failure. One bounded GraphQL query reads the current head, merge state, aggregate check rollup, required-review decision, and explicit reviewer types. `REVIEW_REQUIRED` identifies a review gate even when no reviewer has been requested, including for `pr-auto-merge` flows with native auto-merge enabled. If aggregate access is unavailable, a fresh REST response is weaker evidence (a 304 never renews cached readiness): REST cannot see the required-review decision, so the snapshot (marked `source: rest`) keeps the previous same-head aggregate decision rather than replacing it with `unknown`. A poll that produces no observation keeps the previous snapshot with its original observation time. Unknown review requirements are never guessed.

Snapshots are versioned in the existing polling cursor and scoped to squad/connection/repository/PR. Their readiness facts (merge state, check rollup) expire after five minutes; an expired snapshot still contributes its head, lifecycle state, draft flag, and review facts. Serialization batch-reads this local cache alongside routed facts; it never calls GitHub. Baselines and same-head aggregate changes do not synthesize activity, inbox deliveries, waits, or flow transitions. A changed or cleared durable snapshot invalidates the existing status/attention/native-interest read models. Refreshing only its observation timestamp is silent.

Current-head evidence is reduced by provider observation order, not by event name: a full snapshot attached to a review can establish aggregate readiness, later successful individual CI does not erase that readiness, and a successful workflow cannot establish readiness by itself. Explicit unknown aggregate fields supersede older positive readiness; omitted fields in sparse events do not. The latest check-rollup observation independently blocks merge while pending. New aggregate review/check facts supersede older negative evidence; later failures remain alarming, including on drafts. Review dismissal is reflected by the provider's refreshed aggregate decision without introducing a new routed review event. Unknown, stale, mismatched-head, or mismatched-scope observations cannot advertise a human merge gate.

A human review requirement is a standing fact of the current head rather than a readiness proof, so it does not expire with its observation. The latest same-head evidence that carries a review decision decides: `required` presents `review` ("Review Pull Request", Needs you) until a newer same-head approval, a newer aggregate without the requirement (approved, or GitHub's explicit no-decision `unknown`), a merge, a close, or a new head supersedes it. Likewise the latest same-head event carrying reviewer facts decides whether an explicit human (user or team) reviewer request is pending; sparse events such as comments and CI runs carry none and cannot clear it. Ficus cannot know which users may approve, and does not need to: a required human review is human attention. Pending CI, a merge queue, or auto-merge with review satisfied remain `external`; drafts stay generic; failures, conflicts and changes-requested stay alarming.

Because `review` and `merge` are not `external`, the `automatedReviewGate` annotation never applies to them, and the shared canonical order keeps human delivery gates in the human-actionable tier (0) even if an older or inconsistent payload sets the annotation. `pr-auto-merge` therefore counts as automated only when no human review is pending.

### Pending actions

Delivery `review` and `merge` gates have no wait, so Core can also list them in `/api/actions/pending` as `workstream-delivery` actions (the web feed's Needs you section and Action Center, and the Assistant's Needs you tool) with the stream, the delivery kind, and its open designated pull requests. They are computed from the same batched classification, only for unpaused streams without an open wait (which has its own action), and are view-only: the person acts on the code host, and delivery completes when the provider settles the gate. Visibility follows the squad's `actions:read` permission and the stream's `decisions` attention level. The type is **opt-in**: only requests with `?include=workstream-delivery` (client-core `listPendingActions({ include: ['workstream-delivery'] })`) receive it, and the default response is unchanged. Shipped mobile builds render every pending action through an exhaustive switch without a fallback and would fail on an unknown type, so mobile must add an unknown-type fallback and delivery-gate rendering before opting in. Its Work tab Needs you section already follows the shared selector.

### Manual wait actors

Each manual wait records who must act (`WorkStreamWait.actor`, manual waits only). The column defaults to `human`, so existing rows and callers that omit it keep today's behavior; nothing infers an actor from message text. Consumers treat a missing or unknown actor as `human`.

| Actor   | Presentation state | Label            | Semantic role | Human attention | Native bucket | Canonical order (active)                |
| ------- | ------------------ | ---------------- | ------------- | --------------- | ------------- | --------------------------------------- |
| `human` | `blocked`          | Blocked          | attention     | yes             | needsYou      | tier 0 (human-actionable)               |
| `owner` | `waiting_on_owner` | Waiting on Owner | externalWait  | no              | externalWait  | tier 3 (with dependency/external waits) |

`owner` means the stream's owner agent, or the squad manager when the stream has none. Provider or third-party events also use `owner`, with the wait message naming what it waits on. When several manual waits are open, any human wait wins (human > owner). Wait-type precedence is unchanged: a question, review or dependency still outranks any manual wait, and the exact workflow-owned delivery-approval wait (`approvalWaitId`) is still presented as approval. Workflow human-approval gates keep the default `human` actor and cannot be relabeled.

The actor changes attribution only. Every manual wait blocks admission, auto-parking, queued positioning (`queuedHasWait`) and flow attempts exactly as before. `waiting_on_owner` is presentation-only: Core's `derivedState` keeps `blocked` for older consumers, and older clients that ignore `actor` keep their historical Needs you rendering. The native bucket reuses `externalWait` rather than adding a value, so older native binaries keep rendering these rows as a known, non-alarming wait.

Notifications follow the same rule. Human watchers (inbox and push), channel notifications and Action Center items are produced only for human-actor waits. An open owner wait still outranks a delivery gate, so such a stream presents as `waiting_on_owner` and gets neither a wait action nor a `workstream-delivery` action. The owner agent (else the squad manager) is still woken for every actor, with an actor-specific message. Correcting an open wait's actor (`POST /api/workstreams/:id/waits/:waitId/actor`, CLI `ficus workstream wait-actor`) is limited to users with `workstreams:update`, the owner agent or the squad manager. The change is appended to the wait's `actorChanges` audit trail. It never closes, reopens or re-dispatches the wait, and it sends the normal blocked notice when the new actor is `human`.

## Resource subscriptions and ordinary idle

`WorkStream.hasActiveSlotWait?: boolean` is additive, server-owned context, not a new wait or lifecycle state. An **otherwise idle** stream with `true` presents as `waiting_for_slot` (“Waiting for slot”), using the subdued informational `queue`/cyan palette. Ordinary `idle` is neutral gray. Human manual blockers and delivery setup use amber `attention`; actual execution and delivery failures remain red `danger`. Existing owner/dependency/external wait palettes are unchanged.

Terminal states, pause, explicit waits, failures, delivery gates, admission queue and live execution all retain precedence. Active participants may have slot subscriptions without the stream becoming Waiting for slot. The stored status and `derivedState` vocabulary stay unchanged: older clients still receive `idle`, while new clients select the extra presentation state from the optional fact. Missing or false means **no proven current stream wait**, not proof that none of its agents has ever subscribed.

Attribution is conservative. Core batch-loads current running attempts of activated running flows, then matches a live queued subscription to the participant's execution interval at enqueue time and that execution's exact `flowContext` stream/attempt. Historical participants, previous attempts of a reused agent, unrelated streams and waits outside a provable execution context do not qualify. The existing slot projection excludes granted/canceled/ended waiters, inactive pools, archived squads and invalid owners. Legacy non-flow or otherwise unattributable subscriptions remain visible in agent chat, but do not become stream status. Reads never claim capacity, suspend work, or change scheduler/continuation authority.

The boolean follows existing work-stream read authorization and contains no pool names, agent identities, counts, rank or capacity. Pool details remain behind `GET /api/agents/:id/slot-waits`, which requires both agent visibility and `slots:use` or `slots:write` in the agent's squad. Its response remains `[{ waiterId, poolKey, queuedAt }]`.

Agent chats render a compact informational status **beneath the header**, in normal layout flow above messages. Idle agents say “Waiting for slot”; active/other states retain secondary “Slot queue” context. Distinct names always follow the label inline, separated by middle dots, and wrap naturally without disclosure controls, counts or nested scrolling. Both platforms use static, neutral outlined icons: an hourglass for waiting/queue context and a ticket for holding capacity. Web places one neutral bottom divider below the combined status area, removing it when no status is shown. Native centers each compact, inset, non-interactive `GlassSurface` horizontally, retaining the supported-platform fallback and readable wrapping text. Agent/subagent indicators retain their separate dot treatment. No queue text is placed in composer controls. Permission errors, read failures and cached rows still being revalidated cannot advertise a live wait. `slots.updated` (squad topic) and reconnects refresh both chat and stream projections.

### Held slots in agent chat

Chat also shows live ownership as “Holding slot: name” (or “Holding slots” for multiple distinct names). Holding and queue facts use separate matching compact rows; neither replaces the other, and holding is informational even when the agent is idle. Names are deduplicated per state and wrap without truncation. This changes no work-stream state, aggregates, ordering, widget/Live Activity contract or coordination behavior.

The optional `GET /api/agents/:id/slot-holds` returns `[{ poolKey, expiresAt }]`, with ISO JSON expiry timestamps. It uses the same agent visibility and squad `slots:use`/`slots:write` authorization as slot-waits; visible squadless agents return `[]`. Only active, unended, database-clock-unexpired claims owned by the viewed agent qualify. Live pool/squad and matching agent squad membership are required; dormant, terminated or deleted owners are excluded before reconciliation. Claim IDs, authority tokens, capacity and rank are never exposed.

The clients validate held response names/expiry directly from raw JSON. Reads remain independent: an unsupported endpoint on an older server, permission/read failure or revalidation hides held context without erasing valid waiting context. Existing squad `slots.updated`, agent/lifecycle changes and reconnect revalidation repair the projection. A local one-shot lease deadline also removes expired names without polling; renewed expiry replaces that deadline. Native additionally uses its existing foreground revalidation. No SDK, shared status or packed-package contract change is required.

Widget summary `top[]` rows carry the same optional boolean, including explicit false for clearing. Detailed native rows can use it without changing their aggregate protocol. Proven idle slot waits use the **existing** `externalWait` aggregate bucket; ordinary idle retains its historical aggregate bucket while its detailed label is neutral Idle. Vocabulary, total count and ranking algorithm are unchanged. Slot lifecycle events also refresh the existing coalesced Live Activity fanout: recomputation includes squad subscribers and direct subscribers to nonterminal streams in that squad, with effective attention, authorization, token checks and unchanged-state suppression still applied. No synthetic work-stream lifecycle event or agent wake is emitted.

## Native projection and version skew

`workBucket` deliberately aggregates human review, questions and human-actor manual blockers into amber `needsYou`. Owner-actor manual waits use `externalWait`. It preserves execution failures as `blocked`, uses neutral `paused`, and distinguishes orange `externalWait` from failures. Neither paused nor external work contributes to running or Needs you counts. Terminal rows are not part of Core's nonterminal interest query.

Widget summaries add an authoritative optional `bucket`, boolean `pause` (never private pause reasons), and typed `delivery`. Prefer `bucket` when present; older payloads can fall back to the shared selector. This also preserves the omitted-waits compatibility projection without fabricating waits. `openWaitTypes` remains an explicit array for existing native decoders. New `bucketCounts.paused` and `bucketCounts.externalWait` keys are optional in the consumer type, and should default to zero against older servers. Interest authorization, uncapped counts, title privacy and attention-first ordering remain unchanged. Foreground snapshots and APNs use the same builder.

Source compatibility was inspected at `ficushq/tau-mobile` commit `c84b39e57de916a7acfeda2987e01c8d529c98e1`:

- Both copies of `FicusWorkAttributes.swift` decode bucket as `String`, not a closed Codable enum.
- `WorkStreamsClient.swift` likewise decodes Live Activity buckets as strings and ignores additive summary/count fields.
- `StatusPalette.swift` maps unknown strings to neutral `.unknown`; an older Live Activity therefore shows neutral “Unknown” for the new buckets rather than rejecting its entire update.
- Older widget rows recompute their own buckets and cannot adopt the new semantics until updated; server totals remain authoritative. This is source verification, not a claim about every installed binary.

### Mobile adoption

Actor-aware manual waits need the same adoption: map the `waiting_on_owner` label in JS adapters, and let native decoders tolerate the optional wait `actor`. Until then, older mobile builds render owner waits as Needs you in their own rows, while server-owned widget buckets and counts already exclude them.

Repack the shared package from the **independently reviewed, merged Core commit**, recording the actual source SHA and package checksum. Do not use an unreviewed branch archive. Update JS adapters plus both Swift attribute copies, native bucket/label/color mapping and widget summary decoding together. Map `paused` to neutral and `externalWait` to orange; retain amber Needs you. Preserve unknown-value fallback. Consume optional new count keys with zero defaults, and prefer the server's summary bucket. Run foreground/APNs parity, legacy-payload decoding and widget fixtures before release. This contract does not authorize a mobile release.

The matrix in `packages/shared/src/test-fixtures/work-stream-presentation.ts` is exercised through Core derivation/serialization, shared selection/attention/native projections, and visible web badges.
