# Shared-repository coordination pilot

The user chose to stop isolated-task sampling and move to coordination on
2026-10-27. The unused frozen task list is retained, not a prerequisite to this
study. Prior results remain unchanged.

## External workload and limits

Use requests 1–3 of `code_search` from
[SCBench Problems](https://github.com/gabeorlanski/scb-problems/tree/9cd9ca3a51c3d3e2a99d2488a25baf73a2204451/code_search),
pinned at `9cd9ca3a51c3d3e2a99d2488a25baf73a2204451`. This is a feasibility
selection: a small CLI product with intersecting text search, language support,
and structural matching requirements; the reference needs only Python's standard
library. It is not a random sample or a comparison across the whole benchmark.

The upstream protocol reveals successive specifications as the agent extends its
own code. This pilot supplies the three requests together and asks each team to
choose at least three implementation packages, their dependencies, and a final
integration/review package. Therefore this is a **benchmark-derived coordination
case study**, not an official SlopCodeBench run or leaderboard score. The 47
upstream tests for these requests are unchanged and run after delivery, without
feedback to the agents. Reference solutions and verifier inputs never enter the
agent image. The executable placeholder is resolved to `/app/code_search`.

Both teams start from the same empty Git repository and have the same model,
reasoning effort, requirements, tools, CPU/memory limits, and two-worker cap.
Local branches/worktrees are allowed; all deliverables must be integrated and
committed in `/app`. Coordinators delegate technical decisions and implementation.
They choose the breakdown rather than receiving a hand-written solution plan.

- Ficus uses its native manager, work streams, saved engineering workflow,
  architect, engineers, reviewers, and normal rework routing. An explicit
  evaluation-bootstrap overlay removes the former single-task workspace
  assumption. Production prompts and runtime code are unchanged.
- Pi uses version 0.99.1 and its packaged subagent extension, with the existing
  architect/engineer/reviewer role instructions. The sole extension modification
  changes `MAX_CONCURRENCY` from 4 to 2. The coordinator handles packages,
  dependencies, and integration through these tools.
- Ficus has a separate disposable PostgreSQL container, counted as extra harness
  overhead. Pi dispatches fresh children; Ficus may reuse role sessions.
- The existing budget proxy serializes each client's model requests, including
  receipt settlement. Tool work and work packages can overlap, but these runs
  cannot establish unrestricted parallel throughput or human time saved.

## Gates and accounting

The frozen plan is `coordination-v1-plan.json`. Run baseline, reference, malicious
candidate-test collision, and both native network/setup controls before paid
inference. Capture input, runner, bootstrap, extension, runtime, and image hashes.
No-op must fail; reference must pass all 47 tests. Collision controls must retain
those outcomes. Public source fetching must be blocked during agent execution.

Use the existing $20 phase ledger: opening confirmed usage $5.156131, remaining
$14.843869, and unchanged $5.50 per-request reservation. No reset, no automatic
retry, no operator hints or repairs, and no new paid judge. Stop on provider,
accounting, budget, or control failures and preserve incomplete attempts.
The two arms run sequentially in the predeclared hash order, Ficus then Pi.

## Report separately

1. Correctness: upstream tests passed and total; whole integrated acceptance.
2. Native coordination: actual distinct implementation assignments/streams,
   architecture, dependencies, handoffs, review, integration, and rework.
3. Unattended delivery: accepted final files and finished workflow without rescue.
4. Coordination failures: stalled dependencies, overwritten work, abandoned or
   unintegrated branches, missing final review, and requests for human decisions.
5. Cost and elapsed time: all roles and setup/verification overhead disclosed.

`COORDINATION.md` inside each task workspace is an agent-authored record, not
proof of execution. Audit it against native transcripts, work-stream state,
commits, and independent acceptance. A passing monolithic implementation does
not count as a successful coordination run. A single pilot cannot establish
Ficus superiority or attention saved.

## Reproducing preparation

Use the existing evaluation Python environment (Harbor 0.24.0).

```sh
python evals/harbor/prepare_coordination.py --output /absolute/new/private/run
docker build --platform linux/amd64 -t ficus-coordination-v1:preflight /absolute/new/private/run/task/environment
```

The preparer records source hashes and refuses an existing output directory.
Its optional `--source-cache` verifies a previously downloaded source manifest.
The agent image contains no upstream tests or answers; separate verifier and
oracle directories are supplied only to their respective control stages. The
launcher additionally checks the built image ID and all frozen source hashes.
Both arms retain Git history, worktree listings, and a repository bundle for
post-run integration auditing. Ficus additionally retains a private database and
filesystem checkpoint. Do not publish raw transcripts or checkpoints by default.

## First attempt and transport diagnostic

The first Ficus attempt was stopped after an architect exhausted native retries
with `Connection error` while two dependent streams were active. It cost
$1.657667 across 93 receipted requests. There are no unresolved usage holds.
The checkpoint and all three payload hashes were verified. Pi did not run;
there is no accepted final delivery or paired comparison from this attempt.
See `coordination-v1-interrupted.json`.

Native traces show four packages: a core CLI foundation, Python structural
matching, JavaScript/C++ structural matching, and final integration. The foundation
went through independent review, repair and approval before both dependents
started. Integration remained queued. Reviewer-reported defects have not been
independently reproduced by the operator; do not count them as verified catches.

A no-inference reproduction uses the frozen Bun/OpenAI SDK and two concurrent
1 MB requests to a fake server that serializes responses with a 22-second delay.
Ordinary Docker networking completes at 22/44 seconds. Harbor's original
restricted egress closes both at about 15 seconds with the same SDK connection
error. Adding `readTimeout: 600s` to the sidecar handler completes at 22/44 seconds.
The handler's response-header deadline is described in the
[GOST source](https://github.com/go-gost/x/blob/master/handler/redirect/tcp/metadata.go);
the measured behavior comes from Harbor's pinned image, not an assumption that
current upstream documentation exactly matches it.

`coordination_egress.py` provides this explicit opt-in using a copied build context.
It does not edit installed Harbor, disable sniffing, change allowed hosts, alter
budget reservations, or change production Ficus. The original freeze remains
intact. `coordination-v2-plan.json` declares a fresh corrected pair with the same
inputs and order, under the remaining phase budget. Any new attempt must pass the
fixed-path network checks and freeze its changed source/context hashes first.

## Corrected Ficus outcome: coordination v2

The corrected run lasted **94m45s**, with **$7.698162** in confirmed model usage
across 393 receipted requests and no unknown-usage holds. All three implementation
streams and final integration reached native approval; their tips were integrated
into main at `32d80bfee556b986f22ed1ce14e333f25048d24e`. The final reviewer reports
121 project test methods passing on that actual delivered revision. No operator
code edits, task hints, manual merges, or external-test feedback were supplied.

The budget guard rejected the manager's closing request after approval. The
phase total was $14.511960 against its $20 cap: remaining $5.488040 was below the
unchanged $5.50 reservation. Preserve the trial as interrupted, not a normally
completed unattended delivery. All checkpoint payload hashes were verified.
The earlier transport-failed attempt remains separately accounted at $1.657667.
Pi has not run; budget authorization and an explicit protocol amendment to the
interrupted-predecessor gate are required before continuation. Do not silently
turn the offline result into a successful Harbor trial.

A no-inference, no-network post-stop grade applied the exact preserved patch to
the pristine frozen image and ran the unchanged upstream suite: **37/47 passed,
10 failed, no skips; not accepted**. This result is separate from the original
Harbor result, whose verifier was cancelled. See
`coordination-v2-ficus-result.json` for provenance, counts, accounting, and native
attempt history.

### What coordination did and missed

- The manager created three implementation packages plus integration; native
  worktrees and commits show real division of work and merging of all approved
  inputs. Core/Python implementation overlapped. Model calls remained serialized.
- Review requested eight repair cycles: one Python, five JavaScript/C++, and two
  integration. Four eventual approvals do not establish external correctness.
- Operator-only probes independently reproduced selected native findings before
  repair and confirmed their repairs: Python dictionary pairing 2/4 to 4/4;
  first-round JavaScript/C++ cases 2/13 to 13/13. These are selected review-derived
  examples on intermediate revisions, not an unbiased score or proof that every
  reviewer finding was valid. See `coordination-v2-review-audit.json` and its
  companion probe scripts. No results were sent back to the squad.
- Seven external failures share an unambiguous contract drift: the original
  `regex_flags` JSON array became a string. The manager handoff omitted the type;
  the architect explicitly specified a string, and implementation, unit tests,
  and review agreed with that altered contract. The first explicit string claim
  is preserved in architect message `8c207cb0-f649-4c04-838d-6b2b08af71b0`.
- The remaining failures are an empty capture-map serialization difference,
  literal-dollar matching in Python, and a missing semicolon in Python match
  text/end coordinates. The first two have prose/test ambiguity: the prose shows
  a captures mapping without requiring omission when empty, and requires valid
  target-language patterns while the literal-dollar test uses `$price` in Python.
  Keep the strict 37/47 result; disclose these tensions rather than rewriting tests.

This suggests testing preservation of original requirements through delegation
and a final check against original examples, rather than simply adding more
review rounds. It does not yet justify a production prompt change or a claim
that Ficus performs better or worse than Pi. Finish the matched baseline before
making that comparison; subsequent improvement runs must remain separate.

The added standard-library-only constraint forced considerable handwritten
JavaScript/C++ parsing. This makes the case unusually parser-heavy and limits
its representativeness for ordinary dependency-equipped product work. Preserve
this run, but use a more representative workload for later coordination studies.

## Pi continuation authorization

The user subsequently raised the phase cap from $20 to $30, with no reset and
no release of holds. Opening confirmed usage is $14.511960. The original frozen
plan and launcher remain intact; `coordination-v2-pi-budget-amendment.json`
records the new cap, replacement private launcher hash, and hashes of the
preserved Ficus interruption and offline grade. It explicitly permits Pi to
follow that budget-interrupted arm after all four native work streams and final
review completed. Eligibility does not depend on the external grade passing.

Pi starts once, in a fresh repository and session, with the original task,
model, role instructions, resources, worker cap, verifier, network restrictions,
and $5.50 request reservation unchanged. It receives no Ficus artifacts, failure
analysis, grade, or post-hoc reproduction cases. This amendment does not resume
or repair Ficus, and does not erase its interrupted completion status.
