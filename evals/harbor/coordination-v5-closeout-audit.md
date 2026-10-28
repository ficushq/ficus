# V5 closeout diagnosis and next-run policy

The extra cycle was triggered by a stale coordination record, not a new code
finding. At 03:51:38 UTC the manager received completion of integration stream D.
At 03:52:09 it reported that independent review had approved `1c8f5fc` with 482
tests, but `COORDINATION.md` still listed review as pending. It explicitly reopened
D for a narrow documentation correction. The next design dispatch had already
started at 03:52:06. This follows the runtime's documented reopen semantics:
`reopenWorkflowRun` preserves history, clears completed steps and starts at the
flow entry. There is no evidence of an accidental idle restart.

Attempts 4–6 ran architect, engineer and reviewer. The resulting commit
`a31296afe5f2dfd98900985c209f82666fff5d55` changed only `COORDINATION.md`.
The recorded independent documentation approval arrived at 03:55:03. Both engineer
and reviewer reran the 482-test suite despite no source/test changes.

The three attempts account for 24 calls in the native snapshot: ten design,
eight implementation, six review. Their internal usage totals $0.8474654,
excluding manager overhead. This is descriptive attribution, not a guaranteed
saving from a proposed fix. The native full-run total is $5.855224 versus the
proxy's authoritative settled $5.855335; retain that $0.000111 accounting
precision difference rather than silently mixing ledgers.

## Why existing guidance did not prevent it

The archived runtime contains #677's warning that reopening starts from the
entry, and advice to resolve closeout before finishing. It also requires requested
repository evidence to be committed. The benchmark explicitly asks for review
decisions and integration results in `COORDINATION.md`. Ficus assigned only the D
engineer ownership of that file's D section; the final reviewer approved after the
engineer's record was committed. Recording that later decision therefore became
a follow-up task. Pi's coordinator instead appended final factual approval details
itself after independent review.

This is an ownership/timing interaction, not proof that Ficus lacks the closeout
prompt or cannot do administrative edits. The manager already made earlier
administrative coordination commits. Its fixture permits administrative Git setup
but does not explicitly distinguish evidence bookkeeping from delegated product
documentation. The trace does not establish why the model chose reopen over every
available alternative, nor justify changing production reopen semantics globally.

## Proposed equal guidance for a future frozen comparison

Apply the same policy to both coordinators, declared before inference:

> The coordinator owns factual coordination bookkeeping in COORDINATION.md and
> may update and commit package status, handoff references, and already-issued
> review decisions. This permission does not include product code, tests,
> integration, technical design, or changes to a review decision. Cite the actual
> reviewed product revision and evidence; do not claim a later documentation
> commit was reviewed unless it was. Keep final workflow approval in its native
> record and link it rather than requiring a self-referential commit hash. Delegate
> substantive documentation or implementation corrections through the required
> workflow and preserve every declared review gate.

This is a proposed benchmark contract clarification, **not a deployed prompt
change or validated improvement**. Do not edit v5's frozen contract, runtime,
launchers or candidates. A future setup probe must verify equal coordinator
permission and a fresh contract/runtime hash before paying for either arm.

## Stronger task audit

Reference success, complete collection and mutation sensitivity did not expose
v5's semantic disagreements. Future studies must map collected test IDs to exact
source clauses and test evidence, explicitly covering formatting, null/default
behavior, query parameters, validation precedence and later-request overrides.
Reject unresolved contradictions before inference; do not alter assertions or
feed revealed tests to candidate agents.

`contract_audit.py` checks a pinned audit report, frozen file hashes, collected
inventory coverage, exact evidence quotes and unresolved findings. It is a
completeness/provenance gate, not an automatic semantic verifier. Reviewers remain
responsible for judging agreement. Grouped cases may share a claim only when
its rationale actually covers every mapped parameterization.

Future launchers must call `require_ready(report, task_root, pinned_report_sha256)`
**before** starting the model proxy. Freeze the collected node-ID JSON alongside
the exact specs, tests and case data. Historical launchers remain unchanged and
are not retroactively protected by this new helper. Reference/no-op/collision,
noisy-server, mutation, native-network and budget checks remain required too.

Five offline regression tests cover ready evidence, stale inputs/report hashes,
missing coverage, ambiguity, retrospective/rejected decisions, fabricated quotes
and unknown tests. No new model calls, candidate repairs or ledger changes were
used for this diagnosis.
