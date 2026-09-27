# Hosting & orchestration map

> **DO-droplet machine mode (2026-08-06):** platform-managed tenants can run their sandbox machine host as a second platform-provisioned DO droplet in a per-tenant VPC (default for new tenants), instead of a customer exe.dev account. exe remains a per-tenant fallback. See docs/history/superpowers/specs/2026-08-06-do-machine-mode-design.md.

> **Machine-host sizes (2026-08-06, Part 2):** do_droplet hosts come in a closed catalog (base/boost/power/max; base included, larger sizes are Stripe subscription items at passthrough+markup). Owners and admins resize from the instance/admin pages; a resize is a queued per-tenant job with brief host downtime (boxes restart) and never grows the disk, so downsizing stays possible. Prices shown in UIs are read from Stripe, never hardcoded. exe-mode surfaces are hidden everywhere unless a tenant is machine_mode='exe'.

Where ficus runs, post machine-stack merge (2026-07-24). Two independent axes:
**where the core runs** (api + worker + ParadeDB + web) and **which sandbox
runtime executes agent work** (`FICUS_SANDBOX_RUNTIME`). Any combination works.

> **How to choose:** this page is the map of what exists. If you are setting up
> an install and just need to pick a runtime and turn it on, go to
> [sandbox-runtimes.md](sandbox-runtimes.md).

## Axis 1 — hosting the core

1. **Local dev** — source checkout, `bun run` api/worker, ParadeDB in docker,
   web dev server.
2. **Single-VM hosted (the scripted path)** — the setup toolkit
   (`scripts/setup/`) takes a blank Ubuntu VM from nothing → running: config
   wizard, systemd units (`tau-api`/`tau-worker`), dockerized ParadeDB, built
   dist, bootstrap `FICUS_PASSWORD` that self-disables once a passkey exists.
   `provision.sh` does the whole flow on a fresh VM in ~2–3 min (exe.dev, or
   Hetzner Cloud + Cloudflare DNS via `provision.provider: hetzner`). The
   flavor-aware self-updater (#629) keeps these installs current.
3. **k8s-hosted core** (Hetzner/chart track) — deliberately **paused**; the
   chosen direction is VM-per-tenant (see “What prod looks like”).

## Axis 2 — sandbox runtime (`FICUS_SANDBOX_RUNTIME`)

`FICUS_SANDBOX_RUNTIME` is required and has no default — the core refuses to
start without one of these five values.

1. **`docker-sysbox` / `docker-socket`** — one container per sandbox
   (`tau-sandbox-*`) under sysbox-runc or with the host Docker socket mounted
   in (`docker-sysbox` never falls back to socket mode), manifest-driven bind mounts,
   shared nix base (`~/.tau/nix/.base`) with per-sandbox hardlink/CoW clones
   and terminal-lifecycle reclaim. Containers carry a `tau.spec-hash` label, so
   mount-changing upgrades recreate them lazily on next use (see
   `docs/wiki/machines/upgrading.md`).
2. **`k8s` (the heavy tier)** — real pods with subPath mounts on the shared
   PVC, actual scheduler/limits/isolation, spec-drift self-healing, shared
   nix-cache. The _escalation_ tier: hard-isolation or resource-guaranteed
   tenants go here rather than fattening the vm packer. k3d for local k8s dev.
3. **`vm` (the cheap tier — the product runtime)** — boxes as unix users
   packed onto shared machine VMs (`docs/wiki/machines/runtime.md`). Providers
   behind the `MachineProvider` registry:
   - **byo-ssh** — any Ubuntu 24.04 box reachable over SSH becomes a machine
     (bootstrap pushes everything; multi-user nix/devbox gives no-sudo agents
     self-serve tooling).
   - **exe** — auto-provisioned exe.dev VMs from the public prebaked
     `ghcr.io/ficushq/ficus-machine` image (~1s bootstrap;
     `docs/wiki/machines/exe-provider.md`).

   On top: dumb best-fit unit packer (squads effectively VM-exclusive,
   ~10 agents/VM, `FICUS_UNIT_WEIGHT_*`/`FICUS_MACHINE_UNIT_CAPACITY` tunable),
   pins + `dedicated` scope + sticky placement, idle park + empty-machine
   reaping, manual rebalance/migrate-box (CLI + Settings UI), per-host
   content-hashed server+CLI delivery, pinned reverse-port core callbacks,
   content-hash file-sync, machine-side remnant sweep, per-box auth tokens,
   opt-in egress lockdown, rootless docker per box, remote hosts (team SSH
   targets granted to squads), machines admin UI.

4. **`host` (no sandbox)** — agents run directly on the core's machine as the
   core's user, in the core's own storage directories, with an optional
   per-squad workspace override. Zero extra processes; zero isolation. See
   `docs/wiki/host-runtime.md`.

## Managed hosting

[Ficus Cloud](https://ficus.sh) provides managed instances. For your own deployment,
use the setup toolkit and choose a sandbox runtime appropriate for your workload
and isolation requirements.

## Design lines (deliberate, not gaps)

- The vm tier stays dumb: no affinity/limits/scheduler in the packer. The
  moment a tenant wants that, they belong on the k8s runtime.
- Every runtime delivers the identical per-sandbox asset set via the shared
  asset manifest (`apps/core/src/services/sandbox/asset-manifest.ts`) — agents
  behave the same wherever they land; only transport mechanics differ. The one
  qualified exception is `host`, which has no container to deliver into: devbox
  toolchains, browser tools, container log streaming and the workspace-file
  memory watch are unavailable there (see "Not available on host" in
  `docs/wiki/host-runtime.md`).
- Kernel-escape residual on shared VMs is accepted for the cheap tier; the
  boundary product is the runtime escalation knob, not packer hardening.

See [machine upgrades](machines/upgrading.md) for existing-install migration.
