# Choosing a sandbox runtime

Every ficus install must choose where agent work executes. `FICUS_SANDBOX_RUNTIME`
is **required** and takes exactly one of five values — `docker-sysbox`,
`docker-socket`, `k8s`, `vm`, `host`. There is no default and nothing is
detected for you: the api and the worker refuse to start when it is unset or
set to anything else, so a misconfigured deployment fails loudly at boot
instead of silently running agents somewhere nobody chose. This axis is **independent of
where the core itself runs** (local checkout, a single VM built by the setup
toolkit, or the hosted platform) — any combination works. See
[hosting.md](hosting.md) for that second axis.

## Which one do I want?

| Your situation                                                      | Runtime         |
| ------------------------------------------------------------------- | --------------- |
| My laptop; I just want agents working on my own repos, fast         | `host`          |
| My laptop or dev box; I want containers, but macOS or no sysbox     | `docker-socket` |
| A Linux box where I want real container isolation                   | `docker-sysbox` |
| Many agents, multi-tenant, per-agent VMs / the hosted product shape | `vm`            |
| Hard isolation, resource guarantees, or I already run a cluster     | `k8s`           |

## Comparison

| Runtime         | Isolation                                               | Prerequisites                                                                       | Where agents' files live                                        | Not available                                                           |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `host`          | None — same unix user as the core                       | `bash`; `tmux` for local deployments                                                | The core's own storage dirs (under `HOME_DIR`), no copy         | devbox/toolchains, container log streaming, workspace-file memory watch |
| `docker-socket` | Container, but the sandbox holds the host Docker socket | Docker (any host, incl. macOS); sandbox image built                                 | Bind mounts from the core's storage dirs into `ficus-sandbox-*` | —                                                                       |
| `docker-sysbox` | Container with user-namespace isolation + real DinD     | Linux + [sysbox](https://github.com/nestybox/sysbox) installed; sandbox image built | Bind mounts from the core's storage dirs into `ficus-sandbox-*` | —                                                                       |
| `vm`            | Separate unix user on a separate VM per box             | At least one registered machine (BYO-SSH host or exe.dev credentials)               | On the machine VM, synced/served by the box sandbox server      | —                                                                       |
| `k8s`           | Pod, with scheduler limits and network policy           | A cluster + `KUBECONFIG` (or in-cluster core), storage classes, manifests applied   | PVC subPath mounts on the shared volume                         | —                                                                       |

Nothing on this page changes agent behaviour except where the "Not available"
column says so: every runtime delivers the same per-sandbox asset set (skills,
CLI, ssh, memory) through the shared asset manifest. Browser tools work on
every runtime, including `host`, where the core drives a locally installed
Chrome/Chromium/Edge in-process — see
[browser tools](host-runtime.md#browser-tools).

## Idle VM boxes with pending assets

A VM box can be socket-idle while its required assets are marked `pending`.
This is **Idle — assets refresh on next start**, not active startup. Reading
status does not wake, restart, or reprovision the box to clear that marker.
For pending setup, actual provisioning, recorded setup invocations,
reconciliation, and an ongoing ensure still report startup. Active managed
toolchain installation/setup and failures stay visible over deferred refresh;
ready and degraded boxes retain their existing readiness semantics.

The status API adds optional `assetsRefreshPending: true` for this deferred
case, alongside `readiness: pending` and `devboxReady: false`. The coarse
`status: starting` remains for execution/recovery compatibility: the display
marker is **not permission to execute before ensure completes**. Shared/client
presentation uses the explicit marker to show Idle. Older payloads without it
keep their existing presentation; a pending flag alone never implies idle.

## Mixing runtimes (design — not yet shipped)

> **Status: approved direction, not yet implemented.** This section
> describes the designed per-squad runtime selection from
> the per-squad runtime design
> (issue #1336). It lands as a phased implementation; until then
> `FICUS_SANDBOX_RUNTIME` remains the single process-wide choice.

The design lets **one instance run several runtimes at once**: the instance
default stays `FICUS_SANDBOX_RUNTIME`, and a nullable per-squad override
(`squads.runtime`) — plus a solo-agent override (`agents.runtime`, for agents
in no squad) — selects a different runtime for that squad's shared box and
its member agents' boxes, or that solo agent's box. `null` everywhere means
"the instance default", which is the only state existing installs have.

Rules, in user terms:

- **Squad members follow their squad.** An agent in a squad runs its own box
  and the squad's warm box on the squad's runtime; the solo-agent override
  applies only to agents in no squad. Subagents inherit their parent's box
  and runtime.
- **Every runtime in use is validated at startup.** A value nobody can serve
  (unknown spelling, missing docker image, no `bash` for `host`) refuses to
  start, exactly as a bad `FICUS_SANDBOX_RUNTIME` does today; cluster/machine
  reachability stays a warning, as today.
- **Per-runtime subsystems run for any runtime in use.** The VM reaper and
  K8s prepull/reconcile loops start when any squad uses that runtime, not
  only when it is the default.
- **Visibility:** the squad and agent sandbox-status endpoints report the
  resolved runtime per sandbox; the system status lists the active set and
  every override.
- **Changing a runtime** with a live box stops the old box and re-ensures on
  the new runtime (the same live-migration the machine pin already does).
  Moves between Docker, host, and K8s keep the shared workspace storage, so
  work survives. Moving **to** `vm` starts a fresh box (uncommitted work in
  the old sandbox does not follow). Moving **from** `vm` with a live box, or
  between K8s and non-K8s storage layouts, is rejected with a 409 rather
  than guessed at — export first or stop the box.
- **Rolling deploys:** set overrides only after both the api and the worker
  run the new code; older processes ignore the columns. Rolling back needs
  no data fix — overridden squads simply return to the default.
- **Hosted operators** can structurally disable mixing with
  `FICUS_DISABLE_RUNTIME_OVERRIDE=1`.

## Local quick start (dev checkout)

`bun run setup -- --runtime <host|docker-socket|docker-sysbox|k3d>` does all of
this for a checkout: it writes the runtime and the secrets the UI needs into
`.env`, prepares the runtime (sandbox image or k3d cluster), and starts the
instance — see [docs/wiki/setup.md](setup.md#local-setup). `k8s` and `vm` are not local
installs; their sections below list what they need instead.

Setup writes `FICUS_SERVE_WEB=1`, so the whole app is on one port. The
alternative, for hot-reload work on the frontend, is the vite dev server:

- **`FICUS_SERVE_WEB`** — to reach the UI from the core itself, run
  `bun run build:web` and start the core with `FICUS_SERVE_WEB=1`; the app,
  `/api/*` and `/ws` are then all on `PORT` (3000 by default). `.env.example`
  ships `FICUS_SERVE_WEB=1` — `1`/`true`/`yes` force serving on (warning if no
  build exists yet), `0`/`false`/`no` never serve, and leaving it unset serves
  only when a build already exists. The vite dev server (`bun run dev:web`,
  port 5173) is the alternative, but its proxy targets `localhost:3000`
  only — it cannot talk to a core on another `PORT`.

## `host` — no sandbox

Agents run directly on the core's machine as the core's unix user, in the
core's own directories. Zero isolation between agents, and none from the
machine — pick it for a personal machine or a trusted single-user VM.

**Prerequisites:** `bash`; `tmux` if agents run local deployments. No Docker.

```bash
FICUS_SANDBOX_RUNTIME=host
```

Setup toolkit: `runtime.sandbox: host`.

Deep doc: [host-runtime.md](host-runtime.md) — what agents see, the
environment snapshot, the security model, the per-squad workspace override, and
the full "Not available on host" list.

### Second instance beside an existing one

This is the hand-wired alternative; the installer's `--instance <label>`
(docs/wiki/setup.md → Multiple instances) does all of this for you, one instance per
checkout.

`host` is the cheapest way to try ficus next to an install you already run, but
the two share a machine, so everything they both hold has to be moved apart:

| Knob                         | Why                                                             |
| ---------------------------- | --------------------------------------------------------------- |
| `PORT`                       | API/web port (3000 by default)                                  |
| `FICUS_WORKER_EVENT_PORT`    | the worker's loopback listener (3003 by default)                |
| `FICUS_INTERNAL_EVENT_TOKEN` | must match between _this_ api and worker; give the pair its own |
| `DATABASE_URL`               | its own database                                                |
| `HOME_DIR`                   | its own data root (`~` ok) — agents run on this machine         |
| `APP_URL`                    | so notification links point at the right instance               |

A second database in the same Postgres container, then migrate it:

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U postgres -c 'CREATE DATABASE ficus_host_test'
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ficus_host_test bun run db:migrate
```

Then build and start it (the same checkout is fine):

```bash
bun run build:cli && bun run build:web && bun run dev:core
```

Put those values in the `.env` the core reads, or pass them inline — an
explicit process env var wins over the `--env-file` `dev:core` loads.

## `docker-socket` — containers on any Docker host

One `ficus-sandbox-*` container per sandbox, with the host's Docker socket
mounted in so agents can use Docker. That socket is host-level access: an agent
that can talk to it can escape the container. Use it when you want containers
on macOS, or on a Linux host without sysbox.

**Prerequisites:** a working Docker daemon, and the sandbox image:

```bash
bun run sandbox:build:docker
```

```bash
FICUS_SANDBOX_RUNTIME=docker-socket
# FICUS_SANDBOX_IMAGE=ficus-sandbox:latest   # optional override
```

Setup toolkit: `runtime.sandbox: docker-socket`.

Local install: `bun run setup -- --runtime docker-socket` builds the image and
writes these values for you ([docs/wiki/setup.md](setup.md#local-setup)).

## `docker-sysbox` — containers with real Docker-in-Docker

Same containers, but run under `sysbox-runc`: root inside the container maps to
an unprivileged host user, and Docker-in-Docker works without mounting the host
socket. The strongest Docker-level isolation, and the reason to prefer it over
`docker-socket` wherever it is available. **It never falls back** — if sysbox is
not installed on the host, the core fails with an explicit error rather than
quietly handing agents the host socket.

**Prerequisites:** Linux (kernel 5.12+) with sysbox installed, plus the sandbox
image as above.

```bash
FICUS_SANDBOX_RUNTIME=docker-sysbox
# FICUS_SANDBOX_IMAGE=ficus-sandbox:latest   # optional override
```

Setup toolkit: `runtime.sandbox: docker-sysbox`.

### Installing sysbox

Linux only, kernel 5.12+. The easiest path is the CLI's guarded bootstrap,
which prints the exact plan, requires explicit consent, and verifies
afterwards that docker registered `sysbox-runc`:

```bash
ficus server bootstrap-sysbox            # consent-gated; prints the plan first
ficus server bootstrap-sysbox --dry-run  # print the plan, change nothing
```

It checks the host first (Linux, x86_64, kernel ≥ 5.12, systemd, docker)
and fails with actionable guidance instead of attempting anything on a host
that cannot run it. **Inside WSL**, sysbox needs systemd, which WSL disables
by default — add `[boot]` → `systemd=true` to `/etc/wsl.conf`, run
`wsl --shutdown` from PowerShell, and reopen the distro before bootstrapping.

The manual recipe it automates (same pinned version), from the
[sysbox releases page](https://github.com/nestybox/sysbox/releases):

```bash
# See https://github.com/nestybox/sysbox/releases for the latest .deb
wget https://downloads.nestybox.com/sysbox/releases/v0.6.6/sysbox-ce_0.6.6-0.linux_amd64.deb
sudo apt-get install -y jq

# ⚠️ Installation removes ALL running Docker containers and restarts dockerd
docker rm $(docker ps -a -q) -f
sudo dpkg -i sysbox-ce_0.6.6-0.linux_amd64.deb

sudo systemctl status sysbox      # verify sysbox is running
docker info | grep -i sysbox      # verify Docker can use it
```

If `sysbox-mgr` fails with `open /proc/modules: no such file or directory`
(some VPS kernels), disable the shiftfs check with a systemd override:

```bash
sudo mkdir -p /etc/systemd/system/sysbox-mgr.service.d
cat <<'EOF' | sudo tee /etc/systemd/system/sysbox-mgr.service.d/override.conf
[Service]
ExecStart=
ExecStart=/usr/bin/sysbox-mgr --disable-shiftfs
EOF
sudo systemctl daemon-reload && sudo systemctl restart sysbox
```

## `vm` — boxes on machine VMs

Each sandbox is a **box**: a dedicated unix user on a registered machine (a
provider VM or a BYO-SSH host), running the same sandbox server the k8s runtime
uses, reached over an SSH tunnel. Boxes pack onto shared machines, park when
idle, and migrate between machines. This is the hosted product's runtime.

**Prerequisites:** at least one registered machine. Either

- **byo-ssh** — any Ubuntu 24.04 host reachable over SSH; ficus bootstraps it, or
- **exe** — auto-provisioned exe.dev VMs; store the exe.dev account SSH private
  key in the secret store under `exe-provider-ssh-key` (Settings → Secrets).

Register machines from Settings → Machines in the web UI (or `POST
/api/machines`).

```bash
FICUS_SANDBOX_RUNTIME=vm
# FICUS_EXE_MACHINE_IMAGE=ghcr.io/ficushq/ficus-machine:latest   # optional; exe provider only
```

Setup toolkit: `runtime.sandbox: vm` (plus `runtime.exe.ssh_key_path` and
`runtime.exe.machine_image` when using exe.dev).

### Shared Nix source cache

VM boxes already share the machine's `/nix/store`. Ficus also shares the public
source objects fetched while prewarming the default Devbox toolchains, in
`/opt/ficus/cache/nix/{tarball-cache,tarball-cache-v2}`. Only the dedicated machine
prewarmer publishes objects. Shared packs are root-owned and read-only to boxes;
ordinary agents cannot publish private repositories into this cache.

Each box keeps its own Nix fetcher databases, credentials, custom sources and
writable objects. Its Git-backed tarball cache reads shared objects through
Git alternates. Nix can still write duplicate loose objects, so after every
Devbox install (box seeding and the squad's managed toolchain, including failed
installs) Ficus runs bounded, low-priority `git prune-packed`. That removes only
loose objects already available in packs, so it is safe while other box commands
run Nix. It never runs Git garbage collection because Nix's roots live outside
Git refs.

The private objects are still large when a managed toolchain resolves afresh:
Devbox resolves it against the current `nixpkgs-unstable` commit and downloads that
full nixpkgs source tree. When the toolchain declares only versioned packages, later
boxes of the squad install from a verified pin instead; see
[Pinned toolchain resolution](#pinned-toolchain-resolution). (Measured 2026-11-20 on an agent box: 94,806 loose objects,
408 MB; prune-packed leaves 19,425 objects, 96 MB.) The shared cache cannot hold
a commit that did not exist when it was prewarmed. So at every box service start
(`ExecStartPre`, before the box server or any box command runs), Ficus also
drops the box's private download objects: the repository is renamed away in one
step and removed with a bounded, low-priority delete, then re-attached to the
shared objects. The same box measured 1 MB afterwards. Fetcher metadata and
shared packs are untouched. This is safe because the objects are only a download
cache: realized sources stay in `/nix/store`, `devbox run`, `devbox shellenv`
and already-installed toolchains do not read them, and Nix 2.24 refetches a tree
whose objects are missing. The cost is a re-download (about a minute for
nixpkgs) the next time a box installs a package that needs an evaluated nixpkgs
source. A removal that times out is finished on the next start; the in-session
maintenance passes `--keep-private-nix-objects` and never resets.

Existing machines obtain the updated provisioning script through normal
bootstrap reconciliation; the service unit already calls
`--prepare-nix-cache` at start, so existing boxes shed their private copy on
their next start with no reprovisioning. Prewarming populates the shared cache.
Shared packs are append-only and must not be manually removed while boxes
reference them. This is a VM optimization. Kubernetes pods keep `~/.cache` in
the container's writable layer, which is discarded with the pod, and the guarded
maintenance command is a no-op there because the machine script is absent;
Docker sandboxes are unchanged.

Deep docs: [lifecycle](machines/runtime-lifecycle.md), [placement](machines/runtime-placement.md),
[troubleshooting](machines/runtime-operations.md#troubleshooting) and [machines/exe-provider.md](machines/exe-provider.md)
(credential, image, cost model).

## `k8s` — sandbox pods in a cluster

One pod per sandbox in a sandbox namespace, with subPath mounts on a shared
PVC, real scheduler limits, network policy, and spec-drift self-healing. This is
the escalation tier: reach for it when a tenant needs hard isolation or resource
guarantees. (The separate track that also runs the _core_ on Kubernetes is
paused — see [hosting.md](hosting.md).) For local development, k3d gives you
the same runtime on one machine.

**Prerequisites:** a cluster with the core running in-cluster or a valid
`KUBECONFIG`, RWX/RWO storage classes, and the manifests in `k8s/` applied.
Build and push the sandbox image with `bun run sandbox:build:k8s`.

```bash
FICUS_SANDBOX_RUNTIME=k8s
FICUS_K8S_NAMESPACE=ficus-sandboxes
# FICUS_K8S_RUNTIME_CLASS=sysbox-runc        # set empty to disable
# FICUS_K8S_STORAGE_CLASS_RWX=...            # workspace/memory volumes
# FICUS_K8S_STORAGE_CLASS_RWO=...            # nix store volumes
```

Local k3d instead:

```bash
bun run k3d:setup            # one-time: cluster, image, namespace, PVC
```

```bash
FICUS_SANDBOX_RUNTIME=k8s
FICUS_K8S_LOCAL=true
FICUS_K8S_NAMESPACE=ficus-sandboxes-dev
FICUS_K8S_RUNTIME_CLASS=
```

Setup toolkit: `runtime.sandbox: k8s` (the toolkit does **not** build the
cluster).

Deep docs: [k8s/deployment.md](k8s/deployment.md) (cluster setup; Appendix A
is the full env-var reference) and
[k8s/local-dev-k3d.md](k8s/local-dev-k3d.md) (day-to-day k3d).

## Seeing and stopping what a sandbox runs

A runaway job in a sandbox (a detached full build, a forgotten test database)
can slow every agent that uses it until tool calls and toolchain checks time
out. On a `vm` machine, one box can starve the others on the same machine.
Sandbox status includes the box's load and memory, and the web app flags a
sandbox whose one-minute load is at least twice its CPU count as overloaded.

On `vm`, Core also watches for this. Once a minute it reads the load of each
sandbox an agent is running in; it never reads an idle sandbox, because that
would wake it. When the one-minute load stays at or above twice the CPU count
for 10 minutes, the squad manager gets a fleet alert that names the load and
the commands below. People get the alert 15 minutes later if it has not
cleared, or immediately if the squad has no manager. The alert clears, with a
recovery message, once the one-minute load falls below the CPU count. If no
load reading arrives for 10 minutes, for example because no agent is using the
sandbox any more, the alert is closed and the message says so.

To find and stop the cause without restarting the sandbox:

```bash
ficus squad sandbox-ps <squadId>                        # load, processes by current CPU, containers
ficus squad sandbox-kill <squadId> <pid> [--signal KILL] # TERM by default
ficus squad sandbox-stop-container <squadId> <container>
```

A process an agent's finished command left running shows who left it (agent,
stream and attempt) in `sandbox-ps`; such processes are stopped automatically
when that work ends (see [leftover processes](machines/leftover-processes.md)).

The same commands exist under `ficus agent` for an agent's own sandbox. A squad
member's work runs in the squad sandbox, so use the squad commands for it. In
the web app, the squad's Workspace settings and an agent's own-sandbox controls
have a **Processes** section. Stop/Kill pending state and errors belong to the
individual row, so other processes and containers remain controllable. Both
process actions require confirmation. For containerd shims, Stop (TERM) is
ineffective; shim and runc rows offer Kill directly, still with confirmation.
Killing these runtime processes may disrupt their containers; prefer stopping
the specific container when Docker responds.

Control requests have a 45-second Core budget (including connecting to the box)
and a 50-second browser budget. Docker's stop command has a 40-second budget,
with its CLI force-killed at that deadline. Leaving the panel cancels its browser
requests. Cancellation or timeout does **not** prove that the signal or container
stop was undone: refresh Processes to check the current state before explicitly
retrying. Controls are never retried automatically, and a slow refresh does not
keep a completed control disabled.

The squad header's sandbox pill adds a warning icon when the status reports overload,
runtime degradation, or an informative failure reason (including Docker timeouts).
Hover, focus, or press the icon to read the diagnostics and follow **Open Processes**
to that squad's Workspace settings. Load and memory use the same summary as Info and
Processes; ordinary startup alone is not an overload warning. Older status responses
still surface their pressure and reason without requiring runtime-health fields.
Opening the warning does not sample processes or run Docker diagnostics; **Show processes**
remains an explicit action in the destination panel.

These need `squads:update` for a squad sandbox, or `agents:update` for an
agent's own sandbox (the same permission stops and restarts it); `agents:run`
alone, which covers talking to the agent, is not enough. The agent sandbox status
reports `canManage` for the caller, and the web app shows an agent's Stop, Restart
and process controls only when it is true.
Listing needs it too, because command lines can contain secrets. The sandbox
server runs as the sandbox's own user, so it can only see and signal that
user's processes and its own containers. It refuses to signal itself and the
processes that run it. Processes inside containers can run as other users, so
stop the container instead. Every signal and container stop is logged with the
caller.

### Last-resort VM recovery

If Processes cannot answer, a user with `squads:update` can use **Workspace
settings → Sandbox Lifecycle → Recovery → Restart** on the `vm` runtime.
Confirming restarts only that squad's sandbox-server unit through the machine's
box manager, not through Bash or the box's HTTP command server. It interrupts
commands and terminals, but does not reprovision the box, delete its workspace
or private files, restart other boxes, or reboot the machine. Rootless Docker
is a separate service: this is not a machine-wide Docker reset.

`POST /api/squads/:id/sandbox/restart` uses the authorized squad's stored box
identity. Busy setup, migration, or another restart returns a conflict rather
than queueing a restart for later. SSH is bounded to 30 seconds, followed by
bounded tunnel establishment and a 15-second server-health wait. A successful
response confirms the server answered health, **not** that setup or a declared
toolchain has finished. The status payload exposes `restartPending` while
waiting; errors leave readiness unverified. If Core is interrupted, that pending
indicator expires after two minutes and recovery can be retried once the old
lifecycle lease is gone. The browser stops waiting after 100 seconds; a request
timeout means the outcome is unknown, so check status before retrying.

## Squad sandbox toolchains

Declare packages and an optional idempotent setup hook for every sandbox owned
by a squad:

```bash
ficus squad toolchain set <squad-id> \
  --package python3@latest \
  --package terraform@latest \
  --setup-file ./scripts/ficus-setup.sh
ficus squad toolchain apply <squad-id>
ficus squad toolchain get <squad-id>
```

Ficus stores the setup file as durable inline code and runs it as the sandbox user
after installing the declared packages. Do not embed secrets in the script; read
them from the sandbox's existing environment instead. The script must be safe to
rerun after failures or configuration drift.

This managed toolchain is separate from repository `devbox.json`, legacy
`.ficus/setup.sh`, custom images, and ad hoc `devbox add` workflows. Those existing
mechanisms remain unchanged. It is not available on the `host` runtime (see the
comparison table above).

### Pinned toolchain resolution

On VM and Kubernetes sandboxes, the first sandbox that installs a squad's toolchain
configuration resolves it afresh. Ficus verifies the resulting `devbox.lock` and
keeps a pin built from it for that squad and toolchain fingerprint
(`managed_toolchain_lock_pins`). Every later sandbox of the squad installs from
the pin, so `@latest` means the version the first verified install resolved, not
whatever is newest today. The pin lasts until either of these happens:

1. The configuration changes (packages, setup script, init hooks, readiness
   checks or integration contributions). The new fingerprint has no pin, so its
   first install resolves afresh. A fresh resolution always starts without a lock,
   so it never keeps versions from the previous configuration. Pins for old
   fingerprints are kept, so reverting to an earlier configuration reuses its
   earlier pin.
2. An operator deletes the pin to pick up newer versions without changing the
   configuration. There is no CLI command for this yet; delete the squad's rows
   in the Core database with
   `DELETE FROM managed_toolchain_lock_pins WHERE squad_id = '<squad-id>';`
   (add `AND fingerprint = '<fingerprint>'` to keep pins for other
   configurations). The next sandbox that installs the toolchain resolves afresh
   and records a new verified pin. Sandboxes that already installed keep their
   toolchain until their configuration changes.

Pinning never breaks a sandbox. A stored pin that cannot be read or fails its
reuse check is ignored, and the next verified fresh resolution replaces it. If
installing from a pin fails, that sandbox removes the lock and resolves afresh,
but the pin stays: a sandbox can make any install fail, so a failure never moves a
pin. An operator replaces a pin that is genuinely unrealizable by deleting its
row. A pinned install that times out fails like any other install timeout. The
first verified pin for a fingerprint wins.

#### What Ficus verifies before it stores a pin

The lock is read back from the sandbox right after `devbox install`, before the
setup script runs, and considered only after setup, readiness and activation
succeed. An agent can write to its sandbox, so Core trusts nothing in it and
builds the pin itself, failing closed (no pin, so sandboxes keep resolving afresh)
on any doubt:

- The lock must have exactly one entry per declared package, each referencing
  `github:NixOS/nixpkgs/<commit>#<attribute>` with no content hash.
- Every commit must be identical to or behind `nixpkgs-unstable` according to the
  GitHub compare API. GitHub serves commits from every fork under the
  `NixOS/nixpkgs` path, so the reference alone proves nothing.
- Every store path the lock names, for every system, must have a narinfo on
  `cache.nixos.org`, so it is a path the official cache serves rather than one
  built or added locally.
- The sandbox's own nixpkgs entry for the shell environment is discarded.
  Instead, Core uses the one from its comfort-set lock cache (see
  `devbox_lock_cache`). That is the nixpkgs every VM box's comfort shell already
  uses, so its source is normally already in the machine's `/nix/store`. Its
  commit is checked against upstream too. Its content hash comes from that cache,
  which already decides every box's comfort shell. When Core has no such entry,
  the pin has no stdenv entry and Devbox resolves it at install time.
- A GitHub refusal (including the unauthenticated rate limit), a missing narinfo
  or a network error means the lock is not pinned. Positive results are
  remembered in-process, so repeated pins do not spend the rate limit.

Content-hashed package entries are refused because Nix uses any store path with
that hash without fetching. A lock could otherwise name a tree an agent added to
the store under an upstream commit. Devbox writes such entries only for bare
package names (`bun`), so toolchains with a bare package are never pinned.

The checks prove that everything a pin installs is official: built from upstream
nixpkgs and served by the official cache. They do not prove it is the package or
version that was declared. An agent that controls the sandbox doing the first
install of a new configuration could offer a lock whose `bun@latest` entry names
an old upstream commit, or another official package's store path, and hold the
squad's toolchain on it until the pin is refreshed. Agents of a squad already
share its workspace, so this is not a new trust boundary. Ficus does not compare
entry attributes with package names, because Devbox legitimately maps some names
to other attributes (`gcc@latest` resolves to `gcc16`). Pins
are never shared between squads and are deleted with the squad. Before reusing a
stored pin, Core rechecks its shape and that no package entry has a content hash.
Only Core writes pins.

Measured on a VM box with an empty per-user Nix cache (2026-11-20, Devbox 0.14.0,
Nix 2.24.9):

- `bun@latest` and `jq@latest`: the first install took 50 to 82 seconds and wrote
  409 MB of Nix download cache. Verification took about one second. Installing
  from the verified pin took 3.8 seconds and wrote 1 MB.
- Bare `bun`: about 80 seconds and 400 MB in every new sandbox, pinned or not.
  Devbox evaluates a bare package from a nixpkgs input without a content hash, so
  Nix downloads that commit's source each time.

Pinning only helps versioned packages (`name@latest`, `name@1.2`), so declare
packages with a version. Docker sandboxes do not pin.

## Switching runtimes on an existing install

That is the **instance-wide** switch. For changing a single squad without
restarting the instance into a different runtime, see
[Mixing runtimes](#mixing-runtimes-design--not-yet-shipped) (design status).

Change `FICUS_SANDBOX_RUNTIME` (or `runtime.sandbox` in the toolkit config) and
restart the api and worker. Existing sandboxes on the old runtime are not
migrated: agents get a fresh sandbox on the new runtime, and the old
containers/pods/boxes are left for you to clean up. Squad workspaces and memory
live in ficus's storage, not in the sandbox, so work is not lost — but a machine
change means a different filesystem, so uncommitted work inside an old sandbox
does not follow. See [machines/upgrading.md](machines/upgrading.md) for the
per-runtime migration notes.

Upgrading an existing install is the same story from the other side: the
upgrade rewrites no `.env`, so an install still carrying an old spelling (or no
value at all) must be edited **before** the api and worker are restarted — they
refuse to start otherwise, and both the setup toolkit's `upgrade-host.sh` and
the in-app updater stop before restarting rather than leave the instance down.
The in-app preflight ships WITH this change, so an instance still running
pre-rename code must set `FICUS_SANDBOX_RUNTIME` in `.env` BEFORE applying the
update that introduces it; `upgrade-host.sh` from this checkout is safe either
way.
On the docker runtimes, expect every existing `ficus-sandbox-*` container to be
recreated once after the upgrade: the runtime name is part of the container
spec hash, so the rename alone counts as drift. That recreate is safe —
workspaces, memory and private dirs are host bind mounts.

**Old spellings no longer start the core.** They were removed, not aliased:

| Old value | Now                                                  |
| --------- | ---------------------------------------------------- |
| `sysbox`  | `docker-sysbox`                                      |
| `socket`  | `docker-socket`                                      |
| `auto`    | choose `docker-sysbox` or `docker-socket` explicitly |
| `docker`  | choose `docker-sysbox` or `docker-socket` explicitly |

## Reading images

The `read` tool returns PNG, JPEG, GIF, WebP, and BMP files as native image
content for vision-capable models, not binary text. Sandbox readers classify a
bounded byte prefix on the same authenticated client used to read the file;
shared-workspace routing also applies to this sniff. File extensions do not
override the bytes. Custom Pi read operations must implement
`detectImageMimeType`—Pi does not inherit the host detector for custom operations.

Images use complete binary reads rather than text line ranges. Pi validates the
image, converts BMP to PNG, and applies its inline image size limits. Invalid
images are omitted and unrecognized binary prefixes are rejected instead of
being decoded as text. Text files retain their usual line selection/truncation.
Reading an image does not publish it or make browser `file:` URLs accessible.

## Consultant conversations

A squad's consultant chats share one light runtime (`consultants_<squad-id>`).
Active squads warm this runtime alongside their squad workspace, so opening
another consultant chat normally reuses an already prepared environment. The
runtime can idle when squad activity expires; an always-on squad keeps it warm.

Each conversation retains its own history and short-term memory. Its shell starts
in `<private-root>/conversations/<agent-id>`, and each command receives the calling
agent's Ficus token. Scratch directories prevent accidental filename collisions;
they are not security boundaries between consultants in the same squad. The
runtime, installed tools, browser state, and shell configuration are shared, so
coordinate changes and use squad resource slots where appropriate. Federation
signing requires dedicated key custody and is unavailable to shared consultants.

Terminating or deleting an individual conversation does not stop the shared
runtime. Archiving the squad removes it.

Scratch of finished conversations is pruned inside the runtime
(`services/sandbox/consultant-scratch.ts`). After the runtime is ensured
(`ensureConsultantSandbox`, which squad warmup calls), at most once per six hours
per squad and process and without delaying warmup, Core lists `<private-root>/conversations/` and moves each
directory whose agent (a consultant or one of its subagents) is `terminated` or
no longer exists to `<private-root>/.conversations-archive/<agent-id>-<epoch-ms>`.
As with the personal `/private` archive, `.ficus/agent-secrets.env` is removed
first, and archive entries older than `AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS` are
deleted in the same pass. Directories are archived in batches of 500 per command,
so a long backlog never exceeds the runtime's argument-length limit. Live and dormant agents keep their scratch in place,
including channel agents whose storage was reclaimed. Waking them therefore needs
no restore. Directories not named for an agent, and symlinks, are left alone. The
prune never starts a stopped runtime: a squad whose runtime stays down is pruned
the next time it is warmed. A failed prune is logged and retried after the
interval. Existing consultant chats immediately
use the shared runtime; old per-agent files are not migrated, and old personal
sandboxes remain eligible for normal idle/agent cleanup.
