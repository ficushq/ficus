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

## Structured recovery decisions

Tool and execution boundaries persist recovery episodes and individual outcomes.
Three unexplained failures exhaust a cycle; the server enforces 1s then 2s backoff.
Repeated delivery of an invocation does not spend another attempt, and verified
restart interruption is free. Normal command exits, known filesystem/authorization
refusals, provider gates and deliberate cancellation retain their separate handling.
Budgets survive replacement executions and execution-log pruning. Only safe inner
transport operations and pre-model startup failures retry automatically; arbitrary
commands or external effects require local reconciliation before an explicit retry.

Exhaustion opens a generated Continue/Stop wait for the squad manager. A manager
can grant one extra cycle or forward to the requesting owner. Exhausting that extra
cycle automatically forwards the same server-generated action/count/error summary,
without diagnostic prose. Continue commits an audited cycle and a durable scoped
wake intent together; normal admission delivers it once, retaining other gates.
Stop keeps the scope held and removes repeated human requests. Missing eligible
managers leave a pending record and routing diagnostic, not an owner bypass.
Standalone tasks use the same policy and typed agent-recovery actions.

New manual inputs accept only versioned `continue`, `decide` or `provide` requests.
`continue` references an existing exhausted runtime record, not a caller-supplied
attempt count. `decide` declares task options; `provide` names only a task file,
config value or product choice. A shared validator rejects forensic evidence and
human-run commands, including disguised typed requests and human-question paths.
Credentials continue through protected credential/integration surfaces, never
plaintext task responses. Old waits retain their legacy response/history behavior.

For example, a legitimate owner-agent task input is:

```sh
ficus workstream request-input STREAM --content '{"schemaVersion":1,"kind":"provide","purpose":"task-input","actor":"owner","input":{"type":"config-value","name":"target branch"},"use":"choose the implementation base"}'
```

Resolve it with its current version and matching response kind:

```sh
ficus workstream resolve-input STREAM WAIT --content '{"action":"provide","expectedVersion":0,"value":"main"}'
```

Recovery buttons/CLI instead send `continue` or `stop`; only the designated manager
may `forward`. Standalone decisions use `ficus agent recovery AGENT RECOVERY` with
the same typed source. Generic unblock cannot clear a new structured wait. No
Continue or task response grants review, permission, deployment or merge authority.

The approved contract is documented in
[Structured recovery waits](../history/design/structured-recovery-waits.md).
Focused regressions cover concurrent accounting/decisions, manager-cycle limits,
owner-only routing, scoped parked continuation, legacy compatibility and typed UI/CLI.
Shared provisioning-follower retries are owned by provisioning recovery, not by
restart attribution. The executor-side fields require the updated executor bundle;
this change performs no live restart, artifact refresh or deployment.
