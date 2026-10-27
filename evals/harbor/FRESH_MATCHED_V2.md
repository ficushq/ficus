# Fresh matched mnamer study

This is the next unused task in the frozen DeepSWE selection after Koota:
`mnamer-daemon-watch-lifecycle`. It asks for continuous folder monitoring,
state tracking, logging, and daemon lifecycle commands. Task selection did not
use model results.

The [plan](fresh-matched-v2-plan.json) freezes four sequential first attempts:
Pi engineer, Pi architect/engineer/reviewer, Ficus architect/engineer/reviewer,
then Ficus engineer. This order is derived from the task and arm names by SHA256.
Every condition uses native Pi SDK GPT-6.1 Sol with medium reasoning, the same
original task and unchanged official grader. Ficus reuses the exact Koota
closeout-guidance runtime; no experimental reviewer addition or per-task prompt
tuning is included.

Task resources remain two CPUs and 8 GiB memory; the requested 20 GiB storage is
not an observed enforced quota. Ficus additionally uses a disposable loopback
PostgreSQL container. Host architecture emulation and harness setup overhead
limit timing comparisons. Ficus captures a private task/database checkpoint
before cleanup; elapsed time includes that overhead. Checkpoint restoration
is verified offline, but automatic inference continuation is not implemented.

Before paid inference, require baseline/reference and test-file-collision
controls, and native Ficus/Pi restricted-network probes. Final grading uses a
separate pristine verifier without networking. No solutions, hidden feedback,
previous implementations, or operator task hints enter inference environments.

The existing $20 phase opened this study at $2.457816 spent, leaving $17.542184.
Every request still reserves $5.50; missing receipts retain their holds. There
are no automatic paid retries. Any interruption remains a separate outcome,
and partial results do not become a completed four-arm comparison.

Report official acceptance, feature/regression counts, native role execution,
review/repair transitions, owner waits, cost, and elapsed time separately. One
additional task will not establish a general harness winner or measure human
focus time saved, persistent memory, or dependent product coordination.
