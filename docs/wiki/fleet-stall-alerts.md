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

## Alert and recovery

The durable incident store retains its 30-minute demand window, deduplicated manager-first delivery, delayed human fallback and recovery cooldown. Original backlog age remains visible separately from the last-service clock that determines the deadline. Clearing all executable demand, or observing fresh scoped service/readmission after an incident began, resolves it; pending alert deliveries are canceled and only audiences that received an alert receive recovery. If a sweep missed the entire fresh-progress interval, the incident's clock advances to the actual evidence without inventing a healthy recovery, and already-expired demand can still alert. A healthy unrelated worker or a worker restart cannot resolve a scoped stall. Aggregate-only reconciliation callers without a scoped clock retain the older run-start/cold-start fallback.

The generic explanation says pending work has no fresh execution progress, rather than claiming that no agent run started. Its suggested read-only command is `ficus worker status`. The removed `ficus machines list` command is not present in current fleet-alert source. Command-reference tests check the real CLI tree and the applicable default squad-manager permissions; generic stall guidance is also checked for default workers. Machine/host diagnostics still require the operator's normal authorization; an alert grants no operational recovery authority.
