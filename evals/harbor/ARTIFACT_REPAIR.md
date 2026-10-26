# Native squad repair continuation

This is a known-artifact continuation, **not an unseen benchmark attempt or a
reviewer-prompt comparison**. It uses the original runtime and production reviewer
guidance, GPT-6.1 Sol / medium, and the native planned Engineering workflow.

## Frozen input and controls

The starting artifact is the Bandit implementation from controlled review v2,
patch `fc27071def1014074bf1a7d2531644616ae67e74ffef2a8c9ae9a9916e2f2fcd`.
The squad receives the original task and original review verbatim: two findings
about next-statement targeting and combining inline with structured directives.
It receives no official grade, hidden tests, operator reproductions, or the
candidate-only physical-line File-plugin finding.

Before inference, the derived fixture reproduced the starting official grade
(67/69 feature checks, 280/282 regressions), and the native startup/network probe
passed. The plan and input hashes were committed. A separate nine-case behavioral
check was frozen and run on the starting artifact before the squad started:
4/9 passed. Those checks were never exposed to the squad.

## Native execution

Manager, architect, engineer, and independent reviewer all executed. The manager
created and started a work stream; the architect designed the repair; the engineer
committed it; and the reviewer approved after independent checks. No task guidance,
code edits, owner answers, or manual flow transitions were supplied by the operator.

The manager then reopened the stream because three design/validation/review files
remained untracked despite the original task's explicit instruction to commit
everything. The manager specifically requested documentation-only closeout and
preservation of the approved code. Reopening the configured workflow nevertheless
started another design → implementation → review cycle. Its architect completed
and its engineer committed the evidence documents, leaving a clean working tree.
The implementation flow step was still running and the second review had not
occurred when the budget stop was applied.

The first code approval is at `569ea51`; the captured final commit is `fbbabe9`.
The final patch SHA256 is
`c0e66b1aad3b6cd203bbae4ece648027d2d842531d0da88ab213119976cc8865`.
This additional cycle is observed closeout overhead, not evidence of a code rework
request or a production routing defect. The commit-everything requirement was
real. A future focused improvement could prevent task-created evidence from being
left untracked or support a smaller reviewed closeout path; no production fix is
included here.

## Independent outcome

The exact saved patch was checked in a fresh offline container:

| Measure                           | Starting artifact | Captured repair |
| --------------------------------- | ----------------- | --------------- |
| Supplied review defects fixed     | 0/2               | 2/2             |
| Frozen behavioral cases passed    | 4/9               | 7/9             |
| Withheld File-plugin defect fixed | No                | No              |
| Official feature checks passed    | 67/69             | 67/69           |
| Official regression checks passed | 280/282           | 280/282         |

Both supplied findings are repaired. The withheld region-suppression issue on
comment-only lines remains. The same four official check identifiers fail after
repair; their boundary-interpretation caveats remain documented in
[the Bandit controlled review](ARTIFACT_REVIEW.md#replication-bandit-structured-directives).
The official score is unchanged; this is not a fully accepted benchmark artifact.

The paid run was interrupted for budget, so its verifier did not run automatically.
The captured patch was subsequently replayed through the unchanged official
verifier **without inference**, with the patch hash verified. That separate grade
must not be represented as autonomous delivery. The successful first review cycle
also does not erase the unfinished closeout cycle.

## Budget and stopping

The continuation spent **$1.047728 across 66 requests**, all with settled receipts.
Current phase accounting is **$19.005101 confirmed + $5.50 retained historical
hold = $24.505101 exposure** against the $30 cap. **$5.494899 remains**, just below
the proxy's conservative $5.50 next-request reservation. This is a reservation
limit, not a claim that $30 has been spent.

Once every new receipt was settled and another request could not be reserved,
the operator captured the committed patch, empty working-tree diff, Git state,
and native snapshot, then sent SIGINT to the owned Harbor process. The adapter
exported messages and state and stopped its worker, API, and disposable database.
The outcome remains `interrupted` / budget-limited, with no final delivery claim.
No old hold was released and the ledger was not reset.

The two new reviewer comparisons plus this continuation cost **$3.279914**.
See `artifact-repair-v1-results.json` for role/flow provenance, before/after checks,
hashes, stop calculation, and replay classification. Durable raw evidence remains
in the sibling `ficus-evaluation-data/artifact-repair-v1` directory.

## Closeout-guidance validation (v2)

[PR #677](https://github.com/ficushq/ficus/pull/677) removes conflicting instructions
that prohibited committing plans regardless of the task. It places scratch notes
outside repositories by default and requires ownership/delivery checks before
handoff and approval. Commit requirements remain conditional on the task, and
review gates are unchanged.

A single new run started from the **same original artifact and original review**,
not the partially repaired v1 output. The original runtime archive was patched
with only six prompt/skill changes from commit `bb35f05b`; an independent full
archive comparison verified all other members, modes, and symlinks were unchanged.
Task, instruction, verifier hashes, image ID, model, reasoning, native workflow,
network restrictions, and fresh-disabled memory were retained. Startup/isolation
checks passed without inference. The new plan, runtime provenance, and readiness
manifest were committed before inference. No hidden test result or operator hint
was provided to the squad.

The native run delivered autonomously. Its trace was:

1. Architect committed the required design record before implementation.
2. Engineer committed code, regression tests, and documentation.
3. Reviewer verified the original repairs, then found a separate physical-line
   reconstruction bug involving Unicode separators inside valid Python strings.
4. Engineer made the targeted repair; reviewer independently rechecked it and
   completed the code-quality pass, then approved.
5. Manager moved its own monitoring artifacts outside the repo and verified an
   empty `git status --short --untracked-files=all`. Required deliverables remained
   committed. No work-stream reopen or second design pass occurred.

The monitoring files were runtime artifacts, not discarded requested evidence.
Reviewers explicitly reported them; the manager handled its own files rather
than deleting another participant's work. All six role executions completed, no
open waits remained, and there was no operator task steering. The official
verifier ran as part of this completed trial, unlike v1's separate captured replay.

| Measure                       | Original artifact | v1 captured repair | v2 delivered repair |
| ----------------------------- | ----------------- | ------------------ | ------------------- |
| Supplied review defects fixed | 0/2               | 2/2                | 2/2                 |
| Frozen behavioral checks      | 4/9               | 7/9                | 7/9                 |
| Official feature checks       | 67/69             | 67/69              | 67/69               |
| Official regression checks    | 280/282           | 280/282            | 280/282             |
| Documentation-only reopen     | Not applicable    | Yes                | No                  |
| Native completion             | Not applicable    | Budget-interrupted | Delivered           |

The same four official test identifiers fail. The withheld File-plugin issue
remains; autonomous delivery does **not** mean benchmark acceptance.

The new review finding was independently corroborated after completion in fresh
network-disabled containers: six Unicode physical-line cases failed on the original
artifact and passed on the final patch. These are **post-hoc** cases derived from
the reviewer finding, not additions to the frozen nine-case score. See
`artifact-repair-v2-posthoc-check.py` and `artifact-repair-v2-results.json`.

The final patch SHA256 is
`40e3a24a0a714b2a5a8f6d4e6748766140b75eb81bce50962b9c826085f82332`.
The run cost **$1.215893 across 88 settled requests**. The user explicitly raised
the phase cap to $35; no ledger reset or historical-hold release occurred.
Phase accounting is **$20.220994 confirmed + $5.50 historical hold = $25.720994
exposure**, leaving **$9.279006**. The owned proxy, native services, task containers,
and disposable database were stopped.

This is evidence that the candidate guidance can complete this closeout without
restarting design. One stochastic rerun against an interrupted historical baseline
cannot establish a causal improvement, general reliability, or cost savings. The
newly discovered code defect also changes the substantive review work. Keep these
results separate from unseen-task comparisons and from the experimental reviewer
addition that was not used here.

## Remaining File-plugin defect: offline diagnosis

The delivered v2 artifact still reports B613 for a comment-only line inside a
region that should suppress it. The original request explicitly applies regions
to subsequent **physical lines**, and the existing TrojanSource File plugin
reports characters in both comments and strings. This issue is independent of
the four official assertion failures and their interpretation caveats.

`build_suppressions()` computes region coverage in a local `physical` map, then
copies that coverage into entries for actual statements. `SuppressionMap.for_result()`
only looks up those statement entries. A comment outside a statement therefore
has no retained region coverage when a File plugin reports its line. Assignment
controls pass because those lines do have statement entries.

The squad's committed coverage table cites
`test_file_plugin_uses_reported_statement_location` as coverage of File-plugin
locations. That test uses a finding inside a statement. It does not establish
coverage of every physical line. The independent reviewer approved after 47
focused tests and 320 broader tests, without identifying the comment-only gap.
This supports a specific missing-case diagnosis; it does not establish the
reviewer's internal reasoning or prove that its context caused the miss.

A separate disposable, network-disabled container replayed the exact final patch
and the unchanged nine-case check: **7/9 passed**. An operator-only diagnostic then
retained the physical map and combined it into result-line lookups: **9/9 passed**.
The three small substitutions are recorded in
`artifact-repair-v2-file-line-diagnostic.py`; before/after outputs and hashes are
frozen in `artifact-review-v5-ready.json`. This is a causal probe, **not** a reviewed
Bandit repair, an agent-delivered patch, or a change to the official score. Neither
this mutation nor its results are supplied to the subsequent reviewers.
