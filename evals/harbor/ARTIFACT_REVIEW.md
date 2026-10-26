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

## Replication: Bandit structured directives

The next unused frozen-order task, `bandit-structured-nosec-directives`, repeats
this protocol with the exact same model, runtime archives, reviewer addition,
and baseline-first order. Four official grading controls and both native runtime /
network probes passed before inference. The upstream image required no dependency
changes; its digest and explicit verifier architecture were pinned.

One engineer-only implementation was generated and frozen without operator repairs.
It passed **67/69 official feature checks and 280/282 regression checks**. Neither
reviewer received those results. Both reviewed commit
`8850b4486b42850e26a8e83266d87f148c4dae7d` from patch SHA256
`fc27071def1014074bf1a7d2531644616ae67e74ffef2a8c9ae9a9916e2f2fcd`.

| Reviewer condition            | Verdict           | Independently reproduced findings | Requests | Recorded cost |
| ----------------------------- | ----------------- | --------------------------------- | -------- | ------------- |
| Original prompt               | Changes requested | 2 of 2 reported                   | 17       | $0.222182     |
| Independent-contract addition | Changes requested | 2 of 2 reported                   | 12       | $0.183341     |

Both passed role and repository-integrity checks. Their findings overlap partly:

- **Both:** a next-statement directive inside a multiline statement suppresses
  that already-started statement and leaves the intended next statement unsuppressed.
- **Original only:** a later structured directive in a comment causes an existing
  inline suppression on that line to be discarded.
- **Candidate only:** region suppressions do not reach comment-only lines reported
  by the existing `trojansource` File plugin. Assignment-line controls work.

All three defects were independently reproduced with actual plugins in a fresh
network-disabled container. No implementation repairs were made. The exact
published script is `artifact-review-v2-reproduce.py`. Both reviewers also ran the
visible repository tests successfully; the counts are corroborated by tool output.
Their “Critical” labels are not severity judgments established by this audit.

The four official failed assertions are kept separate from these findings. Three
assert that a named selector remains specific even when it covers every enabled
test; the implementation treats that resolved set as blanket. The fourth expects a
region begun inside a multiline statement to suppress it despite a following
physical dedent. The public request's resolved-set classification and dedent rules
leave interpretation questions at these boundaries. The operator inspected these
failed cases after freezing the artifact; neither reviewer received this analysis.
The official grade remains unchanged, and this is not a claim that the grader is
wrong or that its four failures prove four separate defects.

**Neither reviewer dominates this replication.** Each found one issue the other
missed. The candidate cost less here, but one stochastic run does not establish an
efficiency advantage. Across the two controlled artifacts, the candidate found
useful additional issues, yet also missed a baseline-only issue. These discovered
and subsequently audited issues are not an exhaustive defect inventory, so they
cannot support a recall estimate. Keep the prompt experimental; use more independent
samples before recommending promotion. No production prompt changed.

Generation cost **$0.500047**; the complete replication cost **$0.905570** across
64 requests, with no new unresolved usage. Both replications share the same durable
ledger segment. Current phase confirmed spend is **$15.725187** plus the unchanged
**$5.50** prior hold: **$21.225187 exposure**, leaving **$8.774813** under the $30 cap.
See the v2 plan, input, readiness, artifact, and results manifests. Private artifacts
remain in the durable sibling `ficus-evaluation-data/artifact-review-v2` directory.

## Replication: Kombu consumer lifecycle

The next frozen-order task, `kombu-single-active-consumer-priority`, used the
same runtime archives, model, reasoning, and baseline-first review order. All
four official controls and both native startup/network probes passed. One
engineer produced the frozen artifact, which passed **85/85 feature tests and
1,421/1,421 regression tests**, at a cost of **$0.572532**. Neither reviewer
received that score or the engineering transcript.

Both inspected artifact commit `0421e62d4a11a39fcf7fdcbd0afdd0f76f6e39c4`, patch
SHA256 `109e72dc1a04050e7599a659bf5f208c4dd05189bf8c56a0b52b1db27843a9f3`.
Both completed with reviewer-only provenance and unchanged repositories.

| Reviewer condition            | Verdict           | Reported findings | Requests | Recorded cost |
| ----------------------------- | ----------------- | ----------------: | -------: | ------------: |
| Original prompt               | Changes requested |                 2 |       16 |     $0.224491 |
| Independent-contract addition | Changes requested |                 2 |       17 |     $0.262050 |

Independent offline reproduction qualified the reports as follows:

- **Both:** the new SAC-membership query remains true after direct channel
  cancellation, despite an empty broker registry. The original report also
  identified failed reconsumption and exceptions from all three new Consumer
  inspection helpers after channel close; those reproduced too.
- **Original only:** a demoted Consumer reports itself active when a different
  channel registers the same tag. The channel-level record and actual delivery
  correctly identify the other registration. Failover restores real ownership.
- **Candidate only, inherited integration gap:** an SQS no-ack registration can
  cause backend deletion before the selected manual-ack consumer acknowledges.
  Receipt metadata is lost. Real conversion, dispatch and acknowledgement code
  reproduces this with only external AWS calls substituted; manual/manual
  controls work. Crucially, the same mixed-ack failure occurs on untouched
  upstream code (which ignores SAC). It is an existing backend assumption left
  unresolved by the new consumer selection semantics, **not an established new
  regression**. No live AWS behavior was tested.

The original reviewer found more distinct defects in the newly added Consumer
APIs on this artifact. Both reports' behavioral observations are reproducible,
but counting them as two equivalent new bugs each would obscure the inherited
SQS issue and the original report's broader lifecycle coverage. Neither report's
Critical labels are independently established severity ratings.

Saved tool output supports both reviewers' 25 focused, 251 broader targeted, and
1,452 available unit-test passes (175 skips). Both explicitly excluded two modules
with unavailable Azure/Google dependencies; these are environment limitations.
The official grade is unchanged. No exhaustive defect inventory or recall estimate
is claimed. Keep the experimental prompt out of production.

The complete replication cost **$1.059073** across 67 requests, all settled.
At completion, phase exposure was **$22.284260**, including the retained $5.50
hold; **$7.715740** remained. See `artifact-review-v3-results.json` and
`artifact-review-v3-reproduce.py`, including the untouched-upstream control.
