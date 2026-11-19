# Behaviour recording retention

Keep only the current comparison and minimal regression traces in git. The recursive directory
budget is **1 MiB (1,048,576 bytes)**, approved by Noah on 2026-11-19 and enforced by
`recordings-size.test.ts`. It counts JSON, documentation and nested files; symbolic links are not
allowed. Raising the cap requires an explicit reviewed change.

## Committed evidence

- `2026-11-19-17-06-49.json`, `2026-11-19-17-08-20.json`, `2026-11-19-17-11-34.json`: the final
  complete 216-turn delivery comparison, old ref `8f3e9d7a`, new/harness `8936a554`. Both sides
  ran fresh with their own shipped default voice. The full unchanged no-regression rule passes;
  see `delivery-comparison.md` for the full table and limitations.
- `grader-corrections.json`: only the five complete historical runs needed to reproduce the
  authorized grader corrections (two read-only Astro searches and three quoted-evidence cases).
  Original traces/verdicts are unchanged. Each entry retains its source recording filename and
  full-file SHA-256, matching the external archive manifest. Tests pin the five expected verdict
  corrections rather than silently rewriting the original scores.

## Superseded full cohorts (outside git)

The shared task workspace retains the earlier full recordings under:

`docs/plans/agent-guidance-slim-2026-11-18/stream-4-1/superseded-recordings/`

This path is relative to the shared task workspace, not this repository checkout. Its
`manifest.json` records every original filename, byte size and SHA-256. All 19 copies were verified
byte-for-byte before removing their repository copies; no branch history was rewritten.
The adjacent task reports retain the original failed comparisons and their diagnoses.

| Archived recording         | Old variant            | New variant         |
| -------------------------- | ---------------------- | ------------------- |
| `2026-11-18-17-29-21.json` | origin/main (7f309fbe) | working tree        |
| `2026-11-18-17-31-48.json` | origin/main (7f309fbe) | working tree        |
| `2026-11-18-17-33-43.json` | origin/main (7f309fbe) | working tree        |
| `2026-11-18-17-36-42.json` | origin/main (7f309fbe) | working tree        |
| `2026-11-19-15-40-30.json` | 8f3e9d7a (8f3e9d7a)    | 9b51d472 (9b51d472) |
| `2026-11-19-15-42-55.json` | 8f3e9d7a (8f3e9d7a)    | 9b51d472 (9b51d472) |
| `2026-11-19-15-46-11.json` | 8f3e9d7a (8f3e9d7a)    | 9b51d472 (9b51d472) |
| `2026-11-19-15-51-55.json` | 8f3e9d7a (8f3e9d7a)    | 4eb4f945 (4eb4f945) |
| `2026-11-19-15-55-03.json` | 8f3e9d7a (8f3e9d7a)    | 4eb4f945 (4eb4f945) |
| `2026-11-19-15-58-20.json` | 8f3e9d7a (8f3e9d7a)    | 4eb4f945 (4eb4f945) |
| `2026-11-19-16-09-54.json` | 8f3e9d7a (8f3e9d7a)    | fb7b125a (fb7b125a) |
| `2026-11-19-16-13-02.json` | 8f3e9d7a (8f3e9d7a)    | fb7b125a (fb7b125a) |
| `2026-11-19-16-16-41.json` | 8f3e9d7a (8f3e9d7a)    | fb7b125a (fb7b125a) |
| `2026-11-19-16-31-32.json` | 8f3e9d7a (8f3e9d7a)    | 4230a5df (4230a5df) |
| `2026-11-19-16-33-45.json` | 8f3e9d7a (8f3e9d7a)    | 4230a5df (4230a5df) |
| `2026-11-19-16-37-16.json` | 8f3e9d7a (8f3e9d7a)    | 4230a5df (4230a5df) |
| `2026-11-19-16-54-11.json` | 8f3e9d7a (8f3e9d7a)    | 59758c68 (59758c68) |
| `2026-11-19-16-56-10.json` | 8f3e9d7a (8f3e9d7a)    | 59758c68 (59758c68) |
| `2026-11-19-16-59-30.json` | 8f3e9d7a (8f3e9d7a)    | 59758c68 (59758c68) |

Pre-voice recordings are historical only. Later failed cohorts exposed contradictory fixture
premises, a real decision regression, and narrow grader/response-routing false positives. The
original failures stay in the archive; no superseded score is mixed into the final acceptance.
The original three-repeat offer-followup batch failed, while its historical ten-repeat rerun was
old 8/10 versus new 8/10 on Opus and old 9/10 versus new 10/10 on Sonnet. That rerun is not
current acceptance evidence.

## Replacing a comparison

Before committing a later area, archive the superseded full cohort in that area’s shared task
workspace and verify its bytes. Retain only the new accepted cohort plus minimal reusable
regression traces; update the cohort-membership test, summary and archive references together.
Do not accumulate every live experiment in git. Preserve failed evidence externally rather than
discarding it or choosing a passing subset.
