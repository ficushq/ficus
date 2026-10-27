# Dependency and completion guidance experiment — 2026-10-19

The first full-squad feature pilot exposed an outcome/scope failure: the manager
classified missing dependencies as pre-existing follow-ups and the reviewer
accepted that boundary. The engineer-only arm implemented them and passed.
This experiment changes generic role guidance, without naming benchmark files,
functions, or test cases in production prompts.

The shared squad rule now distinguishes required dependencies from independent
failures, preserves explicit user authorization, and forbids silently weakening
acceptance criteria. The manager must preserve the user's outcome through
planning and scope revisions. The reviewer must independently assess exclusions,
including exclusions recommended by the manager. Deferring a required dependency
does not make the dependent deliverable complete. Read-only investigations and
explicit user-approved reductions are judged against their actual requested
outcome, not a larger implementation goal.

## Fresh decision checkpoints

Eight synthetic cases were frozen before inference in `scope-cases.json`. Each
was evaluated twice under baseline `38efa36c` and candidate `8739f497`, alternating
A/B order. The same model (native Pi GPT-6.1 Sol), medium reasoning, response
contract, and 2,048-token output limit were used. No expected labels are sent to
the model; deterministic scoring checks readiness and disposition. Explanations
are retained for inspection. The cases cover required prerequisites, manager
scope steering, unrelated failures, explicit file permissions, user-approved
reductions, uncertain relevance, a mandatory CI gate, and read-only research.

Both baseline and candidate passed **16/16** decisions. All 32 calls completed
with metered usage, costing **$0.171060**. Effective cumulative accounting moved
from $10.607113 to **$10.778173**. There is no measured improvement on these cases;
they check that the new guidance preserves important distinctions, not that it
solves the long-running orchestration failure.

The probes use the static YAML role prompt and all its ordered includes. They do
not include runtime context/skills, tools, long task history, or multi-agent
handoffs. They are developer regression diagnostics, not an external benchmark,
a substitute for full-squad testing, or proof of better coding performance.
No prompt tuning or case changes were made after reading these responses.

`scope-probe-v1.json` records exact input and composed-prompt hashes and call
order; `scope-probe-v1-results.json` retains every response. To freeze a new,
separately named experiment before inference:

```sh
bun evals/harbor/scope-probe.ts freeze . <baseline-commit> /tmp/scope-new.json
bun evals/harbor/scope-probe.ts run . <baseline-commit> /tmp/scope-new.json /private/path/access.json
```

The existing budget proxy must have a `scope-probes` client. It retains the same
cumulative ledger and cap. The runner refuses changed inputs or existing output,
and stops on incomplete/error responses without retrying. Do not rerun the
committed v1 manifest after changing its prompts or cases.

## Full-squad regression replay

One candidate attempt completed on the previously inspected FeatureBench task. It
used the exact corrected v2 task/verifier, same native model and workflow, fresh
disposable state, and no human steering. The candidate runtime changed only the
three prompt files and revision metadata in the original runtime archive; all
other archive members and the running container's prompt hashes were verified.
The immutable task checksum matched the baseline.

| Full-squad configuration | Official acceptance | Regression phase                 | Inference | Wall time |
| ------------------------ | ------------------- | -------------------------------- | --------- | --------- |
| Earlier baseline         | 10/12, reward 0     | Not run after acceptance failure | $1.417055 | 18m17s    |
| Candidate scope guidance | 12/12, reward 1     | 50 passed, 1 skipped, 1 xfailed  | $1.074870 | 15m18s    |

The candidate completed design → implementation → independent approved review
without a return, operator message, or fabricated approval. All four roles ran;
the stream ended `done`, with no open waits or pending messages. The engineer
implemented both previously excluded helpers and reported the validation and
serialization dependencies as part of delivery. The reviewer independently
approved the integrated result. Official input hashes matched before and after
grading, and the pre-grading submission archive checksum was verified.

The candidate used 66 metered calls, no provider errors, and no unresolved usage.
Agent time was 795.09 seconds; setup was 85.87 seconds; wall time was 917.62
seconds. This is a known-task regression replay, not a fresh-task performance
estimate. One candidate attempt cannot establish causality, general performance,
or a latency/cost improvement. Preserve the earlier 10/12 baseline and do not
replace it or combine this replay with the original four-arm comparison.

`scope-replay-v1.json` freezes the runtime/input hashes and stop policy;
`scope-replay-v1-results.json` records the official result and archive checksum.
The new experiment cost **$1.245930** across 98 fully metered calls (probes plus
replay). Effective cumulative accounting is **$11.853043 / $20**, leaving
**$8.146957**. Paid inference is stopped and owned Harbor containers are gone.
Historical unresolved reservations remain preserved under the existing
operator-confirmed reconciliation checkpoints; no new usage is unresolved.

## Validation and release boundary

Core's scoped config-sync suite passed all 31 tests, including coverage that all
four engineering roles receive the shared rule once. Core typecheck passed.
Three local probe tests passed. CI on `8739f497` passed all applicable checks,
including the full Core and subprocess suites. An initial test-only import crossed Core's
composite TypeScript project boundary; it was removed, and both the scoped suite
and typecheck were rerun successfully. The existing experimental PR remains a
draft; no production configuration has been synced or deployed.
