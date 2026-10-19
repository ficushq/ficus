# Pilot evidence — 2026-10-19

Status: **integration in progress; full-squad completion is not yet verified**.
Do not publish these attempts as a Ficus squad leaderboard result.

The pilot used Harbor 0.24.0 and the unmodified `fix-git` task downloaded from
Terminal-Bench 2.0. Harbor recorded task digest
`sha256:31f6063693d71cdbb49d8ae17848ae54eed7a1953228164efbb3f4100251600d`.
The image was `alexgshaw/fix-git:20251031`, digest
`sha256:61e431c00c58df652287aadce5457634d9f9330cfdd153ebdf2802df0d540119`.
Trials ran locally with Docker/OrbStack, Linux amd64 containers on an arm64 Mac,
the task's original resource limits, one attempt per job, and no automatic retry.
Every Ficus attempt had an empty disposable database and memory disabled.

## All attempts

| Job | Model | Result | What was actually exercised |
| --- | --- | --- | --- |
| `ficus-fix-git-smoke1` | GPT-4.1 mini | Adapter exception | Incorrect readiness probe timed out; no inference. |
| `ficus-fix-git-smoke2` | GPT-4.1 mini | Interrupted smoke | Worker was healthy on a different listener; manager asked for clarification. |
| `pi-fix-git-pilot1` | GPT-4.1 mini | Official reward 0 | Baseline stopped at a merge conflict and asked the user. |
| `ficus-fix-git-smoke3` | GPT-4.1 mini | Official reward 0 | Manager ran tools directly, stopped for clarification; no worker/reviewer. |
| `ficus-fix-git-full-squad1` | GPT-4.1 mini | Official reward 0 | Stronger squad context still did not cause delegation. |
| `pi-fix-git-gpt41` | GPT-4.1 | Official reward 1 | Harbor's Pi baseline completed the task. |
| `ficus-fix-git-gpt41` | GPT-4.1 | Official reward 0 | Manager implemented directly and delivered an incorrect resolution; no worker/reviewer. |
| `ficus-fix-git-envelope` | GPT-4.1 | Official reward 0 | Manager attempted work-stream creation, selected a PR workflow, and hit repository/worktree setup errors; inference later hit the conservative cap. |

Model snapshots were `gpt-4.1-mini-2025-04-14` and `gpt-4.1-2025-04-14`.
The Pi baseline was 0.99.1 with thinking off and Chat Completions; Ficus uses the
same base Pi version with its existing patches. Every role and model tier was
pinned. Output was capped at 8192 tokens for both harnesses. No solutions or
verifier code were supplied to agents, and the grader was not changed.

These are development/smoke attempts, not independent statistical observations:
configuration was adjusted between them. Preserve all attempts and use a fresh,
predeclared task sample for a later frozen comparison.

## Findings and fixes

1. The worker health listener and internal-event listener are different. The
   adapter now uses `WORKER_PORT=17302` for readiness and event port 17303 for
   events. PostgreSQL readiness is checked explicitly.
2. The full squad requirement in background context was insufficient. The
   current adapter puts a generic delegation/review requirement in the task
   handoff, followed by the original task text verbatim.
3. Transport auditing confirmed the real Ficus system prompt reached the model:
   97,351 characters, including the squad execution contract. No prompt contents
   or credentials were recorded by this audit.
4. Engineering's inherited workflow alternatives suggested PR-based coding,
   despite a local deliverable default. The trial now replaces those alternatives
   with the intended `builder-reviewer` flow.
5. Mandatory worktree guidance conflicted with the explicitly disposable,
   single-task checkout. The proposed general guidance permits authorized local
   in-place delivery in that narrow situation, retaining review and the usual
   isolation requirement for shared checkouts. This final guidance change has
   passed offline checks but **has not yet been validated by a completed live
   full-squad run**.
6. The proxy originally stopped reading upstream when a client disconnected,
   potentially losing final usage. It now drains the stream for usage and records
   HTTP status/failure type without prompt bodies or credentials. This change is
   covered by a simulated disconnect test. The cause of the earlier missing
   usage cannot be established from the retained evidence.

## Spending boundary

The shared durable ledger records **$0.957426 confirmed metered usage** and four
unknown-usage reservations of **$2.20 each**: **$9.757426 total upper-bound
exposure**. It refused further calls under the approved $10 cap. Unknown
reservations were not discarded or retrospectively treated as free. No further
paid trials were started after this boundary was reached, and the proxy was
stopped. These figures exclude local compute costs.

## Validation and next run

- Core manager prompt/context tests: 16 passed across one file using the isolated
  package test runner.
- Adapter/accounting/budget tests: 13 passed, including concurrent reservations,
  restart persistence, model changes under the same cap, all-role accounting,
  pending-message completion, and disconnect usage collection.
- Core TypeScript check passed; Python Ruff check/format and Git whitespace checks
  passed.
- Runtime archive rebuilt from commit `e39028ec` with the final bootstrap and
  delivery guidance; archive provenance includes commit and bootstrap hash.
- Owned task containers and database sidecars were removed after attempts.

The next live check must demonstrate manager creation of a work stream, an
engineer's execution, an independent review, any required rework, local delivery,
and an official verifier result. Until then, this is a draft integration. More
inference requires reconciling the unknown reservations against authoritative
provider usage or explicitly authorizing additional budget; do not reset the
ledger to get around the cap.
