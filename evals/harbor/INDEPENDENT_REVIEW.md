# Independent reviewer interpretation pilot

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

## Protocol

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

Prompt and task selection frozen. Environment controls are being checked; no
inference has started for this study.

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
