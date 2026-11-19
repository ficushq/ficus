# Delivery guidance: final full behaviour comparison

Harness and new ref: `8936a554b947b626e8c619a8861c4d64e4c9517b`.
Old ref: `8f3e9d7abab4ed97fcb7a892964b680e1af60a66`.
Both sides were rerun fresh with the same voice-aware, fixture-corrected harness, using each
variant's own shipped default public voice. The default and fast tiers ran three times each for all
18 scenarios (216 turns), in three batches on 2026-11-19. No earlier cohort is mixed into this one.

Recordings:

- `2026-11-19-17-06-49.json` (delivery and merge scenarios)
- `2026-11-19-17-08-20.json` (decisions, follow-up, restart, recovery and worktree scenarios)
- `2026-11-19-17-11-34.json` (remaining seven scenarios)

The result below applies `compareRuns` to the **full cohort**, not to a selected passing subset.
The agreed rule is per model: every must scenario passes at least as often as before, and the
aggregate total does not drop. `readable-handoff` is not a must scenario: its Opus score drops
from 2/3 to 0/3. That made its batch-local total fail, but the full Opus total rises from 41 to 42.
Every must scenario is equal or better. This is a pass under the unchanged full-cohort rule,
not a claim that every run or every individual scenario passes.

Old: 8f3e9d7a (8f3e9d7a). New: 8936a554 (8936a554).

| Model                              | Scenario                        | Must | Old | New |     |
| ---------------------------------- | ------------------------------- | ---- | --- | --- | --- |
| anthropic:claude-opus-5-5:medium   | ask-human-decision              | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | offer-followup                  | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | restart-side-effect             | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | restart-idempotent              | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | no-logs-request                 | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | no-worktree                     | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | cleanup-owned                   | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | automerge-clean                 | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | automerge-blocked               | yes  | 2/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | slot-queued                     | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | paused-wait                     | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | ci-failure-rework               | yes  | 1/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | requester-identity              | yes  | 0/3 | 0/3 |     |
| anthropic:claude-opus-5-5:medium   | new-work-request                | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | cli-discovery                   |      | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:medium   | readable-handoff                |      | 2/3 | 0/3 |     |
| anthropic:claude-sonnet-5-5:medium | ask-human-decision              | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | offer-followup                  | yes  | 2/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | restart-side-effect             | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | restart-idempotent              | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | no-logs-request                 | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | no-worktree                     | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | cleanup-owned                   | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | automerge-clean                 | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | automerge-blocked               | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | slot-queued                     | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | paused-wait                     | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | completion-ready                | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | ci-failure-rework               | yes  | 0/3 | 0/3 |     |
| anthropic:claude-sonnet-5-5:medium | requester-identity              | yes  | 0/3 | 0/3 |     |
| anthropic:claude-sonnet-5-5:medium | new-work-request                | yes  | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | integration-not-merge-authority | yes  | 2/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | cli-discovery                   |      | 3/3 | 3/3 |     |
| anthropic:claude-sonnet-5-5:medium | readable-handoff                |      | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:high     | completion-ready                | yes  | 3/3 | 3/3 |     |
| anthropic:claude-opus-5-5:high     | integration-not-merge-authority | yes  | 3/3 | 3/3 |     |

Total for anthropic:claude-opus-5-5:medium: old 41, new 42 passing runs.
Total for anthropic:claude-sonnet-5-5:medium: old 46, new 48 passing runs.
Total for anthropic:claude-opus-5-5:high: old 6, new 6 passing runs.

Result: no regression.

## Provenance and limitations

Earlier full cohorts are preserved in the shared task archive referenced by `README.md`,
including all failed results. Pre-voice recordings omitted public voice and are historical only.
Successive fresh full cohorts exposed fixture contradictions rather than being silently discarded:
completed versus running assignments, stale edit reads, missing discovery/settings facts, missing
rework transitions, and quoted evidence incorrectly classified as executed commands. The actual
Sonnet owner-decision regression was addressed with an explicit pre-tool decision invariant.

Noah authorized the narrow Astro classifier correction and later command-versus-quoted-evidence
correction; historical JSON verdicts remain unchanged, with the exact five corrected false positives
pinned in offline tests. The manager authorized truthful repository/state fixtures and the final
post-completion premise correction. The final offer-followup case now starts after the small fix
is done, consistent with the approved goal; its current-turn message only asks for a summary,
without supplying the desired no-offer behaviour or permission to fix unrelated defects. Scenario
goals, step limits and the full no-regression threshold were retained.

Known remaining weaknesses: requester-identity is 0/3 on both variants and models; fast-tier
ci-failure-rework remains 0/3 on both; Opus readable-handoff falls from 2/3 to 0/3. Passing this
comparison does not waive those findings. The command extractor covers the shell forms exercised
by these evals and is not a general Bash evaluator or a runtime security boundary.

## Trace review follow-up

The subsequent [trace review](https://github.com/ficushq/ficus/pull/952#pullrequestreview-5979999689)
identified the Opus readable-handoff decline as a contradictory fixture, not worse guidance. The
claimed assembler commit is scripted as a slot-change commit and the expected assembler files are
absent; new-text agents correctly refuse to submit unverifiable work. Scores above remain the
original measured values. Repair that fixture before using it to measure prose again. Requester
identity and fast-tier rework also need a failure-source diagnosis before later guidance areas rely
on their baseline signal. These follow-ups do not alter this recorded cohort or its relative rule.
