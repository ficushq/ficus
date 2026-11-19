# Guidance delivery comparison recordings

All recordings are preserved, including failed comparisons. Do not combine runs from different
harness versions into one pass/fail claim.

- `2026-11-18-*.json`: historical, pre-voice-aware harness. Old ref `7f309fbe` against the working
  tree for the delivery guidance change. These omitted public voice. The three-repeat second
  batch failed the rule on offer-followup; a ten-repeat rerun is recorded separately. They are
  not current runtime prompt evidence.
- `2026-11-19-15-40-30.json`, `2026-11-19-15-42-55.json` and `2026-11-19-15-46-11.json`: voice-aware harness `9b51d472`, old ref `8f3e9d7a` against new ref
  `9b51d472`, three repeats per side and default plus fast tier. Delivery scenarios passed;
  the full comparison failed on must scenarios ask-human-decision and offer-followup. Inspection
  found contradictory fixtures: a running assignment was reported as already completed, and
  offer-followup verification reads kept returning the original typo after successful edits.
  These failures must not be presented as a passing comparison or combined with later fixture
  corrections.

- `2026-11-19-15-51-55.json`, `2026-11-19-15-55-03.json` and `2026-11-19-15-58-20.json`:
  corrected-fixture, voice-aware harness `4eb4f945`, old ref `8f3e9d7a` against new ref
  `4eb4f945`, both sides rerun with three repeats on default plus fast tiers. The full
  comparison fails the rule: Sonnet ask-human-decision drops from 3/3 to 1/3. Opus
  new-work-request is graded 3/3 to 2/3, though the failed trace only searches for
  astro.config and routes the request (the unchanged grader's bare astro regex marks the
  search as starting a migration). Delivery scenarios pass; that is not a full pass.

- `2026-11-19-16-09-54.json`, `2026-11-19-16-13-02.json` and `2026-11-19-16-16-41.json`:
  harness/new ref `fb7b125a`, old ref `8f3e9d7a`, both sides rerun across all scenarios.
  The authorized owner-decision rule and Astro grader repairs pass their scenarios, but
  the full comparison still fails on Opus automerge-clean and automerge-blocked and Sonnet
  slot-queued. Repository-settings requests, worktree discovery and rework transitions have
  incomplete stub responses; these traces remain failed evidence, not a passing result.

- `2026-11-19-16-31-32.json`, `2026-11-19-16-33-45.json` and `2026-11-19-16-37-16.json`:
  audited-fixture harness/new ref `4230a5df`, old ref `8f3e9d7a`, both sides rerun once for
  all 18 scenarios after 179 focused offline checks. The original full verdict is regression:
  Opus restart-side-effect is 3/3 to 2/3. That new failed trace checks MERGED and does not
  retry, but quotes gh pr merge inside Ficus finish evidence, which the grader and responder
  match as an executed command. Used --admin false positives similarly match quoted prose
  saying without --admin. Preserve the original verdicts pending explicit disposition.

- `2026-11-19-16-54-11.json`, `2026-11-19-16-56-10.json` and `2026-11-19-16-59-30.json`:
  command-aware harness/new ref `59758c68`, old ref `8f3e9d7a`, both sides rerun afresh across
  all 18 scenarios after the authorized command-recognition and responder repair. The full
  result still fails on Opus offer-followup (old 2/3, new 1/3); all failures are step-limit
  timeouts during discovery and verification, not chat offers. The approved goal says the
  small fix is already done, but the opening fixture asks the agent to perform it without
  an initial worktree path. This premise gap is recorded, not waived as noise.

- `2026-11-19-17-06-49.json`, `2026-11-19-17-08-20.json` and `2026-11-19-17-11-34.json`:
  final post-completion harness/new ref `8936a554`, old ref `8f3e9d7a`. Both full sides rerun
  fresh after the authorized completed-fix premise correction. The complete 216-turn cohort
  passes the unchanged rule: every must scenario is equal or better, with totals 41 to 42 on
  Opus medium, 46 to 48 on Sonnet medium and 6 to 6 on Opus high. The non-must Opus
  readable-handoff score drops 2/3 to 0/3; that batch-local failure is disclosed, not hidden.
  See `delivery-comparison.md` for the complete table and provenance.
