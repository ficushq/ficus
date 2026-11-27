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

> This command was cancelled by a Ficus restart at &lt;time&gt;; partial effects are possible.

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
persists an idempotent correlated system notice. The agent and the people in
the chat get different copies of it:

- **The agent** reads it as the prefix of the resumed turn's model prompt:

  > Ficus restarted at &lt;time&gt;; any command running then was cancelled by the restart and may have partial effects. This is an interruption, not an incident, and a free retry: once the sandbox is back, check partial output and affected state, then re-run only safe, idempotent work. Never repeat an unknown external side effect; other gates still apply. [restart id: &lt;id&gt;]

  The id matches the one on every command the restart cancelled, so the agent
  can tie those failures to the restart.

- **The chat** shows system rows without the id or a raw timestamp (the row
  shows local time on hover): "Paused for a restart; it will resume
  automatically." at shutdown, and "Resumed after a restart." at resume. The restart id and time stay in each
  message's metadata, which is what resume reads.

A correlated startup failure retains its actual error but is presented as
"Resumed after a restart, but the run could not finish: &lt;error&gt;", rather
than a separate unexplained “Execution failed” notice. This does not classify the new error itself as restart-caused.
Provider/auth policy and admission fences are unchanged.

## Hard interruptions: no shutdown marker

When Core dies without draining (OOM, SIGKILL, node loss), startup recovery
(`recoverInterruptedExecutionsForStartup`) or the abandoned-lease sweep
(`requeueAbandonedLeaseExecutions`) requeues the execution. Their chat notice
records the cause in metadata as `interruptionCause`: `core_restart` for startup
recovery, `lease_lapsed` for the sweep. Nothing was drained, so the pi session
file holds the assistant message with any tool call that was running, but not its
result. On the next model request pi-ai would fill that gap with a generic
`No result provided` error.

On pickup, `findHardInterruption` reads the execution's latest recovery notice.
When it is a hard one (not a graceful pause marker), the base runner:

- records the calls the interruption cut off as a `ficus:interrupted-tool-calls`
  session custom entry, once per notice
  (`services/agent/interrupted-tool-calls.ts`). A call counts only when it is in
  the session's last assistant message, has no result after it, and that message
  was written after the execution was created and before the notice. Any other
  missing result keeps pi-ai's placeholder.
- prefixes the resumed prompt with `interruptedResumeNotice` ("Ficus recovered
  this run at &lt;time&gt; after an unexpected Core restart. …", or "after the
  Ficus worker running it stopped unexpectedly" for a lapsed lease) and the
  shared `RESTART_RECOVERY_BRIEF`. It is sent until a prompt reaches the
  session, so a pickup that fails before prompting repeats it and a later requeue
  of the same run does not. Before this, the chat notice was the only trace of a
  hard interruption, and it never reached the model.

A pi `context` hook (`createInterruptedToolCallsExtension`, registered by
`FicusResourceLoader`) answers each recorded call that still has no result with
a specific error result, chosen by the tool's replay class:

| Class        | Result after "The &lt;tool&gt; call was interrupted by an unexpected Core restart before it returned a result (recovered at &lt;time&gt;). No output was kept." |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe`       | "&lt;tool&gt; only reads, so it is safe to run again."                                                                                                          |
| `idempotent` | "It may or may not have completed. Running it again with the same arguments leaves the same final state, so it is safe to repeat."                              |
| `unsafe`     | "It may have partially run or completed. Inspect the current state before retrying, and do not repeat an external side effect whose outcome is unknown."        |

A call with the same tool and exact arguments that an earlier interruption in the
same session already cut off gets the cautious wording whatever its class: it was
interrupted by a restart before, so it may be what caused it (a read or search
large enough to exhaust memory). The model is told not to run it again as is and
to narrow it first. Nothing else caps a crash loop yet; requeueing a run does not
count against the failure budget.

The hook rewrites only pi's copy of the context; the session file keeps the call
without a result. The Claude Code bridge receives that same context, so a session
re-seeded after the crash (a pending tool result always re-seeds) shows the same
result in its transcript. Nothing is rerun automatically.

### Tool replay classes

Every built-in tool has a replay class in one table, `apps/core/src/tools/metadata.ts`:
`safe` (reads only), `idempotent` (a repeat with the same arguments leaves the same
final state, or is refused) or `unsafe` (a repeat may duplicate an effect). A tool
that is not listed, including pi extension and integration tools, is `unsafe`.
`wrapToolWithRecovery` puts the class on each session tool definition as `ficus`
and as pi's standard `annotations` hints (`readOnlyHint`, `idempotentHint`).

The recovery wrapper also has a budget rule for the class: a `safe` or
`idempotent` call that a lost sandbox connection cut off mid-call
(`BashOutcomeUnknownError`, or a response-phase `SandboxTransportError`) is not
recorded as an unexplained failure, and its error says it is safe to run again. The
same interruption of an `unsafe` tool still counts. Today the rule has no effect on
built-in tools: only the Bash stream reports these errors, and Bash is `unsafe`;
unary sandbox reads and writes classify every transport failure as `connect`, which
counts for every tool. It applies once those transports report response-phase
failures. Restart-tagged cancellations stay free for every tool as before, and a
hard crash records nothing.

## Failed resumed runs

A resumed run is one the platform requeued after an interruption: a graceful
worker stop, startup recovery from a dead process, or the abandoned-lease sweep.
Each of those paths commits a system message carrying
`admissionRecoveryExecutionId` for the requeued execution, and that marker is
the durable proof (`services/execution/resumed-run-failure.ts`). When such a run
fails, at startup or mid-turn, `Execution.fail` checks whether the agent still
holds an active slot claim or owns a running flow attempt in an active stream.

- If the failure is counted by bounded recovery and the episode is still
  recovering, `recordRecoveryFailure` commits one wake with the same fenced
  `recovery-startup:<recovery>:<version>` key as the startup retry. The brief
  names the failed execution, says the interrupted outcome is unknown and may
  have partial effects, forbids repeating an external side effect before it is
  confirmed, and lists each slot claim (id, pool, expiry) and flow attempt
  (stream number and id, attempt, step). Delivery rechecks the recovery
  version, pause, attempt waits and agent status exactly as for other recovery
  wakes. The episode is never `startupOnly`, so a model tool cannot settle it.
- A resumed run that fails at startup without obligations still gets its
  bounded retry, but with that unknown-outcome brief instead of a replay of the
  retained request. A resumed run without obligations that fails mid-turn is
  unchanged: it is not woken.
- When no deliverable wake exists, because the failure is not counted (an
  admission or provider refusal), the budget is exhausted or held, or a pause
  or wait blocks delivery, one `resumed-run-stranded` notice per execution
  carries the claim and attempt identifiers. It is routed by the bounded-recovery
  audience for the episode's current state (manager first; the owner once the
  episode is owner-escalated or no manager is eligible). With no eligible
  recipient it becomes an idempotent `resumed-run-stranded-unroutable` system
  diagnostic. It grants no authority and lifts no gate; the generated Continue /
  Stop card is still sent on exhaustion.

The wake starts an ordinary run without the resume marker, so its own failure
is counted but cannot re-wake the agent. Only a new interruption and resume can,
and each counted failure spends the same three-attempt budget. Lookups fail
open to the previous behavior and never block terminalization.

This closes the gap behind the Desktop 0.5.23 and 0.5.24 release slot expiries.
Both were resumed runs that failed in sandbox setup (`phase_sandbox-ensure` with
a lost bash outcome, and `phase_sandbox-drift-recreate` with a box-provision
exit 3). Nothing woke the agent until its production-change claim expired.

## Recovery safety and verification

Always-loaded shell rules keep the safety needed before a tool is chosen:
inspect affected state in the authorized sandbox, retry only safe idempotent
work, bound unexplained retries to three per operation with backoff, and never
repeat an external side effect whose outcome is unknown. A transport loss is
not restart proof. The recovery-waits include keeps native holds, runtime-owned
counts and references, and the prohibition on human forensic/credential requests.

The resumed prompt owns **one restart instruction brief**. Other surfaces retain
facts and distinct events, not copies of that procedure:

| Surface                                                 | What it carries                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restartResumeNotice`, prefixed once by the base runner | Correlation plus the shared `RESTART_RECOVERY_BRIEF` (free retry, safe recovery) for an execution resumed after a **worker** restart.                                                                                                                                     |
| `interruptedResumeNotice`, prefixed by the base runner  | The cause and recovery time plus the shared `RESTART_RECOVERY_BRIEF`, for an execution resumed after a **hard** interruption (startup recovery or the lease sweep). Never in the same prompt as `restartResumeNotice`.                                                    |
| Cut-off tool results (context hook)                     | Per-call fact and the tool's replay class (safe to run again, safe to repeat, or inspect first). No general restart procedure.                                                                                                                                            |
| Command drain errors/refusals                           | Per-command outcome and correlation; unconfirmed cleanup still requires process inspection. No general replay instructions.                                                                                                                                               |
| Recovery tool wrapper                                   | For a box-only restart (the execution keeps running, so no resumed prompt follows) it appends the same `RESTART_RECOVERY_BRIEF` once to the tool result. For a worker restart it adds nothing. Unknown losses and native holds still carry their own safety instructions. |
| Startup pause/resume chat rows                          | Status and durable correlation metadata, not another agent procedure.                                                                                                                                                                                                     |
| Failed-resume wake                                      | A **new failure** with unknown outcome and live obligations; its new execution has no restart resume marker.                                                                                                                                                              |
| Recovery decision/continuation notices                  | Native versioned decision or authorized bounded cycle, not another restart notice.                                                                                                                                                                                        |

Exhaustion and decision procedures arrive with the actual native recovery
record: tool errors retain the issued id/version, and the designated manager's
notification carries inspection, one-cycle/forwarding, Stop and gate-preservation
instructions. Routing fallback, attempt counting and authorization remain
runtime-owned; no new accounting or recipient inference is introduced.

Include ids and lists are unchanged. Config sync updates unoverridden shared
prompt content; instance content overrides remain intact. Custom types still
resolve their existing `rules`, `squad-rules` and `recovery-waits` ids at compose
time. No new include migration is needed or run by this rewrite.

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
transport operations, pre-model startup failures and failed resumed runs (with an
unknown-outcome brief, see above) retry automatically; arbitrary
commands or external effects require local reconciliation before an explicit retry.

Exhaustion opens a generated Continue/Stop wait for the squad manager. A manager
can grant one extra cycle or forward to the requesting owner. Exhausting that extra
cycle automatically forwards the same server-generated action/count/error summary,
without diagnostic prose. Continue commits an audited cycle and a durable scoped
wake intent together; normal admission delivers it once, retaining other gates.
Stop keeps the scope held and removes repeated human requests. Missing eligible managers and a manager’s own recovery route directly to an eligible owner. A shared resolver prefers the requesting user/agent owner, then authorized squad operators/admins. If nobody is eligible, it persists an idempotent system diagnostic and keeps the hold without granting authority. Detail/list views project the same current audience as Action Center if manager availability changes; this does not rewrite the wait audit or grant a cycle.
Standalone tasks use the same policy and typed agent-recovery actions.

### Deterministic provider request validation

A specific Codex request-schema rejection opens the same native recovery decision
**on the first actual failure**, without spending fictitious retries. The closed
classifier requires `ToolSearchOutputFunctionToolNameParam`, `input[index].name`,
`invalid_string`, and the matching function-name pattern rejection. It prefers
retained Codex event diagnostics; the exact validator text is the fallback when
Pi has flattened the event. Generic HTTP 400 errors, unrelated `invalid_string`
messages, normal user-tool argument validation, transport failures, context
limits and provider authorization/cooldowns keep their existing policies.

The execution is stored as `provider_model` with reason
`request_validation_tool_name`. Its error, recovery card and notification contain
only a fixed diagnostic describing the allowed function-name characters, never
the rejected value, raw provider payload, prompt, tool arguments or credentials.
The Pi AI patch also prevents inner Codex HTTP and outer assistant retries of
this same rejection, including an `input[500]` index that could otherwise match
the transient HTTP 500 heuristic. It does not change ordinary HTTP 500 or other
HTTP 400 retry behavior.

The manager gets one Continue/Stop decision (or the existing authorized owner
fallback). A flow execution binds the wait to its current attempt, presenting it
as blocked rather than merely idle/running. Standalone executions use the same
agent-recovery action. A subagent with this specific rejection remains live and
recoverable, still counts toward delegation limits, and sends its live parent a
non-final hold notice. Corrected completion delivers its final result once; child
or parent cancellation still makes it dormant and fences stale recovery wakes.
Pending validation recovery also refuses replacement dispatches by the parent and
explicit revival of a canceled child; neither action substitutes for an authorized
recovery decision. Other subagent failures retain their existing final-result
behavior. Repeated outcome delivery is idempotent; late distinct outcomes update actual counts and versions without repeating the same hold
notification. Refresh the current record before deciding if a version is stale.

Correct the serializer/request or make a safe re-plan **before Continue**. Continue
uses the existing authorized bounded cycle, not a session reset, budget expansion,
provider outage override or permission to replay an unchanged invalid request.
Another matching rejection immediately holds again; after the manager's one
cycle it routes to the owner. Stop retains the hold. Other pauses, approvals,
questions, dependencies and provider gates remain binding. Confirmed successful
execution settles the recovery normally; do not ask a person for host evidence or
invent a configuration input to resolve this software problem.

New worker manual inputs accept only versioned `continue`, `decide` or `provide` requests. People and managers retain `request-input --message` for ordinary task waits; this does not clear or bypass a structured recovery decision, or disguise the manager’s own unresolved failures in that same scope.
`continue` references an existing held runtime record, not a caller-supplied
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
Read-only host forensics (`systemctl status`, `journalctl`, `ssh`, `docker` or
`kubectl` inspection) stay rejected even when the agent proposes them. A service
lifecycle command (`systemctl start`, `stop`, `restart` or `reload`) is accepted
only in the agent's own proposal ("I'll run…", "May I…") and is rejected when the
text directs the person to act ("please run…", "can you…", "you run…"); incidental
prose such as "the restart you accepted" does not count as direction. `ask_human`
option values and labels are checked as proposed choices, like typed `decide`
option labels. A rejected question names the question and field that matched and
suggests describing the agent's own action in plain words.
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

### Exactly-once creating tools

The tools that create durable records are exactly-once per tool call. Each
derives a key from the agent, the execution and the provider's tool call ID
(`toolCallIdempotencyKey` in `packages/shared/src/node/tool-call-key.ts`, also
used for the Assistant tools' client IDs). The same call executed again (a
transport redelivery, or a rerun of the same call) finds the record its first
execution made:

| Tool                      | Where the key lives                                                      | A repeated call                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask_human`               | `agent_questions.idempotency_key` (unique)                               | Returns the same question and its open waits; opens no second wait. Different questions under the same key are refused.                             |
| `dispatch`                | Child metadata `dispatchKey` and `dispatchIndex`                         | Returns the same children; creates only positions the first run had not created yet. Children stopped to compensate a failed dispatch do not count. |
| `notify_contact`          | `inbox.idempotency_key` (`notify-contact:<key>`)                         | Returns the first notification; sends nothing.                                                                                                      |
| `POST /api/inbox` (local) | `inbox.idempotency_key` (`inbox-send:<digest of sender and client key>`) | Returns the first message with `idempotentReplay: true` (HTTP 200); a different message under the same key is refused with 409.                     |

Commands run by `bash` and `squad_bash` see the calling tool call's key in
`FICUS_TOOL_CALL_KEY` (k8s, vm, docker and host runtimes; absent when the tool
has no execution). The `ficus` CLI derives one key per command from it with
`cliCommandIdempotencyKey`: the digest of the command name, the tool call key and
the canonical JSON of the command's full payload.

- `ficus inbox send` sends it as `idempotencyKey`. The payload is the recipient,
  subject, content, URL, reply target, delivery mode, wake flag, task status and
  the name and SHA-256 of each `--attach` file. A replayed send uploads only the
  files the first run did not attach. `--idempotency-key` overrides it.
- `ficus workstream advance` and `ficus workstream raise-limit` use it as the
  default `requestId`; the payload is the stream reference, the command and the
  attachment flags. An explicit `--request-id` still wins.

So one bash call that sends several different messages or advances different
streams still performs each of them, and re-running the same command with the
same payload inside that bash call is the same request. Two identical sends to
the same recipient in one bash call are one message; pass distinct
`--idempotency-key` values if that is really meant. Outside an agent tool call no
key is derived and each command is new, as before.

**Limit.** A key only protects against the same call running again. After a hard
Core restart the model sees an interruption result for the cut-off call (see
[Hard interruptions](#hard-interruptions-no-shutdown-marker)) and may retry with a
new call, which has a new ID and so a new key. Two narrow content guards cover
the most harmful of those duplicates within the same execution (a restart
resumes the same execution):

- `ask_human` returns an open question from the same execution with exactly the
  same questions instead of asking again. A blocking re-ask of one that does not
  block yet makes it block (as `setQuestionBlocking` does) rather than putting a
  second copy in front of the person; only a re-ask for a stream-wide wait, which
  that conversion does not offer, creates a new question.
- `dispatch` returns the children of an earlier dispatch from the same execution
  with exactly the same specs while every one of them is still live. Once any of
  them has finished, an identical dispatch starts new children.

`notify_contact` and inbox sends have no content guard: sending the same text
again later can be intended, and a duplicate notification is less harmful than
a duplicate question or set of subagents. A call answered by a content guard
records nothing under its own key, so if that call is itself re-executed after
the earlier question was answered or the earlier children finished, it creates
a new record. The dispatch guard needs the earlier call's complete set of
children: a dispatch cut off partway by a hard restart and retried under a new
call ID starts all of its children again, so the ones the first call had already
created run twice.

A replayed `ask_human` whose question was answered returns the recorded answer,
and one whose question was dismissed says that no answer is coming; only an open
question tells the agent to wait. A replayed `dispatch` says which children the
first run had already started and that they may have finished.

**Announcing a question.** A question is announced (`agent-question.created`,
which pushes it to the people asked) after it is recorded and its audience is
finalized. A process that died between those steps used to leave a recorded
question that nobody was ever told about. Each new question now carries
`agent_questions.announce_pending_since` until it is announced, and
`announceAgentQuestionOnce` emits the event and clears it in one transaction
that holds the question row, so the asking call, a replay of it and the worker's
`agent-question-announce-recovery` sweep (at startup and every 60 seconds,
taking questions left pending for over a minute) announce it once between them.
The sweep finalizes a still-pending audience first. A question answered or
dismissed before it was announced is never announced. The event itself is not
durable, so a process that dies after emitting and before that transaction
commits gets the question announced again by the sweep: a narrower window that
now errs towards a second notification rather than none. Questions recorded
before this column existed are not swept.

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

### Foreground Bash transport losses

A foreground stream can fail **inside a still-running model execution**. The HTTP
client emits `BashOutcomeUnknownError` with its executor invocation id and a closed
transport classification (or `protocol_truncated` if EOF arrived without a terminal
exit code). The Bash operations layer attempts cancellation and zero-owned-process
verification before surfacing the loss. Neither stream `end` nor successful process
cleanup proves that an external side effect did not happen. Unconfirmed cleanup
continues to warn that the invocation may still be running; transport recovery must
not silently replay the command.

The SDK Bash tool preserves this typed error through its cause chain. The recovery
wrapper uses that **executor invocation id**, not a replacement tool-call hash, for
its durable outcome. Its generated last-error summary uses only the transport
classification, not raw endpoint, credential, output or cleanup-error text. A mapped
`SandboxOutageError` takes precedence over nested transport provenance: its outage
reason passes through the existing redaction and one-line length limit rather than
being replaced by a generic transport summary. Other tool failures retain their
existing invocation keys and classification policies.

On the third unexplained loss of the **same normalized command target**, the tool
error includes the server-issued recovery id, current `expectedVersion`, generated
attempted-action/count/error summary, and the matching flow wait id. Standalone
errors identify the owning agent. The worker is told that the squad manager or an
eligible owner decides Continue or Stop using this record and version, and to end
its turn until that authorized decision. It is not directed to run a recovery
resolution command or clear its own hold. An
already-held retry returns the same kind of actionable reference without executing
another command. These are references for an authorized manager/owner, not authority
for the worker to Continue itself. Decisions remain versioned: refresh the native
record if a later outcome or decision changed its version. Do not invent an id,
request a human diagnostic question, or substitute generic unblock. Continue grants
one bounded cycle, not permission to replay an unknown external mutation or bypass
pause, dependency, provider, credential or approval gates. A missing current flow
binding is reported as a retained hold/diagnostic, not an invented wait. If accounting
or delivery cannot return the outcome, the tool explicitly says no recovery
reference is available in that result. A durable record may already exist; inspect
native recovery state and reconcile the affected state before another attempt.

Three invocation ids alone do not establish exhaustion: they might represent three
different command targets. Timeout and ordinary unquoted spacing changes do not
create a new target, but unrelated commands do. Confirmed success of an unrelated
inspection does not reset the failing target; replacement model executions and the
manager's extra cycle retain its real history.

#### Duration and silence are separate from recovery accounting

The current repository has these distinct lifetime controls:

- `createHttpBashOperations` supplies a default command deadline of 180 seconds,
  capped at 3600 seconds. The executor enforces that deadline by terminating the
  owned session before returning its timeout/exit-124 frame. That expected command
  timeout is not an unexplained transport loss.
- `SandboxClient.bash` uses an explicit cancellation signal, not its unary RPC
  deadline (normally 30 seconds). It incrementally decodes SSE lines and requires a
  terminal numeric exit code. It has no application-level output-idle timer and
  requires no heartbeat to keep a silent reader alive. EOF, stream reset or an
  unexpected reader timeout without that terminal frame is an unknown outcome.
- The sandbox HTTP server exempts `/bash` from the TCP listener's 255-second idle
  timer. Unix listeners disable that timer globally because Bun ignores their
  per-request override. This is important even for noisy commands: the documented
  historical Bun idle timer was not reset by response writes. The server's separate
  idle-exit coordinator retains reservations for pending admissions/running commands;
  it does not infer idleness from a lack of command output.
- Cancellation has its own 12-second HTTP request budget. A failed cancellation may
  recover the transport and retry **cancellation**, never the original Bash command.
  Correlated restart draining remains distinct and free under the restart policy.

These controls do not guarantee that a network, SSH tunnel or runtime never drops a
stream. Deterministic client regressions advance a mocked clock through ten quiet
minutes, then deliver a split terminal SSE frame; separate fixtures inject timeout,
reset and truncated-EOF outcomes. They verify the application contract, not a live
network or deployed executor version. The reported long-foreground losses do not
establish silence, a specific duration limit or restart as their cause. No timeout
redesign or live restart/deployment is part of this recovery-accounting repair.
