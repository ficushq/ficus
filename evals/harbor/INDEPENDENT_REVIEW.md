# Independent reviewer interpretation pilot

The original temporary raw artifacts are no longer available; the summaries and
hashes below are preserved historical evidence, not a substitute for those files.
See [the controlled follow-up](ARTIFACT_REVIEW.md) for the recovery protocol and
durable storage used for new trials.

## Question and frozen intervention

The preceding concurrent pilot exposed a shared architectural assumption that
both squad implementations retained through review. This follow-up asks whether
explicitly independent contract checking helps full Ficus squads on fresh tasks.
It does not replay the known failing task as evidence of improvement.

`independent-review-v1-addition.txt` is inserted immediately before `## Scope
Checking` in the frozen reviewer's YAML system prompt. Only this prompt and
runtime revision metadata differ; every other archive member was checked for
identical contents, type, permissions, and link target. Production prompts are
unchanged. The addition was frozen before reading these holdouts' instructions
or hidden test contents. It contains no task-specific hints.

The next two unused entries in the original SHA256 selection order are
`igel-persist-feature-schema` and `psd-tools-blend-range-api`. Both conditions use
the same tasks, native Pi SDK 0.99.1, GPT-6.1 Sol at medium thinking, and full
manager/architect/engineer/reviewer planned workflow, with fresh disabled memory.

## Original frozen protocol

Run the unchanged baseline on both tasks concurrently, then the experimental
reviewer on both tasks concurrently. Reuse the audited concurrent runner with one
`ficus-planned` arm per condition, separate job/client namespaces, and a separately
frozen runtime hash for each. The fixed condition order is a limitation, not a
randomized or counterbalanced comparison. Each task/condition gets one attempt.
No task hints, operator rescues, paid retries, or prompt edits during the study.

Before inference, require original-code and oracle grading controls, test-path
collision controls, and no-inference startup/network checks for both runtimes.
Use the official grader and tests unchanged in a separate restricted verifier.
Pin task images by digest. Freeze source, task, prompt, and runtime hashes.

The existing $30 phase ledger remains in force: $4.649604 spent before this
study, leaving $25.350396. Per-trial cap stays $10 and per-request reservation
$5.50. Stop on provider errors, input drift, unknown usage, infrastructure errors,
or insufficient reservation headroom. Preserve all interrupted attempts and
missing-usage holds; they are not successful or free trials.

Primary outcome: official accepted tasks (feature and regression checks).
Secondary observations: cost, elapsed time, review attempts, and whether review
actually tests or resolves consequential assumptions. Do not infer saved human
minutes, reliable statistical improvement, or general benchmark rank from two
tasks and one stochastic attempt per condition. Shared Apple Silicon execution,
amd64 emulation, setup overhead, and unrelated host load also limit timing claims.

## Status

All eight grading controls and four no-inference startup/network checks passed.
Both conditions have finished. The candidate accepted one of two tasks; the
baseline accepted neither and blocked on one. Original-test sensitivity checks
preserved both Igel scores. All paid runners and owned trial/database containers
are stopped. No production prompt has changed.

## Interrupted launch and explicit recovery

The first baseline launch was stopped after a local reservation rejection at
PSD Tools' architect-to-engineer handoff. The $10 per-trial cap could not fit
two overlapping $5.50 worst-case reservations, even though the trial had spent
only $0.312312. The rejection happened before an upstream request and therefore
was not recorded among provider calls; the runner incorrectly kept waiting.
Igel was interrupted with it. Neither trial received an official grade, and the
candidate condition never started. The retained attempt cost is $0.944603, with
54 receipted calls and no unresolved holds.

The proxy now serializes provider requests within each trial through receipt
settlement; different trials still execute concurrently. It neither raises caps
nor releases unknown-usage reservations. Local rejected reservations have a
separate event table (not fabricated usage receipts), and the runner stops on
those events as well as upstream failures. A deterministic concurrent-handoff
regression fails against the original proxy and passes after the fix. All 62
offline harness tests pass. This is an evaluation transport fix, not a production
Ficus change.

The explicitly frozen `independent-review-v1-recovery-1-*-run.json` manifests use
fresh trial/client namespaces and the same two runtime archives, prompt addition,
tasks, grading controls, and model settings. No task-specific steering is added.
The phase retains $5.594207 spent and the original $30 cap ($24.405793 remaining).
These are recovery attempts; do not describe the eventual study as four
uninterrupted first attempts. Original manifests and logs remain intact.

Recovery 1 was also interrupted before grading or the candidate condition. Its
first stop was a `client_disconnected` event with HTTP 200 and a usage receipt;
the proxy was still forwarding after terminal completion. The original wire
trace is unavailable, so closing after completion is a plausible cause, not a
proven timing reconstruction. The proxy now writes a complete terminal SSE event
and stops reading at completed/incomplete Responses events, just as it already
did for terminal failures. Pre-terminal disconnects still stop the trial, and
unknown usage holds remain intact. The terminal regression fails against the
previous implementation and all 62 offline tests pass after the change.

Recovery 1 cost $0.795636 (49 receipted calls). Recovery 2 is explicitly frozen
with unchanged prompts/tasks/runtimes, fresh clients and environments, and the
same caps. Its starting phase spend is $6.389843, leaving $23.610157. Both prior
interrupted batches remain in the reported total. No official outcome is
available from either, and neither is counted as a model acceptance failure.

Recovery 2 again stopped on an upstream-200 client cancellation. Therefore the
terminal-stream defect alone did not explain the observed stops. The supervisor
was also incorrectly treating `client_disconnected` as a provider failure.
Client aborts may be part of normal agent/session lifecycle; the exact trigger
in these stopped runs is unproven. They are now retained as transport observations
without forcing an immediate batch cancellation. Real HTTP/provider/proxy errors
still stop the batch. A later disconnect cannot overwrite an already-recorded
upstream failure. All 63 offline tests pass, including this distinction and
preservation of a cancellation's unresolved charge until its receipt arrives.

Recovery 2 used $1.037168 in confirmed inference and left one $5.50 unknown-usage
hold at shutdown. Recovery 3 starts from $7.427011 confirmed plus that hold:
$12.927011 exposure against the unchanged $30 cap. Available headroom is
$17.072989. The hold is not reconciled or released. Unknown usage after a new
batch still blocks the next condition, and all previous attempts remain retained.
The candidate reviewer still has not been run or adjusted.

## Baseline blocked outcome and observation amendment

Recovery 3's Igel baseline finished: 22/24 feature and 2/2 regression checks,
$1.233294. Its reviewer found and repaired an empty-input validation bug, but the
submitted artifact still failed two official feature checks.

PSD Tools' baseline repaired a reviewer-discovered stroke visibility defect, then
explicitly opened a manual owner wait for unavailable `aggdraw` to validate true
vector paths. No agents or executions were active. This is a real blocked squad
outcome, not a provider failure or a successful autonomous delivery. The observer
missed this wait type and continued polling. The exact committed artifact was
captured read-only (SHA256
`1e973f7f1c83ead02a624d9048faea9e6a47f54dc6705ca0b01d177efa0cb5b9`),
and the blocked process stopped without provisioning dependencies or task hints.
An independent no-inference replay grades that artifact; label its grade
separately from the autonomous delivery outcome. Its first replay failed before
grading due to index/worktree mismatch; the fresh replay now resets to the task's
recorded base commit before applying the exact hash-checked patch.

The observer now recognizes manual owner waits only for active streams after all
executions and inbox deliveries quiesce. Monitor waits and unrelated/stale waits
do not end the trial. A new regression covers these boundaries. All 65 offline
harness tests pass.

The candidate trials use the original frozen prompt/runtime and unchanged tasks
and graders, with this explicit observer amendment. They run sequentially to
preserve reservation headroom: phase confirmed spend is $11.445352 plus the
unchanged $5.50 hold, leaving $13.054648 under the $30 cap. Do not compare batch
throughput to the concurrent baseline. Retain scheduling and observer differences
as limitations, and distinguish artifact acceptance from autonomous delivery.

The separate baseline PSD artifact replay completed without inference: **36/45
feature checks and 979/979 regressions**, reward 0. Its replay metadata and
shutdown-captured patch match the recorded artifact hash. This score does not
convert the blocked squad into an autonomous delivery.

## Completed Igel comparison

Both full squads delivered an artifact, returned through one implementation
revision, and received the same official grade: **22/24 feature checks and 2/2
regressions, reward 0**. Baseline cost $1.233294 (80 calls); candidate cost
$1.154768 (75 calls). Both used all four roles and GPT-6.1 Sol. Both reviewers
independently found the empty HTTP-input path that called the estimator with
`None`, requested a repair, and subsequently approved. The candidate addition
produced no observed acceptance or review-coverage improvement on this task.

Both failed the same two official test identities. The saved schema was present,
but the grader loaded the stored relative filename directly from its working
directory. Both implementations instead resolved it relative to the model
artifact directory. The other test requires a clear all-features-removed error:
the baseline failure is a wording-token assertion, while the candidate instead
rejects `exclude: null` before reaching feature removal. These details limit what
can be inferred from binary failure alone; official scores are not changed.

The submission audit also found changes to the two scored legacy smoke tests,
including test-fixture relocation. The official grader replaces test-patch
collision paths but does not restore every pre-existing regression test. Both
Igel artifacts therefore get a separate, no-inference sensitivity check with
all submission changes under `tests/` excluded and implementation changes kept
identical. Original artifacts, grades and hashes remain retained. That extra
check is not a new model attempt or a replacement official submission.

Both original-test sensitivity checks finished successfully with the same
**22/24 feature and 2/2 regression** counts. Thus the submitted test edits did
not change these reported scores. The original regression tests are verified
separately rather than assumed protected by the patch-collision controls. These
no-inference audits ran while the PSD candidate was active, adding host load;
no timing or throughput comparison is claimed for this study.

## Final results and interpretation

| Task      | Baseline artifact checks                           | Candidate artifact checks         | Autonomous delivery, baseline / candidate | Inference USD, baseline / candidate |
| --------- | -------------------------------------------------- | --------------------------------- | ----------------------------------------- | ----------------------------------- |
| Igel      | 22/24 feature; 2/2 regression                      | 22/24 feature; 2/2 regression     | Yes / Yes                                 | $1.233294 / $1.154768               |
| PSD Tools | 36/45 feature; 979/979 regression, separate replay | 45/45 feature; 979/979 regression | No, owner wait / Yes                      | $2.785047 / $1.127485               |

Official accepted artifacts: **baseline 0/2; candidate 1/2**. Baseline PSD's
artifact grade comes from the explicitly labeled no-inference replay, not its
externally interrupted original Harbor job. Candidate PSD finished on its first
implementation and first review, with all requested roles executed. It modified
no existing test assertion lines in the retained test paths; the official
feature-test collision path was restored by the upstream grader.

The PSD candidate reviewer independently ran the focused tests and reproduced
the same 25 optional-dependency failures on clean `main`. It approved with those
environment limits documented. Baseline instead requested an implementation
repair for a real stroke-visibility defect, then blocked on unavailable `aggdraw`
for deeper vector validation. The candidate's acceptance and lower cost are
encouraging observations, but the successful implementation preceded review.
There is no observed reviewer-requested correction that caused its success.
Different stochastic engineer outputs, fixed order, scheduling, observer changes,
and two tasks prevent attributing this result to the prompt addition.

**Decision:** keep this reviewer addition experimental; do not promote it based
on this pilot alone. A useful next diagnostic would hold completed engineer
artifacts constant and compare blinded baseline/candidate reviews, measuring
concrete supported findings and false positives. Such replays must be labeled
known-artifact diagnostics, not fresh full-squad benchmark acceptance. Future
fresh squad tasks can then test whether any verified review improvement survives
end-to-end orchestration. No further paid trial is started in this report.

`independent-review-v1-results.json` records per-condition grades, delivery
states, model/role provenance, artifact hashes, original-test audits, retained
interruptions and final ledger totals. Current-study inference was **$9.078001**,
including **$2.777407** for the three interrupted launches, **$4.018341** for the
recorded baseline condition and **$2.282253** for the candidate. Adding the
preceding $4.649604 study yields **$13.727605 confirmed** in the user-authorized
$30 phase. Call 446 still retains its **$5.50** missing-receipt hold. Exposure is
**$19.227605**, leaving **$10.772395** conservative headroom through call 829.
No hold was released, historical ledger reset, or budget increased.

Validation: 65 offline harness tests, changed Python Ruff/format checks and
repository-wide Bun typecheck passed for the committed harness changes. Final
report edits are formatted and whitespace-checked. Production prompts and
provider defaults are unchanged; the evaluation PR remains draft.
