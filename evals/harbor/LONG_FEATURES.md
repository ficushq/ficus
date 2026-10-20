# Longer feature-work comparison

## Selection and scope

The completed four-task FeatureBench sample did not show an acceptance gain
from adding squad roles. The next workload uses an existing benchmark with
original, larger repository features: [DeepSWE](https://github.com/datacurve-ai/deep-swe).
Its v1.1 packaging grades committed changes in a separate pristine container.
This measures feature delivery and unattended completion; it does not by itself
measure human time saved or coordination of multiple dependent work streams.

The source is pinned in [the selection manifest](long-feature-v1-selection.json).
Filter to Python `feature_request` tasks for compatibility with the validated
CPU-only runtime, sort by SHA256 of `ficus-long-v1:<task-id>`, and take the first
task, `skrub-duration-encoding`. No model results informed selection. The next
independent candidate is `returns-validated-error-accumulation`; it is not yet
part of this frozen matched run. Both come from the existing external
dataset; no tasks or acceptance criteria are invented for Ficus.

Other candidates considered: [SWE-EVO](https://github.com/SWE-EVO/SWE-EVO) targets
version-to-version evolution but requires another adapter;
[SWE-Lancer](https://github.com/openai/frontier-evals) provides full-stack work
but has different environment requirements. DeepSWE can reuse the installed
Harbor framework and provides separate-verifier isolation. This selection is
based on fit and infrastructure, not published agent scores.

## Pre-inference gates

- Pin the upstream source, task image digest, task prompt, official verifier,
  reference solution and source base commit. Keep hidden material host-only.
- Grade the untouched baseline and reference with unchanged official assertions.
  Test candidate-written test/config collisions in the separate verifier.
  Preserve failed controls; no paid inference on a task with an invalid control.
- Keep the benchmark's public-network block during execution and grading. Agent
  installation may use the task's existing public setup phase. The only run-time
  addition is `host.docker.internal`, for the scoped local inference proxy.
  This is a hostname-wide allowlist, not a port-specific sandbox; record that
  limitation. Verify a public reference-source fetch fails.
- Ficus's optional `database_network=task` shares the task network namespace and
  connects over loopback. It does not attach an extra outbound network. Its
  PostgreSQL sidecar is limited to 0.5 CPU and 512 MiB, with no swap, persistent
  volume or published ports. The task keeps its upstream 2 CPU / 8 GiB limits.
  This extra compute remains a comparison limitation.
- Run a no-model transport/startup smoke and retain its result independently
  of task grades. Frozen Ficus runtime and prompts remain unchanged; adapter
  networking/readiness fixes are recorded separately.

## Intended matched run

Freeze the final controls and configuration before inference. Use the same four
arms as the earlier sample, with GPT-6.1 Sol / medium through native Pi 0.99.1:
Ficus squad, Pi squad, Ficus engineer, Pi engineer. This reverses the previous
harness order; a single reversal is not a randomized order-effect experiment.
Retain the official three-hour execution deadline and one attempt per arm.
Use an equal $10 per-arm inference ceiling, including all role calls and
unknown-usage reservations, under the unchanged cumulative $50 ceiling.
Accounting starts at $25.993347; the cumulative limit always takes precedence.
The conservative $5.50 per-call reservation can stop an arm below $10 confirmed
spend. Do not reset holds, raise caps, or silently retry budget-limited attempts.

No human rescues or corrective hints are supplied. Record original reward,
feature/regression results, committed submission hash, total/phase timing,
all-role spend, executed roles, reviewer returns, human questions and workflow
outcome. `delivered` alone is not unattended success: the official grade must
also pass. Infrastructure repair time is operator effort and must be reported
separately; it is not zero human attention. This run cannot claim hours saved
without an actual supervised comparison.

Only after the single-task integration is valid, freeze a separate pair of
unseen external tasks for matched concurrency-two batches. Count wall time from
both launches to final grading, report accepted tasks/hour and resource limits,
and permit both harnesses equal concurrency. Independent containers measure
batch throughput, not shared-product merge coordination or persistent memory.

## Reproducing the controls

Use the pinned task directory with `harbor run -p TASK -a nop` and `-a oracle`.
For candidate-file collisions, set `PYTHONPATH=evals/harbor` and use
`-a deepswe_controls:BaselineCollision` or
`-a deepswe_controls:OracleCollision --ak reference_task=TASK`.
The oracle control is host-only and receives the official solution directory;
never use it as an inference adapter. Both collision controls deliberately
commit a fake passing duration test and an early-success `test.sh`. The separate
verifier must restore the original tests and retain the baseline/reference grades.

`deepswe_network_smoke.py` contains the no-inference transport probes. It expects
a local HTTP probe on port 18765 returning 403, allows `host.docker.internal`,
and uses `--disable-verification`; these probes are infrastructure checks, never
benchmark results. Ficus uses the frozen runtime and `database_network=task`;
Pi uses version 0.99.1 and the planned workflow. Do not set a global
`DOCKER_DEFAULT_PLATFORM`: Harbor's egress sidecar uses the host architecture,
while the task image is pinned to amd64.

The budget proxy keeps the existing ledger and accepts `--client-cap-usd 10`
for the four named clients. Launch each arm through `run-pilot.py` with
`--restricted-network`, its own client/job name, and the pinned task directory.
The final run manifest records input and control hashes before the first call.
