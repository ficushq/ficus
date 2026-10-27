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

## Pi outcome: provider interruption

Pi's continuation stopped after approximately 12m11s when the upstream streaming
API returned two terminal overload errors under HTTP 200. Native Pi output says
"Our servers are currently overloaded. Please try again later." The guard
cancelled the trial; no automatic retry was launched. Architecture, requirements,
and ownership were committed at `3ebf57a9f6f5f3ab932667aff507e9a77f088a69`;
two engineering assignments had started, but no implementation was delivered.
There is no external correctness score or completed matched comparison.

Confirmed Pi usage is **$0.395131** across the receipted calls. Two unreceipted
calls retain **$11 in reservations**, not confirmed spending. Phase confirmed
usage is **$14.907091**, reserved exposure **$25.907091**, and the authorized cap
remains **$30**. Reconcile actual usage before another $5.50 reservation can fit;
do not reset the ledger or assume overload errors were unbilled. Any retry must
be declared separately and retain this interrupted attempt and cost. See
`coordination-v2-pi-interrupted.json` for evidence and artifact hashes.

Pi's architecture retained the regex-flags array contract. That is an intermediate
observation only, not evidence of final correctness or superiority. Its provider
interruption must not be counted as a failed engineering solution.

## Pi retry after authorized key and budget reset

The user rotated the API key, explicitly asked to reset tracked spending, and
then authorized continuation. A minimal verification of the new key succeeded
for $0.000072. The fresh phase retains a $30 cap and $5.50 request reservation.
The former ledger remains intact with $14.907091 confirmed and $11 unresolved;
these historical holds were not reconciled or declared free. The active private
ledger pointer is the authority for subsequent launches.

`coordination-v2-pi-retry1-plan.json` declares exactly one fresh Pi retry. The
runtime, task, prompts, model, image, resources, network restrictions, and verifier
remain frozen. It receives no prior candidate output, operator findings, or
external-test feedback. The launcher verifies the rotated credential privately
and checks hashes of both preserved predecessor trials before starting. Provider,
accounting, and budget failures still stop the run without automatic retry.

Report this as a retry following a preserved provider interruption, alongside
its prior cost. It is not an uninterrupted paired-run experiment or evidence
that the original Pi interruption was an engineering failure.

## Captured comparison: Pi retry1 and Ficus v2

The Pi retry reached its unchanged **7,200-second agent limit during the fourth
independent review**, with no returned final approval. The full launcher took
**121m02s**, including setup, artifact capture and verification. It used
**$10.046212 across 518 receipted requests**, with no unresolved usage. The fresh
phase total is $10.046284 including the key check, leaving **$19.953716** of its
$30 cap. No further paid run is launched by this report.

| Captured outcome                       | Ficus v2                             | Pi retry1                                 |
| -------------------------------------- | ------------------------------------ | ----------------------------------------- |
| Unchanged external tests               | 37/47                                | 44/47                                     |
| Full external acceptance               | No                                   | No                                        |
| Native final approval                  | All four streams approved            | Three reviews rejected; fourth unfinished |
| Stop                                   | Budget guard during manager closeout | Two-hour agent timeout during review      |
| Confirmed model cost, this attempt     | $7.698162                            | $10.046212                                |
| Launcher elapsed                       | 94m45s                               | 121m02s                                   |
| Operator candidate edits or task hints | None                                 | None                                      |

Ficus's score is an offline grade of its preserved patch after cancellation;
Pi's score is Harbor's normal separate verifier after agent timeout. Both use
the same unchanged 47-test suite and pristine image. Neither is a completed,
accepted autonomous delivery. Do not interpret a zero launcher child exit or
native approval as external correctness. The differing interruptions and budget
history prevent calling this an uninterrupted, budget-matched pair.

### Actual Pi coordination

Native transcripts and Git history show three implementation packages: core
CLI/contracts, language adapters, and structural matching. The coordinator
waited for frozen interfaces before running adapters and matching concurrently.
Integration and preliminary review also overlapped with separate ownership.
All engineering handoffs were committed to shared main; no worktrees were used.
The final working tree is clean at
`ae8195507274172026c37eddc73515d39f7a06b4`, whose last product commit is `ffee47c`.

There were **one architect, twelve engineer, and four reviewer assignments**;
all except the fourth reviewer returned. Engineer assignments include integration
and rework, not twelve independent initial packages. The coordinator edited only
`REQUIREMENTS.md` and `COORDINATION.md`, handled dependencies and handoffs, and
committed coordination notes. It did not quietly become the implementation agent.
Completed reviews requested repairs three times. The last engineer reported 265
project tests passing; this count is not an external score or operator rerun.

The Pi coordinator's `REQUIREMENTS.md` is a **27-line summary**, despite its
“Original product requirements” title. Like the Ficus handoff, it initially omits
the `regex_flags` type; the architect specified a string. Pi's coordinator caught
that mismatch against the incoming task and explicitly required the original
array before engineering (message `3a6dd695`, 16:51:13 UTC). The resulting seven
external cases that fail from this drift in Ficus pass in Pi. This supports a
requirement-preservation hypothesis, not a claim that summaries are reliably
safe or that one harness generally has better reasoning.

### External failures and verified review value

Pi's three external failures are:

- Absent optional capture: emits `captures: {}` where the test omits the field.
- JavaScript declaration boundary: includes the source semicolon when the
  pattern does not; the test excludes it. Language filtering itself works.
- Literal-dollar Python: rejects `$$price` / `$price` as invalid Python where
  the test expects a match.

The first and third share the previously documented prose/test tensions in the
Ficus result. Keep **44/47**, with no waived tests or post-hoc fixes. Pi fixes the
seven array-contract failures relative to Ficus and passes Ficus's Python
semicolon case, but fails a different JavaScript span case; the net difference
is seven tests. These output mismatches are separate from remaining deeper
parser defects found by native review.

After the agents stopped, the operator replayed exact native review probes in
no-network containers at their reviewed and final committed revisions:

| Selected native probe    | Before repair       | Final artifact |
| ------------------------ | ------------------- | -------------- |
| Preliminary review       | 48/70               | 70/70          |
| First final review       | 74/112              | 112/112        |
| Re-review                | 132/162             | 162/162        |
| Unfinished fourth review | No earlier baseline | 99/107         |

The final eight failures involve JavaScript optional `catch` blocks, regex
contents incorrectly exposed as code, and template shielding. They reproduce
independently even though all earlier review probes pass. These are selected,
overlapping cases, not unique-defect counts, a second benchmark score, or a fair
count comparison with the different Ficus audit probes. Raw reports and executable
probes remain private; hashes, revision provenance and audit counts are in
`coordination-v2-pi-review-audit.json`. No audit results reached either candidate.
See `coordination-v2-pi-retry1-result.json` for test, role, timing, cost and artifact
evidence. Frozen runner and prepared-task hashes still match.

### What this changes about the next experiment

The useful next Ficus hypothesis is **preserving the original request through
handoffs**, including schemas and examples, and reviewing against that source
rather than only an architect's restatement. Pi demonstrates one successful
catch, but both coordinators supplied summaries and both implementations retain
failures. Any prompt change should be evaluated as a new condition; this case
must remain frozen and must not become training feedback for another nominally
independent baseline.

For the next coordination study, select an existing multi-step product workload
with its normal dependencies and upstream progression intact. Remove the added
standard-library-only restriction for that new study; it made this case largely
an exercise in implementing language parsers. Keep the same model, resource and
review intent across harnesses, while recording actual decomposition and role
invocations. Align budget headroom from the start and freeze the selection before
inference. Do not resume this Pi run or launch another parser repair cycle by
default.

This case verifies delegation, integration, rework and some real review value.
It does **not** measure uninterrupted human focus, attention saved, production
reliability or unrestricted parallel throughput: calls were serialized, no human
attention clock was collected, and the sample is one adapted case. Ficus and Pi
have different native prompts, session reuse and review granularity. The external
scores and costs therefore describe these captured attempts, not a harness ranking.
