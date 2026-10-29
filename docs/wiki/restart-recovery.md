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
and the real SDK Bash tool through its recovery wrapper, streaming HTTP executor
process and on-disk invocation registry. Restart drain interrupts partial output;
a subsequent explicit safe retry proves zero unexplained failures and no wait. The model-provider boundary uses a deterministic session fixture;
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
Stop keeps the scope held and removes repeated human requests. Missing eligible managers and a manager’s own recovery route directly to an eligible owner. A shared resolver prefers the requesting user/agent owner, then authorized squad operators/admins. If nobody is eligible, it persists an idempotent system diagnostic and keeps the hold without granting authority. Detail/list views project the same current audience as Action Center if manager availability changes; this does not rewrite the wait audit or grant a cycle.
Standalone tasks use the same policy and typed agent-recovery actions.

New worker manual inputs accept only versioned `continue`, `decide` or `provide` requests. People and managers retain `request-input --message` for ordinary task waits; this does not clear or bypass a structured recovery decision, or disguise the manager’s own unresolved failures in that same scope.
`continue` references an existing exhausted runtime record, not a caller-supplied
attempt count. Product choices use `decide`. `provide` requires either
`input: {"type":"file","path":"assets/logo.svg"}` (workspace-relative; the response
is also a workspace-relative path), or a `config-value` with an exact `key` and
`declaredIn`. A workspace JSON declaration must contain that top-level key or JSON
Schema `properties` entry. The server namespace `ficus:work-stream` declares only
`git.worktree`, `git.branch` and `git.baseBranch`, so missing worktree setup does
not itself require a workspace declaration. The server validates file-backed
declarations with bounded, canonical workspace reads before taking wait locks;
remote executors must support scoped-read proof. This never provisions an executor.
A narrow shared guard additionally rejects forensic asks and human-run commands,
including disguised typed requests and human-question paths, while preserving
product logging/registry questions and agent-proposed actions.
Credentials continue through protected credential/integration surfaces, never
plaintext task responses. Old waits retain their legacy response/history behavior.

For example, a legitimate owner-agent task input is:

```sh
ficus workstream request-input STREAM --content '{"schemaVersion":1,"kind":"provide","purpose":"task-input","actor":"owner","input":{"type":"config-value","key":"git.baseBranch","declaredIn":"ficus:work-stream"},"use":"choose the implementation base"}'
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

### Confirmed tool outcomes

Expected command exits, confirmed host deadlines, missing task paths and edit
conflicts are typed feedback, not unexplained executor failures. Host deadlines
keep the SDK's partial output and process-tree cleanup while carrying trusted
timeout provenance. The executor's error-plus-127 frame remains a chargeable
startup/process failure; a command that merely exits 127 is ordinary feedback.
No classification reads an error message to infer its cause.

### Scope continuity and accounting failures

Tool budgets use the tool family and normalized target: the command for Bash,
the path for file operations, and stable arguments for other tools. Ordinary
unquoted command spacing and timeout parameters do not buy a fresh budget;
quoted data and complex scripts retain their semantics. An unrelated successful
inspection or explained error does not settle a failing target. Only a confirmed
success of that same target resolves its episode.
Within a stream, successor attempts retain the allowance; a revised workflow
participant also retains it when a fresh agent replaces the previous session.
Unrelated participants/scopes stay separate, and ambiguous concurrent lineages
are not rebound. Confirmed successor episodes inherit manager-cycle and owner
escalation state. Temporary manager-unavailability fallback stays on that record;
it is not inherited as permanent owner escalation. Replanning (including decision
steps) retires a wait binding, not its retry allowance.
Late failures remain durable even if their old attempt cannot open a wait; a
valid successor must bind the hold before retrying. An exhausted watchdog cycle
without a current owning attempt emits an idempotent internal diagnostic rather
than silently disappearing or granting an unrelated attempt authority.

Any unresolved unexplained failure in the relevant scope gates worker task input,
including failures one and two. Restart-only records do not, and a stopped
incident in another stream cannot suppress legitimate questions.

Healthy tools use non-locking reads, not recovery transactions or agent/stream
row locks. Recording failures degrade to logging; they do not turn a confirmed
tool result into a failure. An already-observed hold remains authoritative even
if a later accounting read, rebind or notification fails.

The continuation watchdog uses the same generated manager/owner recovery card,
with three real delivery failures or the existing three provider-transport
continuations. Its counters, not agent prose, populate the ledger. Delivery
failures that never created an execution have a null execution reference.
Continue resets the native counter atomically with the audited cycle and wake;
execution-start events cannot clear these typed holds. Historical untyped
watchdog waits retain their narrower legacy stale-wait cleanup.

The first actual model tool can confirm continuation or replay-safe startup
progress before a legitimate task question. It cannot settle a post-startup
execution failure or authorize a held cycle. Consumed system recovery receipts
remain task provenance after confirmation, without regaining delivery authority.
