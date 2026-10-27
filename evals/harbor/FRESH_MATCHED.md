# Fresh matched workflow comparison: Koota

This study runs the next unused task from the frozen DeepSWE selection under four matched harness/workflow conditions.
It is a separate batch from the earlier FeatureBench and concurrent DeepSWE results. The original plan allows one
attempt per condition; explicitly authorized recovery attempts are recorded separately below.

## Protocol

- External task: `koota-entity-snapshot-rollback`, upstream source commit
  `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`. The upstream selection metadata
  labels it Python, but the repository is TypeScript. We retained its place in
  the frozen order rather than selecting a different task after inspection.
- GPT-6.1 Sol, medium reasoning, through each harness's native Pi SDK path.
- Engineer-only versus coordinator/architect/engineer/independent-reviewer
  workflows. Pi uses its packaged subagent extension, version 0.99.1. Ficus uses
  its native flows with the closeout guidance from PR #677, fresh state and
  memory disabled. The experimental reviewer addition is excluded.
- Sequential order fixed before inference by sorting a seeded SHA256 of the
  task and condition: Ficus engineer, Pi engineer, Pi squad, Ficus squad.
- Task configuration requests 2 CPUs, 8 GiB memory, and 20 GiB storage. Docker
  CPU and memory limits were observed on the Pi squad container; no separate
  Docker storage quota was observed. Ficus also
  uses a disposable PostgreSQL service; this is extra harness compute, so the
  total resource envelopes are not identical. The Mac host emulates amd64.
- The original plan allows one attempt per condition, no operator task hints,
  hidden-test feedback, automatic retries, or per-task prompt changes. A budget interruption remains an
  interruption rather than a zero-cost or completed result.
- The initial plan retains the $35 phase cap, historical $5.50 hold, and
  conservative $5.50 per-request reservation. The later user-approved budget
  amendment raises the phase cap to $40; it does not discard the interrupted
  attempt or reset accounting. All parent and child inference counts toward cost.

The unmodified official grader has 84 feature checks and 47 regression checks.
Baseline control passed 0/84 features and 47/47 regressions; the reference patch
passed all 131. Both controls retained those results after deliberately colliding
with the task's test path and replacing `test.sh`. Native no-inference probes
confirmed provider access, blocked public fetches, and runtime readiness before
paid runs. Only the image digest and verifier architecture were pinned; the
request and grading files were unchanged.

See the frozen [plan](fresh-matched-v1-plan.json),
[inputs](fresh-matched-v1-inputs.json), and
[readiness manifest](fresh-matched-v1-ready.json). Their
`inference_started: false` fields record the pre-inference freeze, not current
execution status.

## Results

The original four-attempt batch is closed. Its last condition was interrupted
by the budget guard. Elapsed time includes setup, execution, and verification
where completed; it is not a measure of human attention.

| Condition      |    Feature checks |       Regressions | Accepted           | Inference USD |          Trial elapsed |
| -------------- | ----------------: | ----------------: | ------------------ | ------------: | ---------------------: |
| Ficus engineer |             83/84 |             47/47 | No                 |     $0.622898 |                  9m38s |
| Pi engineer    |             83/84 |             47/47 | No                 |     $0.375447 |                  5m39s |
| Pi squad       |             83/84 |             47/47 | No                 |     $1.504200 |                 22m09s |
| Ficus squad    | Not graded in-run | Not graded in-run | Incomplete: budget |     $0.840887 | 11m30s to interruption |

Both completed engineer runs have no infrastructure exception. Ficus completed
one native engineer execution and one execute step, with no owner waits or
pending messages. Both final responses reported committed work and a clean tree.
Agent-reported validation is distinct from the external grader above.

## Failure audit

All three completed first-attempt artifacts fail the same external roundtrip case: snapshot one world, restore it into a
newly created world, then compare snapshots. The implementations reject checkpoint IDs whose packed world ID differs
from the destination world. This same-world restriction was added by the implementations; it does not appear in the
supplied request's `rollbackWorld` contract. The external grader remains authoritative; we do not waive the failure
because the remaining checks pass.

This observation was made after the first run, then checked against the other
artifacts. It was not supplied to any later benchmark agent. Pi's architect
explicitly recommended rejecting cross-world restoration; its reviewer approved
the repaired implementation without removing that restriction. Ficus's original
architect also documented originating-world-only restoration. These traces show
an assumption persisting through handoffs, but do not prove context anchoring or
establish that a particular prompt change would fix it.

## Pi review and repair audit

The Pi coordinator delegated architect, engineer, reviewer, engineer revision,
then reviewer re-review. All returned successfully; the second review explicitly
approved the result. The reviewer requested two concrete allocator repairs:

1. Discarded entity handles became valid again after an ordinary spawn following
   rollback, because the allocator lost generation history.
2. Restoring one entity at the maximum local ID made later allocation fail even
   though lower local slots were free.

An operator-only, no-network reproduction against the exact pre-review and final
patches independently confirmed both observations and their repairs. Two basic
controls (ordinary unique spawning and restoration of a checkpoint handle) pass
before and after. The combined check changes from 2/4 to 4/4. A separate no-inference replay of
the pre-review patch also scores 83/84 features and 47/47 regressions, with
the same cross-world failure. Thus these repairs add demonstrated coverage
outside the official checks without improving this task's official score. Both audit builds
used Node 24.12.0 from the pinned base image; agent validation reported Node
22.23.4, below the repository's declared minimum. These post-hoc checks are
separate from the unchanged official score and are not agent inputs.

Pre-review patch SHA256:
`f84053f83f288a9ee00a6136beb16af87c7072729a2a405db2f3d67c18b8fd05`.
Final patch SHA256:
`cb061d6c184d019a87a59a6f57490a02283e823ac1c6b776e35d8c0631e1dc4e`.
The private durable `fresh-matched-v1/audit` directory retains the exact patches,
probe source, build command, and output logs. The result manifest records hashes
and individual observations.

## Interrupted Ficus condition and authorized recovery

The original Ficus manager and architect completed; the engineer's next model
request was rejected by the cap after $0.840887 of settled inference. There was
no reviewer execution or delivered work stream. The launcher canceled the trial
and disposed of its isolated resources. No provider receipt is missing for
this first attempt.

A separate no-inference replay grades the exact saved implementation at 83/84
feature checks and 47/47 regressions, with the same cross-world failure. This is
an artifact observation, **not a completed squad score or delivery claim**.

The user subsequently approved a $40 phase cap. The database had already been
disposed, so an exact resume was unavailable. A fresh repeat of only this condition
starts from the original task base and receives none of the previous artifact,
transcript, grading feedback, or operator audit findings. The frozen runtime,
model, prompts, resources, and task remain unchanged. Its pre-inference
[budget recovery amendment](fresh-matched-v1-budget-recovery.json) is committed
separately. Retain both attempts and sum their costs for recovery accounting;
do not present this as four uninterrupted first attempts.

The recovery also stopped during implementation, this time because provider call 755 returned an upstream streaming
error after HTTP 200 with no final usage receipt. The trial has no official grade or reviewer execution. Settled cost is
$0.686088 across 37 receipted calls, with one further unresolved call retaining its $5.50 reservation. Elapsed trial
time was 8m33s; launcher cleanup/settlement ended after 8m58s. This is a provider interruption, not an implementation
failure. No further inference retry was attempted in that $40 phase.

Together the two Ficus squad attempts have $1.526975 of settled inference and
one $5.50 unresolved reservation. They do not supply a completed squad result.
The original attempt's saved-artifact grade must not stand in for the recovery
or for a review-approved delivery. The recovery's saved patch is retained by
hash but was not separately graded.

## Accounting at close of the $40 phase

This batch has $4.029520 of settled inference across 287 receipted requests,
plus one unresolved request. Cumulative phase accounting is $24.705390
confirmed, the retained $5.50 historical hold, and the new $5.50 streaming-error
hold: $35.705390 exposure under the $40 cap. The remaining $4.294610 cannot
accommodate another $5.50 reservation. No hold was reset or assumed free.

At that phase boundary, all paid proxies and owned trial/audit containers stopped. The machine-readable
[result manifest](fresh-matched-v1-results.json) preserves both interruptions, role traces, scores, patch/result hashes,
offline checks, and receipt accounting. Further inference then required provider-usage reconciliation or explicit
additional budget. The next attempt below adds durable private checkpoints and verifies offline restoration; automatic
inference continuation remains unimplemented.

The recurring task-level issue worth studying is an added same-world restriction that survives handoffs and review. Keep
it as a concrete diagnostic for future held-out prompt comparisons, not a reason to change production guidance from one
task. The Pi reviewer added real coverage but did not challenge this design assumption. Those attempts did not supply a
completed Ficus-squad comparison.

## Checkpoint-enabled repeat in the new $20 phase

The user explicitly reset the phase allowance to $20 from zero. Old receipts and unresolved charges were preserved
separately. Before any new inference, the [recovery amendment](fresh-matched-v1-checkpoint-recovery.json) froze one
fresh repeat from the original task base. The task, model, medium reasoning, runtime, agent prompts, and official
verifier were unchanged. No prior patch, review, transcript, or grader feedback was supplied. Host adapter changes add
private checkpoint capture and resolve Harbor's main task container explicitly instead of using its shared
network-sidecar hostname.

The full Ficus squad **delivered and passed 84/84 feature checks and 47/47 regressions**. It used 135 receipted requests
costing **$2.457816**, with no unresolved usage. Four client disconnects still had final usage receipts. Trial elapsed
time was **39m01s**, including setup, checkpoint capture, and verification; it is not a pure agent-time comparison. The
launcher ended after 39m07s.

Native state records one completed architect execution, three engineer executions, three reviewer executions, and six
manager executions. The flow ran design, implementation, review with changes requested, repair, another review with
changes requested, another repair, and final approval. It finished with no owner waits or pending messages. There were
no operator task hints.

### What review contributed

The initial implementation at `14481e3` already passed **84/84 + 47/47** in a separate no-inference replay. The final
passing official score therefore cannot be attributed to review, or to a prompt change. This repeat avoided the earlier
same-world restriction before review began.

Review nevertheless identified concrete restoration defects:

1. Restoring a missing relation merged factory defaults back into a replacement record, changing its captured data. The
   first repair (`a804cc6`) fixed the final stored record.
2. Add subscribers still ran before exact restored data was installed. They saw unwanted defaults; a read-only callback
   using a restored Date could throw. The second repair (`14bc685`) initialized the exact data before callbacks.

The operator-only [reproduction](fresh-matched-v1-relation-audit.mjs) independently checks these behaviors against all
three commits in an offline clone, using Bun 1.4.2 and source imports. It covers exact records, callback records, Date
callbacks, and ordinary-add controls, in both exclusive and non-exclusive modes:

| Artifact       | Post-hoc checks | Ordinary-add controls |
| -------------- | --------------: | --------------------: |
| Before review  |             2/8 |                   2/2 |
| First repair   |             4/8 |                   2/2 |
| Final delivery |             8/8 |                   2/2 |

These checks are diagnostic evidence of the reported repairs, not a replacement benchmark or a common score for
comparing harnesses. They were never supplied to an agent. The official grader was unchanged and already passed before
repair.

### Recovery and accounting evidence

The actual completed trial's checkpoint was restored with no network and no worker. Its native database snapshot and
full message export matched exactly, without any new inference requests. The earlier setup probe also verified
workspace/session files and encrypted provider credentials. All temporary audit containers and paid processes were
stopped. Automatic inference resume is not implemented; a future continuation still requires guarded credential
rebinding and native execution recovery.

The new phase has **$17.542184 remaining**. Across all three Ficus-squad attempts, settled spend is $3.984791, plus the
earlier unresolved $5.50 reservation. Across this entire Koota study, including the completed repeat, settled spend is
$6.487336 plus that unresolved reservation. The older unrelated historical hold remains in its original phase. Resetting
the allowance did not reconcile it.

See [repeat results and audits](fresh-matched-v1-checkpoint-recovery-results.json). The original result manifest remains
unchanged. This is a completed repeat after two interruptions, not an uninterrupted fourth first attempt or evidence of
a general harness win. A broader fresh sample with fixed prompts is the next useful comparison; this one case does not
justify changing production prompts.

## Interpretation limits

One task, three completed first attempts, two interrupted Ficus-squad attempts, and one completed Ficus-squad repeat
cannot establish a general harness winner or a causal prompt effect. Official acceptance, audited failure causes, native
role execution, cost, and closeout are separate outcomes. These isolated tasks do not measure shared-product
integration, persistent memory, longitudinal coordination, or human focus time saved.
