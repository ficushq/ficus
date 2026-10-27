# Fresh matched mnamer study

This is the next unused task in the frozen DeepSWE selection after Koota:
`mnamer-daemon-watch-lifecycle`. It asks for continuous folder monitoring,
state tracking, logging, and daemon lifecycle commands. Task selection did not
use model results.

The [plan](fresh-matched-v2-plan.json) freezes four sequential first attempts:
Pi engineer, Pi architect/engineer/reviewer, Ficus architect/engineer/reviewer,
then Ficus engineer. This order is derived from the task and arm names by SHA256.
Every condition uses native Pi SDK GPT-6.1 Sol with medium reasoning, the same
original task and unchanged official grader. Ficus reuses the exact Koota
closeout-guidance runtime; no experimental reviewer addition or per-task prompt
tuning is included.

Task resources remain two CPUs and 8 GiB memory; the requested 20 GiB storage is
not an observed enforced quota. Ficus additionally uses a disposable loopback
PostgreSQL container. Host architecture emulation and harness setup overhead
limit timing comparisons. Ficus captures a private task/database checkpoint
before cleanup; elapsed time includes that overhead. Checkpoint restoration
is verified offline, but automatic inference continuation is not implemented.

Before paid inference, require baseline/reference and test-file-collision
controls, and native Ficus/Pi restricted-network probes. Final grading uses a
separate pristine verifier without networking. No solutions, hidden feedback,
previous implementations, or operator task hints enter inference environments.

The existing $20 phase opened this study at $2.457816 spent, leaving $17.542184.
Every request still reserves $5.50; missing receipts retain their holds. There
are no automatic paid retries. Any interruption remains a separate outcome,
and partial results do not become a completed four-arm comparison.

Report official acceptance, feature/regression counts, native role execution,
review/repair transitions, owner waits, cost, and elapsed time separately. One
additional task will not establish a general harness winner or measure human
focus time saved, persistent memory, or dependent product coordination.

## Results

All four first attempts completed without an infrastructure interruption, paid
retry, owner wait, or operator task hint. Each passed **51/51 feature tests and
319/319 regressions** under the unchanged official verifier.

| Condition      | Accepted | Inference USD | Calls | Elapsed |
| -------------- | -------- | ------------: | ----: | ------: |
| Pi engineer    | Yes      |     $0.221011 |    23 |   6m15s |
| Pi squad       | Yes      |     $0.783735 |    84 |  22m08s |
| Ficus squad    | Yes      |     $1.052676 |    56 |  19m56s |
| Ficus engineer | Yes      |     $0.640893 |    36 |  13m43s |

Elapsed times include startup and verification. Ficus times also include private
checkpoint capture; they are not pure model/agent execution times. All inference
receipts include coordinating and child model calls. No human attention savings
were measured.

Pi's native subagent records show architect → engineer → reviewer → engineer
repair → reviewer approval. Ficus's squad completed design, implementation and
review with first-review approval, plus two completed manager executions. Its
engineer-only condition executed only an engineer; both Ficus streams delivered
with no owner waits or pending messages.

## What review contributed

Pi's reviewer requested three repairs: a source-replacement race that could
lose unobserved data, dry-run destination collisions that disagreed with actual
batch selection, and startup waiting behind an ongoing processing-cycle lock.
The engineer repaired them and the reviewer approved the second review.

The operator-only [offline reproduction](fresh-matched-v2-review-audit.py)
independently confirms the first two repairs. It injects a replacement at
publication and compares dry-run versus actual selections for colliding names.
Both have ordinary-behavior controls. The pre-review artifact passes **2/4**
checks, and the repaired artifact **4/4**; both controls pass in both versions.
No worker, inference, or network is started. The startup/lock finding is retained
as agent-reported evidence and was not independently reproduced.

A separate no-inference replay of the pre-review patch also passes **51/51 +
319/319**. Therefore the demonstrated repairs did **not** improve the official
score. Ficus's pre-review and final patches have identical hashes, matching its
first-review approval; no additional identical-artifact replay was needed.
These diagnostic checks are not a substitute benchmark, a common cross-harness
quality score, or evidence that the other implementations share these defects.
They were never supplied to any agent.

## Evidence and accounting

[Machine-readable results](fresh-matched-v2-results.json) retain patch/result
hashes, native roles, timings, grading, checkpoint checks, and audit outcomes.
Both Ficus checkpoint archives passed complete file-hash verification; restoration
support was verified in the preceding Koota study. No new restoration or automatic
inference-resume claim is made here. Private databases, filesystem archives and
full conversations remain outside Git.

This study spent **$2.698315 across 199 receipted calls**, with no unresolved usage
or budget rejections. The active $20 phase now totals **$5.156131**, leaving
**$14.843869**. Historical spending and unresolved holds remain preserved outside
this explicitly reset phase. All paid trial/proxy processes and owned audit
containers stopped.

On this task Pi engineer was the least expensive and fastest accepted condition.
The extra roles did not improve official acceptance, while Pi review did repair
specific independently confirmed defects beyond that grader's coverage. One
additional task does not establish a general harness or prompt winner. Keep the
prompts fixed for the next unused task in the frozen selection; no production
prompt change is supported by this result alone.
