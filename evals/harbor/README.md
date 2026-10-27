# Full-squad Harbor evaluation

This experimental adapter runs Ficus on existing Harbor tasks, using its real
tools, execution queue, isolated database, and work-stream state machine. Harbor
owns task instructions, containers, time limits, verifier, and scores. This is
not a new benchmark or replacement grader.

Four fresh four-arm FeatureBench comparisons are complete (Pandas, Sphinx,
xarray, seaborn). Ficus passes 3/4 tasks in both configurations; Pi passes 1/4 as
a squad and 2/4 as a single engineer. All four fail seaborn. Pi engineers are
faster and cheaper in every matched task; Ficus squads have higher aggregate
acceptance and cost, with slightly lower aggregate wall time than Pi squads.
Adding squad roles did not improve acceptance over engineer-only execution in
this sample. See [first fresh task](FRESH_FEATURES.md) and
[three-task continuation](FRESH_BATCH.md) for official results, costs, timings,
role verification and limitations. This is a small sample, not a general harness
ranking. That earlier phase stopped at $25.993347 of its authorized cumulative
$50 cap, with no unsettled usage holds.

Subsequent long-task work and the [independent-review pilot](INDEPENDENT_REVIEW.md)
are separate studies. The [controlled reviewer diagnostic](ARTIFACT_REVIEW.md)
compares prompts on identical implementations across four artifacts. Findings
favor the addition on Narwhals, overlap partly on Bandit, favor the original's
coverage of new APIs on Kombu, and match on HTTPX. An inherited SQS issue is
separated from new regressions. This mixed evidence does not justify production
prompt promotion. See the [consolidated assessment](ASSESSMENT.md) for results,
remaining hypotheses, and what these experiments do not measure.

The [native repair continuation](ARTIFACT_REPAIR.md) repaired both supplied Bandit
review findings through all four roles. It left the withheld defect and official
grade unchanged, then hit the conservative budget guard during a second cycle for
documentation closeout. Its captured artifact was graded separately without
inference; it is not counted as autonomous delivery.

The active phase was explicitly reset by the user on October 27, 2026 after
rotating the API key, retaining a **$30 cap** and the existing **$5.50 per-request
reservation**. The minimal key check cost $0.000072. See the
[declared Pi retry](coordination-v2-pi-retry1-plan.json) for authorization and
controls. Future launches must use the private ledger identified by
`ficus-evaluation-data/active-budget.json`; historical launchers must not be
reused unchanged. The preceding October 26 phase remains preserved with
$14.907091 confirmed and $11 in unresolved holds. The reset did not reconcile
those missing receipts.

The previous $40 phase is closed with $24.705390 confirmed and $11 in unresolved
holds. Its ledger and a snapshot are preserved; the reset does not reconcile
missing receipts. Historical result manifests retain their original accounting.
Earlier temporary raw artifacts are unavailable; new evidence is stored durably.

The [fresh matched Koota study](FRESH_MATCHED.md) returns to an unused external task with engineer-only and full-squad
conditions. Its budget-interrupted Ficus attempt and two authorized recoveries are reported separately from completed
first attempts. The checkpoint-enabled repeat completed with 84/84 feature checks and 47/47 regressions for $2.457816;
its pre-review patch already passed that grader. Independent post-hoc checks verified additional review repairs. The new
$20 phase closed that repeat at $17.542184 remaining, with no unresolved usage.

The next [fresh matched mnamer study](FRESH_MATCHED_V2.md) completed all four
first attempts at 51/51 features and 319/319 regressions, costing $2.698315 in total.
Pi engineer was cheapest and fastest on this task. Offline checks confirm two Pi
review repairs beyond the official score. That study left $14.843869 in its then-active phase.

The [shared-repository coordination case study](COORDINATION.md) then moved to
three cumulative SCBench requests, with each coordinator choosing implementation
packages and integration. This adapted parser-heavy case is reported separately
from official benchmark scores and the preceding isolated-task studies.
Ficus's captured artifact passes 37/47 tests and Pi's retry passes 44/47; neither
is fully accepted. Ficus was budget-interrupted after native approval; Pi timed
out during its fourth review. The report separates these outcomes, confirmed
costs, verified review repairs, and the remaining requirement-preservation
hypothesis. The current phase ends this comparison at $10.046284 confirmed,
with $19.953716 remaining and no unresolved new-phase receipts.

Opt-in [private recovery checkpoints](CHECKPOINTS.md) preserve the disposable
database and task filesystem before cleanup. Their offline restore probe makes
no model calls; automatic inference continuation is not yet implemented.

Earlier Terminal-Bench smoke tests, the known Pydantic feature task, and its
scope-guidance replay remain separate development evidence in
[pilot evidence](PILOT.md) and [scope guidance](SCOPE_GUIDANCE.md).

All roles use the same model and reasoning effort. Ficus starts each trial with
an empty disposable database and memory disabled. Local deliverable completion
requires no GitHub repository or PR. Explicitly authorized in-place delivery is
limited to a disposable single-task workspace; ordinary shared checkout isolation
and review remain required. Completed roles are recorded as `executed_roles`;
a run that never delegates must not be presented as a completed squad test.

The broader comparison design is in [the evaluation plan](EVALUATION_PLAN.md).
Small Terminal-Bench tasks validate the adapter; they do not by themselves test
the value of autonomous product development.

## Installation and runtime

Python 3.12+, uv, Docker, and enough local disk for the task/runtime images are
required. Start with Linux amd64 Debian-based tasks with a root task user. Other
runtimes, non-root tasks, task-provided MCP servers, and skills are rejected.

```sh
EVAL_DATA="$HOME/Documents/Codex/ficus-evaluation-data"
mkdir -p "$EVAL_DATA"
uv venv "$EVAL_DATA/venv" --python 3.12
uv pip install --python "$EVAL_DATA/venv/bin/python" -r evals/harbor/requirements.txt
source "$EVAL_DATA/venv/bin/activate"
python evals/harbor/build-runtime.py --output "$EVAL_DATA/ficus-runtime.tar.gz"
harbor datasets download terminal-bench@2.0 -o "$EVAL_DATA/datasets"
python -m unittest discover -s evals/harbor -v
```

The build exports Git HEAD and overlays only the trial bootstrap and Dockerfile;
it never copies the checkout's `.env` or host auth. Runtime revision metadata and
an archive SHA identify the exact runtime. Commit production-code changes before
building an experiment that compares them.

Each task receives the runtime under `/opt/ficus-harbor`. API and worker execute
inside the task's container, using host sandbox mode **inside that container**.
An ephemeral PostgreSQL sidecar has a private Docker network, no published port,
no persistent data volume, and no Docker socket mounted in the task. Neither an
existing Ficus server nor the operator's workspace is used. The task container's
CPU and memory limits remain unchanged; sidecar overhead must be reported when
comparing total compute cost. Installing Ficus adds runtime dependencies, as
other installed Harbor agents do.

## Native OpenAI trials and workflow arms

Ficus already supports OpenAI through Pi. The trial-only preload redirects Pi's
native OpenAI Responses provider to the budget proxy; production provider code
and defaults are unchanged. The older development adapter used a generic
Chat Completions account, which bypassed that native path.

For GPT-6.1 Sol, start the proxy with `--model gpt-6.1-sol`. Both harnesses use
medium reasoning, text/function tools, Standard service, and at most 8192 output
tokens per request. The proxy records terminal Responses usage, including
incomplete responses and cache writes. Short-context rates per million tokens
are $2 input, $0.10 cache read, $2.50 cache write, and $10 output; above 272K input,
input/cache rates double and output rates increase 1.5×. A $5.50 reservation
covers the full context and output ceiling. Missing usage retains the hold;
a missing cache-write field charges uncached input conservatively at the
cache-write rate. See [the model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

The runner accepts `--workflow engineer` (default) or `--workflow planned`:

- Ficus engineer uses the existing Solo preset with its worker set to engineer.
  The disposable fixture clears its manager reference before creating the work
  stream, so lifecycle messages cannot introduce manager reasoning. Inspect all
  executions to verify that only the engineer ran.
- Ficus planned uses the existing Engineering preset, changing only completion
  to local deliverable. It retains architect, engineer, reviewer, and manager.
- Pi engineer uses Harbor's single-session runner.
- Pi planned loads the pinned Pi package's subagent example extension, with
  architect, engineer, and reviewer definitions and a coordinator instruction.
  The example handles process spawning and handoffs; no new routing engine is
  introduced. Role definitions omit model overrides to inherit the coordinator's
  model and thinking. Only the coordinator explicitly loads the extension.

The workflow adapters are experimental. Preserve installation/dispatch failures
as validation attempts; do not score them as a representative comparison. The Pi
parent trajectory omits child inference: use the shared proxy ledger, not its
parent-only token totals, for aggregate cost. Independent child contexts and
Ficus's within-stream session reuse are a remaining workflow difference to
report and investigate before a scored multi-agent comparison.

`native-tool-smoke.ts <access.json>` explicitly runs a two-call SDK tool
roundtrip using the `native-tool-smoke` scoped client. This is a transport check,
not a benchmark. It never reads the host's real API key.

## Original Chat Completions pilot

The original proxy configuration permits text Chat Completions with
`gpt-4.1-mini-2025-04-14` or `gpt-4.1-2025-04-14`, one response, at most 8192 output tokens, and no hosted
tools. Its verified price basis is $0.40/M input, $0.10/M cached input, and
$1.60/M output. It conservatively reserves $0.50 before each request against a
shared durable SQLite ledger; concurrent squad calls share that cap. Missing
usage, failed requests, and interrupted streams retain their reservation.
For GPT-4.1, rates are $2/M input, $0.50/M cached input, and $8/M output, with a $2.20 per-call reservation. Choose it with `--model gpt-4.1-2025-04-14` when starting the proxy. Both harnesses read the selected model from `access.json`. Reusing the same state directory preserves cumulative spend across model changes and restarts. This bounds inference spend, not Docker resource cost. It is a small plumbing
pilot with an inexpensive model, not an estimate of Ficus's best possible score.

With `OPENAI_API_KEY` supplied securely in the operator process environment:

```sh
python evals/harbor/budget_proxy.py --state /tmp/ficus-pilot --cap-usd 10 \
  --client ficus-fix-git --client pi-fix-git
```

The key stays in the proxy. The generated `access.json` contains only scoped
trial tokens. Keep the proxy state private and outside the source checkout. The
proxy listens on the host so Docker can reach it, requires a random bearer token,
and only forwards to the fixed OpenAI endpoint. Stop it when the pilot ends. The default cap is $10; the CLI permits at most $50.
Raise it only with explicit budget authorization, reusing the same ledger.
Upstream failures retain reservations. The proxy records sanitized error codes,
request IDs, and retry headers, and applies known provider cooldowns across all
trial clients; local cooldown rejections create no new reservation. A local cap
stop returns HTTP 403 with `pilot_budget_exhausted`, distinct from a provider
failure. Missing usage requires authoritative reconciliation, not a ledger reset.
The runner below assumes Docker Desktop/OrbStack's `host.docker.internal` name.

In another terminal with the venv active:

```sh
python evals/harbor/run-pilot.py ficus /tmp/harbor-datasets/terminal-bench/fix-git --workflow reviewed \
  --access /tmp/ficus-pilot/access.json --runtime-archive /tmp/ficus-runtime.tar.gz \
  --jobs-dir /tmp/ficus-harbor-jobs --job-name ficus-fix-git-1
python evals/harbor/run-pilot.py pi /tmp/harbor-datasets/terminal-bench/fix-git \
  --access /tmp/ficus-pilot/access.json \
  --jobs-dir /tmp/ficus-harbor-jobs --job-name pi-fix-git-1
```

The baseline pins Pi 0.99.1, matching the base version of Ficus's patched Pi SDK,
with reasoning off and the same Chat Completions endpoint. No task solution or
verifier is supplied to either agent. Do not reuse trial databases or feed test
failures back into a scored attempt. Distinguish adapter smoke failures from
valid task failures, and retain all attempts rather than cherry-picking.

## Evidence and interpretation

Harbor saves the official verifier reward. The Ficus agent directory also
contains runtime provenance, all agents' messages, execution statuses,
work-stream statuses, and the inference ledger. `delivered` is a workflow state,
**not** a passing benchmark score. An idle manager does not stop a run while
workers, work streams, or undelivered messages remain active. A request for human
input is recorded as such rather than fabricated approval.

Aggregate tokens include every manager/worker/reviewer call, including failures
and retries. Ficus's custom-endpoint price estimate is unavailable, so do not
interpret a zero/absent Harbor cost as free inference. Use the proxy's ledger for
actual metered cost plus any conservative unknown-usage reservations. Keep
native transcripts private until reviewed for task data and transient tokens.

For a real comparison, record dataset version/source commit, task IDs and image
digests, Ficus commit/bootstrap/archive hashes, Harbor/Pi versions, model,
workflow, memory policy, retries, hardware, time limits, wall time, total spend,
and official reward. A handful of tasks is a smoke pilot, not a leaderboard
claim. Run a predeclared broader sample with matched budgets after the adapter is
validated. Future Ficus-specific regression cases can use Harbor too, but their
scores must stay separate from public benchmark results.

## Reconciling missing usage

Stop the proxy and all trials before reconciling. `Budget.reconcile(total_usd,
evidence)` appends an operator checkpoint through the current last call using a
conservative provider total covering every call so far. Include the source,
time/scope, and rounding or reporting-delay margin in the evidence. It never
rewrites call rows or pretends unknown calls have token receipts. Future
reservations use this baseline plus subsequent calls under the unchanged cap.
`Budget.total()` returns that effective cumulative exposure; per-client
`summary()` retains raw call accounting and is not reconciliation-adjusted.
Do not reconcile from a partial, stale, or unrelated billing total.

## Scope/completion prompt regression experiment

[SCOPE_GUIDANCE.md](SCOPE_GUIDANCE.md) records a generic manager/reviewer/shared
prompt change, fresh paired decision checkpoints, and a separate known-task
full-squad replay. The diagnostic uses the same capped native Pi provider and
ledger. It is not a replacement for external benchmarks; the replay is not
part of the original four-arm comparison.

## Longer repository features

[LONG_FEATURES.md](LONG_FEATURES.md) defines the separately reported DeepSWE
v1.1 pilot, restricted-network setup, reference and collision controls,
per-arm limits, and autonomy-measurement limitations.

## Original-request preservation diagnostic

[COORDINATION.md](COORDINATION.md#requirements-provenance-correction-and-diagnostic-replay-v3)
records the v2 prompt asymmetry, the production preservation fix, and the v3
same-guidance replay. Ficus completed normal delivery at 44/47 external tests;
`coordination-v3-ficus-result.json` separates source-read evidence, native review,
external correctness, project-test portability, and cost. Pi's declared replay
uses the explicitly amended $35 phase cap with spending retained. This is an
inspected-task diagnostic, not an unseen benchmark or isolated causal estimate.
