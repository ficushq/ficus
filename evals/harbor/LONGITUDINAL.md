# Sequential product-work pilot

This study follows the completed [v8 coordination comparison](coordination-v8-results.md)
and its [offline overhead audit](coordination-v8-overhead.md). It uses three
successive, previously unused DataGate requests from SCBench at pinned revision
`9cd9ca3a51c3d3e2a99d2488a25baf73a2204451`: CSV ingestion, pagination/sorting,
and filtering. Selection happened from specifications before fetching tests and
references. This is a short benchmark-derived longitudinal case study, not an
official leaderboard submission or evidence of long-term production reliability.

## Delivery and retained state

Only request 1 is in the initial Harbor instruction. A host-only, hash-pinned
manifest contains requests 2 and 3. The adapter releases one next request only
after native completion and a clean committed snapshot. Candidates receive no
external grades, test inputs, reference code, operator hints, or fixes.

Ficus retains one database, squad, manager, workspace and native memory. Memory
uses keyword/FTS search; the separate embedding integration is unconfigured.
Pi retains its native coordinator session through `--continue`, the repository
and durable notes; its packaged child sessions remain fresh per assignment.
Their memory implementations differ. We will measure actual writes, searches,
references and reuse, not claim a causal memory advantage without an ablation.

Each increment still requires architectural design, engineering and independent
review, with natural package boundaries rather than a forced three-package
minimum per increment. Existing role prompts are unchanged. Both coordinators
may maintain factual `COORDINATION.md` records, preserve original requests, and
use at most two workers. Model calls remain serialized, using `gpt-6.1-sol`,
medium effort and an 8,192-output-token limit. This first longitudinal baseline
does not inject the overhead audit's suggested optimizations.

## Offline checks and grading

The original specifications, all 117 selected test functions (174 parameterized
cases), fixtures and shared response helpers were audited before inference.
The private audit records source hashes, exact evidence and interpretation per
function. Cases cover 50 tests after increment 1, 122 cumulative tests after
increment 2, and 174 cumulative tests after increment 3.

Each saved patch is independently reapplied to the pristine `/app` baseline in
the separate verifier. Keeping the declared absolute path supports legitimate
absolute-path imports. Later repairs cannot replace earlier deliveries. Missing
snapshots, incomplete collection, errors, skipped cases or timeouts cannot earn
acceptance. The per-checkpoint verifier budget remains 300 seconds; the combined
verifier has 960 seconds for three such suites plus workspace setup/cleanup.
Server stdout/stderr go to named files to prevent pipe-buffer deadlocks. Upstream
assertions and server readiness/request/shutdown timeouts are unchanged.

Controls include the reference, a noisy reference with candidate-side pytest
import collisions, no implementation, independent numeric/sorting/filtering
mutations, and a missing middle snapshot. Native probes exercise Ficus memory
write/read/search across a follow-up to the same manager and Pi session
continuation without provider calls. The initial Ficus probe expected no execution
row, but native message enqueue correctly creates a _queued_ row; its corrected
assertion requires all such rows to remain queued with no usage. Both probe
attempts are retained. No paid candidate was involved.

The tests are not exhaustive. They do not fully assert default CLI options,
readiness behavior or query timeout behavior. Conventional CSV empty-line handling
and integer-to-string filtering interpretations are disclosed in the audit.

## Accounting and reporting

Use the existing `budget-phase-2026-10-28-000028-reset50`, with a **$50 cap** and
unchanged **$5.50/request reservation**. Opening confirmed spend is **$27.011128**;
the unresolved **$5.50 hold for call 1193** remains, leaving **$17.488872** of
conservative headroom. No ledger reset or receipt reconciliation is authorized.
The launcher rejects duplicate clients/jobs, changed inputs, budget exhaustion,
and new missing receipts. An active latest request's reservation is not itself
an unresolved receipt. No paid retries occur automatically.

Report acceptance and regression counts for each saved increment, source and
session continuity, committed delivery, actual delegation and independent review,
memory activity, wall intervals and receipt-backed costs by increment and role.
Disclose unassigned usage and the historical hold. No general harness ranking,
human-time-saved claim or unrestricted parallel-throughput claim follows from
this one three-request product progression.

## Completed outcome

Both arms completed all three native deliveries. External results were identical:
50/50, 119/122 and 171/174, with the same three row-ID failures persisting after
increment 2 and zero skips/errors. Ficus cost $4.034108; Pi cost $2.917134. Ficus's
native memory remained empty while both used persistent repository notes/history.
See the [validated comparison](longitudinal-v1-results.md) and
[receipt-reconciled evidence](longitudinal-v1-results.json).
