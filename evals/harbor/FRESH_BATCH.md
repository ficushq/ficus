# Three-task continuation

This continuation takes the next three tasks from the candidate ordering frozen
before the first Pandas comparison. Selection is recorded in
[fresh-feature-v2-selection.json](fresh-feature-v2-selection.json):

1. Sphinx C domain
2. xarray backend chunking
3. seaborn regression plots

Each task uses the same four arms in order: Pi squad, Ficus squad, Pi engineer,
Ficus engineer. There is one attempt per arm, no operator steering, and no
replacement of unsuccessful tasks. Model, reasoning effort, role prompts, and
Ficus runtime are unchanged from the first fresh comparison. The cumulative
$50 cap includes $14.995062 already accounted for before this batch.

Before inference on each task, audit its repository test layout and verify four
controls using the unchanged official grader: masked baseline fails, reference
passes, and both results survive replacement of the hidden test path by a fake
candidate-written test. Immutable verifier inputs are checked before and after
grading. Submitted source is archived before restoring the test fixtures.

The Sphinx controls passed: the masked baseline fails all 35 feature tests; the
reference passes all 35 and 81 regression tests. Its grader imports Sphinx from
`/testbed/sphinx/__init__.py`, including after its upstream installation commands.
The sanitized image contains no second Sphinx source installation under `/opt`,
`/root`, or `/usr/local`. Original Git history, source backups, patch fixtures,
and stale Python bytecode are removed before inference.

Task images are prepared one at a time to protect host storage. Reproducible
images from completed tasks can be removed, while submitted source archives,
logs, official fixture archives, image digests, and manifests remain. The three
completed Pandas image tags were removed before pulling Sphinx. No unrelated
containers, database volumes, SDKs, or device data were removed in this batch.
Image pulls stop if available host storage falls below 10 GiB.

Results will retain all failures, timeouts, and interrupted attempts. An invalid
control blocks paid inference on that task; it is not a harness failure and does
not justify silently replacing the task. Partial comparisons are reported as
partial. This remains a small convenience sample from a pinned legacy Harbor
FeatureBench snapshot, not a public leaderboard result. Shared-host amd64
emulation and Ficus's additional uncapped PostgreSQL sidecar remain limitations.

## Completed Sphinx comparison

| Arm            | Feature tests       | Regression tests | Total wall time | Inference cost |
| -------------- | ------------------- | ---------------- | --------------- | -------------- |
| Pi squad       | 29 passed, 6 failed | Not reached      | 30m01s          | $2.021502      |
| Ficus squad    | 35 passed           | 81 passed        | 30m20s          | $2.523095      |
| Pi engineer    | 29 passed, 6 failed | Not reached      | 5m50s           | $0.310846      |
| Ficus engineer | 35 passed           | 81 passed        | 13m22s          | $0.641413      |

Both squads executed architect, engineer, and reviewer roles, including internal
revision cycles. Pi's six failures all report a missing `TypedField.make_xrefs`
helper. Ficus delivered and passed the unchanged official grader. Both official
input checks completed for each arm. These outcomes were not fed into later
attempts. Ficus engineer-only execution was independently verified: only the engineer ran.
Both Pi arms failed on the same missing helper. Total Sphinx inference cost was
$5.496856, bringing cumulative exposure to $20.491918. All provider receipts are
present, and all four pre-grading source archive hashes verified. This one task
favors Ficus on acceptance, with higher cost in both workflows; it does not
establish a general performance ranking.

## xarray preflight packaging issues

The first preparation rejected the upstream mask with `corrupt patch at line
477`. The official image had applied its fallback `patch` command. Inspection
showed that the malformed final hunk concerned a test file deleted afterward by
the official Dockerfile. Validation now recounts hunk metadata and excludes the
already-deleted `xarray/tests` paths, while requiring every implementation hunk
to reverse exactly without fuzz. A regression confirms that leaving original
implementation code in place still fails this check. The actual masking patch,
image commands, and grader are unchanged.

The initial reference controls then failed before grading because the upstream
oracle tries to reverse the same mask against that deleted test. An oracle-only
setup step restores the tests from the original Git tree and reapplies only the
test part of the mask with recounted metadata. The byte-identical upstream
oracle can then reverse its complete patch. This setup is never uploaded to an
inference container and does not restore candidate implementation code. The
initial failed preparation and both failed reference-control logs remain in
separate private artifact directories. No model inference preceded these checks.

## Completed xarray comparison

All four controls passed after the reference-only precondition repair: baseline
fails at collection because a masked function is absent; reference passes 18
feature tests and 101 regression tests, with six upstream skips and one warning.
Both collision controls produce the same outcomes. All scoring imports xarray
from `/testbed/xarray/__init__.py`.

| Arm            | Feature tests      | Regression tests      | Total wall time | Inference cost |
| -------------- | ------------------ | --------------------- | --------------- | -------------- |
| Pi squad       | 9 passed, 9 failed | Not reached           | 11m18s          | $0.631002      |
| Ficus squad    | 18 passed          | 101 passed, 6 skipped | 12m58s          | $0.782605      |
| Pi engineer    | 18 passed          | 101 passed, 6 skipped | 3m59s           | $0.124625      |
| Ficus engineer | 18 passed          | 101 passed, 6 skipped | 7m47s           | $0.317505      |

Pi squad's failures involve region-size handling and an absent datetime helper.
Its single engineer passes, so adding roles did not improve this particular
attempt. Both Ficus workflows pass, with higher cost and elapsed time than the
corresponding Pi workflows. The Ficus engineer-only audit confirms that only the
engineer executed. Official input hashes, submitted-source archives, and usage
receipts all verify. The scanned external-source-fetch indicators are absent.
Total xarray inference cost is $1.855737; cumulative exposure is $22.347655.

## Partial seaborn comparison

All four pre-inference controls passed. The masked baseline fails 51 feature
tests and passes one (nine skipped); the reference passes all 52 and 218
regression tests (two skipped). Hidden-test collision controls reproduce both
outcomes. The task and all inputs were frozen before inference.

Pi squad completed its architect, engineer and independent reviewer workflow,
including revisions, but failed acceptance: 37 passed, 15 failed, nine skipped.
Failures concern preserving pandas Series/data attributes, option-specific
missing-dependency errors, and scatter alpha behavior. Regression grading was
not reached. The run took 31m59s and cost $1.626289. Its submitted archive hash
and both official verifier-input checks pass.

The next Ficus squad attempt stopped during environment construction because
its frozen local Docker image was missing. It made zero model calls and cost
$0. This is an infrastructure failure, not a Ficus acceptance failure. Both
engineer-only arms remain unattempted. All unused local images were absent;
the cause is not established. The Docker context was still OrbStack. No broad
image/volume cleanup was issued by this evaluation. With about 17 GiB free,
re-pulling the pinned 9.7 GiB compressed image and unpacking it cannot safely
maintain the 10 GiB storage guard. Paid inference is stopped. The failed startup
and completed Pi result are preserved, with no retry or replacement task.

Results: [partial seaborn manifest](fresh-feature-v2-seaborn-results.json).
This three-task continuation has spent $8.978882, with cumulative accounted
exposure of $23.973944 against the $50 cap. There are no unsettled usage holds.

## Interpretation so far

Across the three fully matched fresh tasks, including the earlier Pandas task,
Ficus squad and Ficus engineer each passed 3/3; Pi squad passed 1/3 and Pi
engineer passed 2/3. Seaborn is excluded from these matched totals because it is
incomplete. Pi was cheaper in every completed matched comparison and faster in
every completed matched arm. Ficus's higher acceptance on this small sample is
encouraging, but it does not establish a general ranking, statistical confidence,
or savings in human attention. The engineer-only xarray success alongside Pi
squad's failure also argues against assuming that more agents always help.

Next: restore storage headroom and the pinned seaborn environment, document any
reconstruction differences, rerun only infrastructure controls, and resume the
three arms that have not made model calls. Preserve the startup failure and use
a distinct recovery job ID. Do not rerun the completed Pi squad or feed its
failures into later prompts. Only then report the full four-task comparison.
