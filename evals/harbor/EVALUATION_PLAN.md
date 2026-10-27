# Evaluating full-squad Ficus

## Question

Can Ficus deliver substantial, correct work with less human supervision, and
keep multiple pieces of work moving while the user is away? Lower inference cost
on a small bug fix is a separate question. Neither advantage is assumed.

This plan uses external tasks and their original graders. Operational
measurements supplement those scores; they are not a new benchmark score or a
replacement for correctness.

## Workloads

1. **Adapter checks:** small Terminal-Bench tasks establish that tools, delegation,
   review, delivery, accounting, and grading work. Preserve failures and incomplete
   workflows. Do not extrapolate a leaderboard or product-value claim from them.
2. **Complex features:** use [FeatureBench](https://github.com/LiberCoders/FeatureBench),
   initially a predeclared sample from its V1.1 fast split. It provides feature
   tasks and an official evaluator without a GPU requirement. Integration is not
   yet validated. Harbor has an existing adapter, but its downloaded tasks retain
   agent-visible answer material; see [preflight findings](FEATUREBENCH.md). Pin
   the dataset, source revision, task images, and grading
   configuration; do not compare a V1.1 sample directly with a V1.0 leaderboard.
3. **Parallel delivery:** run the same predeclared batch of external tasks with
   controlled concurrency. This measures independent-work throughput, not the
   harder claim that agents coordinate dependent changes in one product.
4. **Product continuity:** subsequently evaluate a sequence of real features on
   the same product, with acceptance criteria fixed before work starts and
   independent review. Label this a case study unless an existing benchmark
   supports the sequence. Report integration conflicts, regressions, and rework;
   do not present it as a public benchmark result.

Select tasks before seeing results, record exclusions for infrastructure
compatibility, and retain unsuccessful and interrupted attempts. Keep solutions
and hidden tests out of agent context. Use fresh state for standard benchmark
comparisons; any persistent-memory experiment is separately labeled.

## Comparisons

Use the same API model and reasoning effort for all roles and baselines. Start
with `gpt-6.1-sol`; native Pi transport and usage accounting now pass adapter checks.
Record provider-returned model identifiers, configuration, and run dates. No
production model defaults need to change.

Use a two-by-two design, matching the workflow as well as the model:

| Workflow     | Ficus                                                  | Comparison harness                                              |
| ------------ | ------------------------------------------------------ | --------------------------------------------------------------- |
| Single agent | Engineer-only workflow                                 | Single Pi engineer session                                      |
| Multi-agent  | Architect → engineer → independent reviewer → delivery | Equivalent architect, engineer, reviewer, and delivery workflow |

Both multi-agent configurations use the same review-to-engineer rework path. If Ficus also uses a separate manager, provide
the baseline an equivalent coordination role and include both sides' costs.
Do not rename the current manager/engineer/reviewer pilot an architect workflow;
validate the actual role configuration before running the comparison.

- Ficus: execute that workflow through its normal squad orchestration.
- Baseline: execute the equivalent roles and handoffs using an existing supported
  workflow in the comparison harness where available. Separate role sessions
  preserve independent review. The existing single-session Harbor Pi adapter is
  extended by the packaged Pi subagent example for the planned arm. Both arms
  have completed a smoke task; rework remains unexercised.
- Parallel comparison: run equivalent workflows concurrently on the same batch,
  with matched aggregate resources and concurrency limits on both sides.

Use equivalent role instructions, task information, planning requirements,
review criteria, handoff artifacts, tool permissions, reviewer context, and
rework limits. Preserve harness-specific mechanics and record unavoidable
mismatches instead of silently changing either workflow. Do not give one side
extra planning or review opportunities. Count all orchestration inference,
including manager calls, against the aggregate budget.

Prefer an existing multi-agent workflow over building a bespoke competitor. If
Pi needs human handoffs, that is a separately labeled supervised workflow:
record the coordination time and supplied information, and do not mix it into
the unattended comparison. An automated adapter may transport artifacts and
invoke declared stages, but any new planning, routing, or recovery intelligence
is part of the evaluated baseline and must be disclosed. Do not assume Pi needs
human coordination before inspecting available workflow support.

The engineer-only Ficus configuration is now an explicit evaluation arm, not a
substitute for testing full squads. Verify that no manager, architect, or
reviewer performs task reasoning or supplies extra guidance in that arm. Keep
ordinary runtime bookkeeping and count its overhead; disclose any unavoidable
extra model calls. The smoke trace confirms engineer-only execution; repeat that audit for scored
runs.

Report three comparisons on the same predeclared tasks:

1. Ficus engineer versus Pi engineer: differences between harnesses for one agent.
2. Ficus multi-agent versus baseline multi-agent: differences with matched roles.
3. Multi-agent versus single-agent within each harness: the quality, attention,
   latency, and cost effects of adding planning and review.

Use matched aggregate budgets for the controlled comparison, not a full budget
per role. A separately declared practical-budget experiment can measure whether
extra spend buys useful quality or autonomy. Do not select different tasks for
each arm based on observed results. Repeat and vary run order when budget permits;
a tiny pilot cannot establish a reliable interaction between harness and workflow.
Earlier single-session pilot results still do not constitute this four-arm
comparison, because corresponding Ficus engineer-only runs were not performed.

Record and match task time limits, aggregate inference budget, CPU/memory, and
maximum simultaneous model requests. Include Ficus database/runtime overhead.
Run single-task quality and batch-throughput comparisons separately. A second
budget setting can describe tradeoffs, but must be declared before running it.
Freeze the workflow and baseline configuration before selecting scored attempts.

## Outcomes to report separately

| Outcome             | Measurement                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Correctness         | Original benchmark grade and fully resolved tasks; partial test passes reported separately                |
| Unattended delivery | Tasks both officially accepted and delivered through the intended workflow without human rescue           |
| Throughput          | Accepted tasks per batch wall-clock hour at the declared concurrency and resource limits                  |
| Human attention     | Timed active minutes spent reading, deciding, steering, repairing, and approving                          |
| Interruptions       | Requests that require a person, grouped by clarification, approval, recovery, and coordination            |
| Waiting             | Time genuinely blocked on a person, separately from model, tool, rate-limit, and orchestration waits      |
| Review and rework   | Review rounds, returned work, defects caught, and defects remaining at independent acceptance             |
| Cost                | All roles, retries, failures, and infrastructure; distinguish metered charges from uncertain reservations |

A quiet but stuck squad has not returned useful time. Report unfinished tasks
alongside unattended successes. A workflow marked delivered is not automatically
correct, and a correct patch with a stuck workflow is not autonomous delivery.

## Measuring focus without inventing a proxy

Unattended benchmark runs can measure requests for help and waiting, but cannot
establish human time saved. For that claim, run a separate supervised comparison
with a fixed assistance policy and scheduled review windows. Log actual active
human time, interruptions, and the longest interval of accepted progress without
intervention. Separate one-time setup from recurring supervision. Do not use
message counts or model runtime as substitutes for human attention.

Use matched task groups and vary which system is used first to reduce learning
and order effects. Keep human help and approvals in the audit trail. These runs
are assisted evaluations and must not be mixed with unattended benchmark scores.

## Current focus

The user explicitly moved to [shared-repository coordination](COORDINATION.md)
on 2026-10-27. The remaining isolated tasks stay unused; exhausting their frozen
order is not a prerequisite. The first coordination pilot uses existing external
requirements and tests, with the protocol differences declared before inference.

## Next execution gates

1. Native Pi GPT-6.1 tool use and all-role accounting are validated under the
   unchanged $20 cap. Preserve checkpoints and raw historical reservations.
2. All four configurations completed one official smoke task. Both planned
   feature attempts exercised autonomous review/rework. The remaining session
   lifecycle difference is explicit: Pi dispatches fresh children; Ficus can
   reuse a role session within a stream. Log idle/handoff behavior without
   assuming a production defect. An unavailable arm stays unexecuted.
3. The audited Pydantic FeatureBench task now isolates answer material and
   restores immutable official verifier inputs. Baseline/oracle and colliding
   test-file controls pass; the first pilot's nominal Pi pass was invalidated.
   The separately frozen corrected four-arm pilot is complete, with all earlier
   attempts preserved. Next select fresh tasks for a meaningful comparison.
   Preserve official assertions and retain each submitted workspace for
   independent regrading.
4. The generic dependency/completion prompt candidate passed a known-task replay;
   both baseline and candidate passed the fresh short decision cases. See
   `SCOPE_GUIDANCE.md`. Broader efficacy still needs fresh external tasks and
   repeated/mixed-order trials; do not count the replay as an unseen success.
   Estimate cost from these pilots before requesting or scheduling a broader run.
   The current budget does not authorize a large feature or parallel suite.
5. Add batch and supervised measurements only after quality and workflow
   completion work. Report quality, attention, speed, and cost side by side;
   do not collapse them into an arbitrary composite score.
