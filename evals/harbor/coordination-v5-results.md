# Coordination v5: trajectory API

Both harnesses autonomously completed implementation, integration, review and
repair, preserving the original request exactly and delivering clean committed
repositories. **Ficus passed 190/256 tests; Pi passed 191/256. Neither achieved
external acceptance.** All tests ran, with zero skips and no verifier timeout.
The one-test difference concerns an undocumented raw pagination parameter; most
shared failures expose specification/test tensions. This is not a reliable
implementation-quality ranking.

| Observed outcome                      | Ficus        | Pi           |
| ------------------------------------- | ------------ | ------------ |
| External pass / fail / skip           | 190 / 66 / 0 | 191 / 65 / 0 |
| Agent execution                       | 44m 34s      | 26m 28s      |
| Settled API cost                      | $5.855335    | $3.092984    |
| Model requests                        | 253          | 186          |
| Original request preserved byte-exact | Yes          | Yes          |
| Clean committed delivery before limit | Yes          | Yes          |

Agent times exclude setup and external verification. Costs include all native
roles' model calls, but exclude infrastructure. The pair cost **$8.948319**;
phase spending is **$20.081830 of $50**, leaving **$29.918170**, with no missing
receipts or provider failures. Historical ledgers remain preserved.

## Native coordination and source fidelity

Ficus finished four native streams: API foundation/validation/storage;
search/pagination/reports; mutable trajectories/forks; and final integration.
Each used architect, engineer and reviewer steps. Search/report review returned
once for engineer repair before approval. Final integration then reentered a
complete design/implementation/review cycle for documentation closeout. The
runtime already contains the #677 closeout guidance, so this extra cycle remains
an observable inefficiency rather than a missing-fix explanation.

Pi made eight native subagent calls containing thirteen assignments: two
architect, eight engineer, three reviewer. Five calls dispatched two workers;
the remaining three dispatched one. Packages separated domain, query/report,
store and HTTP/CLI ownership, followed by integration. Early independent review
requested timestamp-precision and huge-number repairs, an architect specified
compatible repair interfaces, engineers repaired their owned modules, and scoped
re-review plus final independent review approved the integrated result. All
thirteen assignment prompts explicitly referenced the original requirements.

Both exact original-source files match their frozen handoff byte-for-byte. This
removes a source-availability concern; it does not prove every requirement was
correctly interpreted or causally attribute results to the prompting changes.
Native reviewers reported 482 Ficus project tests and 728 Pi project tests;
Pi also reported 2,442 live-probe assertions. These are native reports, not
operator reruns or comparable external quality scores.

Ficus delivered `a31296afe5f2dfd98900985c209f82666fff5d55`. Pi delivered
`9b2d9530f7236897aba6f612d5941a68fbd853ae`, with product/integration changes ending
at `742b2ddec99bf53316be0c326fb2e150bae995c6` and subsequent documentation only.
Both external graders used saved committed artifacts, with no dirty-tree repair,
operator hints, paid retries, or post-result candidate changes.

## External failures and interpretation limits

The two arms share all 65 Pi failures. These categories describe **first observed
assertions**, not independent defects or proof that later assertions would pass.

- **54 timestamp assertions:** both emit fractional-second UTC timestamps ending
  in `Z`. The suite requires a whole-second-only regex. The original requests
  require ISO-8601 UTC with `Z`, without explicitly banning fractional seconds.
- **10 assistant-position validations or prerequisites:** both enforce the
  written condition that an assistant must occur before the end of a finalized
  trajectory. For example, `create_finalized_trajectory_default` contains only
  user then assistant and expects successful finalized creation. The request
  explicitly defers this condition for in-progress trajectories, not finalized
  ones. Subsequent tests also encounter this disagreement during setup/finalize.
- **One explicit-null branch:** both reject `branch: null` in a fork request while
  the suite expects success. Input wording says a provided branch is a trimmed
  nonempty string; output/normalization permits null. The contract is unclear
  about explicit input null.
- **One Ficus-only failure:** `regression_search_fork_with_pagination` sends
  `?limit=2&offset=0`. The request documents a `cursor` containing an offset, not
  raw `offset`. Ficus rejects the unknown parameter; Pi ignores it and defaults
  to offset zero. Passing this case does not prove raw-offset pagination support.

All original failures and reward-zero outcomes are retained. No failure has been
waived, no adjusted score calculated, and no masked behavior assumed correct.
The preflight audit successfully checked reference behavior, zero-skip coverage,
noisy-server handling, isolation and mutation sensitivity, but **did not catch
these specification/test disagreements before inference**. That limits the
quality conclusion even though coverage is materially better than v4.

## What this run supports, and next steps

Pi used about 18 minutes less agent time and $2.76 less API cost on this case.
Ficus demonstrably executed its native streams, review return, repair and
integration without human intervention. Its additional documentation workflow
and larger input-token volume are concrete investigation targets; the evidence
does not isolate how much cost each causes.

Before spending on another comparison, audit a fresh public workload for
specification-to-assertion agreement as well as reference success and coverage.
Record ambiguous conventions before running agents. Separately inspect the
Ficus closeout decision against the saved trace to understand why a full cycle
was reopened despite #677. Do not tune candidates against these revealed tests
or silently repair their grades. No further paid run was launched.

This is one adapted SCBench case at revision
`9cd9ca3a51c3d3e2a99d2488a25baf73a2204451`, with requests 1–3 supplied together.
It is not the official sequential protocol, a leaderboard result, a general
harness ranking, or a causal before/after prompt experiment. Model requests were
serialized by the budget proxy, so production parallel throughput and human
focus/time returned were not measured.

`coordination-v5-results.json` records exact timestamps, tokens, clean artifact
revisions, hashes, native workflow metadata and settled accounting. Frozen task,
runner, launcher, runtime and control hashes were revalidated after both runs.
Private bundles, sessions and historical ledgers remain preserved.
