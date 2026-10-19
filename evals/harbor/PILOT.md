# Pilot evidence — 2026-10-19

Status: **integration in progress; full-squad completion is not yet verified**.
Do not publish these attempts as a Ficus squad leaderboard result.

The pilot used Harbor 0.24.0 and the unmodified `fix-git` task downloaded from
Terminal-Bench 2.0. Harbor recorded task digest
`sha256:31f6063693d71cdbb49d8ae17848ae54eed7a1953228164efbb3f4100251600d`.
The image was `alexgshaw/fix-git:20251031`, digest
`sha256:61e431c00c58df652287aadce5457634d9f9330cfdd153ebdf2802df0d540119`.
Trials ran locally with Docker/OrbStack, Linux amd64 containers on an arm64 Mac,
the task's original resource limits, one attempt per job, and no automatic retry.
Every Ficus attempt had an empty disposable database and memory disabled.

## All attempts

| Job                                    | Model        | Result                           | What was actually exercised                                                                                                                         |
| -------------------------------------- | ------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ficus-fix-git-smoke1`                 | GPT-4.1 mini | Adapter exception                | Incorrect readiness probe timed out; no inference.                                                                                                  |
| `ficus-fix-git-smoke2`                 | GPT-4.1 mini | Interrupted smoke                | Worker was healthy on a different listener; manager asked for clarification.                                                                        |
| `pi-fix-git-pilot1`                    | GPT-4.1 mini | Official reward 0                | Baseline stopped at a merge conflict and asked the user.                                                                                            |
| `ficus-fix-git-smoke3`                 | GPT-4.1 mini | Official reward 0                | Manager ran tools directly, stopped for clarification; no worker/reviewer.                                                                          |
| `ficus-fix-git-full-squad1`            | GPT-4.1 mini | Official reward 0                | Stronger squad context still did not cause delegation.                                                                                              |
| `pi-fix-git-gpt41`                     | GPT-4.1      | Official reward 1                | Harbor's Pi baseline completed the task.                                                                                                            |
| `ficus-fix-git-gpt41`                  | GPT-4.1      | Official reward 0                | Manager implemented directly and delivered an incorrect resolution; no worker/reviewer.                                                             |
| `ficus-fix-git-envelope`               | GPT-4.1      | Official reward 0                | Manager attempted work-stream creation, selected a PR workflow, and hit repository/worktree setup errors; inference later hit the conservative cap. |
| `ficus-fix-git-local-delivery`         | GPT-4.1      | Official reward 1                | Correct local delivery, but manager implemented directly; no engineer or reviewer.                                                                  |
| `ficus-fix-git-explicit-orchestration` | GPT-4.1      | Agent timeout; official reward 0 | Manager created a stream; engineer and reviewer ran. Reviewer claimed approval but did not advance the review attempt; stream remained active.      |

Model snapshots were `gpt-4.1-mini-2025-04-14` and `gpt-4.1-2025-04-14`.
The Pi baseline was 0.99.1 with thinking off and Chat Completions; Ficus uses the
same base Pi version with its existing patches. Every role and model tier was
pinned. Output was capped at 8192 tokens for both harnesses. No solutions or
verifier code were supplied to agents, and the grader was not changed.

These are development/smoke attempts, not independent statistical observations:
configuration was adjusted between them. Preserve all attempts and use a fresh,
predeclared task sample for a later frozen comparison.

## Findings and fixes

1. The worker health listener and internal-event listener are different. The
   adapter now uses `WORKER_PORT=17302` for readiness and event port 17303 for
   events. PostgreSQL readiness is checked explicitly.
2. The full squad requirement in background context was insufficient. The
   current adapter puts a generic delegation/review requirement in the task
   handoff, followed by the original task text verbatim.
3. Transport auditing confirmed the real Ficus system prompt reached the model:
   97,351 characters, including the squad execution contract. No prompt contents
   or credentials were recorded by this audit.
4. Engineering's inherited workflow alternatives suggested PR-based coding,
   despite a local deliverable default. The trial now replaces those alternatives
   with the intended `builder-reviewer` flow.
5. Mandatory worktree guidance conflicted with the explicitly disposable,
   single-task checkout. The proposed general guidance permits authorized local
   in-place delivery in that narrow situation, retaining review and the usual
   isolation requirement for shared checkouts. This final guidance change has
   passed offline checks but **has not yet been validated by a completed live
   full-squad run**.
6. The proxy originally stopped reading upstream when a client disconnected,
   potentially losing final usage. It now drains the stream for usage and records
   HTTP status/failure type without prompt bodies or credentials. This change is
   covered by a simulated disconnect test. The cause of the earlier missing
   usage cannot be established from the retained evidence.

## Initial $10 spending boundary

The shared durable ledger records **$0.957426 confirmed metered usage** and four
unknown-usage reservations of **$2.20 each**: **$9.757426 total upper-bound
exposure**. It refused further calls under the approved $10 cap. Unknown
reservations were not discarded or retrospectively treated as free. No further
paid trials were started after this boundary was reached, and the proxy was
stopped. These figures exclude local compute costs.

## Initial validation

- Core manager prompt/context tests: 16 passed across one file using the isolated
  package test runner.
- Adapter/accounting/budget tests: 13 passed, including concurrent reservations,
  restart persistence, model changes under the same cap, all-role accounting,
  pending-message completion, and disconnect usage collection.
- Core TypeScript check passed; Python Ruff check/format and Git whitespace checks
  passed.
- Runtime archive rebuilt from commit `e39028ec` with the final bootstrap and
  delivery guidance; archive provenance includes commit and bootstrap hash.
- Owned task containers and database sidecars were removed after attempts.

The next live check must demonstrate manager creation of a work stream, an
engineer's execution, an independent review, any required rework, local delivery,
and an official verifier result. Until then, this is a draft integration. More
inference requires reconciling the unknown reservations against authoritative
provider usage or explicitly authorizing additional budget; do not reset the
ledger to get around the cap.

## Authorized continuation

The user authorized another $10, raising the cumulative cap to $20. The original
ledger and its four unknown reservations remain intact. The first continuation
(`ficus-fix-git-local-delivery`) used the corrected local workflow bootstrap and
passed the official task verifier, but again ran only the manager. Its 18 new
requests all returned metered usage, adding $0.313942. This is evidence of local
delivery, not full-squad orchestration.

The next development configuration makes the generic handoff explicit about the
first CLI work-stream creation action and prohibits manager implementation even
for a small task. The original task remains verbatim; no task-specific solution
hint is added. It is recorded separately as `ficus-fix-git-explicit-orchestration`.

The explicit-orchestration run exercised all three roles without operator
steering. The engineer initially stopped without advancing, then advanced after
Ficus's ordinary continuation reminder. The independent reviewer inspected files,
reported approval, and sent a notification, but never executed its advance
command, including after a continuation reminder. The durable flow remained at
review (version 1, attempt 2). Harbor enforced the original 900-second agent
limit and awarded 0. Total job time was 16m27s; metered cost was $0.567976.

A general handoff clarification now explicitly requires a successful advance
command before reporting a completed step; prose, notifications, inbox reads,
and memory notes do not advance state. Paused/blocked attempts still must not
advance. Snapshots now retain durable flow state and open waits. These changes
passed six Core handoff tests and typechecking, plus 15 adapter tests. Runtime
commit `17ade874` is frozen for the fresh sample in [SMOKE-SAMPLE.md](SMOKE-SAMPLE.md).

## Fresh sample outcome and current boundary

The predeclared sample began with `ficus-frozen-prove-plus-comm` using runtime
`17ade874` (archive SHA256
`5d45ded42afcbd76862cda59dd2b86fae9725fdb52d75fde043f1ad16de1b3b2`).
Manager, engineer, and reviewer all executed. The engineer advanced the build
step. An unexpected review wait was opened and subsequently resolved by the
manager without operator intervention; the durable review step remained running.

The proxy recorded 49 calls: 46 with usage and three HTTP 429 responses without
usage. Their provider error codes and retry headers were not retained by that
proxy version, so the exact cause of those 429 responses is unknown. The next
reservation would have exceeded the cap. The operator stopped the trial at that
boundary, as predeclared. Harbor recorded `CancelledError`, with **no official
verifier reward**. This is an interrupted run, not a pass or a scored failure.
The paired Pi run and both `overfull-hbox` runs were not executed.

The cumulative ledger now contains 202 calls, **$2.486576 confirmed metered
usage**, and seven unresolved $2.20 reservations, for **$17.886576 conservative
exposure** against the approved $20 cap. Four unknown reservations predate this
continuation; three are the audited HTTP 429 calls. None have been released.
The fresh trial added $0.647232 confirmed usage and $6.60 in unresolved holds.
The billing usage endpoint returned HTTP 403 for the available inference key;
authoritative reconciliation is still required before further full-model calls.
All owned trial containers/database sidecars were removed, and the proxy stopped.

The next proxy revision preserves sanitized provider error codes, request IDs,
and Retry-After metadata without recording prompt bodies or raw error messages.
It shares provider cooldowns across squad requests and rejects requests locally
while the cooldown is active, without allocating another reservation or calling
the provider. The budget guard now returns a distinct non-retryable HTTP 403
`pilot_budget_exhausted` error. Existing holds remain untouched. Nineteen offline
adapter/proxy tests pass, including cooldown, retained holds, error redaction,
and explicit budget exhaustion. These transport changes have not been tested
against a live provider and require a separately labeled future configuration.

No completed full-squad workflow or matched comparison has yet been established.
The evidence supports integration debugging and identifies orchestration and
transport failure modes; it does not establish a leaderboard result.

## Provider reconciliation and transport revision

The operator reported the provider dashboard's total spend for today as $2.49,
matching the $2.486576 metered ledger at call 202. With inference stopped, an
append-only reconciliation checkpoint uses **$2.50** as a conservative rounded
baseline through call 202. The original 202 call rows, including all seven
unknown reservations, remain unchanged. New reservations add to this baseline
under the same $20 cumulative cap; this is not a cap increase or ledger reset.
The dashboard figure is operator-reported, not independently obtained through
the billing API, and may be subject to provider reporting latency.

A separately labeled transport-revision validation will retry `prove-plus-comm`
with the unchanged runtime `17ade874`, full-squad handoff, model, task, and
original time limit. It will then run the matched Pi baseline, followed by Ficus
and Pi on `overfull-hbox` if budget permits. One attempt per harness/task in this
configuration; no prompt changes or operator steering. Retain the earlier
interrupted sample separately. The proxy now retains error details and honors
known cooldowns. The reconciliation and restart/cap behavior pass 20 offline
tests. This remains development validation, not a leaderboard estimate.
