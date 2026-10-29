# VM host Bun convergence

> Implementation checkpoint: pins, atomic disk convergence, offline preview and
> installed-layout compatibility validation are implemented. Scoped graceful box
> adoption is a required prerequisite still being integrated; this checkpoint is
> **not rollout-ready**. No existing fleet update is claimed.

## Pin and delivery contract

`.bun-version` is the desired version (currently **1.4.2**). The machine image
COPYs that file and derives both install and image-marker values from it; there
is no overridable Bun build ARG. The standalone `scripts/machine/bootstrap.sh`
keeps an equal literal, enforced by `host-bun.test.ts`: bootstrap is streamed
without a checkout and shipped verbatim in immutable release `machine/` assets,
so reading a relative `.bun-version` on the destination is not portable.

The host stable executable is `/opt/ficus/bin/bun`, linked to
`/opt/ficus/bun/bin/bun`. Both the installed CLI wrapper and box server units use
it. Normal machine bootstrap hash drift delivers the effective release scripts;
artifact delivery separately supplies the CLI, server and provision script.
Prebaked marker presence still skips apt/nix/devbox/browser installs, **not** the
Bun version check. No baked nix/devbox upgrade is attempted.

## Atomic replacement, partial failure and rollback

`install_bun` takes `/opt/ficus/bun-install.lock` with a bounded 120-second flock
and rechecks the actual executable under that lock. Unexpected symlinked install
directories/lock are refused. Downloads go to a unique stage under `/opt/ficus`,
not the running executable. Installer execution is bounded (180 seconds plus a
10-second kill grace), and a candidate must report exactly the desired version.
The stable executable is replaced with a same-filesystem rename, never truncated
in place: existing processes keep their executable inode. The previous executable
is retained as `/opt/ficus/bun/bin/bun.previous` before the switch.

- Download, staging, candidate/version or backup failure: old executable stays.
- Post-switch version or link-publication failure: restore the previous inode;
  bootstrap fails and must not stamp a successful upgrade. Failed rollback is
  explicit and retains `.previous` for operator recovery.
- Success: stable path reports the pin; old processes may still use the old inode.
- A retry rechecks the actual version under lock and does not download again
  when current. Normal exit cleans its stage. SIGKILL/power loss may leave a
  uniquely named `.bun-stage.*` directory; it cannot become a partial executable.
  Any later cleanup must be ownership-checked and authorized, not a broad sweep.
- A crash after atomic publication leaves a checked executable and its backup;
  an unstamped bootstrap may be retried normally. Never blindly replay an SSH
  invocation whose remote outcome is uncertain: first reconcile its owner/state.

Rollback is a **separate live mutation**, not authorized by this guide. An
operator must pause the rollout, obtain the same authorization/capacity as an
upgrade, verify the retained executable/version and matching release identity,
and restore it atomically under the same lock. Preserve the backup until
readback succeeds. Running processes still require normal idle reconciliation
to adopt a rollback; changing disk alone is neither upgrade nor rollback proof
for an already-running server. Do not reinstall nix or delete `/nix`.

## Box adoption safety (required integration)

Disk publication deliberately does not issue systemctl restarts. Adoption must
use normal provisioning/reconciliation and the canonical release runtime
identity, retaining the owning lifecycle generation, setup leases, provision
coalescing, limits and uncertain remote-invocation barriers. Active/unknown work
and pending invocations must defer adoption; no success stamp may hide deferred
work. Canonical trusted restart context and cancel-before-disconnect must be
reused, scoped to the affected box: **never use a process-wide command drain for
one box**. Other boxes and Core's global shutdown semantics must be unaffected.
A real process/client/registry/tool proof is required before rollout readiness;
a clean executor SIGTERM/exit alone does not establish an agent-visible normal
restart.

## Offline preview — safe to run now

From the repository root:

```sh
bun scripts/machine/preview-bun-convergence.ts \
  --inventory docs/wiki/machines/examples/bun-inventory.json
```

The supplied example is synthetic. This command reads only the supplied JSON and
repository pin, writes JSON to stdout, and never imports Core, invokes SSH,
curl, sudo, systemctl, Docker or any installer. It does not read live host state,
execute binaries from a host root, mutate metadata, download or restart anything.
It is a plan based on supplied observations, **not a live safety check**.

Inventory schema: `hosts[]` each has `id`, `prebaked` (boolean), `bunVersion`
(exact version or null), and `boxes[]`. Each box requires `id`,
`runningBunVersion` (exact version or null), `work` (`idle`, `active`, `unknown`),
`pendingInvocation` (boolean), `lifecycleGeneration` (string or null). Incomplete
metadata is rejected; unknown version/work/generation never invents safe adoption.
Do not include credentials, tokens or customer content.

Output separates `disk` (`current`, `replace-bun-only`, `inspect-version-first`)
from each box's `adoption` (`current`, `idle-normal-reconcile`, `defer-active`,
`defer-uncertain`) and preserves generation. `mutation` is always false. Example:
old synthetic prebaked host → disk replacement planned; idle box → normal
reconcile; active box → defer; uncertain invocation → defer. Tests run with
forbidden command sentinels and verify byte/mtime/directory snapshots unchanged.

## Future gated rollout — NOT performed by this change

1. Finish scoped adoption integration and its real-path agent restart proof;
   independently review code, require exact-head approval and applicable green
   CI, then merge under normal repository rules. A merged code PR does not
   establish fleet adoption.
2. Before **any** live rollout, ask Noah a **blocking** question describing the
   exact release, targets, effects, validation and rollback. Obtain applicable
   explicit production authorization and production-change capacity as well.
   Review approval, an old diagnostic or this guide is not live authority.
3. Under that later authorization, rebuild `ghcr.io/ficushq/ficus-machine` from
   repository root with `packages/machine-image/Dockerfile` for `linux/amd64`.
   Follow `packages/machine-image/README.md` and the normal image publishing
   pipeline; use an immutable approved tag/digest for the canary. Do not trigger
   workflow_dispatch, publish an ad-hoc image or change package visibility as
   part of this source-only task. A new image affects new VMs, not existing ones.
4. Reconcile one approved canary through normal claimed machine bootstrap and
   idle box provisioning, including a host with an older prebaked marker.
   Verify the actual disk version, stable CLI wrapper output completion, live
   server executable/version and health, owning generation and agent-visible
   normal restart. Verify unrelated active work continues; deferred/unknown
   boxes remain explicitly pending, never counted as updated.
5. Expand only within the approved target/rate bounds after canary evidence.
   Stop on version/health/adoption/attribution failures or ambiguous remote work;
   preserve leases/journals and reconcile evidence before retrying. Rollback
   requires its own approved matching release/runtime identity and idle adoption.

No machine image was built/pushed, no live host was contacted or modified, and no
running installation or real box server was restarted for this implementation.

## Local verification

Claim required native test capacity first where applicable, use Bun from
`.bun-version`, and clean up the project's test DB afterward:

```sh
cd apps/core
bun test src/services/machines/host-bun.test.ts \
  src/services/machines/host-bun-preview.test.ts
bun test src/services/machines/installed-machine-bundles.test.ts
cd ../..
bun run test:db:down
```

The installed-layout harness builds the **real release machine bundles**, copies
Bun into a test-owned temporary `opt/ficus/bun/bin`, recreates the production
stable link and CLI wrapper (only its root is relocated), and runs PR 765's ten
stdout-completion cases through that wrapper. A counter proves each child used
the installed wrapper, not source. The package suite uses the installed Bun and
server bundle/native library; source-inventory assertions remain source checks.
An unavailable entrypoint negative control prevents silently testing source.
Every fixture is removed; no actual `/opt` is used. Full Core tests/typecheck
are not run locally.

### Requirement trace and checkpoint evidence

| Binding requirement                                                                                                                         | Implementation / validation                                                                                                                                                                  | Checkpoint status                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Bootstrap and machine image install exactly `.bun-version`; prefer derivation, correct stale comment                                        | Image derives from copied pin; standalone literal rationale above; source contract tests                                                                                                     | Implemented                                                     |
| Regression fails if either host pin differs from repo pin, following Docker source-contract style                                           | `host-bun.test.ts` reads repository sources independently; RED observed on both original 1.2.23 sites                                                                                        | Implemented                                                     |
| Existing hosts, including prebaked skips, actually converge via safe Bun replacement **and normal server adoption**; document image rebuild | Atomic fixture tests, rollback/lock/idempotence tests, offline preview and gated image instructions; scoped runtime adoption integration remains required                                    | **Incomplete** until adoption integration                       |
| Run sandbox-server suite and PR 765 stdout cases on 1.4.2 installed layout; prove agents see normal graceful restart                        | Real machine-bundle layout: 394 package tests across 23 files, zero skips/failures; ten CLI stdout cases via counted installed wrapper; canonical scoped restart/tool proof remains required | Compatibility validated; **graceful adoption proof incomplete** |
| Audit other host-installed runtime pin drift, list in PR, fix only Bun                                                                      | Source audit below; other pins/tool behavior unchanged                                                                                                                                       | Audited; carry findings into PR                                 |

Checkpoint validation on Bun 1.4.2: 12 host Bun/atomic fixture tests and two
preview tests passed; two installed-layout orchestration tests passed (their
394 package tests and ten CLI cases are nested verification, **not additional
independent orchestration tests**). Existing `bootstrap.test.ts` passed 134 tests
with one unrelated nft syntax-validation capability skip; that skip is not Bun
convergence evidence. Focused ESLint, outer/embedded shellcheck, `bash -n` and
`git diff --check` passed. No full Core test suite/typecheck, image build or live
operation was run. These are checkpoint results, not final scoped-restart proof.

## Source-only other-runtime audit (Bun only is changed)

| Host install                     | Repository comparison                                                                               | Finding                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nix 2.24.9                       | Bootstrap and machine-image both 2.24.9                                                             | Aligned with each other; no separate repo-wide Nix engine pin found. Nixpkgs refs select package versions, not the host Nix installer.                 |
| Devbox 0.14.0                    | Machine image 0.14.0; devbox-seed, managed toolchain and both sandbox devbox schema URLs use 0.14.0 | No source pin drift. Schema version is not a claim about live installed version.                                                                       |
| Playwright 1.58.2 / its Chromium | Bootstrap, machine image and Docker sandbox pin 1.58.2                                              | Aligned. Old bootstrap comment suggesting Core depends on Playwright is stale; Core no longer has that dependency. No Playwright/runtime changes here. |
| Docker/containerd and apt tools  | Host apt repository packages are unversioned; no common exact host runtime pin                      | Not comparable to an exact repository pin; no drift assertion or fix.                                                                                  |
| Node/Python/comfort tools        | Not installed by host bootstrap; per-box devbox packages are separate                               | Outside this host-runtime comparison. No changes.                                                                                                      |

This audit compares checked-in sources only; no live fleet versions were queried.
