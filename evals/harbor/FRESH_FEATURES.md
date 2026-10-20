# Fresh feature comparison — preparation

This experiment follows the prompt fix merged in #631. It uses an unattempted
external task and the same four workflows as the development pilot. It is not a
public leaderboard submission or a statistical performance estimate.

`fresh-feature-v1-selection.json` freezes the candidate order before task runs.
Candidates are CPU-oriented level-one tasks from the already pinned Harbor
FeatureBench snapshot, ordered by SHA256 of `ficus-fresh-v1:<task name>`. This is
an explicitly restricted convenience sample, not a random sample of all feature
work. The first candidate is Pandas concatenation/type handling. The snapshot is
not claimed to be FeatureBench V1.1. No model attempts have influenced selection.

The runtime reuses the verified scope-overlay archive. The three new guidance
blocks match merge commit `b0db7060` byte-for-byte; the existing experimental local
delivery support remains necessary and unchanged. No other production drift is
included. Pi uses its existing packaged subagent workflow and unchanged role
prompts. All roles use native Pi GPT-6.1 Sol with medium reasoning, and all calls
are accounted for in the common ledger.

The order is Pi planned, Ficus planned, Pi engineer, Ficus engineer. Each gets a
fresh container, one attempt, two CPUs, eight GiB, and a one-hour agent limit.
There is no operator steering or best-of retry. The cumulative cap was raised
by the user from $20 to $50 before inference; $11.853043 is already accounted for.
The existing conservative $5.50 per-request reservation is retained. A cap stop
or infrastructure/grading failure is reported explicitly; a partial set of
attempts cannot be presented as a completed matched comparison.

## Infrastructure and grader preparation

The Pandas verifier has tests nested under `pandas/tests` and a package-level
`pandas/conftest.py`. Preparation now supports that explicit layout as well as
the previous Pydantic layout. Official tests, pytest configuration and the
upstream requirements file are restored after archiving the agent's submission.
The upstream grader script and acceptance assertions remain unchanged. Nested
parent symlinks are refused before restoration; agent source is preserved.

Before inference, require baseline and reference-solution controls, including
colliding agent-authored test-file controls, to produce the expected 0/1 results
with verified immutable grader hashes. Reference material remains host-only and
is uploaded only to reference/grading containers, never to an agent image.

The first image pull failed after exhausting host disk space; OrbStack stopped.
No model calls ran. Superseded evaluation images and two reproducible runtime
archives were removed; 19 byte-identical immutable Git fixture archives were
hard-linked after SHA256 checks. Results and submitted source archives were
preserved. A second pull also exhausted disk space and stopped OrbStack; it was
restarted again, with no further pull attempted. Five clean worktrees matching
merged PR heads were removed, alongside rebuildable Gradle, CocoaPods and Docker
build caches. Host free space increased from roughly 11 to 26 GiB. Simulator
data and unrelated database volumes were preserved. The user then authorized removing the old iOS 26.1 runtime and its two stopped
devices. The next official-image pull succeeded, with 41 GiB still free.
Candidate order was retained; no task was skipped based on an agent result.

Local validation: 36 offline tests pass, including the nested test restoration,
source preservation, symlink boundary and $50 cap accounting regressions.

## Validated fresh task — 2026-10-20

The frozen setup is in [fresh-feature-v1.json](fresh-feature-v1.json). The
sanitized image has one masked Git commit, no original source backup or hidden
patches, and no duplicate Pandas implementation under the package environment.
The upstream grader remains byte-identical. All four controls completed:

| Control                            | Official feature tests | Regression tests                | Reward |
| ---------------------------------- | ---------------------- | ------------------------------- | ------ |
| Masked baseline                    | 4 passed, 10 failed    | Not reached                     | 0      |
| Reference solution                 | 14 passed              | 146 passed, 8 expected failures | 1      |
| Baseline with colliding test file  | 4 passed, 10 failed    | Not reached                     | 0      |
| Reference with colliding test file | 14 passed              | 146 passed, 8 expected failures | 1      |

No fresh model attempts had run when this configuration was frozen. The four
arms run sequentially on the same Mac through Linux amd64 containers; timings
include the limitations of emulation and shared-host load.
