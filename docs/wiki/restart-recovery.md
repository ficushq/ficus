# Restart interruption context

## Attribution boundary

The stopping worker creates one `RestartContext` (`restartId`, `restartedAt`, UTC
ISO timestamp). The same object goes to command draining, the executor cancellation
RPC and the transactional shutdown recovery notice. `core_restart` is distinct
from `tool-abort`, `timeout` and `transport-loss`. The executor persists correlation
alongside `cancelReason`; `cancelRequestedAt` remains the actual receipt time.
Cleanup retries preserve the original cause.

The cancellation RPC must settle **before** disconnecting the command stream.
Otherwise the executor's disconnect handler can archive a transport loss before
it receives the restart cause. Cleanup still requires proof that no owned process
remains; an unconfirmed cleanup does not authorize blind replay.

The agent-visible error begins exactly:

> This command was cancelled by a Ficus restart at &lt;time&gt;; nothing is wrong with your work or the box. Re-run it when your sandbox is back.

It also includes `reason: core_restart`, the restart id, partial-effects guidance
and, when necessary, a warning that process cleanup was not confirmed.

A lost transport, expired admission lease or new process incarnation alone is
**not** proof that a restart cancelled the command. These retain unknown-loss
semantics, bounded recovery and the existing no-blind-replay protection. The
runtime does not retroactively re-label historical losses based on proximity to
a restart. Abrupt death without a committed shutdown marker remains unknown.

## Durable resume context

Shutdown commits the pause notice and correlation in message metadata together
with the exact admission downgrade and execution requeue. Resume looks up the
latest recovery marker for that exact agent and execution; a later unknown
interruption supersedes an older restart marker.

Before admission/session/sandbox startup can report another failure, resume
persists an idempotent correlated system notice. The first system stream event
and the prefix of the initial model prompt contain:

> Ficus restarted at &lt;time&gt;; any command running then was cancelled by the restart and may have partial effects. This is not an incident: check the affected state and re-run what was interrupted.

The pause and resume messages include the same restart id and time. A correlated
startup failure retains its actual error but is presented as a failed **resume
attempt**, with restart context, rather than a separate unexplained “Execution
failed” notice. This does not classify the new error itself as restart-caused.
Provider/auth policy and admission fences are unchanged.

## Recovery safety and verification

The shared agent doctrine instructs workers, engineers, reviewers, general agents
and managers to inspect partial output inside their authorized sandbox, wait for
sandbox recovery and retry safely with backoff. A known restart is a free retry;
unknown failures have a default budget of three. No restart alone warrants a
manual wait or a request for human platform forensics. Unknown external side
effects must be reconciled, not repeated blindly. Existing approval and pause
gates remain binding.

Focused tests cover exact tool text, RPC ordering, persisted registry cause,
cleanup retries, durable pause/resume correlation and idempotence, stale-context
rejection, notice-before-admission-failure ordering, first model-prompt context,
and a real subprocess interrupted after partial output then safely retried with
no wait created. The model-provider boundary uses a deterministic session fixture;
these tests do not claim to prove arbitrary model obedience.

This runtime contract is not server enforcement of structured waits or recovery
budgets. Those require the separately approved wait schema and routing changes.
Shared provisioning-follower retries are owned by provisioning recovery, not by
restart attribution. The executor-side fields require the updated executor bundle;
this change performs no live restart, artifact refresh or deployment.
