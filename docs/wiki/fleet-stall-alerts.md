# Squad stall alerts

A squad stall is unserved **executable demand**, not a lack of new execution starts. The fleet reconciler checks active squads once per minute. Paused streams, human/input waits, external delivery gates, startup backoff, terminated owners and maintenance holds retain their existing eligibility rules. Provider failures and degraded or overloaded sandboxes have separate incidents; the stall explanation only attributes a provider or sandbox that can explain this squad's pending demand.

## Foreground progress and the demand clock

Each runnable stream attempt has its own last-service/readmission clock, separate from the original backlog creation time. Its clock is the latest of:

- Stream/flow creation and the attempt's durable dispatch receipt: either its exact assignment inbox row or its inline response-assignment transition.
- Closed waits that blocked this attempt or the whole stream, and the owner's ended slot subscription when admission makes its work eligible again.
- Its latest attributed execution's claimed `run_started_at`, persisted assistant steps, and successful completion (`ended_at`). Progress survives execution completion; going idle between turns does not turn seconds-old work into an hours-old stall.

Pinned execution `flow_context` must match both the stream and, for mapped running attempts, the attempt. An execution without pinned provenance can supply a legacy fallback only when its owner has no other active/queued stream association. Assistant steps must belong to the exact agent/execution, not predate the claimed start, and not be in the future. The existing agent/execution message index supports these lookups. Worker/lease heartbeats, agent updates, human traffic, other attempts' executions and unrelated squad activity do not advance the clock.

The oldest runnable route clock wins: a progressing or supervising sibling cannot reset a stale sibling's deadline. A running/stopping execution with progress in the last 30 minutes is still active work rather than idle backlog. Once that evidence expires, its otherwise runnable attempt counts as demand again, anchored to its actual last progress rather than stream creation. A completed turn's progress receives the same bounded 30-minute window; it is not discarded at completion. Fresh dispatch and slot promotion also get a new eligibility window instead of inheriting the stream's entire waiting age. A requeued execution similarly retains its own claimed-start/assistant-step clock rather than reverting to its original queue creation time; another execution cannot advance that clock.

A single foreground operation with no persisted assistant step for 30 minutes does not renew foreground evidence. Use a supervised event monitor for long quiet background waiting, not repeated status output.

## Capacity and supervised waiting

A queued slot subscription is expected admission waiting. It excludes the owner's pending execution, inbox, scheduled inbox work and stream attempt from executable demand. This applies equally to squad-only pools, capped host-shared pools and host-shared budget queues. The alert code never recomputes capacity, clears subscriptions, requeues work or changes a pool. Waiters do not expire by age; promotion/cancellation ends them. Disabled/unregistered pools, terminal waiters and foreign-squad owners cannot suppress demand. Ended valid subscriptions restart the owner's newly eligible demand clock.

[Live monitors](agent-background-monitors.md#quiet-monitors-and-stall-alerts) keep their existing 150-second process-confirmation window. Managed local apps keep their existing two-hour start/owner-check-in window. Both remain agent-attributed, not squad-wide activity exemptions.

## Human questions and independent work

An open human question excludes its waiting stream/attempt and the exact workflow assignment inbox messages whose acceptance is fenced by that wait. The fleet regression tests create a real blocking question and reconcile the full demand snapshot into incidents: an old stream waiting only for its human input stays quiet, with no outage or slot evidence needed. Both attempt-scoped and whole-stream waits retain this behavior. When the wait closes, an old undelivered workflow assignment gets a fresh eligibility clock from the applicable closed wait instead of inheriting its old inbox creation age.

A question is not a blanket agent admission stop. `Agent.queueExecution` fences assignment messages through `lockFlowInboxDelivery`, but independently accepted control turns can still be queued and picked up. Their `flow_context` is captured for attribution/usage even when the owning attempt is waiting; that field alone does not prove the queued work is blocked. Existing queued turns and due startup retries remain executable under pickup's normal eligibility rules. The tests verify both real acceptance and the pickup claim while replacing only the external model/box runner.

Similarly, a scheduled inbox action carries schedule provenance, not an attempt assignment, and can actually emit independent reminder/control work while a question is open. Ordinary independent mail and current wait-resolution controls remain deliverable. Human answers use their dedicated durable answer-delivery protocol, not the ordinary inbox batch; a saved answer can be delivered while a different question on the same attempt still waits. Such independently actionable work remains demand and cannot borrow a question's closure clock to conceal an existing stall.

These distinctions do not authorize continuing the blocked task or clearing its question. A report that a stream is waiting does not, by itself, establish whether another queued turn, inbox item or due schedule is also waiting. Classify each source by its actual acceptance/delivery provenance rather than suppressing the entire agent or inferring an outage.

## Alert and recovery

The durable incident store retains its 30-minute demand window, deduplicated manager-first delivery, delayed human fallback and recovery cooldown. Original backlog age remains visible separately from the last-service clock that determines the deadline. Clearing all executable demand, or observing fresh scoped service/readmission after an incident began, resolves it; pending alert deliveries are canceled and only audiences that received an alert receive recovery. If a sweep missed the entire fresh-progress interval, the incident's clock advances to the actual evidence without inventing a healthy recovery, and already-expired demand can still alert. A healthy unrelated worker or a worker restart cannot resolve a scoped stall. Aggregate-only reconciliation callers without a scoped clock retain the older run-start/cold-start fallback.

The generic explanation says pending work has no fresh execution progress, rather than claiming that no agent run started. Its suggested read-only command is `ficus worker status`. The removed `ficus machines list` command is not present in current fleet-alert source. Command-reference tests check the real CLI tree and the applicable default squad-manager permissions; generic stall guidance is also checked for default workers. Machine/host diagnostics still require the operator's normal authorization; an alert grants no operational recovery authority.
