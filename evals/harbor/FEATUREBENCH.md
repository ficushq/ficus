# FeatureBench integration preflight — 2026-10-19

Status: **do not score the downloaded Harbor tasks yet**. No feature-task
inference or oracle run was started. The four-arm Terminal-Bench smoke checks
are recorded separately in [PILOT.md](PILOT.md).

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
