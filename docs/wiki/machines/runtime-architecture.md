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
  - Park (`stopBox`) persistently disables the socket and takes all three down,
    socket first. Resume re-enables/starts the socket and restarts the server;
    the server itself remains disabled at boot.
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


[VM runtime overview](runtime.md)
