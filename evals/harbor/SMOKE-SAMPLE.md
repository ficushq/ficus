# Fresh smoke sample — 2026-10-19

This is a small development validation sample, not a leaderboard estimate.
It was selected before executing these tasks or inspecting their solutions or
verifiers. The earlier `fix-git` development task is excluded.

Selection: among Terminal-Bench 2.0 tasks labeled `easy` in their metadata, order
by SHA256 of `ficus-pilot-2026-10-19:` followed by the task directory name. Take
the first two. Both environments are Ubuntu with the default root user, within
the adapter's current support constraints. The resulting order is:

1. `prove-plus-comm` (software engineering; 900-second agent limit).
2. `overfull-hbox` (debugging; 750-second agent limit).

Use runtime commit `17ade874`, the explicit full-squad handoff, GPT-4.1 snapshot
`gpt-4.1-2025-04-14` for every Ficus role and for Pi 0.99.1, original task limits,
one attempt per harness/task, no automatic retries, fresh isolated databases and
memory disabled. Preserve the task instructions and official grading. No manual
agent steering or approval is allowed inside an attempt.

Run sequentially: Ficus then Pi for each task. The shared $20 cumulative ledger
includes all previous development attempts and their unknown reservations. Stop
at the guard or an adapter blocker; report missing runs as unexecuted. Do not
replace a failed task or tune prompts between these four sample runs. Any further
fix starts a separately labeled configuration.

Report official reward, actual executed roles and durable flow completion,
wall-clock time (including setup, reported separately where available), and
aggregate cost for every role. A prose claim of completion is not workflow
completion; a completed workflow is not necessarily a passing verifier.
