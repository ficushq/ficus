# VM host Bun convergence

> Source implementation and local validation only. **Bun-only** adoption is
> eventual, after natural idle exit and normal ensure, not immediate fleet
> convergence. Active, pending and unknown Bun-only cases remain deferred. No fleet update or live
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
- Post-switch version or link-publication failure: restore the previous inode.
  Failed rollback is fatal and retains `.previous` for operator recovery.
- On a prebaked host, download, installer, lock or staging failure (or failed
  replacement with a verified successful rollback) is non-fatal **only when the
  old executable/link still prove usable**.
  It warns and reports `bunConvergence: deferred`; the manifest records actual
  Bun, and Core keeps the machine ready **without acknowledging the desired
  bootstrap hash**. `appliedBootstrapVersion` separately records that the release
  scripts were applied, so a deferred Bun swap is not misclassified as a layout
  migration by the maintenance reprovision operator. Actual layout/journal
  preflight still runs. A later normal stale/bootstrap pass retries. This is not a
  tight retry loop or a convergence success. Missing/unusable Bun, unsafe layout
  and failed rollback remain fatal; explicit interruption is not swallowed. A transient download outage must not remove
  a working prebaked host from the fleet.
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
Bun pin has a **separate identity** from the base bundle/role/squad/provision-script
digest and owning generation. A dot-free `:bun:1_4_2` suffix keeps provisioning
marker parsing unambiguous. Immutable release assets supply the pin in artifact
installs, not a checkout-relative `.bun-version` read.

Only a Bun-only change (including a legacy unknown-pin row whose base identity
matches) takes the natural-idle path below. Bundle, role, script, generation,
mixed and other non-Bun drift retain the established park-and-re-ensure lifecycle
and its ownership, stop-verification and trusted restart safeguards. They do not
wait for a Bun bootstrap sweep. Ordinary `ensuring`, `failed` and `restart_failed`
rows keep normal repair/retry behavior; only a row with recorded Bun adoption
intent runs journal recovery. Ordinary contention retains the existing
`box_lock_timeout` classification and retry budget.

New boxes, parked resumes and ordinary repairs also remain usable on hosts whose
disk Bun has not yet been upgraded. Exact runtime readback is mandatory **only
for verified Bun adoption**. An ordinary start records the observed Bun (or an
unknown-pin base identity for older bundles), not the desired pin; it therefore
remains eligible for later Bun adoption. Configuration publication alone is not
runtime convergence proof. In particular, a later explicit idle adoption bypasses
configuration-only fast paths, even when the desired configuration was already
installed on an older runtime.

Healthy ready boxes retain the Bun-agnostic fast path: observed runtime drift
alone does not take a setup lease, run recovery/idle SSH, fence commands or emit a
restart notice. Existing setup fingerprints remain valid while the runtime is
deferred; no bulk fingerprint migration is required. Bootstrap's verified
`bunVersion` capability disqualifies older/unknown disk runtimes before a remote
idle probe. It is eligibility, not safety proof: the final claim still checks
actual disk, units, registry and ownership.

Deferring a runtime restart **does not defer configuration or setup**. Required
asset freshness/revocation checks and due/degraded setup retries still run under
the normal owner. File-managed SSH revocations and rendered secret rotation can
apply while old commands continue. Critical server environment changes retain
ordinary reconciliation and restart safeguards; git-identity-only changes retain
their existing active-work deferral. Pending/ambiguous remote setup is never
cancelled or replayed merely for Bun adoption: it reports readiness pending with
the usable existing client retained.

A running older executor cannot prove a newly introduced maintenance protocol.
An unsupported endpoint or database idleness is **not** permission to force its
restart. Normal ensure/recreate instead:

1. Defers while execution/deployment activity, a pending/ambiguous setup invocation,
   unavailable activity information, or an active/unknown server remains. It keeps
   the observed runtime identity and usable normal client state, including
   a fresh Core manager. The installed historical proof keeps the original Bash
   alive while that fresh manager runs a real HTTP tool with its callback URL.
   Required assets/setup still reconcile. Unchanged repeated reconciliation
   does not HTTP-poll the old executor, which would reset its idle-exit window.
2. Lets the existing executor's conservative idle policy finish commands and stand
   down naturally. A read-only host probe requires an inactive server and proxy,
   active activation socket, exact current disk Bun, no pending server/proxy systemd jobs, and
   no unresolved registry/active/quarantine entries. Read errors, symlinks and unknown
   results defer; no guessed success stamp is written.
3. Under the existing owning setup lease/provision coalescer, takes the box-scoped
   admission fence **before** final idle proof. Existing tracked work immediately
   defers adoption: this path neither waits for nor cancels it. It rechecks proof, takes the existing host flock, stops **only
   the socket**, and rechecks inactivity/registry/jobs. A connection that overtook
   socket closure causes backoff and listener restoration, never a server kill.
4. Keeps socket activation closed through normal provisioning and `server.env`
   publication (`--defer-socket-start`). It starts the replacement service before
   reopening the listener, verifies the actual running `Bun.version` over health,
   and only then publishes the new provision/spec stamp. Listener restoration runs
   on both success and failure; an uncertain SSH result must not be mistaken for
   a successful claim. The owning lifecycle generation is retained.

### Interrupted claim recovery

Before the first claim/socket mutation, the owning Core persists the adopting
marker. Before closing activation, it atomically publishes a root-owned journal
beside the stable host flock in `/run/ficus-box-locks`. It records a unique claim
token and exact source/desired row identities (machine, sandbox and spec including
owning generation). The next **owner of the existing durable setup lease** can
recover that interrupted claim, even if the previous Core was killed and no
JavaScript `finally` ran. A non-owning poll never restores a listener.

Recovery waits for the same host flock (including an outstanding provision/env/
start command), checks the journal against the current row and compares the
observed token again under the lock before restoring **only the socket**. It
then removes only that journal. It never stops a server or replays an uncertain
agent Bash invocation. Active/pending/unknown work still defers adoption after
listener reachability is restored. A Bun operation records its desired target in
`bun_runtime_adopting_spec_hash` before claiming activation, independently of
ordinary `ensuring` rows. After interruption it retains the stronger fenced host
proof; its own active startup execution does not prevent repair once actual host
idleness is proven. Active/unknown remote work or pending setup remains
readiness-pending, not successfully adopted. Only proven claim/listener cleanup
clears the in-progress marker; a ready row with unresolved intent projects
readiness pending. Successful recovery clears ready-row intent with a
physical-identity/target fence; partial rows still need final idle proof. Malformed, symlinked, changed-generation or overtaken
journals defer; late cleanup cannot reopen another owner's listener or erase its
journal. Failed restoration retains recovery evidence for the next owned ensure.
Existing setup-session ownership checks fence continuation and ready publication.

This recovery/adoption path is for the same recorded host. An unavailable-host
replacement or authorized explicit move retains the existing migration/rebind
path and its stop/ownership checks; the old box is never probed on a new host.

This is not an immediate fleet-wide Bun restart. Always-active Bun-only cases,
unresolved work, failed/unknown units and boxes without a proven socket-activated
idle path stay pending for later reconciliation or separately authorized investigation. No remote
maintenance endpoint or unsafe legacy fallback is introduced here.

Bun-only admission reuses canonical trusted restart attribution but **never
cancels** existing work. Ordinary recreation/shutdown retain their separate
cancellation-before-disconnect behavior; failed cancellation prevents replacement.
Neither box-scoped path uses process-wide `drainCommands()` or stops unrelated
boxes. A command racing admission sees a normal restart notice, not a recovery failure.
Normally active legacy commands finish before natural idle exit; the independent
real-server restart proof also checks durable cancellation context, agent-visible
notice, zero failure-budget charge, no human wait, inspected partial effects and
explicit safe retry. This does not claim arbitrary model retry behavior.

### Bounded adoption failure without an availability outage

A healthy HTTP response with a wrong/missing Bun version is a failed **adoption**,
not a successful convergence stamp or proof of a broken executor. The ordinary
current-runtime endpoint stays usable; its observed version (or unknown-pin base)
is retained. `bun_runtime_failure_spec_hash` durably bounds further adoption for
that exact desired spec/generation across Core restarts, ensure and recreate.
Normal starts/resumes/repairs remain Bun-agnostic and preserve the bound unless a
genuinely changed target or verified matching runtime supersedes it.

The verified healthy mismatch and ready/config/runtime metadata are published
atomically with physical/generation fencing, avoiding an owner-loss window that
would otherwise strand a bounded failure on an unfinished row. Listener recovery
is separate: an unproven cleanup retains the adopting marker/journal and reports
readiness pending, never false ready success. The new owner can restore only the
matching listener, including a same-generation mismatch whose observed version
is unknown, without restarting or replaying uncertain work. A different
generation or unmatched failure/intent cannot use this recovery identity.

Investigate and repair the matching host runtime/server bundle, then deliver a
changed desired release/spec through the authorized normal path. Do not erase
the bound or replay setup merely to reset it. Status-only writes preserve the
evidence; stale physical/generation owners cannot poison a replacement. The
additive nullable-column migration is part of the source change; applying it to
a live database is not authorized here.

## Offline preview — safe to run now

From the repository root:

```sh
bun scripts/machine/preview-bun-convergence.ts \
  --inventory docs/wiki/machines/examples/bun-inventory.json
```

This preview describes Bun-only convergence, not ordinary non-Bun spec repair.
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
   Verify `bunConvergence: current` and the acknowledged bootstrap hash (a safe
   deferred host remains ready with its old hash). Verify the actual disk version,
   stable CLI wrapper output completion, live
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
real executor stays uninterrupted. During deferral it also uses the real asset
sync and HTTP file/Bash APIs to remove a revoked synthetic SSH key and rotate a
rendered environment file while the original command continues, without a new
server launch or Bun admission fence. Host/systemd/tunnel/persistence seams are
fixtures; Bash/HTTP/registry/idle-exit/executables are real. Without the two legacy
fixture inputs, the test remains a current-runtime compatibility regression, not
proof of a historical runtime upgrade.

Focused tests cover installer/source contracts, offline non-mutation, admission,
setup/generation barriers and runtime readback. Existing bootstrap tests retain
one unrelated nft syntax-validation capability skip; that skip is not Bun
convergence evidence. The sandbox-server package typecheck and focused lint/shell
checks pass. Full Core tests/typecheck are left to CI; no image build or live
operation was run. Child-loss regressions SIGKILL an owned claimant after claim,
env publication, server start and pending work, then exercise normal ensure
recovery. Additional checks cover live setup-lease exclusion, generation/token
overtaking and publication fencing. Real-process fixtures are explicitly in the
CI subprocess inventory; membership and disjoint execution gates remain enabled.

## Source-only other-runtime audit (Bun only is changed)

| Host install                     | Repository comparison                                                                               | Finding                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nix 2.24.9                       | Bootstrap and machine-image both 2.24.9                                                             | Aligned with each other; no separate repo-wide Nix engine pin found. Nixpkgs refs select package versions, not the host Nix installer.                 |
| Devbox 0.14.0                    | Machine image 0.14.0; devbox-seed, managed toolchain and both sandbox devbox schema URLs use 0.14.0 | No source pin drift. Schema version is not a claim about live installed version.                                                                       |
| Playwright 1.58.2 / its Chromium | Bootstrap, machine image and Docker sandbox pin 1.58.2                                              | Aligned. Old bootstrap comment suggesting Core depends on Playwright is stale; Core no longer has that dependency. No Playwright/runtime changes here. |
| Docker/containerd and apt tools  | Host apt repository packages are unversioned; no common exact host runtime pin                      | Not comparable to an exact repository pin; no drift assertion or fix.                                                                                  |
| Node/Python/comfort tools        | Not installed by host bootstrap; per-box devbox packages are separate                               | Outside this host-runtime comparison. No changes.                                                                                                      |

This audit compares checked-in sources only; no live fleet versions were queried.
