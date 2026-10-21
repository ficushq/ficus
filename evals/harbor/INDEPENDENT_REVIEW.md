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
