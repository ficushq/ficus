# Evaluation assessment

The adapter can run native Ficus orchestration against external tasks and their
unchanged graders. Evidence so far does not establish a general harness winner,
a consistent advantage from adding roles, or measured human focus time saved.
The studies below answer different questions and should not be pooled into one
leaderboard score. All use native Pi SDK GPT-6.1 Sol with medium reasoning.

## Matched workflow comparisons

Four frozen FeatureBench tasks (Pandas, Sphinx, xarray, seaborn), one attempt per
configuration, produced these reported results:

| Configuration  | Accepted tasks | Inference USD | Total elapsed across tasks |
| -------------- | -------------: | ------------: | -------------------------: |
| Pi engineer    |            2/4 |     $1.072002 |                     24m12s |
| Ficus engineer |            3/4 |     $2.254745 |                     44m44s |
| Pi squad       |            1/4 |     $5.044957 |                     87m37s |
| Ficus squad    |            3/4 |     $5.768600 |                     82m13s |

Ficus had higher acceptance than the matched Pi configuration in this sample.
Pi's engineer was cheaper and faster on every task. Adding roles did not improve
Ficus acceptance. Fixed order, shared-host amd64 emulation, extra Ficus database
compute, environment recovery, and one attempt per condition limit inference.
See [the first task](FRESH_FEATURES.md) and [the continuation](FRESH_BATCH.md).

The subsequent concurrent pair of DeepSWE tasks (returns and aiomonitor) produced:

| Configuration  | Accepted tasks | Inference USD | Two-task batch elapsed |
| -------------- | -------------: | ------------: | ---------------------: |
| Pi engineer    |            2/2 |     $0.658107 |                  9m22s |
| Ficus engineer |            2/2 |     $1.322362 |                 15m48s |
| Pi squad       |            0/2 |     $2.063421 |                 20m03s |
| Ficus squad    |            1/2 |     $2.669135 |                 27m09s |

This comparison includes explicitly recorded recovery after provider-credit
failures, not eight uninterrupted first attempts. Both engineer configurations
passed both tasks; extra roles again did not improve acceptance. Ficus squads
completed all four native roles without operator task hints. The returns design
assumption survived independent review; Pi's aiomonitor review repaired a real
bug but still missed required routes. See [the full concurrent study](CONCURRENT_FEATURES.md).

These are independent task containers. They do not measure a manager coordinating
dependent changes in one product, persistent memory, integration conflicts across
work streams, or human attention saved. Calendar time is not a measurement of
human focus time. Infrastructure recovery is separate from task-level assistance.

## Reviewer guidance and repair

The full-squad independent-review pilot accepted 0/2 original-prompt artifacts
and 1/2 experimental-prompt artifacts. The passing implementation already existed
before review, so that difference cannot be attributed to the reviewer guidance.
See [the pilot](INDEPENDENT_REVIEW.md).

Controlled follow-ups instead give both reviewers the exact same frozen artifact.
They receive no hidden-test feedback, other review, or engineering transcript.
Reported defects are independently reproduced after both reviews. These studies
measure review findings, not autonomous repaired delivery. Their discovered issues
are not an exhaustive ground-truth inventory, so no recall estimate is justified.
See [the controlled study](ARTIFACT_REVIEW.md) for each result.

Four controlled artifacts are now complete:

| Artifact | Audited comparison                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Narwhals | Original approved; candidate found two verified defects.                                                                                             |
| Bandit   | Each found two verified defects, including one unique finding each.                                                                                  |
| Kombu    | Original found broader lifecycle defects and an identity defect; candidate added an inherited SQS integration problem that also reproduces upstream. |
| HTTPX    | Both found the same two verified error-path defects.                                                                                                 |

This is mixed evidence, not a consistent advantage for the addition. The Kombu
upstream control matters: a reproducible observation is not automatically a new
regression. Reported Critical labels are not independently established severities.
No production prompt changes are recommended from these four samples.

The separate native squad repair continuation was frozen in
`artifact-repair-v1-plan.json`, with independent checks frozen before that run.
It starts from the known Bandit implementation and the original review, using
original guidance. All four roles executed and independently approved repairs to
both supplied findings. Frozen checks improved from 4/9 to 7/9, but the withheld
File-plugin defect remained and the official grade stayed at 67/69 feature checks
and 280/282 regressions.

The manager reopened the approved stream to commit untracked task evidence,
starting another full design/implementation/review cycle. The documentation commit
was saved, but the run reached the conservative budget guard before flow closeout.
It is budget-limited, not an autonomous delivered success. A separate no-inference
replay graded the exact saved patch. See [the repair report](ARTIFACT_REPAIR.md).
This cannot be represented as an unseen benchmark success, a prompt-effect result,
or a comparison with a fresh single-engineer attempt.

## What should change, and what should remain a hypothesis

- Keep single-engineer and squad configurations separate in product guidance and
  future comparisons. These samples do not support treating extra roles as an
  automatic correctness improvement or a cheaper way to complete an isolated task.
- Evaluate reviews by supported defects and repaired final behavior, not review
  volume, severity labels, or the existence of a reviewer role. Preserve cases
  where the baseline catches something the experimental prompt misses.
- Keep the independent-contract prompt experimental until repeated evidence
  supports a production recommendation. Further prompt comparisons should
  counterbalance review order and use repeated independent artifacts; the
  baseline-first single samples here cannot isolate order or sampling effects. No production prompt changes are included
  in these evaluation commits.
- Avoid a broad reviewer-prompt rewrite based on these results. The narrower
  completion-hygiene fix in PR #677 preserves required task evidence before
  approval. Its separate one-run validation below completed without reopening;
  broader delivery-reliability claims still need replication.
- Investigate the specific observed failure modes: behavioral assumptions copied
  from design into review, approvals despite uncovered public-interface cases,
  and inability to complete when a dependency is unavailable. Do not add broad
  prompt instructions without a concrete regression and a held-out check.
- The next broader study should reuse external tasks with predeclared concurrency
  and resource budgets. Run matched engineer-only and architect/engineer/reviewer
  configurations with the same model, task set, tools, and retry policy. Record
  accepted work, batch throughput, cost, review-to-repair outcomes, owner-wait
  events, and operator interventions. Measure human attention as actual active
  intervention time and interruptions, not a subtraction from wall time.
  Dependent product work and persistent memory need a separate, explicitly
  labeled longitudinal study; these independent-container scores cannot
  establish those benefits.

## Closeout-guidance validation

A targeted follow-up applies only PR #677's six prompt/skill changes to the same
frozen runtime and repeats the known Bandit repair from its original starting
artifact. The squad committed its plan and other required deliverables, completed
a substantive reviewer-requested Unicode-line repair, and delivered without a
second design pass or documentation-only reopen. The manager relocated its own
runtime monitor artifacts and verified an empty final Git status.

The original frozen checks remain 7/9 and the official grade remains 67/69 feature
checks and 280/282 regressions, with the same failures. Six additional post-hoc
Unicode-line reproductions improved from 0/6 to 6/6. They corroborate the new
review finding, not a pre-registered score improvement. This one stochastic run
cost $1.215893; it supports the closeout fix as a candidate but cannot establish
causality or generalized savings. See [the complete audit](ARTIFACT_REPAIR.md#closeout-guidance-validation-v2).

## Fresh review diagnostic and next experiment

Two fresh reviewers examined the delivered Bandit repair with the original
request and no prior conversation or defect hints. Each found two independently
reproduced problems, with no overlap. The baseline found clause-header and
single-line-suite boundary failures. The existing experimental addition found
the known comment-only File-plugin failure and a second semicolon-targeting
failure. Both completed without changing the repository. The original nine-case
score and official grade remain unchanged because no agent repair occurred.

The separate offline diagnosis confirmed physical region coverage was computed
but discarded for findings outside statements. Retaining that coverage in a
**disposable operator-only mutation** changed the frozen checks from 7/9 to 9/9.
This is causal evidence about the code path, not a benchmark score or a delivered
fix. See [the diagnosis](ARTIFACT_REPAIR.md#remaining-file-plugin-defect-offline-diagnosis)
and [the fresh-review audit](ARTIFACT_REVIEW.md#fresh-reviews-of-the-delivered-bandit-repair-v5).

The experimental addition has twice caught this particular gap, but the baseline
continues to find different supported defects. Fresh passes can add coverage;
one selected artifact does not justify a universal second-review stage or prove
context anchoring caused the original approval. Keep the addition experimental.

The next paid study should return to unused external tasks from the frozen
selection, with matched engineer-only and full-squad workflows and no
per-task prompt tuning. Predeclare task order, model, resources, retry policy,
and budget; report official acceptance separately from audited review findings,
closeout behavior, cost, and operator interventions. If testing review variants,
use repeated independent artifacts and counterbalance order. Do not count this
known Bandit continuation as another unseen task. Shared-product coordination
and human attention still need the separate longitudinal study described above.

## Fresh matched Koota task

The next unused external task tests entity snapshot, rollback, and diff APIs in
Koota. Its upstream metadata calls it Python, but it is TypeScript; frozen task
order was retained. Native setup/network probes and baseline/reference/test-file
collision controls passed before inference. The experimental reviewer addition
was excluded; Ficus used the closeout-guidance runtime.

Three first attempts completed, each with 83/84 feature checks and 47/47
regressions (none accepted). Pi engineer cost $0.375447 in 5m39s; Ficus engineer
cost $0.622898 in 9m38s; Pi squad cost $1.504200 in 22m09s. All retained a
same-world rollback restriction absent from the supplied contract. Pi's
architect explicitly recommended it and its reviewer approved the final result.

Pi's reviewer nevertheless found two allocator defects, routed them through an
engineer repair, and approved a second review. Independent post-hoc reproductions
confirm both repairs, with basic controls passing before and after. No-inference
grading of the pre-review patch confirms the official score stayed unchanged.
This illustrates why supported review improvements and official acceptance should
be reported separately.

Ficus's original squad attempt was budget-interrupted during implementation.
Its saved patch grades at the same 83/84 and 47/47 in a separate no-inference
replay, but it was never reviewed or delivered. The user authorized a $40 phase
cap; a fresh repeat with identical inputs then hit a provider streaming failure
without a usage receipt. Both attempts and costs are retained. There is no
completed Ficus-squad result in this batch, and no four-way acceptance ranking is
valid. See [the complete report](FRESH_MATCHED.md).

Before more paid recovery, reconcile the missing receipt and add durable private
runtime/workspace checkpoints with offline resume validation. Keep the repeated
contract-narrowing behavior as a diagnostic for held-out prompt comparisons;
this one task does not justify another production prompt rewrite.

## Evidence and accounting limits

Earlier temporary raw artifacts and the original detailed ledger are no longer
available. Their published results and hashes are retained as historical reports,
not a claim that the original raw evidence can be re-audited today. Controlled
review artifacts, runtime archives, receipts, and reproductions now live in the
durable sibling `ficus-evaluation-data` directory.

The current user-authorized phase cap is $40 (increased from $30 to $35 for
the closeout-guidance validation, then to $40 for the Koota squad recovery). Its opening historical exposure and
unresolved $5.50 hold remain carried forward; the durable ledger segment is shared
across the controlled studies rather than reset between tasks. Latest completed
result manifests are authoritative for current spend. Historical dollar totals in
the tables above belong to their documented phases and are not added again to the
current cap. No missing provider receipt is treated as zero cost.

The two reviewer replications and v1 repair cost $3.279914. The additional v2
closeout validation cost $1.215893 across 88 settled requests. The fresh-review
pair added $0.454876, leaving $20.675870 confirmed before the Koota batch.
The Koota batch adds $4.029520 in receipted inference plus one unresolved
streaming-error call. Current phase accounting is $24.705390 confirmed plus
$11 of holds ($5.50 historical and $5.50 new): $35.705390 exposure under $40.
The next $5.50 reservation does not fit. All owned trial processes are stopped;
no hold was released without provider reconciliation.
