# Controlled reviewer diagnostic

This follow-up isolates the reviewer prompt from engineering variability. It is
not another full-squad benchmark score. The previous two-task full-squad pilot
could not attribute its one improved result to review: the passing implementation
already existed before the candidate reviewer inspected it.

## Recovery and selection

The earlier temporary checkout, raw patches, transcripts, runtime archives, and
spending database no longer exist. Published reports and hashes remain, but they
cannot substitute for the missing evidence. Exact replay of the old implementations
is unavailable. Historical scores are retained as reported, with that limitation.

`artifact-review-v1-plan.json` freezes the replacement protocol before inference:
one new engineer-only implementation of `narwhals-rolling-window-suite`, the next
unused task in the previously frozen selection order. Freeze its patch regardless
of grade; do not regenerate or repair it to make the diagnostic more interesting.

Both reviewers get the same original task and implementation. They do not receive
hidden tests, reference code, official test results, the engineer's conversation,
or each other's findings. The original prompt runs first, then the existing
`independent-review-v1` addition; this fixed order and one sample limit conclusions.

## Native execution and validation

The fixture uses Ficus's Solo workflow with the native reviewer role and tools,
GPT-6.1 Sol at medium thinking through the native Pi SDK provider, disabled memory,
and no manager inference or delegation. The deliverable is a structured review
report outside the repository. A changes-requested verdict still completes this
report-only workflow; it does not initiate an engineering repair cycle.

The adapter checks the input patch SHA256 before inference, applies it to the
exact clean base, and creates a deterministic artifact commit. It then checks
that the commit, tracked content, and nonignored untracked paths remain unchanged,
that only reviewers executed, and that the report completed with a valid schema.
These are post-run integrity checks, not a read-only filesystem sandbox. Claims in
the report still need independent validation against requirements and reproductions.

Both runtime archives are compared member by member. Only the reviewer YAML and
runtime provenance metadata may differ; their prompt hashes match the earlier
experiment exactly. Official grading is disabled during reviewer-only runs.

The upstream Narwhals image initially could not import Polars on the Mac's amd64
emulation because AVX/AVX2 was unavailable. A documented derived image adds only
`polars-runtime-compat==1.39.3` alongside the existing `polars==1.39.3`, for both
agent and verifier. The task, grader, hidden tests, and reference solution remain
unchanged. Original failed controls are retained. The verifier's Dockerfile also
selects amd64 explicitly without changing the native network sidecar architecture.

Readiness requires a failing starting implementation, passing reference solution,
matching controls when candidate files collide with official tests, and startup /
network-isolation probes for both runtimes. See the input, environment-recovery,
runtime, and readiness manifests for hashes and outcomes.

## Accounting and storage

The $30 phase cap remains. The last durable report records $13.727605 confirmed
plus a retained $5.50 unknown-usage hold: $19.227605 of exposure. A new ledger segment
is capped at the remaining $10.772395. No historical usage receipts are fabricated,
and the old hold is not released. Aggregate exposure is the opening amount plus
new segment exposure, including any new unresolved calls.

New private artifacts, logs, receipts, and archives live under
`/Users/noah/Documents/Codex/ficus-evaluation-data/artifact-review-v1`, outside the
repository and temporary directories. The restored Python dependency environment
is captured there; its transitive versions are not asserted to match the lost
old environment. Public manifests and diagnostic conclusions are committed here.

A correct implementation with no independently verified defects can make this
comparison uninformative. One trial cannot establish a general prompt improvement
or justify promoting the experimental prompt to production.
