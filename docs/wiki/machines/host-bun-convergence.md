# VM host Bun convergence

> Source implementation and local validation only. Adoption is **eventual**,
> after natural idle exit and normal ensure, not immediate fleet convergence.
> Active, pending and unknown boxes remain deferred. No fleet update or live
> rollout has been performed or authorized.

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

## Eventual box adoption through normal reconciliation

Disk publication deliberately does not restart services. The effective release's
bootstrap Bun pin participates in the provision identity alongside the effective
box-provision script. A pin change therefore reaches ordinary spec reconciliation
for existing boxes; the release's immutable assets are the source in artifact
installs, not a checkout-relative `.bun-version` read.

A running older executor cannot prove a newly introduced maintenance protocol.
An unsupported endpoint or database idleness is **not** permission to force its
restart. Normal ensure/recreate instead:

1. Defers while execution/deployment activity, a pending/ambiguous setup invocation,
   unavailable activity information, or an active/unknown server remains. It keeps
   the old published spec/setup identity and reusable client. Repeated reconciliation
   does not HTTP-poll the old executor, which would reset its idle-exit window.
2. Lets the existing executor's conservative idle policy finish commands and stand
   down naturally. A read-only host probe requires an inactive server and proxy,
   active activation socket, exact current disk Bun, no pending server/proxy systemd jobs, and
   no unresolved registry/active/quarantine entries. Read errors, symlinks and unknown
   results defer; no guessed success stamp is written.
3. Under the existing owning setup lease/provision coalescer and box-scoped command
   admission fence, rechecks the proof, takes the existing host flock, stops **only
   the socket**, and rechecks inactivity/registry/jobs. A connection that overtook
   socket closure causes backoff and listener restoration, never a server kill.
4. Keeps socket activation closed through normal provisioning and `server.env`
   publication (`--defer-socket-start`). It starts the replacement service before
   reopening the listener, verifies the actual running `Bun.version` over health,
   and only then publishes the new provision/spec stamp. Listener restoration runs
   on both success and failure; an uncertain SSH result must not be mistaken for
   a successful claim. The owning lifecycle generation is retained.

This is not an immediate fleet-wide restart. Always-active boxes, unresolved work,
failed/unknown units and boxes without a proven socket-activated idle path stay
pending for later reconciliation or separately authorized investigation. No remote
maintenance endpoint or unsafe legacy fallback is introduced here.

The selected box's admission fence reuses canonical trusted restart attribution
and cancellation-before-disconnect; failed cancellation prevents replacement.
It does not use process-wide `drainCommands()` or stop unrelated boxes. A command
that races admission sees a normal restart notice, not a recovery failure.
Normally active legacy commands finish before natural idle exit; the independent
real-server restart proof also checks durable cancellation context, agent-visible
notice, zero failure-budget charge, no human wait, inspected partial effects and
explicit safe retry. This does not claim arbitrary model retry behavior.

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
from each box's `adoption` (`current`, `await-natural-idle-exit-then-normal-ensure`, `defer-active`,
`defer-uncertain`) and preserves generation. `mutation` is always false and `convergence` is `eventual-idle-adoption`. Example:
old synthetic prebaked host → disk replacement planned; idle box → normal
reconcile; active box → defer; uncertain invocation → defer. Tests run with
forbidden command sentinels and verify byte/mtime/directory snapshots unchanged.

## Future gated rollout — NOT performed by this change

1. Independently review the code and local installed-layout evidence, require
   exact-head approval and applicable green CI, then merge under normal rules. A merged code PR does not
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
# For the full legacy proof, supply owned Bun 1.2.23 and an older server bundle.
FICUS_TEST_LEGACY_BUN=/owned/fixtures/bun-1.2.23 \
FICUS_TEST_LEGACY_SERVER_ENTRY=/owned/fixtures/older-server.js \
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

### Requirement trace and local evidence

| Binding requirement                                                               | Implementation / validation                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact repo Bun in bootstrap and machine image                                     | Image derives from copied pin; portable bootstrap literal rationale above; independent source contract tests                                                        |
| Regression catches either host pin drifting                                       | `host-bun.test.ts` reads repository sources independently; RED observed on both original 1.2.23 sites                                                               |
| Existing/prebaked hosts converge safely through normal server adoption            | Atomic installer/rollback/lock/idempotence fixtures; runtime identity, non-waking deferral, socket claim and normal provision/start; gated image instructions       |
| Installed-layout package/stdout compatibility and agent-visible graceful behavior | Full sandbox-server suite, ten counted-wrapper CLI cases, real older/current bundle natural-exit adoption, real installed-server scoped restart/tool/recovery proof |
| Audit other runtimes; change only Bun                                             | Source findings below; carry these findings into the PR                                                                                                             |

Local validation used Bun 1.4.2 and **four** installed-layout orchestration tests.
Their nested checks are not additional independent orchestration tests: the full
sandbox-server suite (398 tests / 23 files, no skips/failures), ten CLI stdout cases, one
legacy adoption proof and one scoped graceful restart proof. The legacy proof
used Bun **1.2.23** with a bundle built from repository revision
`2cf7635fb59165477549306cdf83d720b4c46c74`, before these changes, with no maintenance
endpoint. The historical bundle is copied into the owned installed layout; the
replacement uses the newly built release bundle and 1.4.2. It proves repeated
polling does not wake the old server, active commands finish, unknown persisted
work defers after exit, normal ensure adopts, generation is preserved, and another
real executor stays uninterrupted. Host/systemd/tunnel/persistence seams are
fixtures; Bash/HTTP/registry/idle-exit/executables are real. Without the two legacy
fixture inputs, the test remains a current-runtime compatibility regression, not
proof of a historical runtime upgrade.

Focused tests cover installer/source contracts, offline non-mutation, admission,
setup/generation barriers and runtime readback. Existing bootstrap tests retain
one unrelated nft syntax-validation capability skip; that skip is not Bun
convergence evidence. The sandbox-server package typecheck and focused lint/shell
checks pass. Full Core tests/typecheck are left to CI; no image build or live
operation was run.

## Source-only other-runtime audit (Bun only is changed)

| Host install                     | Repository comparison                                                                               | Finding                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nix 2.24.9                       | Bootstrap and machine-image both 2.24.9                                                             | Aligned with each other; no separate repo-wide Nix engine pin found. Nixpkgs refs select package versions, not the host Nix installer.                 |
| Devbox 0.14.0                    | Machine image 0.14.0; devbox-seed, managed toolchain and both sandbox devbox schema URLs use 0.14.0 | No source pin drift. Schema version is not a claim about live installed version.                                                                       |
| Playwright 1.58.2 / its Chromium | Bootstrap, machine image and Docker sandbox pin 1.58.2                                              | Aligned. Old bootstrap comment suggesting Core depends on Playwright is stale; Core no longer has that dependency. No Playwright/runtime changes here. |
| Docker/containerd and apt tools  | Host apt repository packages are unversioned; no common exact host runtime pin                      | Not comparable to an exact repository pin; no drift assertion or fix.                                                                                  |
| Node/Python/comfort tools        | Not installed by host bootstrap; per-box devbox packages are separate                               | Outside this host-runtime comparison. No changes.                                                                                                      |

This audit compares checked-in sources only; no live fleet versions were queried.
