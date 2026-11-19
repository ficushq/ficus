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
