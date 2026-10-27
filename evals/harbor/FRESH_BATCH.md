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

## Initial partial seaborn comparison (preserved)

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
$0. This is an infrastructure failure, not a Ficus acceptance failure. At that point both
engineer-only arms remained unattempted. All unused local images were absent;
the cause is not established. The Docker context was still OrbStack. No broad
image/volume cleanup was issued by this evaluation. With about 17 GiB free,
re-pulling the pinned 9.7 GiB compressed image and unpacking it could not safely
maintain the 10 GiB storage guard. Paid inference was stopped. The failed startup
and completed Pi result were preserved; no model attempt or replacement task ran
before the recovery below.

Original results: [preserved partial seaborn manifest](fresh-feature-v2-seaborn-partial-results.json).
At that checkpoint, the continuation had spent $8.978882, with cumulative
accounted exposure of $23.973944 against the $50 cap and no unsettled usage holds.

## Seaborn infrastructure recovery

After the user-authorized storage cleanup, the pinned base layers were still
available in Docker's cache. Rebuilding the unchanged official Dockerfile
produced the exact original image ID. Sanitization was repeated with the frozen
preparer. The original masked root commit can be reconstructed from the recovered
source tree and original timestamp, verifying the same tree, author identity and
message. The new sanitized image and Git commit have new timestamps/metadata;
they are not claimed to have the old image ID. All frozen grader files are
byte-for-byte identical. All four controls reproduce their earlier outcomes.

The three configurations that had not made any model calls resumed with distinct
recovery job/accounting IDs. The completed Pi squad is not rerun, and the
zero-call Ficus startup failure remains recorded. Model, instructions, workflow,
Ficus runtime, budget, and resource settings are unchanged. The original
PostgreSQL sidecar tag was not digest-pinned; its recovered digest is now recorded,
but original digest equality cannot be independently established. An idle,
network-disabled container retained the sanitized image while runs were active
and was removed after completion.
See [recovery manifest](fresh-feature-v2-seaborn-recovery.json).

## Completed seaborn comparison

| Arm            | Feature tests                   | Regression tests | Total wall time | Inference cost |
| -------------- | ------------------------------- | ---------------- | --------------- | -------------- |
| Pi squad       | 37 passed, 15 failed, 9 skipped | Not reached      | 31m59s          | $1.626289      |
| Ficus squad    | 42 passed, 10 failed, 9 skipped | Not reached      | 17m02s          | $1.166069      |
| Pi engineer    | 44 passed, 8 failed, 9 skipped  | Not reached      | 8m46s           | $0.345703      |
| Ficus engineer | 43 passed, 9 failed, 9 skipped  | Not reached      | 8m57s           | $0.507631      |

All four official rewards are zero. Each run has both immutable-input checks,
a verified submitted-source archive, and complete provider usage receipts.
The full squads executed architect, engineer and reviewer; Ficus also executed
its manager. Only the engineer executed in the Ficus engineer-only arm. No human
answers, operator steering or additional model attempts were introduced. The original Pi
squad result was not rerun. The zero-call startup failure remains separate.

Eight failures common to all arms require the plotter `.data` attribute. The
written `establish_variables` interface describes storing variables with
`setattr` and converting arrays to numpy, but does not explicitly name `.data`.
This is a task-contract caveat, not a reason to exclude the task or alter the
unchanged official score. Additional failures include scatter alpha (both
squads and Ficus engineer), warning category (Ficus squad), and Series handling
and optional-dependency error messages (Pi squad).

The Ficus squad reviewer reported 276 passing selected tests, seven skips and
one unrelated failure before approval. Those checks missed the hidden
compatibility requirements. A delivered work stream and a successful chosen
test suite are not proof of acceptance. These traces alone do not establish
that another generic prompt change would fix the problem.

Source-fetch indicator matches were inspected. They come from existing utility
source/tests and edit context: the `seaborn-data` dataset URL and `urllib.request`
imports. No reference-implementation fetch was identified in those matches;
repeated streaming events inflate raw counts. This is a trace audit, not proof
of network isolation. See the [completed manifest](fresh-feature-v2-seaborn-results.json).

Seaborn cost $3.645692, including the original Pi squad. Recovery added $2.019403
for the remaining three arms. The three-task continuation cost $10.998285;
cumulative confirmed exposure, including earlier development, is $25.993347 of
$50. There are no unknown-usage holds. The paid proxy and trial processes are
stopped.

## Complete four-task comparison

This includes the earlier fresh Pandas comparison and all three tasks above.
A task passes only when the unchanged official feature and regression phases
both pass; failed-feature runs do not reach regression grading.

| Arm            | Tasks passed | Total inference cost | Total wall time | Agent setup | Agent execution |
| -------------- | ------------ | -------------------- | --------------- | ----------- | --------------- |
| Pi squad       | 1/4          | $5.044957            | 87m37s          | 85.39s      | 5049.90s        |
| Ficus squad    | 3/4          | $5.768600            | 82m13s          | 456.53s     | 4349.44s        |
| Pi engineer    | 2/4          | $1.072002            | 24m12s          | 66.05s      | 1258.19s        |
| Ficus engineer | 3/4          | $2.254745            | 44m44s          | 325.97s     | 2226.85s        |

These 16 runs cost $14.140304. Wall time includes setup, execution, grading and
runner overhead; the two phase columns are not intended to sum to wall time.
Inference prices exclude host compute and the extra PostgreSQL sidecar.

Ficus has higher acceptance in both matched workflows on this sample. Pi's
engineer is cheaper and faster on every task; Pi squads are cheaper and faster
on the first three tasks, while seaborn reverses that comparison. Ficus squads
therefore have slightly lower aggregate wall time, but higher aggregate cost.
These are observations from four fixed-order, single-attempt tasks, not a
statistically reliable ranking. Source/task restrictions, reconstructed seaborn
environment metadata, unequal database compute, shared-host emulation, and
workflow/session differences limit comparability.

Adding squad roles did not improve acceptance over an engineer alone: Ficus
remains 3/4, while Pi falls from 2/4 to 1/4. This does not measure parallel
feature delivery, long-lived product work, or time returned to a human. Before
spending more on this comparison, choose an existing benchmark with independent
concurrent tasks or longer repository changes, freeze the task set and resource
budget, and record human questions/interventions, unattended completion,
calendar time and accepted changes alongside cost. Keep those measurements
separate from the official task score. Do not tune prompts against these four
known tasks and then count reruns as fresh evidence.
