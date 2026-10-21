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
