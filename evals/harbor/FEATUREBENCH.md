# FeatureBench integration preflight — 2026-10-19

Status: **unmodified downloaded tasks remain unsuitable; an isolated lv1
variant now passes preparation checks**. The original masked baseline receives
0 and the reference solution receives 1. The four-arm Terminal-Bench smoke
checks are recorded separately in [PILOT.md](PILOT.md).

## Existing integration

Harbor already provides a [FeatureBench adapter](https://github.com/harbor-framework/harbor/tree/346d04c545ddad5d171606ee9f2a3db3e5838f18/adapters/featurebench).
Use existing benchmark preparation and grading rather than creating a new
benchmark. Do not confuse FeatureBench with the separate FeatBench adapter.

Inspected Harbor source: `346d04c545ddad5d171606ee9f2a3db3e5838f18`. Downloaded the 30-task
`featurebench-lite` legacy registry entry, version `1.0`. Its entries reference
`harbor-datasets` at mutable `HEAD`; the registry version is not proof of the
upstream dataset revision. Before scored trials, freeze the actual dataset
commit, task checksums, image digests, and prompt version. In particular, these
files must not be called the proposed V1.1 fast sample without verification.

## Agent-visible answer material

The downloaded Pydantic task's `environment/Dockerfile` has SHA256
`f519aab3f31fd36011a9cbb9fc89fd2f3dc9ab5c62f3964926df57600d99e196`. Its setup:

- Copies `setup_patch.diff` into `/tmp/setup_patch.diff` and keeps it for the
  oracle, whose solve script reverses it. An agent can read that patch too.
- Keeps `test_patch.diff`, exposing withheld test contents.
- For level-two tasks, stores the original repository in
  `/tmp/.hb_solution.tar.gz` before presenting the empty workspace.
- For level-one tasks, snapshots the original Git diff rather than rebuilding
  a clean masked repository. Original Git objects must also be audited for
  answer access.

The inspected current upstream template has the same behavior. This is a source
inspection finding, not an accusation that a particular model exploited it.
Do not send these materials to the model or treat a passing result from this
configuration as clean evidence. No solution content was copied into our source.

## Next implementation boundary

The original FeatureBench inference runtime already removes the pristine source
copy, applies and deletes the mask patch, removes held-out tests and stale Python
bytecode, and initializes a fresh Git baseline. Reuse that preparation, or bring
the Harbor task preparation to equivalent isolation. Keep grader inputs outside
the agent container until verification. Preserve the upstream evaluator's
acceptance tests and include failed/interrupted predictions.

Before paid feature runs:

1. Pin a CPU-compatible task/image and prepare it without visible gold patches,
   hidden tests, solution archives, old Git objects, or stale bytecode. Audit the
   actual container filesystem; a prompt asking agents not to read them is not
   isolation.
2. Validate the unchanged grader in separate disposable containers: original
   masked baseline, then oracle. Record any upstream test filtering instead of
   silently weakening the acceptance criteria. Never reuse an oracle container
   for inference.
3. Freeze the task selection and four-arm configuration before model runs. Match
   resources, reasoning, task information, review expectations, and aggregate
   budget; disclose the remaining Pi/Ficus session-reuse difference.
4. Grade every attempted arm, retaining failures. If using `fb eval`, specify
   `--include-failed`; report attempt one rather than best-of retries.

This preflight uses no additional inference. The $20 cumulative cap remains in
force; a full FeatureBench suite has not been authorized or scheduled.

## Isolated lv1 preparation and frozen pilot

`prepare_featurebench.py` prepares a fresh task from a locally built upstream
image. It checks that the mask applied, retains the original Git state and
answer/test fixtures on the host, removes them from the agent filesystem, clears
stale bytecode/source copies, and initializes a single masked Git commit. The
only package source found in the Pydantic image is `/testbed/pydantic`; no second
pristine package tree or held-out test file remains. Root cannot access the host
Docker socket or original image layers from the task container.

Harbor uploads `tests/` only after the agent finishes. A wrapper then restores
upstream Git/index metadata without overwriting agent working files and invokes
the byte-identical upstream test script. This preserves the existing acceptance
tests and change guard. Oracle-only fixtures live in `solution/`, never in the
agent image. Level-two tasks are deliberately unsupported by this preparer.

Two local isolation tests verify answer-history removal, preserved agent edits
on grading restoration, and refusal of an unapplied/invalid mask. Live setup
attempts one and two failed before grading because the temporary preparation
entrypoint persisted through Docker commit; setting an explicit passthrough
entrypoint corrected it. These attempts used no model inference. The third
isolated baseline received 0 and the oracle received 1, without exceptions.

All eight downloaded task files match dataset commit
`37db108843a49bb31a592e37a75e2c40dc3f9749`. [feature-pilot.json](feature-pilot.json)
freezes source hashes, the isolated image, runtime, task limits, model, ordered
arms, and budget before feature inference. The task is Pydantic deprecated-field
support. This is an exploratory single-task pilot using the pinned Harbor
snapshot, not the originally proposed V1.1 fast split or a leaderboard estimate.

The Ficus adapter now preserves the task image's PATH when prepending its own
runtime tools. Both harnesses can activate the image's `testbed` conda environment.
No production runtime or provider changes were required.
