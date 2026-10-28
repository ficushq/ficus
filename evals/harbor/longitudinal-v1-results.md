# Successive product requests: completed comparison

Both harnesses completed three successive DataGate requests in the same repository,
with clean committed deliveries and independent reviews. Both passed the first
checkpoint, then made the same row-number interpretation error in checkpoint 2
and retained it in checkpoint 3. Neither earns full external acceptance.

| Measurement                                | Ficus                     | Pi                        |
| ------------------------------------------ | ------------------------- | ------------------------- |
| CSV ingestion                              | 50/50                     | 50/50                     |
| Pagination, sorting and shapes, cumulative | 119/122                   | 119/122                   |
| Filtering, cumulative                      | 171/174                   | 171/174                   |
| Skips / errors                             | 0 / 0 at every checkpoint | 0 / 0 at every checkpoint |
| Full trial, including setup and grading    | 40m25s                    | 34m31s                    |
| Settled model cost                         | $4.034108                 | $2.917134                 |
| Model requests                             | 202                       | 221                       |
| New unresolved receipts                    | 0                         | 0                         |
| First-increment review repair cycles       | 1                         | 2                         |

The cumulative rows overlap: they are not 346 independent tests. At the final
checkpoint, all 50 ingestion cases still pass, 69/72 query-control cases pass,
and all 52 new filtering cases pass. No additional regression appears in the
third delivery. All three exact patches were independently applied to the
pristine baseline; later changes did not replace earlier artifacts. Neither arm
timed out or raised a harness exception. Both native completion signals preceded
grading and neither received grader feedback.

See the [frozen protocol](LONGITUDINAL.md), [readiness controls](longitudinal-v1-ready.json)
and [machine-readable evidence](longitudinal-v1-results.json). The latter records
checkpoint hashes, source fidelity, review revisions, session continuity, per-role
usage and evidence hashes. Private raw sessions, databases, snapshots and ledgers
remain outside the repository.

## Shared failure: preserving the request was insufficient

The original second request says `rowid` is the **1-based source-file row number**.
The ordinary CSV fixtures include a header, so their first data row is source
row 2. Both implementations instead enumerate stored data records from 1.
The unchanged failing tests are:

- `TestCore::test_shape_objects_includes_rowid`
- `TestCore::test_rowid_ignores_sort`
- `TestFunctionality::test_rowid_sequential_all_rows`

Both designs explicitly choose this interpretation. Ficus's increment-2 design
says to exclude the header and use the original data-row ordinal. Pi's design
likewise explicitly says the first data record has ID 1, not 2. Their engineers
implement those choices and their independent reviewers accept them. This is
not evidence of a missing original request: every delivered source file contains
the complete original request verbatim, within the harness handoff wrapper, and
saved tool calls show original-source and plan reads by the worker roles.

The failure illustrates a shared review weakness: an interpretation in a design
can become an accepted contract even when the original wording points elsewhere.
A useful follow-up would require reviewers to distinguish explicit requirements
from design assumptions and test contract-sensitive boundaries independently.
That intervention has not been applied or measured here. The unchanged grade is
retained; no candidate repairs or test changes were made. These failed fixtures
use single-line records, so they do not establish behavior for ambiguous physical
line counting with multiline or blank CSV records.

## Retained state and actual memory use

Ficus kept the same database, squad and manager across all requests. It created
three work streams, each with architect, engineer and reviewer roles, and all
three reached native `done`. Repository originals, design/implementation plans
and `COORDINATION.md` persisted and were read during later increments.

However, **native memory was not exercised**: every captured memory export has
zero documents and zero chunks, and the public tool traces contain no explicit
memory-tool or `ficus memory` invocation. The no-provider preflight had verified
native write/read/search capability, so this is observed non-use in this short
case, not evidence that memory was unavailable. The configured search was
keyword/FTS with no embedding provider. These observations do not establish
whether memory would help this workload or whether production agents generally
save enough memories.

Pi retained one coordinator session through `--continue`; each saved session is
an exact append-only extension of the previous snapshot. Its native child
sessions remained fresh per assignment. Original requests, per-increment designs
and coordination notes persisted in the repository and were read by later
children. Both therefore demonstrated repository/history continuity; this was
not a controlled comparison of equivalent memory implementations or an ablation
of memory versus no memory.

## Independent reviews and committed deliveries

Ficus's first review requested a repair for a non-text charset codec producing
HTTP 500 instead of the required 400. Its native workflow returned to engineering,
then received independent approval. Pi's first review rejected broad rejection of
punctuation-prefixed CSV headers; its second review found that HTML preceded by a
comment could be accepted as CSV. Pi completed two repair/rereview cycles before
approval. These are findings and validation recorded by the native reviewers,
not extra external benchmark points or separately rerun operator probes.

Both subsequent increments received independent approval on their first review.
Those approvals missed the shared row-ID defect despite extensive self-authored
checks. Test quantities reported by native agents are not interchangeable with
external acceptance counts.

| Arm / increment | Independently reviewed product | Delivered commit |
| --------------- | ------------------------------ | ---------------- |
| Ficus 1         | `f8c4e493`                     | `be12f87b`       |
| Ficus 2         | `9e8b276d`                     | `1e23fa90`       |
| Ficus 3         | `ef17e118`                     | `7b55f6b7`       |
| Pi 1            | `7f57b973`                     | `9657425c`       |
| Pi 2            | `927b698d`                     | `74a8e9d3`       |
| Pi 3            | `6dcb527c`                     | `b6b9d59c`       |

For all six deliveries, the reviewed product is an ancestor of the delivered
commit and the only changed path after approval is `COORDINATION.md`. Captured
worktrees are clean. Bundle HEADs and saved patch hashes match the independently
graded snapshots. No uncommitted work is counted as delivered product.

## Costs and elapsed time

All 423 request token tuples reconcile exactly with the scoped proxy receipts;
reconstructing its per-request rounding reproduces the settled totals with
**$0 unattributed cost**. Native Pi's configured cost field is zero, so the report
uses token receipts and the frozen proxy pricing rather than that field. The
JSON records input, cache-read, cache-write and output tokens by role and increment.

| Increment | Ficus cost | Pi cost   | Ficus delivery interval | Pi delivery interval |
| --------- | ---------- | --------- | ----------------------- | -------------------- |
| 1         | $1.545242  | $1.096098 | 14m39s                  | 14m33s               |
| 2         | $1.192730  | $0.718686 | 10m58s                  | 6m51s                |
| 3         | $1.296136  | $1.102350 | 10m21s                  | 9m31s                |

Delivery intervals begin at agent execution start for the first increment, and
at the preceding saved delivery thereafter. They include intervening adapter
work, native closeout and capture. Full trial duration additionally includes
setup, teardown and external grading. Overlapping role execution spans are not
added to estimate elapsed time or human effort.

| Role, all increments          | Ficus     | Pi        |
| ----------------------------- | --------- | --------- |
| Manager / coordinator         | $0.763244 | $0.373880 |
| Architect                     | $0.972880 | $0.511235 |
| Engineer, including repairs   | $1.657779 | $1.326084 |
| Reviewer, including rereviews | $0.640205 | $0.705935 |

Ficus costs $1.116974 more in this case. Planning plus coordination account for
$0.851009 of that difference; this is role attribution, not measured waste or
causal savings. Role responsibilities and contexts differ, and Pi incurred two
first-increment repairs versus Ficus's one. No audit optimization was injected
into either candidate baseline.

The pair cost **$6.951242**. The unchanged $50 phase now has **$33.962370 confirmed**
and the pre-existing **$5.50 call-1193 hold**, for **$39.462370 conservative exposure**
and **$10.537630 remaining**. The historical hold belongs to coordination-v8,
not this pair. No receipt was released, cap changed, ledger reset or paid retry
performed. Both launchers and the pair have stopped normally.

## Interpretation and next decision

This completes the overhead audit and the first sustained-product pilot. It
shows native progression through successive requests, genuine independent
review/repair, source preservation and a shared specification-interpretation
failure. Pi was faster and cheaper on this case, with the same external results.
It does not establish a general harness ranking, a causal memory benefit, human
time saved or unrestricted parallel throughput: it is one three-request product
and all model calls were serialized.

The most defensible next improvement is to challenge design assumptions against
original contracts during review. Native memory non-use is also worth examining
on a workload that actually benefits from cross-task knowledge. Any prompt
intervention should be evaluated separately and preferably on fresh external
tasks; replaying this inspected row-ID case would be a diagnostic regression,
not new benchmark evidence. No further paid run was started.
