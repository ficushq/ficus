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

## Partial results — provider credits exhausted

The Pi squad batch completed both official graders in **20m03s**, with 15m43s
of overlapping agent execution. Its cost was **$2.063421**. Neither task passed
all official checks, so accepted-task throughput is zero for this batch:

| Task | Feature checks | Regression checks | Result | Inference USD |
| --- | ---: | ---: | --- | ---: |
| returns | 157/159 | 61/61 | Fail | $0.996580 |
| aiomonitor | 51/53 | 8/8 | Fail | $1.066841 |

`returns` failed two `lash` checks involving the entire error tuple. `aiomonitor`
returned 404 for the grader's `/api/snapshot/save` and `/api/snapshot/list` routes.
Official scores remain unchanged. Both Pi submissions added tests without removing
existing assertion lines. The aiomonitor reviewer found a task-ID reuse bug and
requested a revision; it approved the second implementation, which still missed
the route checks. The returns reviewer approved its first implementation. These
are examples of review contributing useful checks without guaranteeing acceptance.

Both Ficus squads started, but the provider then reported **no remaining API
credits** during their design-stage work. The transport returned HTTP 200 while
the runtime logged an SDK credit error. Operator diagnostics identified the
blocker and cancelled both attempts; neither has an official score. They are
provider-blocked, **not task failures**. Neither engineer-only batch was launched.
The comparison is incomplete; do not rank Ficus against Pi from this batch.

This experiment added **$2.376550 confirmed usage**, including $0.313129 before
the Ficus failures. Two calls lack usage receipts and retain **$11** in conservative
reservations. Prior accounting plus confirmed new usage is **$31.723031**; total
ledger exposure including those holds is **$42.723031 / $50**. Paid inference is
stopped. Do not release reservations without provider evidence or silently retry
these attempts. Restore API credits and reconcile dashboard usage before deciding
on an explicitly recorded recovery experiment; preserve the original attempts.

`concurrent-feature-v1-partial-results.json` records individual results, review
provenance, overlap, artifact hashes and credit-error evidence. Frozen inputs
still matched after cancellation and before the following post-run fixes.

### Post-run infrastructure fixes

The proxy now recognizes terminal `error` and `response.failed` events under
HTTP 200, records a sanitized provider code, forwards a complete event and closes
the failed stream. Missing usage still retains the full reservation. This follows
the [official Responses streaming event format](https://developers.openai.com/api/reference/resources/responses/streaming-events).
The batch runner checks the ledger during execution and stops both owned processes
on provider failure instead of waiting for their full task deadlines. It records
cancellation exit codes and the stop reason. This changes no scored attempt or
frozen runtime/prompts. A new freeze is required before any future inference.

All 57 offline tests pass, including terminal HTTP-200 failures and a real-process
check that both disposable children terminate and usage holds survive. These tests
make no provider calls. Failure diagnostics remain private; only hashes and
non-sensitive summaries are committed.

## Explicit recovery phase

After restoring provider credits, the user authorized a **new $30 budget from
this point forward**. The old ledger is preserved unchanged at call 2470 with
$42.723031 exposure, including the $11 missing-receipt holds. The new phase has
its own empty ledger; this is a budget reset, not a reconciliation or a claim
that the interrupted calls cost nothing.

`concurrent-feature-v1-recovery-1.json` freezes the recovery before inference.
New `cv1r1` client/job IDs prevent accidental reuse of old attempts or costs.
Only Ficus squad, Pi engineer and Ficus engineer batches run. The original Pi
squad results remain the comparison baseline. Both Ficus squads restart once in
pristine environments after their provider-blocked attempts; engineer controls
are first attempts. No task-specific hints, previous solutions or failed-test
feedback are passed to the agents. Model, runtime, prompts, tasks, graders and
resource limits remain unchanged. The two changed infrastructure sources are
the streamed-error handling and the runner's fail-fast/recovery bookkeeping.

Report this phase separately and retain original interruption overhead. A
three-batch recovery alone cannot claim a complete four-arm comparison. Timing
comparisons span the interruption and fixed batch order. Existing controls are
retained because task, grader and runtime hashes are unchanged. All 60 offline
tests pass, including recovery/original accounting isolation and rejection of
previously billed client IDs even when the job directory is empty.

## Completed comparison, including explicit recovery

All six recovery trials finished with official grades. Combined with the original
Pi squad pair, all eight task/configuration results are available. This includes
two Ficus squad recovery starts, **not eight uninterrupted first attempts**.

| Configuration | Tasks accepted | Two-task batch elapsed | Inference USD |
| --- | ---: | ---: | ---: |
| Pi engineer | 2/2 | 9m22s | $0.658107 |
| Ficus engineer | 2/2 | 15m48s | $1.322362 |
| Pi squad (original) | 0/2 | 20m03s | $2.063421 |
| Ficus squad (recovery) | 1/2 | 27m09s | $2.669135 |

| Task | Pi engineer | Ficus engineer | Pi squad | Ficus squad |
| --- | --- | --- | --- | --- |
| returns | 159/159 features, 61/61 regressions | 159/159, 61/61 | 157/159, 61/61 | 157/159, 61/61 |
| aiomonitor | 53/53 features, 8/8 regressions | 53/53, 8/8 | 51/53, 8/8 | 53/53, 8/8 |

The new phase spent **$4.649604 of $30**, with **283 requests, zero missing usage
receipts and zero provider failures**. Remaining phase budget is **$25.350396**.
The four reported batches total $6.713025, including the previously completed Pi
batch. Original interrupted Ficus overhead ($0.313129 confirmed plus $11 held
without receipts) remains separately recorded; it is not hidden in a free retry.
The old ledger is unchanged through call 2470. The inference proxy is stopped and
all owned task/DB containers have been removed. No unrelated resources were pruned.

Both Ficus engineer controls executed only the engineer (one execution each,
zero manager executions). Pi controls dispatched no subagents. Each Ficus squad
executed manager, architect, engineer and reviewer. Returns had two review
attempts with an intervening repair; aiomonitor had one. Neither system required
operator task hints. All hashes still match the recovery freeze. Candidate tests
added by these submissions removed no existing lines, and no official assertions
or scores were changed.

### What this says about orchestration

In this two-task sample, the engineer-only configurations matched each other's
full acceptance and were cheaper and faster than their squad configurations.
Ficus squad improved on Pi squad's aiomonitor acceptance, but both engineers also
passed that task. There is no evidence here that extra roles improved on an
engineer, nor enough tasks/repetitions for a general harness ranking.

The returns failures are particularly useful. Both squads chose per-error `lash`
recovery; the official checks require passing the whole error tuple to the
callback. The public task explicitly defines per-element `alt` behavior but does
not spell out `lash`; its inherited behavior requires interpretation. The Ficus
architect documented an assumption for `lash`, and implementation and review
accepted it. Its reviewer found an intentional private-field access missing a
local lint suppression, requested that repair, then approved. That repair did
not address the behavioral assumption. Both single engineers chose the behavior
required by the official checks. Scores stand as published, including this
interpretation sensitivity.

A useful next hypothesis is to have reviewers independently check uncertain
behavioral assumptions against existing interfaces and examples, rather than
only checking compliance with the architect's plan. Test that change on fresh
held-out tasks before claiming improvement; do not tune against these two failed
assertions and present a rerun as fresh evidence. This run changed no prompts.

The original Pi aiomonitor reviewer did find and repair an object-ID reuse bug,
yet still missed two required HTTP routes. Review can contribute genuine checks
without guaranteeing benchmark acceptance. Its benefit should be measured from
outcomes and revisions, rather than inferred from the presence of a reviewer.

These are concurrent **independent task containers**. They do not evaluate one
manager coordinating a shared product, cross-task integration, persistent memory,
or measured human focus/time saved. Fixed order, provider variation, Ficus's
additional database/setup, a shared emulated host, and the recovery interruption
all limit timing comparisons. A broader feature/project evaluation is still
needed for those benefits.

`concurrent-feature-v1-recovery-1-results.json` contains the recovery-only audit;
it deliberately does not claim a standalone four-arm comparison.
`concurrent-feature-v1-combined-results.json` explicitly joins original Pi results
with recovery results, retaining interrupted attempts, source-report hashes,
role/model evidence, test-path audits, timings and both budget periods.
