# CLI stdout completion diagnosis

## Reproduce offline

Use the repository's `.bun-version` runtime and Python 3, from `apps/cli`:

```sh
bun ../../scripts/test-runner.ts src/stdout-completion.test.ts
```

This directory's `bunfig.toml` avoids the root database preloads. The test starts
an ephemeral loopback HTTP server and runs the **real CLI entrypoint**, argument
parsing, API client, `workstream flow` command and output/exit path. No command or
output modules are mocked in the child. Environment/authentication are synthetic;
no live API, saved credentials or operational payloads are used.

For an offline comparison against another already-available Bun executable:

```sh
FICUS_CLI_TEST_BUN=/absolute/path/to/bun bun test src/stdout-completion.test.ts
```

The override selects only the child runtime; it does not install or change one.
Pipe cases use Python's subprocess OS pipe, forwarding captured bytes unchanged.
Direct `Bun.spawn` stdout capture did **not** reproduce the failure below, so it
would be insufficient regression coverage. The slow reader waits 100 ms, then
reads 1,021 bytes per millisecond. A 10-second producer kill bound and a separate
12-second capture bound prevent indefinite hangs. Files, server and children are
cleaned up on exit. The CI gates lane runs this focused suite with the completion
summary checker.

## Observed crossed matrix (2026-10-29, Linux)

The fixture is deterministic and includes multibyte Unicode, escaped newlines and
text around 64 KiB boundaries. Its compact API response is 336,633 bytes; expected
pretty-printed stdout including its final newline is **336,647 bytes**, SHA-256:

```text
5aafcb11c1c1ea90c9775c2ba0cd477a0588ee4f57d19f82c2521b940858dc00
```

Two CLI artifacts were tested: repository source at
`4bee48ade78086e5d882440a52bcdb8eda0842b2` and an installed bundle identifying itself
as `dev (58ed383, 2026-10-28T21:15:30+00:00)`. Each artifact ran against the same
synthetic endpoint under both runtimes. API responses were written in 8,191-byte
chunks. File, ordinary pipe and throttled pipe captures were checked locally, not
inferred from displayed terminal output. Runtime revisions were
`1.4.2+744846f84` and `1.2.23+cf1367137`; installed bundle SHA-256 was:

```text
35a7cad786158649d1519d91798ea1e0b80d66b01d7ad3ebaaccdb851ae8e9d0
```

| CLI artifact     | Bun    | Regular file | OS pipe   | Slow OS pipe |
| ---------------- | ------ | ------------ | --------- | ------------ |
| Source           | 1.4.2  | Complete     | Complete  | Complete     |
| Installed bundle | 1.4.2  | Complete     | Complete  | Complete     |
| Source           | 1.2.23 | Complete     | Truncated | Truncated    |
| Installed bundle | 1.2.23 | Complete     | Truncated | Truncated    |

Every matrix run exited **0** with **empty stderr**. Complete means exact bytes,
matching SHA-256 and successful JSON parse/equality. The initial crossed matrix's
truncated captures were all 65,536 bytes, invalid JSON, with SHA-256:

```text
f615c43585f0f9fe8845e94710371f2e18c345e2175d785dd8ba36bc70dd3142
```

A regression-suite run also observed a 69,632-byte slow-pipe prefix under 1.2.23;
the truncation length is scheduling-sensitive, not an asserted universal limit.
The suite catches this with exact byte count/hash, not a guessed threshold.
Additional tests cover 26/65,535/65,536/65,537-byte JSON, JSON-over-quiet precedence,
quiet success, and API error stderr/nonzero exit semantics. Final focused
validation under 1.4.2 passed all 148 tests across the completion, output-isolation,
global-option, workflow and workstream test files. Under 1.2.23 the completion
suite deliberately fails 3 of 10 cases (large pipe, large slow pipe and
65,537-byte pipe), demonstrating detection of real production-path truncation.

## Verified boundary versus remaining hypotheses

**Verified:** with these artifacts and fixture, the failure follows the child
runtime and real OS-pipe destination. Changing only 1.2.23 to the repository-pinned
1.4.2 produces complete output. The same API bytes and caller capture produce a
complete regular file; local hashes are computed before any display transport.
This rules out API truncation and display clipping for this synthetic reproduction.

**Not verified:** the exact runtime write/drain/exit mechanism. Asynchronous exit
was an initial hypothesis, not an established cause. We have not traced runtime
internals, established the first fixed Bun release, or proven that every original
operational observation had this same cause. A successful exit alone does not
prove complete output. No PTY measurement was needed for the crossed comparison.

**Remediation gap:** this change adds regression coverage and diagnosis, not a
production CLI rewrite or installed-runtime repair. Output, interactive behavior,
streaming paths and error handling are unchanged. Tests passing under 1.4.2 do
**not** fix an existing 1.2.23 installation. Follow-up runtime alignment must
identify the provisioning path, validate the installed artifact with this
synthetic pipe test and obtain any required rollout authorization separately;
no blanket runtime upgrade is implied.
