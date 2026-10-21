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

## Completed result

Both reviews inspected artifact commit
`57990ef865b51971af6469bbefc965d72c1330cb`, from patch SHA256
`aafc0cd73b79ad6b211ea93c00627c797ab2d54a601f4914553c47e26b2c5a32`.
The implementation passed all 103 official feature tests and all 10,093 existing
regression tests. Its engineer-only generation cost $0.561816 across 37 requests.
Neither reviewer received those results.

| Reviewer condition            | Verdict           | Independently reproduced blocking findings | Requests | Recorded cost |
| ----------------------------- | ----------------- | ------------------------------------------ | -------- | ------------- |
| Original prompt               | Approve           | None reported                              | 16       | $0.220501     |
| Independent-contract addition | Changes requested | 2 of 2 reported                            | 19       | $0.309695     |

Both runs completed with reviewer-only role provenance and an unchanged repository.
The candidate found two defects that the original reviewer did not flag:

1. **Pandas grouped rolling dispatch was missing.** Existing `rolling_sum` and
   `rolling_mean` work with `.over('g', order_by='i')`, but all four new methods
   raise `NotImplementedError`. The implementation's new tests skip pandas grouped
   rolling as unsupported. The original reviewer accepted that claimed limitation;
   the candidate checked the existing public behavior and rejected it.
2. **Arrow discrete rolling quantiles reject valid numeric inputs.** For lower,
   higher, and nearest interpolation, large Int64 values and Decimal values raise
   `ArrowInvalid` during result reconstruction. The existing nonrolling quantile
   handles the same inputs, and the new linear/midpoint cases succeed.

Both findings were reproduced independently in a fresh container, with the exact
frozen patch, network disabled, and no repairs. The reproduction is in
`artifact-review-v1-reproduce.py`. These are functional correctness issues; the
candidate's “Critical” severity labels are not established by this audit.

The original review was not superficial: its tool outputs confirm 1,713 passing
rolling regression cases and 2,448 additional boundary comparisons. Its approval
still missed the incorrect grouped-backend assumption and the uncovered numeric
inputs. The candidate's focused test counts and defect reproductions are also
supported by its saved tool outputs.

This is positive controlled-artifact evidence for the guidance, not proof of a
repeatable general improvement. The two issues were discovered by the candidate
and checked afterward; they are not an exhaustive, predeclared defect set, so no
recall estimate is claimed. The official benchmark score stays unchanged. The
result also shows why passing its tests does not establish exhaustive correctness.
No full-squad repair cycle was measured here, and production prompts remain
unchanged. Replicate on additional frozen artifacts before recommending promotion.

Total new recorded usage was **$1.092012**, with no new unresolved calls. Phase
exposure is **$20.319617**, including the retained earlier $5.50 hold, leaving
**$9.680383** under the $30 cap. See `artifact-review-v1-results.json` for full
reports, integrity checks, reproduction hashes, and accounting. The private
ledger has a completed-segment backup in the durable data directory.
