# Guidance delivery comparison recordings

All recordings are preserved, including failed comparisons. Do not combine runs from different
harness versions into one pass/fail claim.

- `2026-11-18-*.json`: historical, pre-voice-aware harness. Old ref `7f309fbe` against the working
  tree for the delivery guidance change. These omitted public voice. The three-repeat second
  batch failed the rule on offer-followup; a ten-repeat rerun is recorded separately. They are
  not current runtime prompt evidence.
- `2026-11-19-15-*.json`: voice-aware harness `9b51d472`, old ref `8f3e9d7a` against new ref
  `9b51d472`, three repeats per side and default plus fast tier. Delivery scenarios passed;
  the full comparison failed on must scenarios ask-human-decision and offer-followup. Inspection
  found contradictory fixtures: a running assignment was reported as already completed, and
  offer-followup verification reads kept returning the original typo after successful edits.
  These failures must not be presented as a passing comparison or combined with later fixture
  corrections.
