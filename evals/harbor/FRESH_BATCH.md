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
