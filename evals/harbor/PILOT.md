# Pilot evidence — 2026-10-19

Status: **the corrected four-arm feature pilot is complete**. The first feature
revision exposed a verifier defect; its invalid pass and interrupted run remain
recorded below. The current results use verified official test inputs and retained
submission archives.

| Corrected configuration | Official reward | Metered inference | Wall time | Agent time |
| --- | --- | --- | --- | --- |
| Ficus engineer | 1 | $0.754351 | 9m40s | 8m07s |
| Pi engineer | 1 | $0.396861 | 4m32s | 3m44s |
| Ficus manager + architect/engineer/reviewer | 0 (10/12 acceptance tests passed) | $1.417055 | 18m17s | 16m40s |
| Pi coordinator + architect/engineer/reviewer | 1 | $1.046489 | 13m27s | 12m37s |

Each passing arm passed all 12 official acceptance tests, then 50 regression
tests (1 skipped, 1 xfailed). Every arm used native GPT-6.1 Sol, medium reasoning,
the same frozen task/image, and the original resource/time limits. Wall time
includes setup and verification. These local emulated timings are descriptive,
not production latency measurements. Raw sanitized metrics and archive hashes
are in [feature-pilot-v2-results.json](feature-pilot-v2-results.json).

The actionable observation is that the Ficus manager explicitly scoped out two
pre-existing helpers needed by acceptance behavior; its reviewer recognized the
missing helpers but approved that scope. The Ficus engineer alone implemented
them and passed. This suggests testing a general dependency/completion-guidance
improvement. One inspected task and one attempt per arm do **not** isolate a
causal effect or establish general harness superiority, multi-agent value, or
human time saved. Use fresh tasks and repeated/mixed-order runs next.

At the end of this four-arm pilot, effective cumulative accounting was
**$10.607113 / $20**, leaving **$9.392887**. The subsequent
[scope-guidance experiment](SCOPE_GUIDANCE.md) records its additional spend
separately; cumulative accounting after that experiment is **$11.853043 / $20**.
The corrected four-arm revision added **$3.614756** across 304 fully metered calls.
Paid inference is stopped. No production changes were merged or deployed.
The chronological sections below preserve earlier failures; the final section
records the current validated configuration.
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

### Handoff finding from the transport-revision trace

In the `prove-plus-comm` retry, the engineer received the complete handoff,
including the exact versioned `ficus workstream advance` command, but ended with
a formatted delivery summary instead. The ordinary automatic continuation then
elicited another summary saying the work was ready for review. No advance was
attempted, so this evidence does not indicate a CLI rejection or permission error.
There were no provider errors during these turns. The generic continuation did
not restate the pending workflow action. The operator only inspected state and
transcripts; no messages, approvals, or task changes were injected.

This is evidence about this experimental configuration with GPT-4.1, not proof
that production squads exhibit the same idle behavior. Do not change production
continuation or completion semantics on this evidence alone. The next model
configuration should use an available current model and its supported transport
before drawing a conclusion about the workflow.

### Transport-revision outcomes and stop

| Harness / task            | Official reward | Workflow / termination                                                                      | Metered inference                                         |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Ficus / `prove-plus-comm` | 1               | Agent timeout; manager and engineer executed, reviewer did not; build step remained running | $0.324282 / 26 calls                                      |
| Pi / `prove-plus-comm`    | 1               | Completed normally                                                                          | $0.008676 / 5 calls                                       |
| Ficus / `overfull-hbox`   | Not graded      | Operator canceled when the user requested a model change                                    | $0.666740 / 48 calls, plus $11.00 unresolved reservations |
| Pi / `overfull-hbox`      | Not run         | Configuration stopped                                                                       | —                                                         |

The proof task used the same task checksum for both harnesses. Ficus's agent
execution took 907.32 seconds including timeout cleanup; Pi's took 10.59 seconds.
Setup is separate (68.30 and 29.50 seconds respectively). A passing proof does
not make the timed-out Ficus workflow a completed full-squad run. These are
adapter validation results, not a representative estimate of product work.

The interrupted second task had five provider `rate_limit_exceeded` responses
without usage (calls 271, 273, 275, 277, 279). The reservations remain recorded.
At stop, 281 raw calls contain $3.486274 confirmed metered usage; effective
cumulative exposure after the call-202 reconciliation is $14.499698 against the
unchanged $20 cap. Exposure includes uncertain holds and is not actual spend.
The proxy and owned Harbor containers are stopped.

The available API model list includes `gpt-6.1-sol`. Its official documentation
requires Responses for tool calling, so changing only the model string in the
existing Chat Completions pilot is insufficient. No GPT-6.1 scored run has been
performed. Model transport and accounting support remain implementation work.

See [the evaluation plan](EVALUATION_PLAN.md) for the revised scope: complex
features, unattended delivery, and parallel throughput, alongside official task
quality rather than a single small-task cost ranking.

## Native Pi GPT-6.1 Sol: four-arm adapter validation

The user confirmed **$3.49** on the provider dashboard through call 281. With
inference stopped, an append-only **$3.50** checkpoint includes a rounding margin.
The existing $20 cumulative cap and every original receipt/reservation remain
unchanged. This is operator-reported billing evidence, not an independent billing
API reconciliation.

Ficus already supports the model through Pi. The evaluation-only preload and
proxy now preserve Pi's native Responses transport instead of using the old
adapter's generic Chat Completions account. Production provider/authentication
code and model defaults were not changed. A two-call native SDK function-tool
roundtrip completed for $0.000526 before task runs.

All four arms used `gpt-6.1-sol`, medium reasoning, the same 8192-token response
ceiling, and Harbor 0.24.0 with Pi 0.99.1. Ficus runtime archive SHA256:
`903ff3d33a08776c4005c3430ef13152101d25b72435fc27b242320573efec18`,
from runtime commit `eea49e862c5d`. The task was `prove-plus-comm`, checksum
`c2e6faf1396913cf529854f75a27939b6f05ac811f1415150312aa6d22248a1c`.
The official task and grader were unchanged; no verifier or solution was supplied
to the agents. This task was already inspected in development and is not a fresh
scored sample.

| Job                           | Official reward | Model calls | Metered inference | Wall / setup / agent seconds |
| ----------------------------- | --------------- | ----------- | ----------------- | ---------------------------- |
| `pi-sol-engineer-smoke-v2`    | 1               | 5           | $0.010575         | 68.80 / 25.60 / 19.24        |
| `ficus-sol-engineer-smoke-v2` | 1               | 8           | $0.116096         | 237.95 / 71.77 / 142.69      |
| `pi-sol-planned-smoke-v2`     | 1               | 16          | $0.053383         | 134.18 / 28.22 / 83.20       |
| `ficus-sol-planned-smoke`     | 1               | 25          | $0.333332         | 305.94 / 70.87 / 212.07      |

Ficus engineer-only executed only the engineer; its fixture suppressed manager
lifecycle dispatch before creating the work stream. Ficus planned executed the
manager, architect, engineer, and reviewer. Its design, implement, and review
attempts all completed; the work stream was done, the flow completion-ready,
and no pending messages or open waits remained. No operator messages or approvals
were injected. Pi's packaged subagent extension executed architect, engineer,
and reviewer under its coordinator, all on the selected model. Its reviewer
explicitly approved the result after independent validation.

Neither successful multi-agent run required rework. The rework route is configured
but not yet exercised end to end. Pi starts fresh child sessions on dispatch;
Ficus can reuse a role's session on rework. This remains a disclosed workflow
mismatch before a scored comparison. Initial Pi result files lacked role/token
metadata because metadata was populated before Harbor's post-run hook. Raw
sessions and proxy receipts were retained, and a supplementary role audit
confirmed all child executions. The adapter now populates metadata after the run
and suppresses misleading parent-only aggregate usage. Original result files
were not rewritten.

These timings include local container/runtime overhead; Ficus's agent phase also
includes isolated service startup. The runs were not scheduled as a controlled
latency study, so this table does not establish a speed ratio, feature quality,
human time saved, or a leaderboard score.

Retained startup failures before these successful attempts:

- `pi-sol-engineer-smoke`: Harbor rejected the undeclared workflow option before
  inference. The adapter now declares its option schema.
- `ficus-sol-engineer-smoke`: malformed Bun preload argument order printed help
  instead of starting services. Stopped without model calls; corrected to
  `bun run --preload=... <entry>`.
- `pi-sol-planned-smoke`: the installer assumed the wrong Pi package-root depth.
  It failed before inference; corrected for the pinned `dist/bundle/cli.js` entry.

Calls 282–337 all have usage receipts and no provider errors. New metered usage,
including the native tool check, is **$0.513912**. Raw confirmed usage is
**$4.000186**; effective cumulative budget accounting is **$4.013912** after the
rounded reconciliation, leaving **$15.986088** of the authorized $20 cap. Twelve
historical unknown reservations remain in the raw audit; none are unresolved
since this checkpoint. The proxy and owned trial containers are stopped.

Twenty-nine offline Python adapter/proxy tests passed, along with the native
provider test (one test, six assertions), Core typecheck, Ruff/format, and whitespace
checks. The next step is an existing feature benchmark with a frozen sample and
its official evaluator; the smoke checks alone do not answer the product-value
question.

## Frozen FeatureBench pilot

The task and four-arm configuration were frozen in `feature-pilot.json` before
inference. The isolated lv1 task retains the byte-identical upstream grader;
its masked baseline scores 0 and reference solution scores 1. Source and image
provenance, answer-material removal, and preparation failures are recorded in
[FEATUREBENCH.md](FEATUREBENCH.md). This is one exploratory Pydantic task, not a
representative estimate or leaderboard result. No operator messages, fabricated
approvals, retries, or changes to the frozen configuration were supplied.

### Ficus planned: orchestration completed, acceptance failed

`feature-ficus-planned-1` received official reward **0**, with **10 tests passed
and 2 failed**, without a Harbor exception. The manager, architect, engineer,
and independent reviewer all executed. Design completed, implementation advanced
to review, the reviewer requested changes, the engineer repaired the issue,
and the second review approved. The stream ended `done`, with no pending
messages or open waits. The flow's final status was `completion-ready`.

The first review found inherited computed-field metadata shared between parent
and child models: child configuration could change parent serialization after a
rebuild. Its evidence included a reproduction and targeted repair request. This
is an observed autonomous rework cycle; it does not establish that review made
the external acceptance score better, because the intermediate revision was not
graded independently.

The official failures were missing `GenerateJsonSchema.encode_default` and
`rebuild_model_fields`. The delivery trace classified broad regression failures
as pre-existing missing baseline infrastructure and outside the completed work.
That suggests a scope/dependency classification problem: missing baseline code
can still be necessary for the requested behavior. This is a hypothesis from
one task, not a reason to change production guidance or the remaining pilot arms
mid-run. Internal focused-test success and completed workflow state did not
establish external acceptance.

All 108 requests returned usage receipts, with no provider failures. Metered
cost was **$1.604015**, including all roles and rework. Total wall time was
**1,632.78 seconds**, including 71.19 seconds of adapter setup; agent execution
was **1,531.02 seconds**. Cumulative effective accounting reached **$5.617927**
against the unchanged $20 cap before the Pi planned arm began. Local compute
cost is excluded; this emulated local run is not a production latency estimate.
The outcomes below supersede the remaining-arm status at this checkpoint.


### Pi planned: nominal pass invalidated by verifier audit

`feature-pi-planned-1` emitted reward 1, but this is **not a valid benchmark pass**.
The engineer independently created `tests/test_deprecated_fields.py`, colliding
with the withheld test path. The unchanged upstream shell grader failed to
restore the official file, ignored the error, and ran 29 agent-authored tests
instead of the 12 official acceptance tests. Its subsequent regression stage
reported 50 passed, 1 skipped, and 1 xfailed; that does not repair the missing
acceptance coverage. This is a verifier defect, not evidence of deliberate
benchmark exploitation by Pi.

The coordinator dispatched architect, engineer, reviewer, engineer for rework,
and reviewer again. The first reviewer independently caught the same shared
parent/child computed-field metadata bug observed in the Ficus run. All 128
requests were metered, costing **$1.301571**. Wall time was **1,038.21 seconds**,
including 16.87 seconds of setup and 988.06 seconds of agent execution. These
measurements describe the attempt, not cost or time to a verified solution.
The completed task workspace was not retained by that adapter configuration,
so a trustworthy regrade of this exact candidate is unavailable. Do not
reconstruct an alleged final candidate from partial transcripts or count this
nominal pass in a comparison.

`feature-ficus-engineer-1` had already started when the verifier log audit found
the collision. It was stopped, retaining its logs and an interrupted workspace
snapshot. Harbor recorded `CancelledError`, no reward, and only engineer
execution; four calls cost **$0.072859**, all with usage receipts. The last call
recorded client disconnection during cancellation but still settled its usage.
Pi engineer-only was not started. The original four-arm pilot is incomplete;
it must not be silently resumed under a changed grader or reported as a matched
comparison.

Paid inference and owned task containers were stopped. Cumulative effective
accounting is **$6.992357** against the unchanged **$20** cap, leaving
**$13.007643**. The raw historical unknown reservations remain preserved under
the earlier reconciliation checkpoints; no new usage is unresolved.

## Corrected-verifier revision (v2)

`feature-pilot-v2.json` freezes the corrected verifier preparation separately.
All model, role, prompt, resource, timeout, and order settings are unchanged.
Official test/configuration hashes must match before and after grading, and
pre-grading submission archives are retained. All costs below add to the earlier
$6.992357; the original attempt history is preserved.

The planned Ficus run received **0**, with **10 official tests passed and 2
failed**, no exception, and verified input hashes. It completed design,
implementation, and approved review without a returned attempt; all four roles
executed and the stream ended `done`, with no pending messages or open waits.
All 99 calls were metered, costing **$1.417055**. Wall/setup/agent times were
**1,096.82 / 64.73 / 999.89 seconds**. Both missing helpers from the earlier run
remained. The retained manager trace explicitly directed scope to stay focused
and classify those pre-existing gaps as follow-up; the reviewer named both
helpers but approved the scoped delivery. This strengthens the dependency/scope
classification hypothesis without establishing a general failure rate.

The planned Pi run received **1**, with **all 12 official acceptance tests
passed**, then **50 regression tests passed, 1 skipped, and 1 xfailed**. Official
input hashes matched before and after grading. The coordinator dispatched
architect → engineer → reviewer → engineer → reviewer; the first review found
parent/child metadata sharing and the second explicitly approved the repair.
All 104 calls were metered, costing **$1.046489**. Wall/setup/agent times were
**806.69 / 16.50 / 757.27 seconds**. The source archives for both planned runs
were retained and their checksums verified. Both runs share task checksum
`4c3c1ac1f67aeb353ed802f5133ccd96b49e071c4b19932fd2ff634fa039140c`.

The engineer-only outcomes are recorded below. These are
single-task development observations on an inspected masked-repository task;
they do not establish harness superiority, general feature-delivery performance,
production latency, or measured human time saved.

### Engineer-only completion and final accounting

Ficus engineer-only received **1**, with all 12 official acceptance tests and
50 regression tests passing (1 skipped, 1 xfailed). Its only attempted and
completed role was `engineer`; the manager object remained idle. The execute
flow completed, the stream ended `done`, and there were no open waits or pending
messages. All 53 calls were metered, costing **$0.754351**. Wall/setup/agent times
were **580.00 / 60.09 / 487.10 seconds**.

Pi engineer-only received **1** with the same official test results. It ran the
single-session configuration without the subagent extension. All 48 calls were
metered, costing **$0.396861**. Wall/setup/agent times were **271.68 / 15.09 /
224.19 seconds**. All four arms share the same task checksum, verified official
input hashes, and retained checksummed pre-grading archives. No user steering or
approval was inserted. The corrected revision had no provider errors or missing
usage receipts. Ficus planned completed without rework in this revision; Pi
planned completed one repair/re-review cycle.

The cumulative ledger at call 881 has $10.593387 in raw confirmed receipts and
12 historical unknown reservations preserved from earlier development. The
operator-reported reconciliation checkpoints bring effective cumulative
accounting to **$10.607113**. All new calls after the last checkpoint are metered.
The proxy was stopped and owned benchmark containers removed after the final
arm. Do not spend the remaining $9.392887 on a broad suite without a new scoped
sample and cost estimate.


### Implementation validation

The offline Python adapter/accounting/proxy/isolation suite passed all 33 tests;
Ruff lint and formatting checks passed. CI on `2d4b5534` passed typecheck, lint,
build, web, subprocess, gates, and local setup. The shared Core suite failed one
deployment-health assertion (`restarting` expected, `crashed` received), with
14,111 passed and 30 skipped. A focused run using Core's isolated test entrypoint
passed all 51 tests in that file in 11.4 seconds and exited zero. That isolated
pass does not establish that the full suite is green or prove the failure's
cause. The deployment-health implementation and test are unchanged by this PR;
no unrelated production fix or weakened assertion was introduced.


## Follow-up scope-guidance experiment

See [SCOPE_GUIDANCE.md](SCOPE_GUIDANCE.md). Both prompt variants passed 16/16
fresh synthetic scope-decision checks. The generic candidate guidance then
passed the known-task full-squad regression replay: 12/12 official acceptance
tests and 50 regression tests, with unchanged verifier inputs and no operator
steering. This is a separate experiment, not a replacement for the failed arm
above. The candidate prompt commit `8739f497` also passed full CI.
