# CI and releases

Ficus uses GitHub Actions to validate changes and publish distributable artifacts.
The workflows in [`.github/workflows`](../../.github/workflows) are authoritative.

## Pull-request checks

[Core CI](../../.github/workflows/ci.yml) runs typechecks, lint, builds, package
tests, subprocess and restart checks, and setup/updater verification. Native
macOS portability coverage is selected by the changed paths. Test completion
guards require every expected lane and test file to finish successfully.

The [CLA workflow](../../.github/workflows/cla.yml) checks contributor agreements.
See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the signing process.

Build, test, lint and documentation jobs run on `pull_request` with read-only
repository permissions and no stored secrets. The setup/update fixture uses the
automatically issued, read-only `github.token`; contributors do not configure a
personal token or production credentials. First-time contributors may need a
maintainer to approve the workflow run in GitHub.

CLA automation runs separately on trusted base-branch code, with a pinned bot
implementation. It never checks out the contributor's code with its registry
credential. Release jobs run on main pushes, version tags or manual dispatch,
and use GitHub's automatic token to publish; PR jobs do not publish releases or
container images. The unsigned Core build is retained as a workflow artifact.

Linux jobs run on GitHub-hosted Ubuntu 24.04 runners; native portability
tests remain on macOS. Runner selection does not change required checks, tests
or completion guards.

Run `bun typecheck` and the relevant package test entrypoints before opening a
pull request. See [development](development.md) for local commands and isolated
test databases.

## Rendered web checks

The browser checks in `apps/web/scripts/check-*.ts` render real web and farm
components with the real stylesheet and made-up data in headless Chromium, with
no database or backend. They catch what unit tests in jsdom cannot: layout,
wording on the rendered page, motion and theme contrast. CI runs them in three
jobs:

- `Plan rendered web checks` (`bun .github/rendered-checks-gate.ts plan`) diffs
  the event's range the same way the macOS gate does and picks the checks the
  change touches. Each check is listed in
  [`apps/web/scripts/rendered-checks.ts`](../../apps/web/scripts/rendered-checks.ts)
  with its fixture page. What it covers is computed rather than listed by hand:
  every file the check and its fixture import, followed through `apps/web`,
  `apps/farm` and the workspace packages' sources, stylesheets included (Bun's
  bundler reads the graph in about five seconds for all checks). A changed
  component, CSS file or piece of wording therefore selects every check that
  renders it, and a new import is covered as soon as it is added. A few paths no
  import graph shows run every check: the runner, the mapping, the shared
  fixture server, `ci.yml`, the lockfile and package manifests (including the
  `playwright-core` pin in `apps/core/package.json`) and the web build
  configuration. The nightly schedule runs every check. When the range or the
  graph cannot be read, the plan fails closed and runs every check.
- `rendered checks (shard N of M)` installs the headless Chromium that matches
  the locked `playwright-core` (`--with-deps`, so its fonts and libraries come
  with it) and runs its share with `bun scripts/run-rendered-checks.ts`. The
  plan balances the checks into at most five shards of about five minutes each,
  using each check's measured `seconds` in the mapping. Within a shard the checks run one at
  a time, because they share Vite's dependency cache and measure layout and
  motion that a busy machine would skew. Each check runs in its own process
  group and is killed with its browser after ten minutes; a failure, a timeout
  or a crash fails the shard, and the other shards still finish
  (`fail-fast: false`).
- `rendered checks` is the verdict. It passes when the plan succeeded and
  selected nothing, or when every shard succeeded. A selected shard that was
  skipped or cancelled fails it. The required `test` check depends on it, like
  the other test lanes, so a broken rendered check blocks the merge.

Before it became required, every check ran four times on CI runners (140 runs,
no failure; the slowest check took 136 seconds against its 600-second cap). A
check that turns out flaky should be fixed, not retried in a loop: the runner
deliberately has no retry.

Every check together takes about 16 minutes on a runner, which the plan splits
into four shards of about four minutes, plus under a minute of installs each:
about 21 job-minutes, and about five minutes of wall clock in parallel with the
other lanes. A pull request runs only what it touches. Replayed over the 150
merges to `main` before this was added, a third selected no check, and the
average was about 9 check-minutes (about 12 job-minutes with installs), mostly
because a change to `packages/shared` or a shared stylesheet reaches nearly
every page.

`test / gates` runs `apps/web/scripts/rendered-checks.test.ts`, which fails
when a `check-*.ts` file is missing from the mapping, a mapped script no longer
exists, or an entry names a fixture its script does not load. A new check needs
only its entry; its covered paths follow from its imports.

Run them locally from `apps/web` (set `CHROMIUM_PATH` when Playwright's own
Chromium is not installed):

```bash
bun scripts/run-rendered-checks.ts --changed origin/main --list   # what CI would select
bun scripts/run-rendered-checks.ts --changed origin/main          # run those
bun scripts/run-rendered-checks.ts check-squad-cards.ts           # named checks
bun scripts/run-rendered-checks.ts                                # every check
```

Each check also runs on its own (`bun scripts/check-<name>.ts`); `SCREENSHOT_DIR`
saves its screenshots when a CI failure needs a closer look.

## Dependency installation

Jobs run `bun install --frozen-lockfile` with no dependency cache. Do not add
`actions/cache` for `~/.bun/install/cache` or `node_modules` without measuring
both paths on the runner first.

The workflows used to cache `~/.bun/install/cache` with a `bun-<os>-` prefix
fallback. Each lockfile change restored the previous cache and saved a
superset, so packages that left the lockfile stayed in the cache. Bun stores
packages unpacked, and every `@anthropic-ai/claude-agent-sdk` bump alone adds
about 700 MB (its glibc and musl Linux binaries). By November 2026 the
compressed entry was about 2.4 GB. A cold cache for the same lockfile is about
2.3 GB on disk and about 510 MB compressed.

Measured over 40 main and pull-request runs before the change, restoring that
cache took 38 to 50 seconds at the median per job (p90 up to 61 seconds), plus
up to 26 seconds to save it after a lockfile change. The 1-minute step limit
in `subprocess-shards` timed out on 6 of 72 shard runs, and those shards never
ran their tests. The uncached `Managed BigBrain Linux containment` job ran the
same full install in 6 seconds at the median (15 seconds at most), and the
cached jobs still spent 1 to 5 seconds in `bun install` after the restore.
Without a cache step, there is no restore that can time out, the repository's
Actions cache quota is not filled by dependency trees, and a real install
failure still fails the job.

## Real-subprocess lane

`subprocess-tests` remains the required, fail-closed aggregate check. It depends
on both `subprocess-shards` matrix jobs (`1` and `2`); failure, cancellation or a
skipped matrix blocks it. Matrix fail-fast is disabled so one shard cannot hide
the other's diagnostics. No branch-protection check rename is needed.

The file list in the workflow's **Run real-subprocess tests** step remains the
canonical subprocess inventory. `scripts/run-core-tests.ts` adds every Core
`mock.module` test to the isolated inventory, then partitions that entire list
into two disjoint file lists. The four long-running files are paired across
shards; all other files are assigned alternately in sorted order, including new
files. Membership, completion and plan gates prove that no file is omitted or
duplicated. Every file still runs in a fresh Bun process, sequentially within
its shard, with the existing schema cache and completion assertions.

The target is **under 10 minutes per shard**, measured from job start through
setup, checkout, dependency installation, tests and reporting/post actions, not
summed test-body durations. Provider queue time is excluded. The first step
starts a lane clock; an absolute **540-second** deadline stops test execution,
allows the existing **20-second** TERM-to-KILL cleanup grace, and leaves time
for reports before the target. The 20-minute job timeout is only a hang
backstop, not a performance allowance: the final wall-time check still fails at
600 seconds. Setup steps are individually bounded (at most 16 minutes combined),
with 3 minutes for full-history checkout and 4 minutes for dependency installation
to tolerate a slow package registry. The outer backstop leaves room for diagnostics even
if setup consumes all those hang limits; an already-expired deadline starts no
tests and fails with inventory diagnostics rather than waiting for cancellation.

On success and failure, logs and the Actions job summary contain all selected
files sorted by measured wall duration, with `PASSED`, `FAILED`, `INCOMPLETE`
(interrupted), or `UNSTARTED` status. Deadline expiry is always a failure, even
if a child handles TERM and exits cleanly. A setup failure reports unstarted
inventory when checkout and Bun are available. The final reporting step checks
the 600-second target; use the Actions job start/completion timestamps for the
full duration including post actions. A passing test runner alone is not proof
that the end-to-end target was met.

For inventory inspection without starting a database:

```sh
bun scripts/run-core-tests.ts --subprocess --subprocess-shard 1/2 --list
bun scripts/run-core-tests.ts --subprocess --subprocess-shard 2/2 --list
```

Omitting `--subprocess-shard` keeps the full local isolated lane. Sharding is
accepted only with `--subprocess`, and explicit paths must still match the
entire canonical subprocess inventory before partitioning.

## CLI binaries

[CLI Binaries](../../.github/workflows/cli-binaries.yml) builds archives for Linux
and macOS on x64 and arm64, plus Windows x64. It publishes the archives, manifest,
and installer scripts to GitHub Releases. Main builds update `nightly`; version
tags identify versioned releases.

The workflow publishes release assets without requiring SSH access to a host.
Each manifest records the source commit so installed binaries can be identified.

## Machine image

[Publish Images](../../.github/workflows/publish-images.yml) publishes
`ghcr.io/ficushq/ficus-machine` for exe.dev machine provisioning. Main builds are
selected by image-source changes; version tags and manual dispatch build the
image explicitly.

See [the machine image README](../../packages/machine-image/README.md) for local
build commands and [machine upgrades](machines/upgrading.md) for running hosts.
DigitalOcean and other Ubuntu hosts use the setup/bootstrap scripts.

## Self-hosted builds and updates

Use [the setup toolkit](setup.md) to provision a host, or [local mode](../../apps/cli/README.md)
to run Ficus on your own computer. The root [Dockerfile](../../Dockerfile) builds
an image containing Core, the CLI, web assets and embedded documentation.

For existing installations, use the updater appropriate to the installation
method. Deployment credentials belong to the operator's environment; they are
not needed to run the normal source validation checks.
