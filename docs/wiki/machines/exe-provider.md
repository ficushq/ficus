# exe.dev provider (`provider: 'exe'`)

exe.dev is a **provider-provisioned** machine backend: unlike a BYO-SSH
machine (an operator registers an endpoint they already run), an `exe`
machine is a VM ficus itself creates, keys, bootstraps, and eventually
destroys. Once exe.dev hands back an SSH endpoint, every other part of the
VM runtime — bootstrap, boxes, tunnels, lifecycle, placement — runs over that
endpoint completely unchanged (see `docs/wiki/machines/runtime.md`). This document
covers what's specific to exe: the credential, the wire format, the
account-key auth model, and the cost model.

**✅ VERIFIED live (recon + end-to-end run, 2026-07-13).** exe.dev's wire
format was confirmed against a real account: the full production flow —
`POST /api/machines provider:'exe'` → SSH in with the account key → bootstrap
→ box ensure → `/bash` exec → box teardown → DELETE destroys the VM — passed
the gated integration test
(`apps/core/src/services/machines/integration-exe.test.ts`) against a live
VM. Every wire-format fact is still isolated in ONE module,
`apps/core/src/services/machines/providers/exe-api.ts` (tagged `VERIFIED`
inline, with the two remaining `UNVERIFIED` items called out: the `cp` clone
subcommand — unused — and `rm`/`cp` failure semantics). The adapter (`exe.ts`)
and the placement policy (`placement.ts`) depend only on the `ExeApi`
interface, never on the wire format, so any future correction touches
`exe-api.ts` alone.

## Credential setup

exe.dev's "API" is an SSH lobby, and its credential is the **account's SSH
private key** (Settings → SSH keys on exe.dev) — not a bearer token. ficus runs
instance-per-tenant, so one tenant's own exe.dev account key backs every VM it
provisions. The key lives in the secret store — never in a `machines` row,
never logged — under:

```
exe-provider-ssh-key
```

Set it via the secret store the same way any other system secret is
configured (see `apps/core/src/services/secrets`); `provider-credentials.ts`
exposes the read side as `getExeSshKey()`. The web SecretsSection has a
dedicated entry for it.

**Registration is conditional on the key.** BYO-SSH is always registered; the
exe provider is registered by `registerBuiltinMachineProviders()`
(`providers/index.ts`) **only** when `getExeSshKey()` resolves non-null at
call time. No key ⇒ `provider:'exe'` requests 400 at `POST /api/machines`
("configure exe.dev credentials to provision exe machines") and the
placement policy's `getExeProvider()` returns `null`, which routes every
placement decision through the BYO/least-loaded path (see runtime.md §
Placement) — **exe absent is a fully supported "not opted in" state, not an
error state.**

To start using exe:

1. Store the account SSH private key under `exe-provider-ssh-key` in the
   secret store (SecretsSection in the web admin, or the secrets API).
2. Restart Core (or otherwise cause `registerBuiltinMachineProviders()` to
   re-run) so the registry picks it up — `POST /api/machines` also
   re-registers idempotently on the next request, so a live process should
   pick up a freshly-set key without a restart in most cases, but a restart
   is the guaranteed path.
3. `POST /api/machines { "name": "...", "provider": "exe" }` to provision a
   machine by hand, or simply let placement provision squad/commons/dedicated
   machines automatically as agents/squads ensure their sandboxes.

## What "provision" does

`createExeMachineProvider({ api }).provision(spec)` (`providers/exe.ts`) calls
`ExeApi.createVm({ name, image? })` and maps the result straight onto
`ProvisionedMachine { sshHost, sshPort, sshUser, providerRef }`. The route
(`POST /api/machines`) and the placement policy's `defaultProvisionMachine`
(`placement.ts`) both follow the same sequence:

1. `provider.provision({ name, scope? })` → the VM's SSH endpoint
   (`<vm_name>.exe.xyz`, port 22, user `exedev`) + a `providerRef` (exe.dev's
   VM name). **No keypair is generated for exe machines** — exe's proxy
   authenticates the account key only (see § Account-key auth below), so every
   exe VM shares the account key as its SSH identity.
2. Insert the `machines` row (`provider: 'exe'`, `status: 'registered'`,
   `providerRef`, the returned `sshHost`/`sshPort`/`sshUser`, and
   `sshKeyId = 'exe-provider-ssh-key'` — the SHARED account-key secret, not a
   per-machine key). `DELETE /api/machines/:id` deliberately never deletes
   that shared secret (every other exe machine depends on it); per-machine
   BYO keys are still cleaned up as before.
3. `bootstrapMachine(machine)` — pushes `bootstrap.sh`, installs (or, on the
   prebaked image, skips) the base toolchain, stamps the row `ready`. Only
   placement's provisioning path does this automatically; a hand-issued
   `POST /api/machines` leaves the row `registered` until an operator calls
   `POST /:id/bootstrap` (mirroring BYO-SSH — see runtime.md).

## Custom box image: the prebaked `ficus-machine` image

By default an exe VM boots exe's stock **exeuntu** image (bare Ubuntu 24.04),
and `bootstrap.sh` then installs the whole toolchain (bun, multi-user nix,
devbox, Docker engine + rootless extras) — a multi-minute cost. To collapse that
to a **seconds-long** boot, ficus provisions exe VMs from a **prebaked custom
image**, `ficus-machine`, that bakes exactly that toolchain at the same pinned
versions and paths. `bootstrap.sh` then detects the baked toolchain and skips the
installs (see § Prebaked box image + fast bootstrap in `runtime.md`).

### The image

- Source: `packages/machine-image/Dockerfile` (+ `README.md`). It is
  `FROM ghcr.io/boldsoftware/exeuntu:latest` (exe's own default image, public on
  ghcr) with `install_base_packages` / `install_docker_packages` / `install_bun`
  / `install_nix` / `install_devbox` mirrored on top, plus the ficus scripts in
  `/opt/ficus/bin` and the **`/opt/ficus/prebaked` marker** — JSON recording the pins
  it baked (`{"bunVersion","nixVersion","devboxVersion"}`) — that bootstrap's
  fast-path reads. It keeps the `exe.dev/login-user=exedev` label so it stays a
  valid exe custom image. It is the **base toolchain only**; the per-box devbox
  comfort set is still seeded per box at runtime.
- **KEEP IN LOCKSTEP** with `scripts/machine/bootstrap.sh`: the Dockerfile's
  `ARG BUN_VERSION` / `NIX_VERSION` / `DEVBOX_VERSION` should equal bootstrap's
  pins. On drift, bootstrap still boots on the **baked** tooling (it never
  reinstalls over a prebaked image — a nix reinstall over the baked `/nix` would
  brick the boot) and logs a warning telling you to rebake — see § Version drift
  below.

### Build & publish

exe VMs are x86_64, so the image **must** be built for `linux/amd64`. From the
**repo root** (the Dockerfile COPYs `scripts/machine/*`):

```
docker buildx build --platform linux/amd64 \
  -f packages/machine-image/Dockerfile \
  -t ghcr.io/ficushq/ficus-machine:latest .
```

CI publishes it (`.github/workflows/publish-images.yml`, `build-machine-image`
job): `latest` on `main`, `sha-<short>` always, the tag name on `v*`. GHCR package
visibility is configured independently of repository visibility.

**One-time public-package step (required).** exe pulls the image anonymously (no
`--registry-auth`), so the ghcr package must be set **Public** once, by hand, in
its ghcr package settings after the first push. Until that's done, exe VMs can't
pull the image and provisioning fails at boot. (A future _private_ image would
instead thread `--registry-auth` from a secret — a documented hook in
`exe-api.ts` `createVm`, intentionally not built yet.)

### Config: `FICUS_EXE_MACHINE_IMAGE`

The exe provider reads the image ref from `getExeMachineImage()`
(`provider-credentials.ts`), which resolves `FICUS_EXE_MACHINE_IMAGE`:

| `FICUS_EXE_MACHINE_IMAGE` | Behavior                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **unset**                 | `ghcr.io/ficushq/ficus-machine:latest` (`DEFAULT_EXE_MACHINE_IMAGE`) — the default.                           |
| a value                   | that image ref (a tenant override, e.g. a pinned `sha-<short>` tag).                                          |
| **empty string**          | `undefined` ⇒ the provider omits `--image`, so exe boots its own default exeuntu image. The explicit opt-out. |

The provider passes the resolved image on **every** provision:
`ExeApi.createVm({ name, image })` appends `--image <ref>` to `new` (VERIFIED
live 2026-07-13); when the ref is `undefined` the flag is omitted.

### Version drift → rebake the image (bootstrap never reinstalls over it)

If the running Core's `bootstrap.sh` pins ever get ahead of the image (a bump
merged but the image not yet rebaked/republished, or `FICUS_EXE_MACHINE_IMAGE`
pinned to an old tag), the marker's baked versions won't match the script's
pins. Because the `/opt/ficus/prebaked` marker is **present**, bootstrap **keeps
using the baked tooling** — it does **not** reinstall over the image — and logs a
`WARNING` per drifting tool (e.g. `prebaked image nix 2.24.9 != script 2.25.0 —
using baked tooling; rebake the ficus-machine image to change pinned versions`).

This is deliberate and safety-critical, **not** a self-heal: the official nix
installer refuses to run over an existing `/nix`, so a boot-time reinstall would
error under `set -e`, abort provisioning, and mark the VM `unreachable` — a
`NIX_VERSION` bump on a prebaked image would **brick** it. So a pin change is
applied by **rebaking + republishing the image** (§ Build & publish), never
auto-upgraded at boot. The machine still boots normally on the baked tooling
until you rebake; the only cost of drift is that the baked versions lag the
script's pins until the next rebake.

### Lobby operation budgets and observability

`defaultExeExec` classifies lobby calls without retaining or logging argv:

| Class     | Command                           | Expected latency                                                          | Retry/cancellation characteristics                                                                   | Current budget       |
| --------- | --------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| `create`  | `new` (with or without `--image`) | VM/image provisioning; expected slowest, not yet isolated by measurements | Persistent mutation; do not retry blindly after timeout because the remote create may have committed | 20s                  |
| `destroy` | `rm`                              | Control-plane mutation; not yet measured                                  | Irreversible and `rm` idempotency is unverified; reconcile with `ls` before retry                    | 20s                  |
| `list`    | `ls --json`                       | Read-only control-plane call                                              | Safe to retry; cancellation has no remote side effect                                                | 20s                  |
| `clone`   | `cp`                              | Provisioning-like but entirely unverified and unused                      | Persistent mutation; do not retry blindly                                                            | 20s                  |
| `unknown` | future command                    | Unknown                                                                   | Unknown                                                                                              | bounded 20s fallback |

The classes are typed separately so evidence can change one budget without
silently affecting the others. They deliberately remain equal today: the
existing 20-second value is a bound, not latency evidence. Every completion
emits secret-safe debug telemetry containing only `operation`, `outcome`,
`durationMs`, and `timeoutMs`. It never includes the account key, identity
path, VM/image names, credentials, or raw command arguments.

**Operator overrides (no redeploy).** Because 20s is a bound rather than a
measurement, each class's deadline can be widened on a running instance:

| Env var                             | Class     |
| ----------------------------------- | --------- |
| `FICUS_EXE_EXEC_CREATE_TIMEOUT_MS`  | `create`  |
| `FICUS_EXE_EXEC_DESTROY_TIMEOUT_MS` | `destroy` |
| `FICUS_EXE_EXEC_LIST_TIMEOUT_MS`    | `list`    |
| `FICUS_EXE_EXEC_CLONE_TIMEOUT_MS`   | `clone`   |

Each takes unsigned decimal integer milliseconds from `1` through
`2,147,483,647` (the signed 32-bit maximum safely supported by Bun/Node timers).
Whitespace, signs, fractions, exponent/hex notation, unsafe integers, and larger
values are **ignored with a redacted warning** and the class keeps its compiled
default. Warning metadata never echoes the raw environment value. Thus a bad
value cannot become an immediate, overflowed, or effectively unbounded timer,
and a typo cannot take provisioning down. `unknown` commands keep the
compiled fallback and have no override. This is an escape hatch for an
incident, not a substitute for the calibration below: record any value you set,
and why.

### Approved live latency calibration runbook

**This procedure creates and destroys billed external resources. Do not run it
unless the operator explicitly approves this exact run and confirms the exe.dev
account key, subscription/cost model, public image, and resource cap.** Merely
setting a credential is not approval. The normal unit and skipped integration
tests make no external calls.

1. Record the approver, UTC window, account, image digest/tag, region (if exe
   exposes one), and the pre-run `ls --json` inventory. Set a hard cap of **one
   concurrent VM, 20 total creates, and 90 minutes**. Stop immediately on quota,
   auth, cleanup, or unexpected billing errors.
2. Use names `ficus-cal-<UTC-date>-<random-run-id>-<01..20>` so every disposable
   resource is attributable. Refuse to start if any name already exists.
3. Collect 20 sequential `new --image` samples through the instrumented runner:
   five cold samples after at least ten idle minutes (or after an operator-
   confirmed cache reset, if exe offers one), then 15 warm samples. Record the
   operation/outcome/duration telemetry plus whether the sample was cold/warm;
   never record argv, key paths, or credentials. Do not parallelize.
4. After **each** successful or ambiguous create, reconcile by exact name using
   `ls --json`, issue `rm` if present, and poll the listing with a bounded
   five-minute deadline until absent. A create timeout is ambiguous: cleanup by
   name even when no create response arrived. Do not continue while the prior
   sample remains.
5. On interruption or failure, run the same exact-name cleanup for every name in
   the run manifest. Preserve the manifest and telemetry, but not credentials.
   If any VM remains after the cleanup deadline, stop, notify the operator, and
   report its name and observed state; never broaden deletion beyond the unique
   run prefix.
6. Report success/timeout/error counts, cold and warm min/median/p90/p95/max,
   create-to-visible and destroy-to-absent durations, residual resources, and
   the provider-reported or estimated cost. With only 20 samples, use the
   nearest-rank **p95** plus the observed maximum as calibration evidence; do not
   claim p99. Propose (do not silently apply) a create budget with at least 25%
   headroom above the larger of p95 and max, rounded up to whole seconds and
   still capped. Keep other classes unchanged unless separately sampled.
7. A run passes only when all 20 names are confirmed absent and the post-run
   inventory differs from the pre-run inventory by no calibration resources.
   Operator acknowledgement is required for any residual resource or cost.

### Live validation (gated/manual — not in CI)

**Validated live 2026-07-13/14** on an exe VM booted from the published
`ghcr.io/ficushq/ficus-machine:latest`: bootstrap completed in **1 second**
(the log shows `prebaked ficus-machine image detected … skipping install steps`,
no apt/nix output) versus multi-minute on bare exeuntu; the caps probe
reported `docker:"rootless"` and `forwarding:"yes"`; a box provisioned in ~0s
and (with `--with-docker`) its rootless daemon came up with working container
egress. To re-validate after a rebake, repeat that flow: boot a VM from the
image, run bootstrap, assert the fast-path log + seconds-long wall clock,
ensure one box + exec a round-trip, destroy the machine. Costs real exe.dev
usage; never run in CI.

## Account-key auth (VERIFIED — there is no pubkey injection)

exe.dev's SSH proxy authenticates connections against the **account's
registered keys only**. Two live-confirmed consequences (recon 2026-07-13):

- A public key placed in a VM's own `~/.ssh/authorized_keys` is **rejected**
  by the proxy ("Please complete registration") — per-VM keys simply cannot
  work, and there is no `--ssh-key` flag on `new`.
- The one account key reaches **every** VM under the account (and the lobby
  itself). So the same `exe-provider-ssh-key` secret is both the lobby
  credential and every exe machine's SSH identity (`machines.sshKeyId` points
  at it — see § What "provision" does).

This is why exe machines mint no keypair and the DELETE route guards the
shared secret. It also means exe machine access is account-scoped by
construction: anyone whose key is on the exe.dev account can SSH any of the
tenant's VMs — which matches ficus's instance-per-tenant model (the account IS
the tenant boundary).

## Wire-format verification status

The authoritative inventory lives as inline `VERIFIED` / `UNVERIFIED` tags in
`exe-api.ts`; summary:

| Status                        | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ VERIFIED (live 2026-07-13) | Lobby `ssh exe.dev new\|ls\|rm --json`; `new --name <n> --json` echoes the name back as `vm_name` and emits `{ vm_name, ssh_dest, ssh_port, https_url, proxy_port, … }`; missing `ssh_dest` ⇒ `<vm_name>.exe.xyz`, missing `ssh_port` ⇒ 22; SSH user is always `exedev`; `ls --json` emits `{ "vms": [ … ] }` (an object with a `.vms` array); `rm <vm_name>` destroys the VM; `--image OWNER/IMAGE:TAG` boots a custom OCI image (public images pull unauthenticated); account-key auth (above); the exe.xyz HTTPS proxy forwards ports 3000–9999. |
| ⚠️ UNVERIFIED                 | `cp <src> <new> --json` (CoW clone — `ExeApi.cloneVm`, unused this slice); `rm`/`cp` failure semantics (assumed non-zero exit + human stderr).                                                                                                                                                                                                                                                                                                                                                                                                      |

Re-validate any of it end-to-end with the gated integration test (provisions
ONE real VM, runs the full production flow, destroys it; costs real exe.dev
usage — never run in CI):

```
FICUS_TEST_EXE_SSH_KEY=~/.ssh/<your exe account key> \
FICUS_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) \
bun test src/services/machines/integration-exe.test.ts
```

Skipped-mode collection (no `FICUS_TEST_EXE_SSH_KEY`) makes zero exe.dev network
calls and zero DB writes — `describe.skipIf` skips its `beforeAll`/`afterAll`
too.

## Kernel quirk: rootless docker needs `--skip-iptables` (handled)

exe's custom kernel compiles `nf_tables` **into** the kernel but lists it in
neither `/proc/modules` nor `modules.builtin`, so
`dockerd-rootless-setuptool.sh`'s iptables pre-flight (`modprobe nf_tables`)
fails even though iptables works fine there (nft backend). `box-provision.sh`
handles this generically: it installs with `--skip-iptables`, then strips the
`--iptables=false` flag that escape hatch bakes into the unit (which would
otherwise kill container egress) via a systemd drop-in, and restarts the
daemon. On kernels that list the module normally the whole dance is a no-op.
Verified live on exe (2026-07-14): per-box daemons active, container egress
green. Details in `provision_docker` (`scripts/machine/box-provision.sh`).

## Cost model

Per the provider survey: exe.dev bills either a **flat rate (~$20 for up to
50 VMs)** or **per-second usage**, with an **idle VM costing approximately
nothing**. This is why `park`/`resume` are intentional no-ops in
`exe.ts` — unlike a BYO-SSH machine (where parking stops a systemd unit to
free CPU/RAM the operator is paying for regardless), an exe VM has no
explicit pause/snapshot primitive and idling it costs the tenant nothing
worth the round-trip. The vm-runtime's idle reaper still calls `stopBox`
(which stops the box's own `ficus-sandbox-server.service` unit and cancels its
tunnel) exactly as it would for BYO — that's a **box**-level park, not a
**machine**-level one, and is unaffected by exe's no-op park/resume. The exe
VM itself, and its disk, simply keep existing (and costing ~free) until an
operator or the placement/lifecycle machinery explicitly terminates it.

## Placement: how a box lands on an exe machine

See `docs/wiki/machines/runtime.md` § Placement for the full role/scope-aware
policy (squad-per-VM, the tenant commons singleton, dedicated VMs, and the
`FICUS_MAX_MACHINES` provisioning cap). In short: when the exe provider is
registered, ficus auto-provisions and reuses exe machines by role instead of
falling back to the BYO least-loaded rule; when it isn't, placement is
byte-identical to the pre-exe BYO-only behavior.
