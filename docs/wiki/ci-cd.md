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
to tolerate cold caches. The outer backstop leaves room for diagnostics even
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
