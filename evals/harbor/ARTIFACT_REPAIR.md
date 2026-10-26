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
