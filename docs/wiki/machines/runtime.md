# VM sandbox runtime (`FICUS_SANDBOX_RUNTIME=vm`)

The `vm` runtime runs each sandbox as a **box**: a dedicated Unix user
(`box_<hash>`) on a registered **machine** (a provider VM or a BYO-SSH host),
serving the same `packages/sandbox-server` sandbox-server the k8s runtime uses —
only reached over an SSH tunnel instead of cluster DNS. To callers (routes,
tools, `ensure.ts`) it is behaviourally interchangeable with the k8s and docker
runtimes: it implements the same `ISandboxManager` contract via
`VmSandboxManager`. (The `host` runtime is the exception — it has no container
at all, and drops the features listed in `docs/wiki/host-runtime.md`.)

Enable it by setting `FICUS_SANDBOX_RUNTIME=vm` and restarting the api + worker
(setup toolkit: `runtime.sandbox: vm`); you also need at least one registered
machine, per the sections below. See
[`docs/wiki/sandbox-runtimes.md`](../sandbox-runtimes.md) to compare the five
runtimes.

This document describes how the runtime works, what a machine must provide,
the ensure/park/remove lifecycle, placement, how a box calls Core back, how the
fleet is observed and administered (events + the web Machines admin section),
and how to troubleshoot it. The authoritative design is
`docs/history/superpowers/specs/2026-07-12-vm-machines-design.md` (§4, §6, §8, §9).

## Remote hosts are not machines

A `machines` row is substrate ficus **colonizes**: ficus bootstraps it, creates a
Unix box user on it, installs a sandbox server, and runs agent sandboxes on
it (everything below). A **remote host** is the opposite — a team-owned box
(staging server, build machine, a Mac with Xcode, a Windows box with `sshd`)
that a squad merely SSHes _into_. ficus never bootstraps a remote host, never
creates users on it, and never installs anything on it. If you're looking to
give ficus a new place to run agent sandboxes, that's this document; if you're
looking to let a squad reach an existing box the team already owns, see
`docs/wiki/remote-hosts.md` instead.

## Architecture at a glance

```
  ┌──────────────────────── Ficus Core (this process) ────────────────────────┐
  │                                                                          │
  │  VmSandboxManager ── box-manager ──┬── ssh.ts (one-shot exec, key 0600)  │
  │        │                           ├── server-bundle.ts (bun build+push) │
  │        │                           └── tunnel-manager.ts (ControlMaster) │
  │        │                                                                 │
  │  SandboxClient(127.0.0.1:<localPort>)  ← HTTP/WS over the -L forward     │
  └────────┼─────────────────────────────────────────────────────────────────┘
           │  ssh -M (one persistent ControlMaster per machine)
           │  -L <localPort>:127.0.0.1:<boxPort>   (Core → box: tools)
           │  -R 0:127.0.0.1:<corePort>            (box → Core: callbacks)
           ▼
  ┌──────────────────────── Machine (Ubuntu 24.04) ─────────────────────────┐
  │  sshd (AllowTcpForwarding yes)                                           │
  │  /opt/ficus/{bin/bun, bin/box-provision.sh, server/server.js, manifest}  │
  │                                                                          │
  │  box user  box_<hash>  (HOME /home/box_<hash>, 0700)                     │
  │    ├─ <prefix>.socket        → owns 127.0.0.1:<boxPort>, always on       │
  │    │     └─ <prefix>-proxy.service (systemd-socket-proxyd, 30s idle)     │
  │    │           └─ <prefix>.service  (see "unit modes")                   │
  │    │                 └─ bun /opt/ficus/server/server.js → unix socket    │
  │    ├─ ~/.ficus/server.env   (0600, systemd EnvironmentFile — secrets)    │
  │    ├─ ~/workspace         (squad box work root)                          │
  │    ├─ ~/.private          (0700; agent/system-manager work root)         │
  │    └─ ~/bin/ficus, ~/.ficus/skills, ~/memory  (pushed over /write)       │
  └──────────────────────────────────────────────────────────────────────────┘
```

- **Box server** = the unbundled k8s sandbox-server, `bun build`-bundled to a
  single `server.js` and pushed to `/opt/ficus/server/server.js`. One copy per
  machine; every box runs it as its own Unix user under a systemd unit.
- **Socket activation** — a box is THREE units, `<prefix>` being
  `ficus-box-<user>` (system mode) or `ficus-sandbox-server` (user mode):
  - `<prefix>.socket` holds `127.0.0.1:<boxPort>` forever and is the only unit
    that is enabled. Core's tunnel forward always finds a listener.
  - `<prefix>-proxy.service` (`systemd-socket-proxyd --exit-idle-time=30s`) is
    what the socket activates; it `Requires=` the server, so the first
    connection after an idle exit brings the server back (~1–2s cold start,
    well inside Core's health budget). An `ExecStartPre` waits for the server's
    socket to appear, because socket-proxyd does not retry a refused backend.
  - `<prefix>.service` is the server, bound to a **unix socket**
    (`EXECUTOR_SOCKET`) rather than the port. It exits 0 after
    `EXECUTOR_IDLE_EXIT_MS` (10 min) only after startup reconciliation has
    settled and there are no request reservations, live foreground Bash
    invocations, open shells, or active watchers. Request admission and drain
    are serialized before body parsing or process creation; once drain wins,
    later requests receive retryable 503 responses and cannot spawn. Health
    probes are ordinary activity, never a safety mechanism. The non-delegated
    service cgroup uses `ExitType=main` and `KillMode=control-group`.
    Service-cgroup ownership is marked by the unit's ExecStart switch
    (`--service-cgroup`) — argv is owned by the root-installed unit, so
    configurable `host.env`/`server.env` content (systemd `EnvironmentFile=`
    inputs, which override `Environment=` values regardless of unit order)
    cannot disable the census. Before a
    managed idle exit, the server counts residual cgroup children without
    inspecting their identities or commands, emits one numeric warning, and
    leaves cleanup to systemd; an unavailable census defers exit. Measured
    2026-09-01 on a test host: 39 idle servers held 1,672 MB, which this
    reclaims.
  - Core reads this as three liveness values: socket up + server up =
    `running`; socket up + server down = `idle` (**healthy**); no socket (and no
    legacy user unit) or a `failed` server = `exited`. The 60s keep-warm tick
    learns the whole picture in ONE `ss -ltnH` per machine and passes a
    `listening` hint down, so it never HTTP-probes — and so never wakes — an
    idle box. Request-path ensures still probe: waking is what they want.
  - Park (`stopBox`) takes all three down, socket first; resume starts the
    socket and restarts the server.
    The foreground-only contract is explicit:

| Event                           | Foreground Bash                      | Detached child                    |
| ------------------------------- | ------------------------------------ | --------------------------------- |
| idle window, no probes          | keeps server alive                   | unsupported; warning, then killed |
| clean idle, no work             | server exits 0                       | n/a                               |
| next socket request             | server restarts                      | not recovered                     |
| park/restart/migrate/remove/OOM | cancellation and cleanup rules apply | no survival promise               |

Completion-critical work must stay in one foreground Bash request with a timeout up to 3,600 seconds. `&`, `nohup`, `setsid`, `disown`, hand-launched tmux, and one-shot monitors are not durability mechanisms.

- **Unit modes** (`box-provision.sh --unit-mode`, derived from the sandboxId
  prefix and mirrored by box-manager's `boxUnitControl` seam):
  - `agent_*` → **system**: one root-owned
    `/etc/systemd/system/ficus-box-<user>.service` with `User=`/`Group=<user>`
    and its own `ficus-box-<user>.slice` (which carries the per-box
    memory/CPU/tasks limits). **No linger**, so a light box costs no
    `systemd --user` manager + dbus pair — measured 2026-09-01 on a test
    host at ~13 MB per box across 45 managers.
  - `squad_*` / `system_manager_*` (and any unknown legacy id) → **user**:
    the lingering `ficus-sandbox-server.service` in the box user's own manager,
    with limits on `user-<uid>.slice`. Required by **rootless docker**, whose
    daemon is itself a user service on `/run/user/<uid>/docker.sock` —
    `--with-docker` with `--unit-mode system` is rejected outright.
  - A box whose mode changed is migrated on its next provision: the script
    detects the other layout ON DISK and tears it down (stop, disable, remove
    the unit + slice drop-in, drop linger) before installing the new one.
- **Tunnels** are multiplexed over ONE SSH ControlMaster per machine
  (`tunnel-manager.ts`). Core reaches a box over a local `-L` forward; a box
  reaches Core over a `-R` reverse forward.

## Machine prerequisites

A machine must be:

- **Ubuntu 24.04 LTS.** `bootstrap.sh` and `box-provision.sh` target systemd
  255 / bash 5.2 only. Other distros are out of scope and untested.
- **Reachable over SSH as root, or as a passwordless sudoer.** Bootstrap and
  per-box provisioning install system packages, write `/opt/ficus`, and manage
  other users' systemd `--user` managers via
  `systemctl --machine=<user>@.host --user`, all of which need root.
- **sshd with `AllowTcpForwarding yes`** (or `all`/`local`/`remote`). Forwarding
  is the entire transport: a machine with `AllowTcpForwarding no` **cannot** host
  a tunnel-reached box and is rejected loudly at ensure (see Troubleshooting).
  `bootstrap.sh` probes this **definitively** and records it in the machine's
  `capabilities.forwarding`. The probe is a decision ladder: (1) `sshd -T`
  effective config (via sudo) when available → its explicit `yes`/`no`; (2) when
  `sshd -T` is unavailable — observed live on exe's exeuntu sshd — an **empirical**
  loopback self-test (`ssh -o ExitOnForwardFailure -L` back into the local sshd,
  reporting `yes` if the forward carries data, `no` if the channel is refused);
  (3) if even that can't run, grep the config files for an explicit
  `AllowTcpForwarding no` → `no`, else OpenSSH's compiled-in default `yes`. A
  reachable host therefore **never** reports `unknown` (the old blanket fallback
  that let a forwarding-disabled host slip through as usable).

**Docker** (optional, per box): a machine that will host squad / system-manager
boxes needs the Docker engine + rootless launcher installed. `bootstrap.sh`
installs `docker-ce` + `docker-ce-rootless-extras` from Docker's apt repo and
**masks** the shared rootful `docker.service`/`docker.socket` — no shared daemon
ever runs. Each box then gets its OWN rootless dockerd (see § Per-box rootless
docker). The machine's `capabilities.docker` probes to `"rootless"` when the
rootless launcher is present and the kernel permits unprivileged user namespaces
(Ubuntu 24.04 default), else `"none"`.

**Egress** (optional, opt-in per machine): when a machine's `egressPolicy` is
set, `bootstrap.sh --egress-lockdown --core-cidr <cidr>` installs nftables rules
that lock the machine's outbound traffic down (see § Egress model). Off unless
the machine opts in.

**Toolchain (nix + devbox)**: `bootstrap.sh` installs a pinned `bun`, plus **nix**
(MULTI-USER daemon mode) and **devbox** (the pinned release binary at
`/usr/local/bin/devbox`). Multi-user nix is required because one machine hosts many
unprivileged box users and only the root-owned, socket-mediated store lets any of
them realize store paths — a single-user store serves only its one owner. `nix` is
also symlinked onto `/usr/local/bin` so it is reachable from the sandbox-server's
**non-login** box shell (which never sources nix's login-only profile entry). This
is what makes the per-box devbox comfort-set seeding (§ Devbox comfort-set seeding)
work with no operator setup.

## Prebaked box image + fast bootstrap

`bootstrap.sh` on a bare Ubuntu host installs the whole toolchain (apt base +
rootless-docker prereqs, Docker engine, bun, multi-user nix, devbox) — a
multi-minute cost dominated by the nix install and the release downloads. The
**`ficus-machine` image** (`packages/machine-image/Dockerfile`) bakes exactly that
toolchain — same pinned versions, same paths — on top of exe.dev's base image, so
a VM booted from it needs to install nothing. See § exe.dev in
`docs/wiki/machines/exe-provider.md` for how the exe provider boots box VMs from it.

**How bootstrap fast-paths it.** The image writes a marker file
`/opt/ficus/prebaked` — JSON recording the pins it baked
(`{"bunVersion","nixVersion","devboxVersion"}`). Near the top of a run,
`bootstrap.sh` reads it (via `jq`, baked into the image; grep/sed fallback):

- **Marker present** (a VM booted from the ficus-machine image) → SKIP every
  install step (`install_base_packages`, `install_docker_packages`,
  `install_bun`, `install_nix`, `install_devbox`) and use the baked tooling.
  PRESENCE — **not** an exact version match — is the source of truth: a prebaked
  image is **never reinstalled over at boot**. Skipping the `apt-get update` +
  release downloads + version probes is what turns a multi-minute bootstrap into
  a **seconds-long** one.
  - **All three baked versions equal the script's `BUN_VERSION` / `NIX_VERSION` /
    `DEVBOX_VERSION` pins** (the healthy case) → a plain fast-path log line, no
    warning.
  - **A baked version DRIFTS** from the script's pins (a stale image whose baked
    toolchain predates a pin bump) → **still skip the installs and boot on the
    baked tooling**, but log a `WARNING` per drifting tool naming the drift and
    recommending an image rebake (e.g. `prebaked image nix 2.24.9 != script
2.25.0 — using baked tooling; rebake the ficus-machine image to change pinned
versions`). bootstrap does **not** attempt to reinstall over the baked
    tooling: the official nix installer refuses to run over an existing `/nix` and
    would error under `set -e`, aborting the whole run and marking the VM
    `unreachable` — so a naive "upgrade on drift" would **brick** a prebaked
    machine on a `NIX_VERSION` bump. Changing a pinned version on a prebaked image
    is therefore done by **rebaking + republishing the image**, not by a boot-time
    reinstall; the machine keeps booting normally on the baked tooling until then.
- **Marker absent** (an ordinary BYO-SSH host) → the full install path,
  **byte-for-byte unchanged**. The fast-path is an optimization, never a
  dependency.

**What still runs on the fast path** — the skip covers _only_ the installs. The
genuinely per-machine / per-boot work always runs, prebaked or not:

- `make_dirs` (harmless when the dirs are already baked),
- the **manifest write** (`/opt/ficus/manifest.json`, stamped with the caller's
  `--version` bootstrap hash — deliberately NOT baked into the image),
- the **egress lockdown** (`--egress-lockdown` nftables rules) when the machine
  opts in,
- the **capabilities probe** (`print_capabilities` — arch/cpus/mem/disk/kernel +
  the docker + forwarding probes above), which reflects THIS VM.

So a fast bootstrap produces the identical `machines` row (manifest, caps,
egress) a full bootstrap would — it just skips the redundant installs. The
manager still re-pushes the current `box-provision.sh` regardless (the image
bakes a copy, but the manager overwrites it with the running version).

`box-provision.sh` is ALSO a registered machine artifact (content-hashed, first
in `MACHINE_ARTIFACTS`), so bootstrap is only its first delivery. Every later
`ensureMachineArtifacts` re-pushes it when the checked-in script changes, which
is what lets a new script MODE reach machines already in the fleet without a
re-bootstrap — `--restore-stream` is exactly that case, and a migration ensures
the destination's artifacts before it streams.

An operator re-bootstraps machines from the tenant Core VM, without an admin
token, with the bundled entrypoint (run from the Core install root, where Bun
loads Core's `.env`):

```bash
FICUS_MB_MACHINE=<machineId>|all-stale bun current/apps/core/dist/machine-bootstrap.js
```

It claims and bootstraps each machine exactly as `POST /api/machines/:id/bootstrap`
does — `all-stale` takes every `ready` or `unreachable` machine whose stored
`bootstrapVersion` differs from the running Core's — and prints one
`MACHINE_BOOTSTRAP <id> ok` or `MACHINE_BOOTSTRAP <id> failed <reason>` line per
machine. It exits 1 if any failed and 2 for an unknown machine id.

## The ensure flow

`VmSandboxManager.ensureSandbox(sandboxId, opts)` →
`box-manager.ensureBox(...)`. The order is load-bearing:

1. **Resolve the machine once.** Honor an explicit `machineId` pin (agent/squad
   row) or a live box's recorded machine; otherwise apply placement (below). The
   SAME machine is used to build the box's callback URL, so the box and its
   reverse tunnel never land on different machines.
2. **Guard forwarding.** If `machine.capabilities.forwarding === 'no'`, throw
   `MachineUnusableError` BEFORE any mutation.
3. **Validate the caller env.** Reject bad keys or newline-bearing values (this
   is a systemd `EnvironmentFile`) before touching the machine.
4. **Fast path.** A box already `ready` on this machine that still answers
   `/healthz` — and whose row carries an executor auth token — is returned
   as-is, no re-provision. Health is checked every time. A legacy row with no
   token (pre-hardening) deliberately misses the fast path ONCE so the full
   path below mints + delivers its token (and the current server bundle).
5. **Provision.** `ensureServerBundle` (push the bundle if the machine's
   recorded version is stale) → `bindMachineBox` (allocate the box's port +
   mint its auth token atomically) → `box-provision.sh` (create the user, dirs,
   and the lingering systemd unit — enabled but deliberately NOT started: the
   unit fails closed until `server.env` lands, see the hardening section) →
   push `~/.ficus/server.env` (**mode 0600**, chowned to the box user) → restart
   the unit (its first real activation, with token + bind already in place) →
   establish the ControlMaster + `-L` forward → poll `/healthz` (bounded: 240s default, `FICUS_BOX_HEALTH_BUDGET_MS`; a "still waiting" progress line every ~20s)
   → mark the box row `ready`.
6. **Sync files.** Push the k8s-PVC-equivalent artifacts over the box's own
   `/write` endpoint (so the box user OWNS them): the `ficus` CLI → `~/bin/ficus`
   (0755), materialized skills → `~/.ficus/skills`, squad `.env` →
   `~/workspace/.ficus/.env` (0600), `identity.pem` → `~/.private/identity.pem`
   (0600), and a read-only memory replica → `~/memory`. A failure after a secret
   write best-effort removes the partial secret, so a half-provisioned box never
   lingers with readable key material.

`ensureSandbox` is idempotent and deduped in-flight; re-ensuring a healthy box
is a no-op past step 4 (plus the file re-sync in step 6).

### Executor auth + loopback bind (cross-box hardening)

Boxes are co-located unix users on a shared machine, so the sandbox-server
itself is a security boundary. Two per-box env vars in `server.env` harden it.
The auth token is the **sole** cross-box boundary: every process on the machine
shares the loopback interface regardless of uid, so a loopback bind cannot stop
box_A from connecting to box_B's `127.0.0.1:<port>` — the bind only removes
off-machine exposure (defense-in-depth).

- **`EXECUTOR_AUTH_TOKEN`** — a 32-byte random token, persisted on the
  `machine_boxes` row (`auth_token`; both core processes must present it, and
  the API routes strip it), and pushed only into the box's **0600**
  `server.env` — siblings cannot read it. It is minted **atomically inside
  `bindMachineBox`**: each bind generates a candidate but the upsert keeps an
  existing token (`COALESCE(auth_token, excluded.auth_token)` — first writer
  wins, never overwritten), so two concurrent full ensures of the same
  brand-new box (api + worker) observe the SAME token and cannot wedge the box
  on a token the running server does not enforce. The server 401s every route
  except `GET /healthz` unless the request carries
  `Authorization: Bearer <token>`; `SandboxClient` sends it on every HTTP
  request and on the `/shell` WS upgrade. Enforcement is **conditional on the
  env var being set**, so k8s pods (which never set it) and legacy vm boxes
  (server.env pre-dating the token) are unaffected until their next full
  provision delivers it. The token is stable across ensures (reused from the
  row), so a re-provision never invalidates the other process's live client.
- **`EXECUTOR_BIND=127.0.0.1`** — the box is only ever reached via the SSH
  `-L` forward, which connects to loopback ON the machine, so the server does
  not listen on non-loopback interfaces at all. This is off-machine hardening
  only; co-located boxes still share loopback (isolation there is entirely the
  token's, above). k8s pods keep the `0.0.0.0` default (they are reached over
  pod networking).

**Fresh provisions fail closed.** `box-provision.sh` enables the unit but never
starts it — the first real activation is box-manager's post-`server.env`
restart, so the server only ever boots with token + bind already in place. And
the server itself refuses to start (exit 1) when it detects a VM boot without a
token: `FICUS_BOX_PORT` (baked into the unit itself, present even before
`server.env` lands) or `EXECUTOR_BIND` set while `EXECUTOR_AUTH_TOKEN` is not.
A prematurely-activated unit therefore crash-loops harmlessly instead of
serving an unauthenticated executor on `0.0.0.0` for the provision window —
previously that window stayed shut only by accident (the bun-pty `dlopen` of
`BUN_PTY_LIB`, also server.env-only, crashed the import first). Neither marker
is set on k8s/docker, which keep the legacy no-enforcement path.

`box-provision.sh` additionally `chmod 700`s the box HOME on every provision
(Ubuntu `useradd` leaves 0755), closing sibling reads of `~/memory`,
`~/.ficus/skills`, `~/bin`; re-provisioning an existing box tightens it too.

## Tool paths: logical roots rebased to the box HOME

The vm runtime drives the **same** client-based coding tools the k8s runtime
uses (`createK8sSandboxedCodingTools`, `squad_bash`), and those tools address
k8s **logical** container roots — `/private`, `/workspace/<squadId>`,
`/memory[/<squadId>]`. In a k8s pod those are real mount points; on a box they
are literal, root-owned machine paths the box user cannot touch. So the
**sandbox-server rebases** them onto the box's physical HOME layout, transparent
to Core's tools (`packages/sandbox-server` `resolvePath` for `/read`/`/write`/`/stat`
and the `/bash` `cwd`):

| logical root             | box path (`$FICUS_BOX_HOME` = `~`) | where it's provisioned / synced          |
| ------------------------ | ---------------------------------- | ---------------------------------------- |
| `/private`               | `~/.private`                       | box-provision dir; `identity.pem` synced |
| `/workspace[/<squadId>]` | `~/workspace`                      | box-provision dir; squad `.env` synced   |
| `/memory[/<squadId>]`    | `~/memory`                         | materialized by the memory file sync     |

The `/<squadId>` namespace segment **collapses**: a box holds exactly one squad's
tree directly under `~/workspace` / `~/memory` (file sync writes
`~/workspace/.ficus/.env`, not `~/workspace/<squadId>/.ficus/.env`), so the box's own
`FICUS_SQUAD_ID` segment is stripped during the rebase. Rebasing is gated on
`FICUS_BOX_HOME`, which **only** vm boxes set (box-manager `derivedBoxEnv`); k8s
pods and docker sandboxes never set it, so their path handling is byte-identical
(a parity snapshot in `paths.test.ts` locks this). The rebase is security-safe:
paths are normalized (`path.resolve`, collapsing `..`) **before** the prefix
match, and the result must still fall under an allowed prefix — a traversal or a
sibling box's HOME (`/home/box_other/...`) is rejected, not silently escaped.

Manager-level `exec` / `spawnShell` already run against the box-native work root
(`~/workspace` or `~/.private`), so those never needed rebasing; the rebase closes
the gap for the per-agent session tools and `squad_bash`.

## Park / stop / remove semantics

- **Park (`stopBox` / `stopSandbox`).** Stop the box's systemd unit and cancel
  its `-L` forward; mark the box row `stopped`. **On-disk state persists** —
  the home, `~/workspace`, and `~/.private` are untouched, so a later ensure
  resumes the box in seconds (start unit + retunnel), not the minutes an
  image-pull + pod-boot costs. **Park is reversible** — this is exactly what the
  idle-policy loop (§ Lifecycle below) does to an inactive box, and exactly what
  a later ensure undoes.
- **Unverified park recovery.** If the recorded machine is not ready, Core writes
  `stop_unverified`; that is a logical stop intent, not proof the remote unit is
  down. Chain health therefore reports an unknown box server and the raw machine
  view retains the distinct marker. The minute lifecycle tick verifies the unit
  stop and removes the forward if the same machine becomes ready. After five
  minutes continuously non-ready, it atomically detaches the logical sandbox ID
  into an `orphaned` retirement-remnant row carrying the original sandbox
  identity plus the exact old machine, Unix user, and port. Dormancy then settles
  on a later attempt; only a subsequent wake may place a replacement. If the old
  machine later becomes ready, its exact remnant is archived under the original
  owner and removed without touching the replacement. A returning sole machine
  attempts that remnant retirement inline before replacement and restores the
  archive produced by that exact recovery. Ordinary fresh boxes never restore
  unrelated historical snapshots. When replacement occurs
  while the old host is still unavailable, its `/private` remains there until
  recovery and is then preserved in the owner-attributed archive; it is not
  silently merged into an already-running replacement. That recovery artifact
  remains available only for `AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS`, including
  when the owner has already returned to a live state. Operators should
  first prove the old host is powered off or quarantined, persist it as
  `unreachable` via the machine check API, clear/repoint any explicit machine
  pin, and retry. If it will never recover, `DELETE /api/machines/:id` terminates
  and forgets the machine; its cascade discharges the retained remnant so the
  fleet is not held indefinitely. Never forge `machine_boxes.status='stopped'` or delete the row:
  that can create two live incarnations and discard the cleanup pointer.
- **Remove (`removeBox` / `removeSandbox`).** **Teardown, not reversible.** Cancel the tunnel, optionally pull
  the box's `~/.private` as a gzip'd tar into Core's private-archive root
  **before** teardown, then `box-provision.sh --remove` (which archives the
  whole home machine-side as belt-and-braces, then `userdel -r`), then delete the
  box row. Agent/system-manager boxes archive their `~/.private`; squad boxes
  (shared workspace, nothing per-remove to keep) do not.
- **Archive sweeping.** Core-side archives are written as
  `<sandboxId>-<epochMillis>/private.tar.gz` — a per-archive directory named for
  its trailing epoch. The existing private-archive janitor
  (`purgeExpiredAgentPrivateArchives`) sweeps entries whose name matches
  `/-(\d+)$/`, exactly as it does for k8s agent archives. Machine-side archives
  under `/opt/ficus/archive` are the reconciler's concern.

## Lifecycle: idle reap, machine health, orphan reconcile

The vm runtime has a periodic **`vm-sandbox-lifecycle`** subsystem
(`services/sandbox/vm/lifecycle.ts`) — the vm-runtime counterpart to the k8s
manager's 60s reconciliation loop. It is gated `isVmRuntime()` (inert, not
even registered, on the k8s/docker runtimes) and registered on
`createPeriodicRunner` at a **60s** interval, with a first pass kicked
immediately at worker boot (before the first scheduled tick). Each tick runs
four independently-wrapped sub-steps — one step failing (e.g. a
machine-health probe error) logs and does **not** skip the others — guarded
against overlap by a re-entrancy flag (a tick already in flight skips a
concurrent invocation rather than running two passes at once):

1. **Idle reap.** Enumerate every box **from the database**
   (`listAllMachineBoxes` — a single query across all machines, not process
   state) and decide per box whether to park it, via the pure decision rule
   `shouldParkBox` (`services/sandbox/vm/idle.ts`). A box is parked
   (`stopBox` — never `removeBox`; idle reaping only ever parks) iff **all**
   of:
   - its DB row status is `ready` (a mid-provision/`stopped`/`orphaned` box is
     never touched here — the authoritative gate is the DB row, not any
     in-memory view);
   - it is not `alwaysOn`;
   - **this process has activity data for it** (see the single-worker caveat
     below — an untracked box is skipped, never reaped on a guess);
   - the keepalive predicate does not want it kept warm (mirrors the k8s
     manager's `buildIdleKeepAliveChecker`: kept warm while it has an active
     local deployment (`hasActiveLocalDeployments`) OR its work stream has a
     recently-active member (`hasRecentWorkStreamActivityForSandbox`));
   - it has been idle strictly longer than its timeout.

   **Per-role idle timeouts** (seeded into the box's tracked lifecycle state
   at ensure, from `opts.k8s.idleTimeout`/`opts.k8s.alwaysOn` — see
   `ensure.ts`):
   - **Agent** boxes: fixed **30 minutes** (`AGENT_IDLE_TIMEOUT_MS`), never
     `alwaysOn`.
   - **Squad** boxes: **60 minutes** by default, overridable per squad via
     `sandboxConfig.idleTimeoutMinutes`; `alwaysOn` when
     `sandboxConfig.alwaysOn` is set (an always-on squad is never parked for
     inactivity, full stop).
   - **Default fallback** (`DEFAULT_IDLE_TIMEOUT_MS`, **15 minutes**): used
     when a box's ensure call did not pass an explicit `idleTimeout`.

2. **Machine health.** `sweepMachineHealth` probes every `ready`/
   `unreachable` machine (`probeMachineHealth`): a live SSH ControlMaster is
   trusted directly as proof of reachability; otherwise the machine's
   provider is asked (`provider.status()`; a BYO-SSH machine's probe is a
   real `ssh … echo ok` round-trip). `gone` flips the machine to
   `unreachable`; a reachable probe flips it back to `ready` — so a machine
   that comes back up is detected and resumes hosting on the next ensure.
   Only machines already `ready`/`unreachable` are touched; a `parked` or
   `terminated` machine (an operator's explicit state) is left alone, and a
   still-`bootstrapping`/`registered` machine is left alone so the sweep never
   races provisioning. `lastSeenAt` is stamped only when a persisted probe
   finds the machine ready (liveness watermark, mirroring POST /:id/check).
3. **Orphan reconcile.** `reconcileOrphanedBoxes` reclaims `machine_boxes`
   rows stranded on a **dead** machine (`unreachable`/`terminated`/row
   absent) whose **owner is terminated** (`agent.terminatedAt` set/missing,
   or `squad.archivedAt` set/missing; a `system_manager_*` box is never
   considered owner-terminated — it is a process-lifetime singleton). Both
   conditions must hold: a box on a dead machine whose owner is **still
   active** is left untouched — `ensureBox` already re-places a live box onto
   a healthy machine the next time its session runs, and reclaiming it here
   mid-session would be data loss. When both hold, the row is marked
   `orphaned` (durably, before any teardown attempt — a best-effort remote
   teardown on an unreachable machine can fail, and the marker must survive
   that so the row is never mistaken for live and is retried next pass), then
   torn down best-effort (private archived for agent/system-manager boxes,
   not squad boxes, mirroring normal removal).
4. **Spec drift + warm.** `reconcileSquadSandboxSpecs` (recreates an
   always-on squad box whose immutable spec drifted) plus the two
   runtime-agnostic warmup passes (`warmupActiveSquadSandboxes`,
   `warmupWorkStreamAgentSandboxes`) — reused verbatim from the k8s policy
   modules; nothing vm-specific here.

### Single-worker / DB-driven caveat

The idle reaper enumerates boxes from the database, but a box's **activity
timestamp** (`lastActivityAt`) lives only in the vm manager's in-memory
lifecycle state (`getLifecycleState`), which is empty right after a Core
restart or for any box this specific worker process never `ensure`d. For such
an **untracked** box `lastActivityAt` is `undefined`, and `shouldParkBox`
treats that as "unknown, never reap on a guess" — it is skipped by the idle
reaper entirely, not parked and not assumed idle. This mirrors the k8s pod
manager's identical care. An untracked box is not orphaned by this: it still
gets machine-health-swept and, if its machine is genuinely dead and its owner
terminated, orphan-reconciled; if its owner is still active, the box is
picked up and its lifecycle state re-seeded the next time that owner's
session calls `ensureBox` (fast path if the box is already healthy, full
re-provision otherwise). In short — a box this process doesn't track for idle
purposes is never wrongly reaped; it is reconciled or re-ensured instead.

## Placement

`box-manager.ensureBox` resolves a box's machine via
`resolveMachineForBox` → `placement.ts`'s `resolvePlacement`
(`services/machines/placement.ts`), in precedence order:

1. **Pin.** An explicit `machineId` on the agent/squad row → that machine (must
   be `ready`, else `MachineUnavailableError`). Set it via `PATCH /api/agents/:id`
   / `PATCH /api/squads/:id` (`machineId: string | null` in the body — `null`
   unpins) or via the dedicated `POST /api/agents/:id/machine` /
   `POST /api/squads/:id/machine` endpoints; see § Pin + migrate below for how
   the write paths differ and how a live box moves.
2. **Sticky.** A box that already has a recorded machine sticks to it while that
   machine is `ready` — re-running placement could otherwise repoint the row and
   orphan the old machine's user + unit + forward.
3. **`dedicated`.** A box requesting `dedicated: true` gets a freshly
   provisioned VM of its own — **requires the exe provider** (BYO-SSH machines
   are registered by an operator, never auto-provisioned by ficus); no exe
   provider configured → `DedicatedPlacementUnavailableError`.
4. **No cloud provider (BYO-only).** When the exe provider isn't registered
   (no `exe-provider-token` configured — see `docs/wiki/machines/exe-provider.md`),
   every box — regardless of role — falls to the **least-loaded ready shared
   machine**: the `ready` `scope:'shared'` machine with the fewest boxes
   (`COUNT(machine_boxes)`), ties broken deterministically by `createdAt` then
   `id`. Zero ready shared machines → `MachineUnavailableError`. This is
   byte-identical to the pre-exe (slices 1-4) behavior.
5. **Squad-per-VM.** With the exe provider available, a `squad` box — or an
   `agent` box carrying a `squadId` (an agent collaborating within a squad) —
   shares ONE exe VM per squad: `findReadySquadMachine(squadId)` reuses an
   existing one; a miss provisions a fresh exe VM tagged `purpose:'squad'`,
   `squadId` set, subject to the provisioning cap (below).
6. **Commons singleton.** A solo `agent` (no `squadId`) or a
   `system-manager` box, with the exe provider available, lands on the
   tenant's ONE singleton commons VM (`purpose:'commons'`) —
   `findReadyCommonsMachine()` reuses it if it exists, otherwise provisions it
   once, subject to the cap.

Steps 3/5/6 provision through the shared `provisionCapped` helper: mint a
keypair, `provider.provision(...)` (injecting ficus's public key —
UNVERIFIED for exe, see `docs/wiki/machines/exe-provider.md`), insert the row,
`bootstrapMachine` it so it comes back `ready` (a box can only land on a
bootstrapped machine). Reusing an existing squad/commons machine (the "else"
half of steps 5/6) is never cap-blocked — only a genuinely NEW provision
counts against the cap.

**Provisioning cap (`FICUS_MAX_MACHINES`).** Placement never silently
over-provisions: before any new machine is created, the live fleet size
(`countMachines()` — every row, since a terminated machine's row is deleted
rather than retained) is checked against `FICUS_MAX_MACHINES` (default **20**,
`DEFAULT_MAX_MACHINES`). At or over the cap, provisioning is refused with a
structured `MachineProvisioningCapError` rather than silently queuing or
degrading placement — raise the env var or free a machine.

**Purpose + squad_id columns.** `machines.purpose` (`'shared' | 'squad' |
'commons' | 'dedicated'`, default `'shared'`) records WHY a machine exists —
distinct from `machines.scope` (`'shared' | 'dedicated'`), which records
placement _eligibility_ for the least-loaded query. Every pre-slice-5 machine
backfills to `purpose:'shared'`, preserving old placement behavior exactly.
`machines.squad_id` (nullable, not an FK — a machine can outlive or pre-date a
squad row, and placement only ever equality-matches it) is the squad-per-VM
reuse key, set only on `purpose:'squad'` rows.

**Provider selection.** A machine's `provider` column (`'ssh' | 'exe'`)
determines who provisions/terminates/parks/resumes it (`getMachineProvider`
registry). `'ssh'` (BYO) is always registered; `'exe'` is registered only when
`exe-provider-token` is configured — see
[`docs/wiki/machines/exe-provider.md`](exe-provider.md) for credential setup,
the pubkey-injection mechanism, cost model, and — because exe.dev's real API
was never confirmed against a live account — the complete UNVERIFIED-API
inventory a credentialed human must validate before relying on the exe path
in production. Placement is fully autonomous and tested without exe (steps
5/6 simply never trigger; every box takes the BYO least-loaded path), so the
absence of exe credentials degrades gracefully rather than breaking anything.

**Single-worker provisioning race-safety.** Provisioning is a check-then-act
(count the fleet, look for an existing squad/commons machine, provision on the
miss). Like the rest of the VM runtime, ficus runs one worker, so two placement
calls for the same tenant never run concurrently — a future multi-worker
deployment would need an advisory lock around the provision step; the cap and
the `(purpose, squad_id)` reuse key bound the blast radius until then.

## Pin + migrate: moving a box to a specific machine

An operator (or the web Machines admin section) can pin an agent or squad to a
specific machine, overriding placement (§ Placement, rule 1). Every write path
validates the target through `assertMachinePinReady`
(`services/machines/pin.ts`) BEFORE the row is touched: `null` unpins with no
DB read; a non-null id must resolve to an existing `ready` machine or the
request is rejected with `MachinePinError` — a pin can never be set to a
missing or not-ready machine.

- **`PATCH /api/agents/:id` / `PATCH /api/squads/:id`** write the `machineId`
  column only. They do **not** move a live box — the box migrates lazily, the
  next time `ensureBox` runs for it.
- **`POST /api/agents/:id/machine` / `POST /api/squads/:id/machine`**
  (`machines:write`-gated) write the pin AND migrate a live box **now**:
  agents call `ensureAgentSandbox` once, which drives `ensureBox`'s own
  migrate-with-teardown branch (below); squads stop-then-start
  (`removeSandbox` then `ensureSquadSandbox`) to force the box off the old
  machine before re-ensuring on the new one. Both are best-effort — a
  migration failure does not roll back the already-written pin, so the row and
  the error are both visible even if the move didn't complete; retry via the
  same endpoint.

**Migrate-with-teardown (`box-manager.ensureBox`).** When an explicit pin
moves a box to a machine different from where its row currently lives
(`existing && opts.machineId && existing.machineId !== machine.id`), the OLD
box is torn down BEFORE the new one is bound — the same teardown `removeBox`
uses for a normal remove (cancel the tunnel, best-effort pull the
`~/.private` archive for agent/system-manager roles, `box-provision.sh
--remove`, delete the row) — so a pin change never leaves an orphaned Unix
user, systemd unit, or tunnel forward behind on the old machine (the
correctness gap flagged in the slice-5 review). Two guards keep this safe:

- **Old-machine-ready gate.** Teardown only runs when the OLD machine is still
  `ready`. If it's missing or not `ready` (the outage-recovery case — the box
  is being re-placed because its old machine died), teardown is **skipped**
  entirely and the box just rebinds on the new machine; SSHing a dead machine
  would throw and fail the whole ensure. **What this leaks:** the rebind
  repoints the `machine_boxes` row to the new machine and drops the stale
  tunnel forward, but the OLD machine's box-side remnants — the `box_<hash>`
  unix user, its `systemd --user` unit, and its home dir — are currently
  **NOT** reclaimed. The orphan-reconcile pass (§ Lifecycle, step 3) is
  **row-based**: it scans `machine_boxes` ROWS, and the rebind already moved
  the only row that pointed at those remnants, so the reconciler can no longer
  see them. If the old machine later comes back it keeps that leaked box user /
  unit / home indefinitely. Only the DB row and the tunnel forward are cleaned
  up here; a machine-side remnant sweep is a follow-up (§ Backlog). The same
  leak applies on a **failed teardown** (a `ready` machine that goes
  unreachable mid-teardown) and on the null-pin dead-machine re-placement path
  in `box-manager.ensureBox`.
- **Best-effort, never blocking.** The teardown call is wrapped so a
  mid-teardown failure (network blip, the old machine going away mid-call) is
  logged and swallowed, not rethrown — the code always falls through to bind
  on the new machine regardless of whether the old teardown succeeded.

Neither guard changes the null-pin, sticky (same-machine), or dead-machine
placement paths — migrate-with-teardown only engages on an explicit,
different-machine pin.

## Manual rebalance: re-packing live boxes

Placement (§ Placement) only ever decides where a **new** box goes, so a
`FICUS_UNIT_WEIGHT_*` / `FICUS_MACHINE_UNIT_CAPACITY` change can leave live boxes
co-located in ways the packer would now refuse. Manual rebalance
(`services/machines/rebalance.ts` on top of the `migrateBox` primitive in
`services/machines/box-migrate.ts`) re-packs the **existing** shared fleet so
its two placement invariants hold again:

1. **Unit budget** — the summed `unitWeightForSandboxId` of a VM's boxes stays
   within the machine unit capacity (with the packer's tolerated exception: a
   single non-squad box heavier than the capacity keeps its own VM — evacuating
   it would reproduce the violation forever).
2. **Squad exclusivity** — a `squad_` box shares its VM with nothing else.

**Squad boxes migrate by default; rebalance still never moves them.** A direct
`migrateBox` — `ficus machines migrate-box <sandboxId> --to <machineId>`, and the
primitive the platform's machine-host resize uses to evacuate EVERY box off a
host before destroying it — moves a squad box like any other. Pass
`migrateBox(..., { allowSquad: false })`, or `--skip-squad` on the CLI, to
refuse one instead.

Plain `rebalance` is unaffected: it only ever moves a squad's non-squad
co-tenants **off** its VM, never the squad itself. That is not this flag — its
PLANNER excludes squad boxes structurally (they are VM-exclusive anchors, and
only non-squad boxes are ever selected as movable), so rebalance behaviour is
identical whatever the default is.

Squad migration was originally opt-in because the archive path buffered a box's
whole state in core's memory as base64 — fine for an agent box's `~/.private`,
hopeless for a multi-GB `~/workspace`. Streaming removed that ceiling, and with
it the reason for the gate. (A squad workspace is "practically identical to an
agent's private workspace, just potentially a lot more files," which is why the
old immobility was a policy choice, not a hard constraint.)

A migrating squad box behaves like an agent box with two additions:

- **Durable state set.** The transfer leg carries both `~/workspace` and
  `~/.private` for every box role. This durability contract is independent of
  the role-specific `WORKSPACE_PATH`; consequently idle and never-run agent
  workspaces survive migration even though agents actively work in `~/.private`.
- **Deployment quiesce/restart.** Before the transfer, the squad box's local
  deployments are **actually terminated** (their managed processes killed, not
  just marked) so nothing is writing to `~/workspace` while it is tar'd — a
  failed stop aborts the move pre-archive (`quiesce-failed`, old box intact).
  After the move proves out (repoint + old teardown), the managed/restartable
  deployments are restarted on the target; a restart failure is logged, never a
  migration failure (the user can restart them). `~/memory` and
  `~/workspace/.ficus/.env` are re-materialized from core, so they are not
  archived. The quiesce marks a managed-always deployment `crashed` (not
  `stopped`) so it _stays_ restartable — but `crashed` is also the health
  poller's and `ensureSquadSandbox`'s restart trigger, so both consult the
  SAME `machine_boxes.migrating` fence before restarting (never a second flag)
  and skip while it's up; only `migrateBox`'s own post-move restart is exempt
  (`skipIfMigrating: false` — it already knows the row is repointed). If a
  migration aborts AFTER the quiesce (e.g. `quiesce-failed`, `archive-failed`),
  the deployment sits down on the (still-authoritative) old box for one poller
  tick — up to `LOCAL_APP_HEALTH_POLL_INTERVAL_MS` (10s) plus its
  `LOCAL_APP_RESTART_COOLDOWN_MS` (30s) — before the fence is clear and the
  poller self-heals it there. Benign, by design: a short user-visible restart
  window, not data loss.
- **Exact manifest verification.** Before transfer, core inventories both durable
  roots with canonical path/type/mode/size/content digests. It scans the stopped
  source again after transfer and independently scans the target; any source
  change or target mismatch retains the source. Whole-host recreation additionally
  freezes the database roster and persists an operation receipt bound to both
  machine IDs, hosted generations, roster digest, and aggregate manifest digest.
  Core machine deletion and provider droplet deletion require that exact receipt;
  a same-size retry without pending evidence performs no historical deletion.
- **Streamed transfer (no materialization anywhere).** The state is NOT pulled
  back to core. The source's `sudo tar c` is piped straight over SSH into the
  destination's `box-provision.sh --restore-stream`, which extracts from stdin
  and re-owns/locks the members with the same helper `--restore` uses
  (`~/workspace` 0755, private trees 0700). Core's memory stays flat regardless
  of workspace size, and nothing is staged on core's disk or on either machine's
  (staging would need transient headroom equal to the workspace on both, and
  disk pressure is frequently _why_ a migration is running). The codec is agreed
  across BOTH hosts first — `zstd` when each proves a `--zstd` tar round-trips,
  else `gzip` (`FICUS_BOX_ARCHIVE_CODEC` pins a candidate, still verified) — so
  the codec that writes is always the codec that reads. This restore-only mode
  intentionally omits `--port`: it does not start or configure the sandbox
  server. A supplied port is still required to use the separate `--port VALUE`
  form and pass the normal 1024–65535 validation; a bare `--port` fails without
  consuming the following option, and `--port=VALUE` is not supported.
- **Fail-closed transfer.** A truncated stream must never look complete, so
  three independent signals must all agree: the SOURCE tar's exit status
  (primary — a `tar` fed a prefix ending on a member boundary extracts it and
  exits 0, so the destination alone cannot detect truncation), the DESTINATION
  restore's exit status (a compressed stream truncated anywhere fails its
  decompressor, and the script runs under `set -euo pipefail`), and a non-zero
  streamed byte count. A timeout or connection death is a failure too. Which
  END failed picks the reason, preserving the `archive-failed` (old machine
  unreadable) vs `restore-failed` (target write failed) distinction — but that
  attribution is a **best-effort guess, not a fact**, and the error says so.
  When the destination fails, core's pipe pump cancels the source's stdout and
  the source ssh dies of EPIPE, so BOTH ends exit non-zero, a shape
  indistinguishable from a truncated source (which also fails the destination's
  decompressor). Every failure therefore carries BOTH ends' exit codes and
  stderr tails, so whichever end is blamed the real cause is still legible. An
  **ambiguous** attribution is reported as `restore-failed`, never
  `archive-failed`: the two behave identically, and `archive-failed` renders to
  an operator as "old machine unreadable" — a guess must not name a machine.
- **Destination verification (replaces the old at-rest archive check).**
  Streaming removes the pulled file the old `tar tzf` floor check inspected. In
  its place the state dirs are measured FOUR times — both ends, on both sides of
  the transfer. _Before_ anything is provisioned, on the SOURCE (presence +
  owner/mode + top-level entry count; a squad with no `~/workspace` aborts as
  `archive-failed` with nothing provisioned). _After provisioning but before the
  stream_, on the DESTINATION, which must be present and EMPTY — `ensure_dirs`
  creates every state dir empty and nothing has written into them yet, so a
  non-empty one is a leftover tree from an earlier attempt whose best-effort
  teardown failed, and streaming onto it is refused. _After the stream_, on the
  SOURCE again and then on the DESTINATION: every state dir must exist, hold a
  top-level entry count within `[min, max]` of the TWO source readings, and be
  owned by the box user with the mode the restore promises (a root-owned
  `~/workspace` is a dead squad box). An unverifiable end — either one — is
  treated exactly like a failed one. Failure aborts as `restore-failed` with the
  old box untouched; this verifies the OUTCOME rather than the transport, which
  the old check could not do.

  Two details are load-bearing. The empty baseline holds NOT because assets
  avoid the state dirs — two of the five vm assets land inside them (the squad
  `.env` at `~/workspace/.ficus/.env`, the identity key at
  `~/.private/identity.pem`) — but because asset delivery goes through the box
  SERVER's HTTP API, `box-provision.sh` only `enable`s the unit and never starts
  it, and migrate never calls `syncBoxFiles` at all. Move asset delivery ahead
  of the stream and this invariant dies with it. And the source is measured
  TWICE because it stays LIVE across the move: minutes of artifact delivery
  (up to 2 min per file) and box install sit between the first reading and the
  tar, so a background build adding one top-level entry would otherwise abort
  the migration AFTER the whole multi-GB stream was paid for. The band between
  the readings absorbs that drift; the upper bound survives it, as the backstop
  for the stale-superset shape the empty baseline is the primary guard against.

- **Size budget (transfer AND teardowns).** Role-scaled: 30 minutes for a
  squad's potentially-huge `~/workspace`
  (`FICUS_BOX_MIGRATE_ARCHIVE_TIMEOUT_MS`), 5 minutes for an agent /
  system-manager box's `~/.private` (which holds its git trees;
  `FICUS_BOX_MIGRATE_AGENT_ARCHIVE_TIMEOUT_MS`). Neither is the SSH runner's 30s
  default — that bound exists for a HUNG box, not a fat one — but the agent
  budget stays an order of magnitude under the squad's, because rebalance moves
  boxes sequentially and one unreachable box must not stall the whole run for
  half an hour. The SAME budget covers both of a migrate's teardowns, because
  `box-provision.sh --remove` gzips the entire home before `userdel`: on the 30s
  default the teardown of a just-streamed multi-GB home times out, its tree
  survives on the target, and the empty-baseline check then refuses every LATER
  migration of that box to that machine — a permanent block rather than the one
  retry the baseline's rationale promises. The state-dir probes keep the runner
  default on every role (they are O(top-level entries)), so an unreachable
  machine still fails those fast.

**Idle boxes only; squad execution activity is included.** A non-squad box is
only moved when every owning agent is provably idle: the fence's activity probe
covers the agent **and its subagent descendants** (they share the parent's
sandbox), and for a `system_manager_<userId>` box **all** of that user's
system-manager agents. For `squad_<id>`, running and stopping executions block
migration even if their agent or subagent has since terminated. Queued rows do
not independently block: once migration owns the squad row lock, pickup cannot
claim them. Squad managers, workers, consultants, and squad subagents qualify;
top-level system-manager and artifact-builder executions remain personal-only.

Execution pickup locks every accessible box row (the private or inherited box
and, for capable squad runners, the shared squad box) in sorted order inside the
queued-to-running transaction. Thus pickup and migration cannot pass each other:
the winner's commit makes the loser defer or refuse. An `active-turn` refusal
may include only `activeExecutionCount`; it exposes no agent IDs or execution
content. Local deployments are quiesced separately before archive.

The activity probe is deliberately DB-only. An **in-flight `squad_bash`
command** is covered while its execution remains running or stopping, but an
untracked background process or build writing to `~/workspace` remains outside
the execution fence. That is the accepted residual: move a squad host when
non-execution background work is quiescent. A violation no legal move can fix
(two squads on one VM; a lone over-capacity squad) is surfaced as
`unresolvable`, not silently skipped.

**Progress + timeouts.** Because a squad `~/workspace` can be tens of GB, the
streamed transfer's SSH budget is raised well past the 30s default
(`FICUS_BOX_MIGRATE_ARCHIVE_TIMEOUT_MS`, 30 min default) — **squad moves only**:
rebalance moves boxes sequentially, so widening every box's budget would let
one hung agent box stall a whole rebalance for up to 30 minutes instead of
failing fast at 30s; the agent/system-manager path gets its own, much smaller
minutes-scale budget (`FICUS_BOX_MIGRATE_AGENT_ARCHIVE_TIMEOUT_MS`, 5 min
default). The state-dir probes on either side are
O(top-level entries) and deliberately keep the runner default on every role, so
an unreachable machine fails them fast instead of hanging for half an hour.
`migrateBox` reports
per-phase progress (`fence → stop-deployments → archive → provision → restore →
health → repoint → teardown → restart-deployments`) that the `migrate-box` route
streams as SSE and the CLI tails — as NDJSON under `--json` (one record per
phase, then the final result record) so a resize orchestrator driving the CLI
over SSH can tell which phase is running without waiting for the end. The phase
NAMES are unchanged by the switch to streaming (external orchestrators key off
them), but their content moved: `archive` is now the source-side measurement +
codec agreement (fast), and `restore` carries the whole streamed transfer plus
the destination verification (where the minutes are spent).

**The migrating fence.** `migrateBox` claims the box by setting `migrating` on
its `machine_boxes` row inside a transaction that re-checks activity under the
row lock — a turn that slips in first wins and the move is refused
(`active-turn`; rebalance reports these as `skippedActive`). While the fence is
up, execution pickup **defers** any queued turn for the box's owners instead of
starting it mid-move, and every exit path — success, structured failure, or
throw — lifts the fence, so a box is never left fenced. API startup clears stale
durable fences before migration/rebalance routes proceed; this recovery barrier
assumes the current single-API-process deployment. Multiple API replicas would
require leased fence ownership rather than unconditional recovery. Note the
idle/fence definition is **execution-based**: non-execution writes into
`~/.private` (e.g. a precompaction bake or file-sync) are not fenced, and a
write landing after the source is read is simply not migrated — rebalance when
the agent is quiescent.

**Forcing past the fence.** `ficus machines migrate-box --force <reason>`
requires an explicit bounded reason. The API additionally
requires `machines:force-migrate` and derives an attributable user/agent actor
from authentication; legacy and anonymous system-token identities fail closed.
Under the locked fence decision, core records actor, reason, request ID,
box/squad, source and target machines, and the exact running/stopping count on
the fence transaction's connection. The fence and started audit commit together
_before_ destructive work. Audit failure aborts the move. Terminal settlement is
first-writer-wins and row-count checked: an exact retry is idempotent, while a
missing or conflicting audit fails closed — except after a fence that threw,
which rolled its own started audit back, so a missing record there is expected
and the fence's error surfaces unwrapped. A successful audit settlement and box
repoint commit in the same transaction. API boot marks interrupted records
canceled with `api-restart` and a replayable failed result; if recovery races a
success, the loser observes the winner rather than overwriting it. Cancellation
is recognized from typed abort signals (including causal aborts), never error
message text. The single-API caveat above still applies to unconditional fence
recovery; audit race hardening does not add leased fence ownership.

Force exists only to evacuate a machine that is failing regardless. It bypasses
the active-execution refusal, not missing/unready boxes or a concurrent fence.
It is genuinely destructive: the source box is torn down after transfer, so
whatever live turns write after the archive is read is gone. There is no web-UI
equivalent by design — a second button beside a one-click Migrate is the wrong
affordance for an override that destroys live work.

**The transfer step (old box survives until the move is proven).** A move runs:
fence → (squad only: stop the box's local deployments) → measure the old box's
state dirs (`~/.private`, plus `~/workspace` for a squad box — the role-driven
set) → provision the new box on the target → **stream that state
source→destination before the new unit's first start** → verify the
destination's actual restored state → start + health-verify (including a
token-authenticated probe, since `/healthz` is auth-exempt) → repoint the
`machine_boxes` row → tear down the old box → (squad only: restart the managed
deployments on the target).
Any failure before the old teardown leaves the old box fully authoritative (the
freshly provisioned box is torn down best-effort); a teardown failure after the
healthy repoint is logged remnants — the move still succeeded.

**Dry-run is exact.** The planner (`planRebalance`) is pure — it reads the
fleet and returns `{ moves, skippedActive, unplaceable, unresolvable }` with no
effects — and the executing run (`rebalanceFleet`) executes exactly that plan,
so `dryRun: true` shows precisely what a real run would attempt. Evacuees are
chosen lightest-first from each violating VM and targeted best-fit against the
fleet's virtual state; when nothing fits, the plan groups evacuees onto the
fewest freshly provisioned shared machines (subject to `FICUS_MAX_MACHINES` —
past the cap they're `unplaceable`). The executing loop runs moves sequentially
in outbound-before-inbound order; one move's failure never aborts the rest, and
a fleet with no violations plans zero moves (idempotent).

**Long runs and connection loss.** A non-dry-run rebalance is one synchronous
HTTP request, and each move is a measure → provision → stream → verify SSH cycle
that takes minutes — a large plan can easily outlive the client or proxy
connection. That only loses the caller's per-move results: the server keeps
executing regardless. Re-running afterwards is safe — the loop is idempotent
and the per-box migrating fence prevents double-moves — and `--dry-run` shows
what (if anything) remains. Executes are single-flight per process: a second
non-dry-run request while one is running is refused with 409 (dry runs are
never blocked), since overlapping executes would each provision their own
fresh machines for their provision groups (duplicate billed VMs).

**Surface.** Both entry points are admin (`machines:write`) HTTP routes served
by `routes/machines.ts`, with `ficus machines` CLI wrappers:

- `POST /api/machines/rebalance` body `{ dryRun?: boolean }` → the plan (plus
  per-move `results` when executing, each stamped with the resolved
  `targetMachineId` — the machine actually provisioned for a `provision:<n>`
  planned target) — `ficus machines rebalance [--dry-run]`. 409 while another
  execute is running.
- `POST /api/machines/:id/migrate-box` body
  `{ sandboxId, allowSquad?, force?: { reason, requestId } }` moves one box
  onto machine `:id` and
  returns `migrateBox`'s structured result
  (`{ moved, reason?, activeExecutionCount? }`). CLI:
  `ficus machines migrate-box <sandboxId> --to <machineId>`, plus
  `--skip-squad` / `--force <reason>`.

VM runtime only (`isVmRuntime()`); on other runtimes the routes return an
error.

## Events: `machine.*` / `box.status` (admin-global)

The fleet is observable over the same WS EventMap/topic mechanism the rest of
ficus uses (`packages/shared/src/events.ts`, `ws-topics.ts`):

```
'machine.created': { machineId: string }
'machine.updated': { machineId: string }
'machine.status':  { machineId: string; status: string }
'machine.deleted': { machineId: string }
'box.status':      { sandboxId: string; machineId: string; status: string }
```

All five bridge to topic `'machines'` / instance topic `` `machines:${machineId}` ``
(`services/ws/bridge.ts`) and are emitted after the corresponding DB write:

- `routes/machines.ts` — `machine.created` after register-insert; on
  bootstrap/check, a real status transition emits `machine.status`, a
  non-transition update emits `machine.updated` (mutually exclusive, via the
  route's `emitMachineChange` helper); `machine.deleted` after the row is
  deleted.
- `services/machines/machine-health.ts` — `machine.status` on a `probeMachineHealth`
  ready↔unreachable flip (transition only, same as the route's bootstrap/check
  path).
- `services/machines/box-manager.ts` — `box.status` with `status: 'ready'` on
  a successful `ensureBox`, `status: 'stopped'` on `stopBox`, and
  `status: 'gone'` on `removeBox` (both the normal-teardown and
  machine-already-gone cases).

**Admin-global, not squad-scoped.** Machine/box events carry no `squadId`, and
`services/ws/topic-scope.ts`'s `'machines'` case returns `{ kind: 'unresolved'
}` for the `machines:<id>` instance topic — the WS layer has no cheap way to
check a subscriber's `machines:read` permission per-message, so it fails
closed. In practice this means only WS clients whose accessible-squad set
resolves to `'all'` (i.e., an admin) ever receive `machine.*`/`box.status`
messages; a non-admin client can subscribe to the bare `machines` collection
topic but never gets delivery on the instance topic. The web Machines admin
section relies on exactly this — it's gated `machines:read` in the UI, and the
underlying WS delivery independently enforces admin-only.

## Web admin: Machines settings section

`apps/web/src/components/settings/MachinesSection.tsx` (SettingsPage → Admin
group → 🗄️ Machines, gated `machines:read` to view / `machines:write` to
mutate — `SECTION_PERMISSIONS.machines` in `SettingsPage.tsx`) is the
operator-facing fleet UI:

- **Fleet list** — name, provider, status badge, purpose/squad, box count,
  last-seen, kept live via the Task-3 `QueryInvalidator` subscription to the
  `'machines'` topic (§ Events above) rather than polling; a light
  `refetchInterval` still runs while any machine is `bootstrapping`/
  `unreachable`, mirroring `ProviderAuthSection`'s conditional poll.
- **Register** — BYO-SSH (name/host/port/user) shows the generated public key
  once, with the instruction to add it to the target host's
  `~/.ssh/authorized_keys`; or `exe` (name/scope), which requires the
  `exe-provider-token` secret to be set first (see below).
- **Per-row actions** — Bootstrap, Check, Delete (confirm-gated; a machine
  still hosting boxes 409s on delete).
- **Assigning a machine to an agent/squad** (the pin) drives the
  `POST .../machine` endpoints above via `apps/web/src/api/machines.ts`
  (`setAgentMachine`/`setSquadMachine`).

**exe-token secret.** The exe.dev API token is registered like any other
credential, in `apps/web/src/components/settings/SecretsSection.tsx`, key
`exe-provider-token`, category `Machines` — on-demand (no restart required);
setting it is what makes the `exe` provider option (and squad-per-VM/commons/
dedicated placement) available.

**Mobile: deferred.** No mobile Machines UI shipped this slice — the
`liveUpdates.ts` seam that already carries other admin-ish live state makes
adding a mobile read surface (or a minimal pin-setter) a cheap follow-up when
prioritized; nothing in the backend design blocks it.

## Callbacks: how a box reaches Core

A box bakes `FICUS_API_URL` for its `ficus` CLI and callbacks:

- **Reverse tunnel is the DEFAULT**: `resolveBoxApiUrl` allocates one
  (`machineTunnels.addReverse(machine, corePort)`) and bakes
  `http://127.0.0.1:<remotePort>`, which the box's sshd forwards back to Core.
  The tunnel rides the same SSH connection Core already uses to reach the box,
  so it works whenever the box is reachable at all — immune to the box's
  egress/firewall/NAT and to public-LOOKING but gated/unreachable `APP_URL`
  hosts (which silently broke callbacks under the old hostname-reachability
  heuristic). A machine that disallows TCP forwarding can't host
  tunnel-reached boxes at all (Core's `-L` forward to the box's server needs
  forwarding too), so a functioning VM box's machine always supports the
  reverse tunnel.
- **Direct `APP_URL`** is only the degraded fallback when establishing the
  reverse tunnel fails; it is sanity-checked for http(s) validity only — never
  reachability. No tunnel and no valid `APP_URL` ⇒ the resolution throws,
  naming both causes.

Reverse tunnels have the same aliveness/purge semantics as forward tunnels: an
idempotent hit re-checks the master is alive, and a dead master purges the
machine's stale reverses so the next `addReverse` re-establishes a fresh port.

## Per-box rootless docker

A shared rootful `dockerd` is root-equivalent for every user in the `docker`
group (`docker run -v /:/host …` trivially reads every box's `~/.private`), which
is incompatible with the per-box privacy the runtime promises. So the vm runtime
**never runs a shared daemon** — `bootstrap.sh` installs the engine but disables
**and masks** `docker.service` + `docker.socket`. Each box that needs containers
runs its **own rootless dockerd** instead (spec §5):

- **Which boxes.** `box-provision.sh --with-docker` provisions the daemon;
  box-manager passes it for **squad** and **system-manager** roles (they run
  container workloads). **Agent** (light) boxes never run containers, so they get
  no daemon and no `DOCKER_HOST` — mirroring k8s, where the agent role skips the
  dockerd bring-up.
- **How it works.** `--with-docker` runs `dockerd-rootless-setuptool.sh install`
  as the box user and enables a `docker.service` **systemd `--user`** unit under
  the box user's linger. The daemon listens on `unix:///run/user/<uid>/docker.sock`;
  containers run inside the box user's own subuid/subgid namespace (auto-allocated
  by `useradd`, or allocated deterministically if missing), so a container escape
  lands in the _box user_, not root, and other boxes' files stay unreadable.
- **`DOCKER_HOST`.** The box user's uid is `useradd`-assigned and NOT
  deterministic, so `box-provision.sh` prints it once on stdout (`FICUS_BOX_UID=<uid>`);
  box-manager reads it (`parseBoxUid`) and bakes
  `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` into the box's `server.env`
  (`derivedBoxEnv`). The sandbox-server's docker path is gated on `FICUS_BOX_HOME`
  (set only by vm boxes): it never spawns rootful `dockerd` or `chmod 666`s a
  system socket — it only **verifies** the box's own rootless socket answers
  (`docker info`). k8s pods (sysbox) and local docker leave `FICUS_BOX_HOME` unset
  and are byte-identical to before (`packages/sandbox-server/src/docker.ts`).
- **Known workload gaps** (spec §5): no `--privileged` in the rootful sense,
  ports <1024 need a sysctl, some exotic network modes fail. These are inherent to
  rootless docker; the escalation tiers below cover workloads that truly need more.

**Escalation tiers (FUTURE — designed in spec §5, not built this slice):**

- **Dedicated-machine rootful.** A box whose workload genuinely needs rootful
  docker (or heavy DinD nesting) is _placed on its own VM_, where a rootful daemon
  is harmless because it owns only that VM. This is a placement setting on the
  agent/squad config, not new architecture — but the setter is not wired yet.
- **Docker-host machine.** A machine whose only job is a rootful daemon, with
  boxes pointing `DOCKER_HOST=ssh://` at it (build-farm / CI style). **Caveat:**
  bind mounts don't cross machines (`-v $PWD:/app` breaks), so it suits image
  builds and self-contained compose stacks, not mounted-workspace dev loops. Not
  implemented this slice.

A shared rootful daemon on a multi-box machine is **never** offered.

## Egress model

Egress lockdown is **machine-level and opt-in**: it governs the whole machine
(every box on it), not per box. Set a machine's `egressPolicy` and `bootstrapMachine`
runs `bootstrap.sh --egress-lockdown --core-cidr <cidr>`, which loads a dedicated
`table inet tau_egress` output-hook ruleset (idempotent — flushed + recreated on
each apply) reproducing `k8s/network-policy.yaml`'s egress intent:

- **Allowed:** loopback (`oif lo`), `established,related` return traffic, DNS
  (udp/tcp dport 53), every `--core-cidr` allow-exception, and — by the default
  `policy accept` — the public internet.
- **Dropped (IPv4):** the `denied4` interval set — RFC1918, CGNAT, loopback,
  link-local, the cloud-metadata `169.254.0.0/16`, and the other special-use
  ranges, byte-identical to the `except:` block of `network-policy.yaml`.
- **Dropped (IPv6):** the `denied6` set — `fc00::/7` (ULA, which subsumes both
  `fd00::/8` and the AWS IPv6 IMDS `fd00:ec2::254`) and `fe80::/10` (link-local,
  which subsumes the `fe80::a9fe:a9fe` metadata mapping). Collapsing to these two
  non-overlapping supernets is deliberate: an nftables `flags interval` set
  rejects overlapping elements, so listing a subrange alongside its supernet would
  fail to load. This closes the slice-2 dual-stack leak.
- **Container path.** A box's containers egress via slirp4netns userspace NAT,
  which does the real outbound `socket()` in the **host** netns as the box user —
  so container traffic traverses this same output hook and is subject to the same
  deny-list. A container cannot reach RFC1918 that the host can't.

The `--core-cidr` value is **security-critical**: it is interpolated verbatim
into the root `nft -f` input, so `bootstrap.sh` validates it (strict IPv4-CIDR
shape _and_ numeric bounds, base-10 to reject octal leading-zero octets) and
exits non-zero before any `nft`/`apt` call on a bad value. The box→core **reverse
tunnel** keeps working under lockdown even when core sits in an otherwise-dropped
RFC1918 range: it rides the inbound SSH connection (`established`) over loopback,
both allowed ahead of the drop.

**Honest limits.** DNS is allowed **globally** (any resolver on :53), not pinned
to a specific server — a deliberate simplification. The rules are the machine
boundary between _tenants_; intra-tenant isolation between one tenant's boxes on a
shared machine is Unix users + rootless docker, not egress (which is machine-wide).
Per-tenant machines are the tenant boundary.

## Browser service

Like rootless docker, headless browsing is **shared per machine, isolated per
box** — one Chromium process serves every box on the host, the same trade
that keeps ~1.5 GB of browser-process overhead off a 9-box machine instead of
paying it per box (design: `docs/history/superpowers/specs/2026-08-21-browser-tools-in-sandbox-design.md`).

- **One `ficus-browser` service per machine.** `bootstrap.sh`'s `install_browser`
  creates an unprivileged `ficus-browser` system user + group, installs Playwright
  - a pinned Chromium under `/opt/ficus/browser`, and writes the `ficus-browser.service`
    systemd **system** unit (`User=ficus-browser`, `RuntimeDirectory=ficus-browser`).
    The service (`scripts/machine/browser/ficus-browser.js`, embedded byte-identical
    into both `bootstrap.sh` and `packages/machine-image/Dockerfile`) launches one
    headless Chromium and listens on a unix socket at `/run/ficus-browser/sock`,
    mode `0660` group `ficus-browser` — nothing outside that group can connect.
    Chromium's own sandbox stays on (a hard bootstrap gate, unrelated to the box
    sandbox); `Restart=on-failure` recovers a crashed browser, dropping every
    box's in-flight pages.
- **One `BrowserContext` per box, run-id-keyed pages inside it.** The service
  keys a `Map<boxUser, { context, pages: Map<runId, page> }>` on the
  _authenticated_ box user — no verb accepts or reads a context identifier, so
  one box cannot express reaching another box's context or pages even in
  principle. `open`/`click`/`type`/`scroll`/`screenshot`/`read`/`console`/`close`
  mirror the seven core browser tools' schemas verbatim (`apps/core/src/tools/browser.ts`).
- **Auth: per-box token digest files, not a pushed token list.** Box-manager
  writes `sha256(<box's EXECUTOR_AUTH_TOKEN>)` hex — never the raw token — to
  `/opt/ficus/browser-tokens/<boxUser>.token`, `0640` `root:ficus-browser`, at
  provision (right after the `server.env` push, over the same non-argv
  `install -m /dev/stdin` channel). The service compares `sha256(bearer)` from
  the request against the file contents with `crypto.timingSafeEqual` — a
  leaked digest file is unreplayable, so a chown mistake or an on-box `cat`
  can't hand out a working credential. The tokens directory is a **sibling**
  of `/opt/ficus/browser` (not nested in it), because `install_browser`
  recursively chown/chmods `/opt/ficus/browser` world-readable for the Chromium
  binaries and would otherwise expose every box's digest to every other box.
  Box removal `rm -f`s the token file (`removeBoxUserOnMachine`), which is the
  revocation mechanism — the service never gets an explicit "box removed"
  notification, so a stale context simply 401s on its next call and is reaped
  by the 15-minute context-idle sweep below. Both writes are **non-fatal**
  (self-cleaning on failure) so a pre-browser machine's provisioning is
  unaffected.
- **Box server pass-through.** `packages/sandbox-server/src/server.ts` proxies
  `/browser/open|click|type|scroll|screenshot|read|console|close` straight to
  the socket with the box's own token — no Playwright dependency in the box
  server, and the socket peer's status/body are forwarded verbatim. If the
  socket is absent or refuses the connection (pre-browser machine, service
  down), the box server returns `503 { error: 'browser unavailable on this
machine', code: 'BROWSER_UNAVAILABLE' }` rather than hanging or 500ing.
- **Core: thin `/browser/*` clients, no Playwright.** `apps/core/src/tools/browser.ts`'s
  seven `browser_*` tools no longer run their own Chromium — Playwright is
  deleted from core's `package.json`/build externals/postinstall entirely.
  Each tool resolves the calling agent's `SandboxClient` and calls one of
  `browserOpen`/`browserClick`/`browserType`/`browserScroll`/`browserScreenshot`/
  `browserRead`/`browserConsole`, which POST straight to the box server's
  `/browser/*` routes above (a `browserClose` client method exists but core
  never calls it — cleanup rests on the service's idle reaper, ruling R-C6). `browser_click`, `browser_type`
  and `browser_scroll` set `returnScreenshot: true` on every call, so the
  service performs the action and captures the post-action screenshot in one
  request — today's "act, then see the result" UX costs the same single
  round-trip it always did, just from the box instead of in-process. A call
  against an unopened session (no prior `browser_open`) gets `No page is
open in this browser session — use browser_open with a URL first.`
  instead of the old silent blank-page creation (spec §10, R-C3).
- **DEPLOY-WINDOW semantics — two machine/box generations can lag core.**
  Because the tools, the box-server routes and the `ficus-browser` service
  version independently (§ Fleet effect below), a rollout window exists
  where core's expectations outrun what a given machine or box is actually
  running:
  - A machine whose `ficus-browser` service predates `returnScreenshot`
    ignores the flag (unknown field, old code path) — `click`/`type`/`scroll`
    still succeed but come back with no `screenshotBase64`, so the tool
    degrades to a text-only result `(screenshot unavailable)` until that
    machine re-bootstraps onto the new service.
  - A box still running a pre-Phase-2 server bundle (before `/browser/*`
    existed) 404s every browser route — `browser_open` reports "Browser
    routes are unavailable on this box (stale sandbox server) — the box
    will gain browser support when it is next recreated." rather than a raw
    404, until the box is recreated (park + re-ensure) onto the current
    bundle. The other six tools instead read a 404 as R-C3's "no page open"
    case, since a stale-bundle 404 and a genuine unopened-session 404 are
    indistinguishable to them.
    Both are self-healing, not incidents: the machine reconciler and the box
    spec-hash drift check each carry the fleet forward on their own schedules:
    see § Fleet effect below for the box side.
- **Caps.** 3 pages per box (a 4th `open` evicts the box's own LRU page,
  concurrency-safe — an in-flight page reservation counts toward the cap so a
  concurrent burst can't sneak past it); a machine-wide ceiling of
  `floor(MemoryHigh / 256 MB)` total pages (`MemoryHigh` from the
  `ficus-browser.service` memory-cap drop-in, default 8 GB → 32 pages),
  returning `429` past either limit; pages idle-close after 10 minutes, whole
  contexts idle-close after 15 (cookies/storage are not preserved across
  that — browsing is ephemeral by design).
- **SSRF host filter.** Every navigation — the `open` verb's own check and a
  `context.route('**')` guard covering redirects/iframes/subresources — blocks
  loopback, `169.254.0.0/16` (including the `169.254.169.254` cloud-metadata
  IP), `*.internal`/`metadata`/`metadata.google.internal`, and the IPv6
  equivalents (`::1`, `fe80::/10`, `fc00::/7`, and IPv4-mapped/NAT64 forms of
  the above, normalized so bracket/trailing-dot tricks can't bypass it).
  **RFC1918 private ranges are deliberately allowed** — a box's `bash` already
  has the machine's network position and can reach them today, so blocking
  only the browser would be inconsistent security theater. The filter is a
  name-based table, not a DNS-rebinding defense (see
  `docs/backlog/machines/follow-ups.md`'s Phase 2 ledger); it stops an agent-supplied
  URL from directly reaching the metadata IP or another box's loopback
  service, which is the primary abuse case for a shared-host renderer.
- **Fleet effect of shipping this.** `server.ts` and `box-provision.sh` both
  changed, which bumps the sandbox-server bundle version and the
  box-provision script version that feed a box's spec hash (§ Troubleshooting
  → Drift / stale bundle). Every box on every machine picks up the change the
  same way any other drift does — not a forced fleet-wide restart, but each
  box recreates (park + re-ensure) the next time it goes through the idle
  reaper or is otherwise re-ensured, so the rollout is gradual and
  idle-gated rather than immediate.

## Devbox comfort-set seeding

The k8s sandbox image baked a "comfort set" of ergonomic CLIs (ripgrep, fd, tree,
gh, tmux, …) into each box. A vm box runs on bare Ubuntu with no such image, so
`seedBoxDevbox` (called at ensure, after file-sync) materializes a per-user
`devbox` at `~/.ficus/devbox` and runs `devbox install` **as the box user** (via the
box's own `/write` + `/bash`, never root):

- **Role split.** Agent (light) boxes get the LIGHT set (node/python + ripgrep/fd/
  tree/less/gh/tmux/procps, mirroring the Dockerfile `agent` stage's global nix
  profile); squad + system-manager boxes get the HEAVIER set (adds bun/jq/gnumake/
  gcc/diffutils/patch/perl, mirroring `packages/sandbox-server/sandbox/devbox.json`).
- **Hash marker (no per-ensure tax).** The intended `devbox.json` content is
  hashed; after a successful install the hash is recorded in `~/.ficus/devbox/.seeded`.
  A later ensure whose content hashes to the same marker SKIPS the slow install
  entirely; a changed comfort set (different hash) forces a fresh install. The
  marker is written ONLY after success, so a failed install retries next ensure —
  the same sync-on-every-ensure lesson applied to a minutes-long step.
- **Both devbox shapes are the user's config.** devbox rewrites `packages` from
  the seeded list form into its map form (`{"zlib": {"version": "latest",
"outputs": ["dev"]}}`) as soon as an agent runs `devbox add … --outputs`. The
  seeder merges missing comfort packages into whichever shape it finds (a map
  stays a map — flattening would drop the options) and the box server's
  `devboxHasPackages` / `prepareDevboxShellEnv` count either shape, so a
  customized box still reports `devboxReady`. Before this, a map-form file left
  the box permanently `ready_degraded (devbox_unavailable)` with the marker
  suppressing every reseed. Each failed setup component now logs one bounded
  `vm-setup` WARN naming the step and error class — the durable row only keeps
  the reason code.
- **Non-fatal.** Unlike file-sync (FATAL — a box missing its CLI/skills/identity is
  broken), seeding is NON-FATAL: a box without the comfort set still works with a
  degraded shell, so a failure logs WARN and the ensure proceeds. `bootstrap.sh`
  installs the pinned nix + devbox toolchain onto the machine (§ Machine
  prerequisites), so `devbox` is on every box user's PATH — no operator step needed.
- **Reaching box shells (belt-and-suspenders).** Realizing the devbox is not
  enough — the tools reach a shell's PATH only through the box server's _cached
  devbox shellenv_, inlined into every `/bash` preamble. On k8s an entrypoint POSTs
  `/devbox-ready` to trigger that cache; a vm box has no entrypoint (its systemd
  unit execs the server directly), so it is delivered two ways: (1) the manager
  POSTs `/devbox-ready` right after a successful seed, and (2) the server
  **self-caches at boot** when `FICUS_BOX_HOME` is set and `~/.ficus/devbox/devbox.json`
  declares packages (surviving unit restarts; an empty/un-realized devbox is never
  shellenv'd — it would hang). Interactive terminals get the same env from a
  `~/workspace/.ficus/.bashrc` (or `~/.private/.ficus/.bashrc` for agent boxes) the
  manager writes after seeding, which activates the box devbox from its fixed
  `~/.ficus/devbox` dir. Both the boot self-cache and the bashrc `devboxDir` mode are
  gated so k8s/docker behavior is byte-identical.

## Troubleshooting

- **`MachineUnusableError: AllowTcpForwarding=no`.** The machine's sshd forbids
  forwarding. Set `AllowTcpForwarding yes` in `sshd_config`, restart sshd, and
  re-bootstrap so the capability re-probes to `yes`. If the caps show
  `forwarding: "unknown"`, `sshd -T` was unavailable during bootstrap (sshd
  absent, bad config, or sudo denied) — fix that and re-bootstrap.
- **`control socket path too long (… > 90 bytes)`.** SSH's `sockaddr_un.sun_path`
  is ~104 bytes; the tunnel manager rejects derived control-socket paths over 90
  bytes rather than let ssh silently truncate and fail cryptically. Shorten
  `HOME_DIR` (the control dir defaults to `<HOME_DIR>/machines/ctl`). Note:
  on macOS the default `TMPDIR` is a long `/var/folders/...` path — if you point
  the control dir at a temp dir, use a short one.
- **Drift / stale bundle.** The box's spec hash folds in the sandbox-server
  bundle version and the box-provision script version. When either changes, the
  box is `recreate`d (park + re-ensure; state persists). The server bundle is
  content-hashed and re-pushed only when the machine's recorded version differs.
  The **file-synced** artifacts (`~/bin/ficus`, skills, squad `.env`,
  `identity.pem`, memory) are re-pushed over `/write` on **every** ensure (step 6
  runs after `ensureBox` returns). `server.env`, however, is pushed only on a full
  (re-)provision — the healthy **fast path** (step 4) returns BEFORE the
  `server.env` push, so a re-ensure of an already-healthy box does NOT re-push it.
  None of these re-pushes trigger a recreate. File-synced assets also persist a
  bounded manifest of paths they own. When a grant, secret, identity, or tree
  entry is revoked, reconciliation writes the new manifest, removes only stale
  previously managed files (never unmanaged user files), and stamps completion
  only after deletion succeeds. An explicitly empty SSH source therefore
  revokes the last delivered host key instead of leaving it usable.
- **Stale baked `FICUS_API_URL` after a Core restart.** When Core reaches a box
  over a reverse tunnel, the box's `server.env` bakes `FICUS_API_URL=http://127.0.0.1:<remotePort>`.
  A Core restart allocates a NEW reverse-tunnel port, but the healthy fast path
  does not re-push `server.env` (above), so the box keeps the stale baked URL. The
  interactive/session surfaces are unaffected — `exec`/`spawnShell` and the bash
  tool re-inject the LIVE callback URL per command (`resolveToolApiUrl` /
  `spawnShell` env) — but a box-side process that reads the baked `server.env`
  value directly (e.g. a long-lived watcher) can point at a dead port until the
  box is next fully (re-)provisioned. Force a re-provision (`recreate`, or park +
  ensure) if a box must pick up a new reverse-tunnel port.
- **`starting` vs `failed`.** `getSandboxStatus` distinguishes non-terminal
  from terminal states, and the difference matters — routes keep a
  `starting`/`running` session alive but tear down a `failed` one, and the outage
  watch treats `failed` as a crash:
  - `starting` — the box is mid-(re-)provision, or its machine is `ready` but the
    tunnel/`/healthz` hasn't converged yet. Transient; leave it alone.
  - `failed` — the box's machine is gone or no longer `ready`. Terminal: the box
    is unrecoverable where it lives and will be re-placed / reclaimed.
- **Diagnosing a box that never goes healthy.** The systemd unit tolerates a
  missing bundle/env and stays failed-and-retrying until they arrive; check the
  unit with `systemctl status ficus-box-<user>.service` (system mode) or
  `systemctl --machine=<user>@.host --user status ficus-sandbox-server.service`
  (user mode) and its journal on the machine. Under socket activation an
  `inactive (dead)` server unit is NOT a fault — check the `.socket` unit
  first: if it is `active (listening)`, the box is idle and healthy, and
  `curl 127.0.0.1:<boxPort>/healthz` on the machine will wake it.

## Known limitations

- **The full systemd path is validated only on real VMs.** `box-provision.sh`'s
  linger + `--user` unit + `--machine=<user>@.host` restart — and, by extension,
  per-box **rootless docker** and **devbox** seeding — require systemd as PID 1,
  which a plain container does not have. The tenant-zero VM smoke test covers
  those paths end-to-end. The gated container integration test
  (`integration-vm.test.ts`) covers everything AROUND them — bootstrap, the same
  ssh runner, tunnel manager, real server bundle, `SandboxClient`, and the
  file/exec/reverse contracts — via a UNIT-FREE box (the server started
  directly), and asserts box-provision fails loudly at the systemd step. Its
  slice-3 blocks are additionally gated: `FICUS_TEST_EGRESS` (NET_ADMIN — the live
  RFC1918-drop proof) and `FICUS_TEST_SYSTEMD` (a real systemd host — the rootless
  docker + docker-path egress blocks). Devbox seeding is folded into the MAIN
  flow, but although `bootstrap.sh` puts `devbox` on PATH, `devbox install`
  realizes packages through the nix DAEMON, which runs only on a systemd VM (and
  the nix install itself dies under qemu on an amd64-emulated host). So the seed
  step self-gates on the nix daemon socket (`/nix/var/nix/daemon-socket/socket`)
  or `FICUS_TEST_SYSTEMD` and skips otherwise; running the full main flow (seed +
  cached-shellenv + a comfort tool resolving in a PLAIN `/bash`) therefore needs a
  **native-amd64 systemd host**, aligned with those gated blocks.
- **Sync-on-every-ensure re-push traffic.** File sync (CLI, skills, `.env`,
  identity, memory) re-pushes on every ensure rather than diffing, so a busy
  ensure/park cycle re-transfers unchanged artifacts. Acceptable at current
  scale; a content-hash skip is a future optimization.
- **Egress lockdown is opt-in and coarse on DNS.** The nftables rules (§ Egress
  model) apply only when a machine's `egressPolicy` is set; they now cover both
  IPv4 special-use ranges AND an IPv6 metadata/ULA/link-local drop (the slice-2
  v4-only gap is closed). Remaining coarseness: DNS is allowed globally (any
  resolver on :53, not pinned), and the lockdown is machine-wide, not per box.
- **The lifecycle loop's 60s cadence and real systemd unit stop are not
  container-modelable.** `integration-vm.test.ts` exercises the slice-4
  primitives directly against the real container and a real database row
  rather than waiting out the 60s tick: `box-manager.stopBox` parks a
  real box (asserting the `machine_boxes` row flips to `stopped` and the
  tunnel forward is genuinely torn down — a post-park request through the old
  forward fails) and re-adding a forward proves the resume side (row back to
  `ready`, `/healthz` answering) in seconds; a separate machine row pointed at
  a closed port proves `probeMachineHealth` flips a real unreachable target to
  `unreachable`. What it does NOT prove: that `stopBox`'s
  `systemctl --user stop` actually stops a real systemd unit — the plain
  container has no systemd (§ above), so that command is a harmless no-op
  there and the box's unit-free server process never actually stops. That half
  of park (and the full-provision side of resume, which needs
  `box-provision.sh`'s systemd path) is VM-smoke-deferred, same as the rest of
  the systemd surface.
- **The exe.dev provider path is UNVERIFIED-pending-credentials.** exe.dev's
  entire wire format (lobby command grammar, JSON field names, the token's
  auth role, and — the biggest open question — the pubkey-injection mechanism
  that lets ficus SSH into a VM it just created) is an assumption from a
  provider survey, never confirmed against a live account. Every assumption
  is isolated in `providers/exe-api.ts`, and the gated
  `integration-exe.test.ts` (separate `FICUS_TEST_EXE_TOKEN` gate from the SSH
  integration test) is the ONLY thing that exercises the real API — it has
  never actually run in this environment (no exe.dev token available). Until
  a credentialed human runs it, treat the exe provider as **authored but
  unverified**: BYO-SSH placement is fully verified and safe to depend on
  today; exe-based placement (squad-per-VM, commons, dedicated) is
  code-complete and unit-tested against a fake `ExeApi`, but its correctness
  against the real service is an open question. See
  `docs/wiki/machines/exe-provider.md` for the complete UNVERIFIED-API inventory
  and the exact run command.

## Backlog (not done in slice 6)

Slice 6 shipped the events surface, the pin setter + migrate-with-teardown
fix, and the web Machines admin section (above). These remain open follow-ups,
none blocking the above:

- **Concurrent same-key provision dedupe** (from slice 5). Two placement calls
  racing to provision the _same_ target machine name (e.g. two boxes for the
  same new squad) both reach `provider.provision(...)` — the existing
  `InflightDeduper` in `services/sandbox/vm/manager.ts` keys only on
  `sandboxId`, not on the computed squad/commons/dedicated machine name.
  Backstopped today by the DB's unique `machines.name` constraint plus
  cleanup-on-conflict, but a keyed in-flight dedupe by machine name (see the
  doc comment on `placement.ts`'s `resolvePlacement`) would remove the wasted
  provision attempt.
- **Dedicated-placement reuse/teardown** (from slice 5). Placement's
  `dedicated` path (§ Placement, rule 3) always provisions a fresh VM — there
  is no reuse-by-(`purpose='dedicated'`, `name`) lookup and no teardown path,
  unlike squad/commons which reuse by their deterministic name. A retry after
  a mid-`ensureBox` failure would re-provision `exe-ded-<sandboxId>` and
  collide forever on the `machines.name` unique constraint, since nothing
  currently reclaims a failed dedicated attempt's row. (Note: this is
  independent of the machine pin shipped this slice — the pin targets an
  _existing_ machine; `dedicated` placement is about auto-provisioning a new
  one per box.)
- **Squad-warmup vs. keepalive predicate alignment** (from slice 4).
  `squad-warmup.ts` warms a squad on `squad.isSandboxAlwaysOn ||
hasRecentAgentActivity(...)`, but the idle reaper's keepalive predicate
  (§ Lifecycle, step 1) checks `hasActiveLocalDeployments ||
hasRecentWorkStreamActivityForSandbox` — and `work-stream-activity.ts`
  explicitly returns `false` for squad/system-manager sandboxes. A squad
  warmed by recent agent activity currently has no corresponding keepalive
  signal protecting it from being idle-reaped shortly after. The two
  predicates should be reconciled.
- **Drop the hardcoded `VmLifecycleState.status` field** (from slice 4).
  `services/sandbox/vm/manager.ts`'s `getLifecycleState()` returns a literal
  `status: 'ready'` justified only by a comment ("a tracked box completed
  ensure, so its status is 'ready'") rather than deriving it from the box's
  actual live state.
- **Machine-health serial-SSH concurrency at fleet scale** (from slice 4).
  `sweepMachineHealth` (§ Lifecycle, step 2) probes machines one at a time in
  a plain `for` loop with no concurrency limiter; fine at current fleet sizes,
  but a large BYO-SSH fleet would serialize on SSH round-trip latency per
  60s tick.
- **Machine-side remnant sweep.** After a skip-teardown or failed-teardown
  pin migrate (§ Pin + migrate, old-machine-ready gate) — or the null-pin
  dead-machine re-placement in `box-manager.ensureBox` — the OLD machine's
  `box_<hash>` unix user, its `systemd --user` unit, and its home dir are left
  behind: the rebind repointed the `machine_boxes` row, and the
  orphan-reconcile pass is **row-based** (`reconcileOrphanedBoxes` in
  `machine-health.ts` scans `machine_boxes` ROWS), so it can no longer see
  those remnants. A machine that later recovers keeps the leaked box user /
  unit / home forever. Follow-up: a machine-side sweep that enumerates
  `box_<hash>` unix users / `systemd --user` units on ready machines and
  reclaims those with no matching `machine_boxes` row (the reconciler can't see
  them today).
- **Mobile machines UI.** Deferred this slice (§ Web admin above) — no
  backend blocker, just not built yet.

## Instance maintenance pause

Ficus has a global execution pause for host maintenance. An administrator hold and an expiring platform lease are independent; the instance remains paused while either holder is active. Lease expiry is evaluated from database time on every read, so a crashed platform job cannot leave an instance frozen indefinitely.

Acquiring an effective pause fences new queued-to-running claims, interrupts active turns, waits for their persisted session events to settle, and requeues executions without consuming a retry. Queued and newly submitted work resumes through normal pickup after the final hold is released. Machine-host resize acquires a five-minute lease, renews it every minute, verifies ownership before destructive checkpoints, and releases it in cleanup; expiry remains the final recovery backstop.

Use `ficus system pause-status`, `ficus system pause --reason "..."`, and `ficus system resume` for administrator operations. Releasing the administrator hold never clears a platform lease.

### Native machine-host resize recovery

An in-place resize holds the instance maintenance lease continuously across provider
power-off, resize, power-on, and machine recovery. Provider-confirmed physical size is
stored separately as `machineHostObservedSize`; the settled `machineHostSize` changes only
after the returning machine matches the durable ID, name/generation, SSH host, and ready
heartbeat. Recovery polls exit early but are bounded by one DB-authored deadline; each
provider/core call is capped by the remaining window. A crash adopts the durable phase and
observes provider state without repeating the resize. `request_outcome_unknown` operations remain observation-only until target convergence,
deadline expiry, or an audited operator re-arm based on inspected provider action history
plus live source-size/active-power proof. `request_owner_lost` is never re-armed: retries
observe only, and deadline expiry preserves the truthful
`recovery_deadline_exceeded/request_owner_lost` provenance. A null provider action ID is
not proof that DigitalOcean accepted no request.

Owner-qualified migration fences are crash-adoptable, not permanent. While a platform
maintenance lease is active only that exact lease/token owner may set or clear its fences.
After expiry, token rotation, or SIGKILL, a replacement lease is validated against DB time
and atomically adopts stale owner fences before continuing; an old runner cannot clear or
settle the successor's fence. Ownerless legacy fences alone are cleared at process boot.

## VM sandbox setup readiness and transport recovery

VM box liveness and best-effort setup readiness are independent. A usable box remains
physically `running`, while its durable readiness is either `ready` or
`ready_degraded`. Degraded reasons are bounded safe codes for Devbox comfort tools,
shell activation, Git credentials, callback transport, transport recovery, or ambiguous
command cleanup; raw stderr, commands, endpoints, tokens, and invocation IDs are never
returned by status APIs or fleet alerts.

Failed setup reconciliation backs off from 30 seconds exponentially to a 15-minute base
cap, with deterministic bounded jitter. The 60-second VM lifecycle scans due rows and
repairs tracked boxes; ordinary warmups skip degraded rows until they are due. The third
consecutive degraded result establishes the `sandbox_degraded` alert clock. Devbox and
shell-activation failures notify the current squad manager first and make human escalation
due 15 minutes after that third observation (not after manager delivery). Git credentials,
transport recovery, callback transport, ambiguous outcomes, mixed reason sets, empty sets,
and unknown reason sets notify both audiences immediately. If no valid current manager
exists at initial eligibility, manager delivery is terminally skipped for that episode and
the human alert is immediate; assigning a manager later does not revive it. A new episode
routes using its then-current attribution.

`sandbox_overloaded` incidents come from the fleet-alert tick. On the `vm` runtime it
reads `/healthz` load from ready boxes that have a running execution (an agent's own
box and, for a squad member, its squad box). It reads at most 48 boxes, 8 at a time,
with a 5-second budget each, and skips any that fail. Boxes with no running agent are
never read, since a read would wake a socket-activated box or reset its idle-exit
clock. The load is machine-wide, so every busy box on an overloaded machine has its
own incident. An episode opens when the one-minute load reaches twice the CPU count
and alerts when a reading 10 minutes later is still that high. The squad manager is
told first, and people 15 minutes later; if there is no valid manager, people are told
immediately. The episode resolves when the load falls below the CPU count, or when no
reading has arrived for 10 minutes.

Fleet alerts use one durable delivery row per incident phase and audience. Human messages
retain the trusted `fleet-alert` system-inbox source and best-effort push/external fan-out.
Manager messages use a separate agent-only source and pin their resolved recipient across
retries. Recovery is audience-paired: only an audience whose alert was durably delivered
receives recovery, so resolution before delayed human escalation produces neither a human
alert nor a human recovery. Dead-fleet episodes recover when demand becomes quiet or a
non-manager worker records `run_started_at`; the current manager's wake execution does not
recover or reset the episode, while a worker execution started by that manager counts
normally.

Manager-audience rows are written unconditionally. This is safe only between
audience-aware Core builds, so the audience-aware image must already be deployed
fleet-wide before this build ships: a pre-audience worker that claimed a manager row
would deliver it to the human system inbox under `source: fleet-alert`, fanning
manager work-injection text out to human push and external channels. Once every API
and worker replica is audience-aware, ordinary rolling/selective tenant upgrades are
safe. Episodes a pre-audience Core already alerted stay human-only — a human-only
alert row suppresses late manager injection — while newly eligible episodes use the
manager-first policy.

Bun socket-close, connection reset, refused, timeout, and network failures are classified
as secret-safe typed transport errors. Core first probes the authenticated executor, then
atomically refreshes only the affected SSH local forward and callback reverse path before
publishing a replacement client. Diagnostics distinguish transport kind, stale forward or
master loss, callback degradation, and executor uptime regression without logging secrets.

A streamed Bash EOF or read failure without a terminal `exitCode` has an unknown outcome.
Core never transparently replays the command: it keeps the stable invocation identity,
reconnects only for future work, and repeats only `/bash/cancel` until the server proves no
owned process remains. Cancellation proves that no predecessor is still running, not that
it produced no side effects. This is especially important for long `devbox install`
commands, which run at most once per reconciliation cycle. Monitor polling retains its
existing five-consecutive-failure tolerance.

### Setup blocked by unproven invocation cleanup

`VM setup invocation cleanup remains unproven` means the setup row retains a
pending Bash invocation and `/bash/cancel` cannot prove its cleanup. A healthy
machine or newly freed disk space does not by itself clear that record. Consultant
chats share a sandbox per squad, so creating another chat in the same squad does
not bypass the blocker.

The executor runs registry maintenance before reserving an invocation. It keeps
known completion proof in memory until terminal records are durably published,
prevents idle exit while that proof is pending, and retries persistence on
cancellation after storage recovers. Terminal records are published atomically so
a partial disk-full write cannot become an immutable, corrupt completion record.

A record left by an older executor or a crash may have no process identity and no
completion proof. Such a record must still fail closed; absence of a PID in JSON
is not evidence that no command ran. Operator recovery requires holding the
sandbox setup lease, ruling out active executions, stopping its server/socket/proxy
units, and verifying no command processes survive before recording termination.
Preserve the original invocation record for diagnosis. Do not simply delete the
setup row or replay an ambiguous command; stopping a process does not undo any
side effects it already produced.
