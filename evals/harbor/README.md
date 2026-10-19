# Full-squad Harbor evaluation

This experimental adapter targets **Ficus squad orchestration** on existing Harbor tasks.
The first pilot verified task startup, model calls, grading, accounting, and cleanup,
and later exercised manager, engineer, and reviewer, but has not yet completed
the full workflow or a frozen matched comparison. See [pilot evidence](PILOT.md). It
uses the real manager, engineer, reviewer, tools, execution queue, and work-stream
state machine. Harbor owns task instructions, containers, time limits, verifier,
and scores. This is not a new benchmark or a replacement grader.

The initial configuration is the engineering preset with **With Review**
(`builder-reviewer`): manager → engineer → independent reviewer → deliverable,
including returns for rework. Generic delivery guidance permits an explicitly authorized in-place deliverable only in a disposable, single-task workspace; shared checkouts retain normal worktree isolation. Its existing `completion.mode: deliverable` needs
no GitHub repository or PR. The original task instruction is included verbatim in a generic full-squad execution envelope sent to the manager. The envelope requires work-stream creation, delegation, review, and unattended local delivery, without adding task-specific hints. The same guidance is also supplied as squad context. All
roles and model tiers use the same pinned model. Memory is disabled for this
first configuration, and every trial starts with an empty database.

Observed completed roles are recorded as `executed_roles`; a run that never delegates must not be presented as a completed squad test. A single-worker Ficus configuration is not the primary entry. Harbor's supported
Pi adapter is the external baseline. Results from this configuration should be
labeled **Ficus full squad / With Review / fresh memory disabled**.

The broader comparison design is in [the evaluation plan](EVALUATION_PLAN.md).
Small Terminal-Bench tasks validate the adapter; they do not by themselves test
the value of autonomous product development.

## Installation and runtime

Python 3.12+, uv, Docker, and enough local disk for the task/runtime images are
required. Start with Linux amd64 Debian-based tasks with a root task user. Other
runtimes, non-root tasks, task-provided MCP servers, and skills are rejected.

```sh
uv venv /tmp/ficus-harbor-venv --python 3.12
uv pip install --python /tmp/ficus-harbor-venv/bin/python -r evals/harbor/requirements.txt
source /tmp/ficus-harbor-venv/bin/activate
python evals/harbor/build-runtime.py --output /tmp/ficus-runtime.tar.gz
harbor datasets download terminal-bench@2.0 -o /tmp/harbor-datasets
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

## Capped pilot

The included proxy is intentionally narrow: text Chat Completions with
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
and only forwards to the fixed OpenAI endpoint. Stop it when the pilot ends. The default cap is $10; the CLI permits at most $20.
Raise it only with explicit budget authorization, reusing the same ledger.
Upstream failures retain reservations. The proxy records sanitized error codes,
request IDs, and retry headers, and applies known provider cooldowns across all
trial clients; local cooldown rejections create no new reservation. A local cap
stop returns HTTP 403 with `pilot_budget_exhausted`, distinct from a provider
failure. Missing usage requires authoritative reconciliation, not a ledger reset.
The runner below assumes Docker Desktop/OrbStack's `host.docker.internal` name.

In another terminal with the venv active:

```sh
python evals/harbor/run-pilot.py ficus /tmp/harbor-datasets/terminal-bench/fix-git \
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
