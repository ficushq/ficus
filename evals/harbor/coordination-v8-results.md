# Coordination v8: both harnesses pass the circuit case

Both Ficus and Pi delivered clean, independently reviewed integration artifacts
that passed **205/205 unchanged upstream tests, with zero skips**. Pi finished this
case sooner and with lower confirmed usage. Ficus completed its four native
streams without returning or reopening an approved stream; Pi used three explicit
repair-and-rereview cycles. Neither required an operator to repair the candidate.

This is one fresh benchmark-derived coordination case, not a general harness
ranking or an official sequential SCBench result. Ficus's actual total cost is
still unsettled because one receipt is missing.

## Result and delivery

| Measure                                 | Ficus                                      | Pi                                         |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| External tests passed / total           | 205 / 205                                  | 205 / 205                                  |
| Failed / skipped                        | 0 / 0                                      | 0 / 0                                      |
| Harbor acceptance reward                | 1                                          | 1                                          |
| Trial elapsed time                      | 41m31s                                     | 29m50s                                     |
| Confirmed model usage                   | $4.507401                                  | $2.421897                                  |
| Unresolved usage reservation            | $5.50                                      | $0                                         |
| Settled calls                           | 219                                        | 185                                        |
| Missing usage receipts                  | 1                                          | 0                                          |
| Native implementation packages          | 3 plus integration                         | 3 plus integration                         |
| Return/reopen or repair cycles          | 0 returns/reopens                          | 3 repairs and 3 rereviews                  |
| Completion / timeout                    | Complete / none                            | Complete / none                            |
| Final working tree                      | Clean                                      | Clean                                      |
| Delivered HEAD                          | `01a73fbc5add57699298b9e137869ded4d262ec9` | `baf56055c374c108a6d3c14c006f139df6d67040` |
| Independently approved product revision | `47ab1b150eeb887b303453e2f3da17576f070aaa` | `42ada7617d85eff76c8d278647a40470813a0002` |

Both artifact bundles contain the integrated product in HEAD. Changes after the
approved product revisions affect only `COORDINATION.md`. They record factual
closeout under the same predeclared permission for both coordinators; they do not
replace a product review or alter its decision. No uncommitted patch is needed to
obtain either passing result.

Both preserved the full supplied original requests. Ficus committed its complete
handoff verbatim in `docs/ORIGINAL_REQUEST.md`; Pi committed its complete handoff
in `ORIGINAL_REQUEST.md` with one extra trailing newline. Tool records show source
access in all 12 Ficus worker executions and all 15 Pi child assignments. This
checks availability and access, not whether every requirement was understood.

## Native coordination and review

Ficus created parser/validation, CLI, evaluation, and integration streams. Each
completed design, implementation, and independent review once. There were no
return attempts or manager reopen cycles. Integration did include an engineer's
self-repair to keep pytest from recursively collecting nested worktrees; that
work stays within implementation cost. Zero returns does not mean zero fixes.
The final reviewer approved the integrated product revision before the manager
updated the factual completion record.

Pi used one architect assignment, separate syntax, semantics, and CLI engineers,
independent reviewers, and an integration engineer followed by a final reviewer.
Its reviewers returned three substantive findings to engineers:

- Parser recursion depth, keyword-shaped assignment targets, and the malformed
  example's required error column.
- Recursion in structural AST hashing during validation/evaluation.
- Python's decimal conversion limit for very wide bit vectors.

Each repair received an independent rereview. Final reviewer R4/G4 explicitly
approved `42ada761…`; its own report records 452 local tests and an additional
187 CLI subprocess probes. Ficus's final native review records 634 local tests
and 166 additional probes. These are native review evidence, **not extra external
benchmark passes**, and their differing scopes are not directly comparable.

Ficus's sampled progress shows at most two active non-manager agents and two
active streams. The `active_executions` counter reaches four because it also
counts queued/waiting/stopping records and the manager; it is not a count of
running workers. Pi's installed extension limits concurrent children to two, and
recorded child result batches contain at most two. These observations are
consistent with the declared worker limit, but sampled state is not continuous
utilization tracing. Model requests remain serialized in both arms.

## Where the confirmed usage went

Costs are attributed from explicit role, stream, attempt, and assignment metadata;
no hidden reasoning was inspected. Ficus uses native nanodollar usage records.
Pi's custom-endpoint SDK reports zero dollar cost, so its token receipts were
priced with the frozen proxy rates and per-request rounding. Those reconstructed
Pi costs reconcile exactly with all 185 settled proxy receipts.

| Stage                                     | Ficus native attribution | Pi receipt attribution |
| ----------------------------------------- | -----------------------: | ---------------------: |
| Coordinator work before final closeout    |               $0.6286333 |              $0.299723 |
| Planning                                  |               $1.0525272 |              $0.130052 |
| Implementation, including integration     |               $1.7296139 |              $0.716233 |
| Initial and final review                  |               $1.0453483 |              $0.534246 |
| Separately assigned repair implementation |             Not isolated |              $0.363989 |
| Separately assigned repair review         |       No return attempts |              $0.344465 |
| Factual closeout                          |               $0.0511796 |              $0.033189 |
| Attributed total                          |               $4.5073023 |              $2.421897 |
| Proxy rounding difference                 |               $0.0000987 |                     $0 |
| Confirmed proxy total                     |                $4.507401 |              $2.421897 |

The $5.50 unresolved Ficus reservation is **not** assigned to any stage or treated
as confirmed spend. No receipt has been inferred from native cost records.
Ficus self-repair inside an engineer attempt cannot be separately priced without
inventing finer-grained attribution.

Ficus planned each of four streams, whereas Pi used one initial architect
assignment. Planning accounts for about $0.92 of the roughly $2.09 confirmed-cost
gap. That is a descriptive decomposition, not proof that changing Ficus's planning
policy would preserve quality or realize that saving. Pi also spent about $0.71
on separately assigned repairs and rereviews, yet still used less confirmed
budget overall. Factual closeout was small in both arms, and neither repeated
product review just to update its completion record on this case.

| Settled token category              |     Ficus |        Pi |
| ----------------------------------- | --------: | --------: |
| Input, including cache reads/writes | 9,951,288 | 3,699,121 |
| Cache reads (subset of input)       | 9,017,633 | 3,262,757 |
| Cache writes (subset of input)      |   932,998 |   435,809 |
| Other input (subset of input)       |       657 |       555 |
| Output                              |   127,173 |   100,491 |

These are the proxy's recorded categories, not estimates for the missing call.

Timing uses Harbor trial start/end, including setup and verification. The launcher
elapsed times are slightly longer (41m54s Ficus and 30m13s Pi). Per-assignment
observed windows are retained in the JSON companion, including planning,
implementation, review, repair, and Ficus manager closeout. They include tool and
queue time and overlap; **do not add them** to obtain total time. Pi child windows
end at the parent batch result, so paired windows are upper bounds to batch
return rather than precise individual completion times.

## Protocol and budget accounting

The source is `gabeorlanski/scb-problems` at
`9cd9ca3a51c3d3e2a99d2488a25baf73a2204451`, task `circuit_eval`, requests 1–3
supplied together. The [plan](coordination-v8-plan.json) and
[readiness manifest](coordination-v8-ready.json) preserve the frozen task,
assertion audit, runtime, controls, resource limits, and shared factual
bookkeeping policy. All 205 upstream tests and helpers remain unchanged.

Reference, noisy-reference, and collision-reference controls passed 205/205.
Empty and collision-empty controls failed; width, XOR, and MUX mutations failed
6, 23, and 3 tests respectively. The source audit covers 86 test functions. Its
known coverage limitations remain: default-input tests allow a missing-input
error, and some composite tests check only part of the output. Passing is not
proof of exhaustive specification compliance.

The original pair stopped after Ficus because the launch guard refused to start
Pi with an unresolved receipt. Pi had made no model calls. Noah then authorized
Pi's **first** attempt while retaining this exact hold and the unchanged cap;
[the continuation record](coordination-v8-pi-continuation.json) documents that
exception. The original driver was never restarted. There were no paid retries,
operator candidate repairs, frozen-input changes, or test repairs during either
paid attempt.

Phase `budget-phase-2026-10-28-000028-reset50` now contains:

- **$27.011128 confirmed**, including earlier preserved v4/v5 runs.
- **$5.50 retained** for Ficus call 1193, HTTP 200 without a usage receipt.
- **$32.511128 conservative exposure** against the unchanged $50 cap.
- **$17.488872 conservative headroom**. No further run was started.

Pi added no unresolved receipts. The stopped-run call-1193 hold is not a live
in-flight reservation, and remains intact in the original ledger.

## Interpretation and next decision

This case establishes that both orchestration paths can independently deliver a
fully passing integrated artifact while preserving source requirements and
separating factual closeout from product approval. It does not isolate the effect
of the new handoff wording: the task changed too. Different role prompts,
decomposition, session history, and runtime overhead remain possible explanations
for cost and time differences. No general ranking, unrestricted parallel speed,
or human-time-saved claim is supported.

A useful next offline investigation is the repeated planning/context cost in
Ficus, using this preserved role and receipt evidence to distinguish necessary
architecture from repeated source loading or handoff overhead. Any resulting
policy change should be tested symmetrically on a newly frozen case; neither
candidate nor this completed result should be retroactively repaired. No new
paid experiment is authorized by this report.

The [JSON companion](coordination-v8-results.json) records exact revisions,
per-assignment costs/windows, token totals, source-access evidence, and artifact
hashes. Private sessions, original artifacts, previous results, and every ledger
remain preserved. The report publishes measurements, not raw private sessions.
