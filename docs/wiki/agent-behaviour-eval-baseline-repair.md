# Behaviour eval baseline repair

Harness revision: `2026-11-19-baseline-fixtures-v2`. This is a harness-only correction, not a
guidance comparison. The scenario goals, must flags, step limits and no-regression thresholds are
unchanged. Noah approved the executable/reviewer-flag-scoped requester grader correction on
2026-11-19. No other grader changes are included.

On 2026-11-19, Noah explicitly authorized reduced **offline-only delivery**, while keeping dependent
live guidance comparisons blocked. Review and delivery of these harness fixes therefore do not
claim a passing live baseline or waive the controlled rerun described below.

## Original evidence and classification

Source review: [PR 952 review at 507b01f6](https://github.com/ficushq/ficus/pull/952#pullrequestreview-5979999689).
The retained final delivery cohort compares old guidance
`8f3e9d7abab4ed97fcb7a892964b680e1af60a66` with new guidance/historical harness
`8936a554b947b626e8c619a8861c4d64e4c9517b`. Its verdicts and bytes remain unchanged.
The following indices are zero-based indices into each recording's `runs` array.

| Scenario and original score                       | Classification                                                                               | Trace evidence                                                                                                                                                                                                                                                                                                                                                                     | Repair and remaining limitation                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readable-handoff`, Opus old 2/3, new 0/3         | Fixture contradiction, not demonstrated prose regression.                                    | `2026-11-19-17-11-34.json`, runs 72–77. The notes claim assembler commit `4f1c2ab9`; discovery instead describes a slot retry commit and exposes no assembler artifacts.                                                                                                                                                                                                           | Declare one assembler repository for the handoff: matching title, head, source, test and both callers. Verify missing files and mismatched revisions remain negative cases. A fresh live cohort is required before claiming restored prose signal.                                                                                                                                                                                |
| `ci-failure-rework`, fast old 0/3, new 0/3        | Fixture contamination.                                                                       | `2026-11-19-17-06-49.json`, runs 42–47. All six receive the unrelated slot commit; `find . -name squad-agent-prompt*` produces no assembler paths. Some compound calls return only unrelated discovery instead of the search result.                                                                                                                                               | Declare an assembler repository whose source actually drops the memory section when the map is absent. Read-only discovery can now establish that the failing test belongs to the current head. The tracked rework goal and grader are unchanged. No behavioral failure can be isolated from this cohort.                                                                                                                         |
| `requester-identity`, both tiers old 0/3, new 0/3 | Fixture defects plus grader misclassification; no established identity-selection regression. | `2026-11-19-17-11-34.json`, runs 36–47. All twelve read message metadata containing the correct sender. Eight receive a false creation response to a help request; workflow/repository discovery is incomplete. The old fast repeat 2 grader treats the manager's `--owner` ID as a reviewer; new Opus repeat 1 counts the agent-message lookup ID from the same compound command. | Supply the actual reviewed-coding preset and scoped repository/squad discovery; separate help from creation, and retain consistent created-stream state. The authorized grader inspects executable reviewer assignments, ignores help/quoted prose, distinguishes owner from reviewer, and accepts a subsequent reviewer update only for the identified created stream. None of these historical runs is promoted to a live pass. |
| CLI after-help carrier                            | Help-rendering defect.                                                                       | `tools.ts` used `helpInformation()`, which omits `addHelpText('after', ...)`; the independently reported `POINT_OF_USE_GUIDANCE` regression reproduces offline.                                                                                                                                                                                                                    | Capture real Commander `outputHelp()` output, restore output callbacks and filtered command arrays in `finally`, and retain permission filtering, aliases, options and compound-call help. No unfinished guidance is imported.                                                                                                                                                                                                    |

The original three recordings have these SHA-256 hashes, pinned by `baseline-provenance.test.ts`:

| Recording                  | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `2026-11-19-17-06-49.json` | `df2e0ef4819e790b48320c61c27e1cedfb7701e6f77b01f7e406b7fe8e476a1c` |
| `2026-11-19-17-08-20.json` | `405bd7e11080c468efc9baa520577edc86d54b1dbc1052d07c789834cab238e8` |
| `2026-11-19-17-11-34.json` | `be397bae49ce9d5ddfd81819a6a27c178e28e5b5183e1bb5208390b4f392d9d8` |

Recordings are under `apps/core/src/services/agent-evals/recordings/`. The existing recursive
1 MiB size guard remains enforced. No copies of the old full cohorts are added. See that directory's
README for the external superseded-cohort archive and original provenance.

## Affected contracts

- **Readable handoff:** the requested implementation is already committed and verifiable. The
  agent submits readable step evidence. A refusal caused by genuinely missing artifacts is not
  relabeled as readable evidence or made successful by the fixture.
- **CI rework:** the current completed attempt has a real change-related failure. Verification is
  read-only; rework must precede any edits. A new responder starts with the completed attempt,
  and successful rework creates a distinct running attempt without rewriting the completed one.
- **Requester identity:** the requester is identified from the matching message, not another sender,
  the agent identity, or a CLI credential. The requester must actually be assigned as reviewer.
  Merely mentioning the ID in a description, owner field or quoted command is insufficient.
- **Discovery/help:** only declared repository paths and commands are scripted. Unknown paths and
  revisions do not return artifacts. Unsupported shell requests are explicitly diagnosed rather
  than silently presented as empty success. Help does not mutate fixture state or reveal commands
  withheld by the caller's permission map.

## Offline validation versus live behavior

`baseline-fixtures.test.ts` covers matching and negative artifacts, actual execution of the declared
memory-section source, requester setup/state isolation, and rework state transitions.
`baseline-provenance.test.ts` pins the retained evidence and diagnoses without changing verdicts.
`tools.test.ts` covers after-help content, normal help, aliases, permission filtering, repeated capture
and restoration on exceptions. `evals.test.ts` retains positive/negative grader fixtures and adds
owner-versus-reviewer, quoted/help, and same-stream reviewer-update cases.

Offline passing tests establish consistent premises and discriminating graders, **not a passing live
baseline**. A controlled main-versus-working baseline was attempted on 2026-11-19 using the approved
development credential: all three affected scenarios, default and fast tiers, three repeats per side
(36 planned runs), concurrency 2. The harness was commit `4e900f64`, main was `ae02bb9b`, and static
prompts were unchanged. After reporting 10/36 completed, the provider refused further calls because
the account's specified API usage limit was reached (access resumes 2026-12-01 at 00:00 UTC).
No retry, account substitution or favorable subset was used.

**This cohort is incomplete, not passing evidence.** At the time of that invocation, the CLI persisted
recordings only after all jobs finished, so the interrupted invocation has no persisted traces, verdict table or
recoverable SDK usage total. Its actual cost is therefore unavailable; it is not reported as zero.
The main baseline log is retained outside git in the shared task workspace at
`docs/plans/agent-guidance-slim-2026-11-18/stream-4-harness/main-baseline.log`. There is no new complete
recording to commit or replay. The original cohort bytes remain preserved above.

The requester-identity and CI-tracking guidance comparisons must remain incomplete until the repaired
must scenarios demonstrate live baseline signal. No true behavioral blocker is established by the
contaminated original cohort or the interrupted new attempt; that is not a waiver of the original
zero baselines. Re-run both sides of the same controlled cohort without selecting favorable repeats,
and report model usage and cost separately from product inference accounting.

The CLI now atomically checkpoints completed runs and SDK usage after each job, stops scheduling
on failure, and drains in-flight calls. New recordings distinguish `running`, `partial` and
`complete` cohorts; failed batches cannot produce an accepted comparison. `batch.test.ts` verifies
failure after success, in-flight draining, successful completion and checkpoint-write failure.
This fix does not retroactively recover the lost invocation and has not been re-run live.

Final offline checks: `bun run test src/services/agent-evals` from `apps/core` completed all
116 tests across 10 files with zero failures. The static prompt guard completed 33 tests with zero
failures. Focused ESLint and `git diff --check` passed. Full Core tests/typechecking were not run
locally; they remain CI checks. The focused test database was shut down after each use.

## Static prompt sizes

The harness changes no configured static guidance, includes, roles, overrides or public voice.
`AGENTS.md` only clarifies Noah’s product-inference versus development-eval accounting boundary.
There is no include migration. Measured against the stacked implementation base `1ca76e47`, composed static
UTF-8 bytes are identical before and after (runner sections and tools are excluded):

| Built-in type            | Before |  After |
| ------------------------ | -----: | -----: |
| architect                | 40,090 | 40,090 |
| artifact-builder-default |  9,125 |  9,125 |
| assistant-worker         | 20,831 | 20,831 |
| assistant                |  7,444 |  7,444 |
| consultant               | 50,291 | 50,291 |
| engineer                 | 38,974 | 38,974 |
| general                  | 34,680 | 34,680 |
| manager                  | 69,366 | 69,366 |
| reviewer                 | 42,590 | 42,590 |
| security-auditor         | 39,862 | 39,862 |
| subagent                 |  5,716 |  5,716 |
| sysops                   | 40,852 | 40,852 |
| system-manager           | 21,738 | 21,738 |
