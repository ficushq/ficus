# Squad stall alerts

A squad stall is unserved **executable demand**, not a lack of new execution starts. The fleet reconciler checks active squads once per minute. Paused streams, human/input waits, external delivery gates, startup backoff, terminated owners and maintenance holds retain their existing eligibility rules. Provider failures and degraded or overloaded sandboxes have separate incidents; the stall explanation only attributes a provider or sandbox that can explain this squad's pending demand.

## Foreground progress

A claimed `executions.run_started_at` gives a 30-minute grace period. After that, recent persisted assistant steps for the **same agent and execution** count as foreground progress. The query uses `messages.metadata.executionId`, `role = 'assistant'` and `created_at`, within the last 30 minutes and not in the future or before the claimed start. The existing agent/execution message index bounds these lookups. Sequential foreground tool checks persist assistant steps as the session advances; they do not need another execution to start.

Worker and admission-lease heartbeats, agent updates, human messages, another execution's messages and sandbox activity do not prove foreground progress. A `running` or `stopping` row alone cannot protect a stream forever: once its evidence expires, its otherwise runnable attempt counts as demand again. A single foreground operation that produces no persisted assistant step for 30 minutes does not renew this evidence. Use a supervised event monitor for long quiet background waiting, not repeated status output.

Mapped attempts are evaluated against their own eligible agent, so a progressing or supervising sibling cannot hide an idle/stale sibling. An attempt without an agent binding uses the stream's busy state as a conservative fallback. The demand snapshot carries its scoped unserved-demand clock; unrelated same-squad run starts cannot postpone or resolve that stall. Aggregate-only reconciliation callers without a scoped clock retain the older run-start fallback.

## Capacity and supervised waiting

A queued slot subscription is expected admission waiting. It excludes the owner's pending execution, inbox, scheduled inbox work and stream attempt from executable demand. This applies equally to squad-only pools, capped host-shared pools and host-shared budget queues. The alert code never recomputes capacity, clears subscriptions, requeues work or changes a pool. Waiters do not expire by age; promotion/cancellation ends them. Disabled/unregistered pools, terminal waiters and foreign-squad owners cannot suppress demand.

[Live monitors](agent-background-monitors.md#quiet-monitors-and-stall-alerts) keep their existing 150-second process-confirmation window. Managed local apps keep their existing two-hour start/owner-check-in window. Both remain agent-attributed, not squad-wide activity exemptions.

## Alert and recovery

The durable incident store retains its 30-minute demand window, deduplicated manager-first delivery, delayed human fallback and recovery cooldown. Old demand that becomes runnable after stale progress or an ended slot wait can alert on the next sweep once its original demand window has elapsed. Clearing all executable demand, including renewed scoped foreground progress or a valid wait, resolves the incident; it cancels pending alert deliveries and only sends recovery to audiences that received an alert. A healthy unrelated worker does not resolve an incident while other scoped demand remains unserved.

The generic explanation says pending work has no fresh execution progress, rather than claiming that no agent run started. Its suggested read-only command is `ficus worker status`. The removed `ficus machines list` command is not present in current fleet-alert source. Command-reference tests check the real CLI tree and the applicable default squad-manager permissions; generic stall guidance is also checked for default workers. Machine/host diagnostics still require the operator's normal authorization; an alert grants no operational recovery authority.
