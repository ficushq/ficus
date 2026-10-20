# Two-task concurrent feature comparison

This is a separate matched batch-throughput experiment, following the completed
single-feature comparison in `LONG_FEATURES.md`. The next two unseen tasks in the
original deterministic DeepSWE selection are `returns-validated-error-accumulation`
and `aiomonitor-task-snapshots-diff`. They were selected before model outcomes.
No new benchmark tasks or acceptance assertions are introduced.

Each of the four configurations receives both tasks concurrently, with separate
pristine workspaces. The batches run sequentially in the frozen order: Pi squad,
Ficus squad, Pi engineer, Ficus engineer. Both squads retain their coordinator,
architect, engineer and independent reviewer workflows; both controls use one
engineer per task. All use native Pi 0.99.1 GPT-6.1 Sol / medium and the previous
frozen Ficus runtime/prompts. Fresh memory stays disabled. There is one model
attempt per task/configuration and no operator task steering or retries.

Measure batch time from launching the first process until both official graders
finish, plus each trial's setup/execution/grading times and overlap. Report
accepted tasks/hour, both individual outcomes, all-role cost, reviewer revisions
and human-question states. An unfinished batch or unresolved usage cannot claim
completed throughput. These independent containers do **not** measure shared-repo
merge coordination, a single manager's scheduling across work streams, persistent
memory, or human minutes of focus returned. There is no paired serial run of these
tasks, so this cannot establish a concurrency speedup either.

The upstream 2 CPU / 8 GiB task and separate verifier limits are retained. Ficus
adds 0.5 CPU / 512 MiB for each task's isolated PostgreSQL. A shared arm64 Mac runs
amd64 task images; other local services remain running. Fixed batch order,
provider variability, different setup costs and extra DB resources limit timing
comparisons. Runtime networking remains blocked except the host proxy hostname;
this is hostname-wide rather than a port-specific allowlist. Verifiers have no
network. Setup can download harness dependencies.

Before paid inference, both tasks must pass untouched-baseline, reference,
candidate-test-collision and reference-with-collisions controls, plus native
Ficus and Pi startup/network probes. Original grader/prompt/solution files remain
unchanged; only the image reference in task.toml and tests/Dockerfile is pinned to
its pulled digest. Hidden tests and solutions remain host/verifier-only.

The prior accounted exposure is $29.346481 against the unchanged cumulative $50
ceiling. Keep $10 per task/configuration and the existing conservative $5.50
per-call reservation, across all roles. Start a batch only with headroom for two
reservations. The durable proxy applies the cumulative ceiling atomically; it may
stop trials below their nominal caps when simultaneous reservations consume the
remaining headroom. Do not discard holds, silently retry or increase the cap.
Stop subsequent batches on infrastructure failures, unknown usage or input drift.

`concurrent-feature-v1-selection.json` records the upstream task/image identities.
`concurrent-feature-v1-run.json` freezes source/runtime/task hashes, all eight
passing grading controls, four passing startup/network probes, resources, model
and budget before inference. All 53 offline adapter/accounting tests, changed-file
Ruff checks and repository-wide typecheck passed. `run_concurrent_feature.py` checks those hashes
before and after each batch, refuses existing attempt directories, owns its child
processes, and retains separate batch timelines and per-trial results. Use its
`--frozen-sha256` argument to pin the manifest itself. Credentials are read from a
private proxy access file and never committed.
