# VM runtime provisioning

## Machine prerequisites

A machine must be:

- **Ubuntu 24.04 LTS.** `bootstrap.sh` and `box-provision.sh` target systemd
  255 / bash 5.2 only. Other distros are out of scope and untested.
- **Reachable over SSH as root, or as a passwordless sudoer.** Bootstrap and
  per-box provisioning install system packages, write `/opt/ficus`, and manage
  other users' systemd `--user` managers via
  `systemctl --machine=<user>@.host --user`, all of which need root.
- **A host key a person has trusted.** Core checks every machine connection
  strictly against person-confirmed keys. A new machine's key is fetched on the
  first connection (bootstrap) and that connection is refused until someone
  trusts the fingerprint in Settings > Machines > SSH host keys. See
  [SSH host keys](../ssh-host-keys.md).
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

- **Marker present** (a VM booted from the ficus-machine image) → skip apt,
  Docker, nix, devbox and browser INSTALLS, even if their baked versions drift.
  Never reinstall nix over the baked `/nix`; changes to that toolchain require
  an image rebake. The marker is immutable image provenance, not live adoption.
- **Bun only**, on either branch → compare the actual executable version to the
  script's exact repository pin, stage/verify and atomically replace on drift.
  The old executable remains available for rollback; existing processes retain
  their old inode until normal idle provisioning reconciliation adopts the new
  binary. Bootstrap does not restart box servers itself.
- **Marker absent** (BYO-SSH Ubuntu host) → full idempotent install path, with
  the same atomic Bun installer; other tool behavior is unchanged.

See [host Bun convergence](host-bun-convergence.md) for the offline-only preview,
validation, remaining adoption prerequisite and separately authorized rollout.

**What still runs on the fast path** — the skip covers baked toolchain installs, not the Bun version check. The
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

At worker startup, automatic re-bootstrap first checks the host layout over
SSH without changing it. A host that needs an identity migration, or has an
interrupted migration journal, waits for an explicit operator or API bootstrap.
An inconclusive probe also defers the work. Deferral preserves the machine's
ready status and old bootstrap version so existing boxes remain usable and the
operator's stale-machine selection still includes it. Fresh and already
migrated hosts retain automatic re-bootstrap.

Complete the tenant Core upgrade successfully before explicitly migrating its
machines. Recycle their boxes only after that migration succeeds. This ordering
keeps the activation health check's automatic Core rollback from crossing a
machine identity change. Once machines migrate, do not roll Core back to a
release predating that layout.

An operator re-bootstraps machines from the tenant Core VM, without an admin
token, with the bundled entrypoint. Run it as root through the operator wrapper
from the setup toolkit, which loads Core's `.env` and runs the entrypoint as the
account Core runs as (the entrypoint refuses any other account, so nothing it
writes under Core's HOME is ever root-owned on a service-user host):

```bash
FICUS_MB_MACHINE=<machineId>|all-stale bash run-core-operator.sh machine-bootstrap
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
   The box's stamped **provisioning marker** must also still match what the
   caller wants. The marker is `<specHash>.<criticalEnvHash>.<identityEnvHash>`
   (hashes only, never env values):
   - **Critical env** is everything in the box env except the git author keys:
     the callback secret, `FICUS_API_URL`, `APP_URL`, role and executor settings.
     A change here, or to the spec hash, takes the full path at once — the env
     is re-pushed and the unit restarted, which ends whatever the box is running.
   - **Identity env** is exactly `GIT_USER_NAME`, `GIT_USER_EMAIL`,
     `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
     `GIT_COMMITTER_EMAIL`. When only these differ and the box has an active
     execution, the box is returned as-is and its stamp is left stale; the first
     ensure that finds the box idle applies the change. If activity cannot be
     determined the change is deferred. A parked box always takes the full path.
   - A stamp in the older `<specHash>.<envHash>` format that matches the same
     spec and env is rewritten in place (also on the parked-box resume path), so
     a Core upgrade that changes the marker format does not restart the fleet.

   The git author identity itself comes from the squad's assigned, enabled
   GitHub connection and does not depend on that connection's momentary health.
   It stays the same while a token refresh is being validated, while a periodic
   validation has failed, and after the validation window lapses; it is removed
   when the connection is disabled, unassigned, needs reauthorization, or is
   rejected by GitHub. The public profile (name, email) is cached per Core
   process and a failed profile request keeps the last loaded one. Before this,
   each GitHub token refresh (every 7h55m) dropped the author keys for a few
   seconds and every box of the squad was fully reprovisioned twice.

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

### Provision serialization and cross-process single flight

Provisioning has two independent fences:

- **On the machine**, `box-provision.sh` takes an exclusive `flock` on
  `/run/ficus-box-locks/ficus-box-<unix_user>.lock` before dispatching any
  provisioning, removal, restore or cache-publication effects. The directory
  is root-owned under `/run` (not the shared writable `/run/lock` directory).
  Root invocations and passwordless-sudo invocations use the same inode; the
  latter re-exec as root after validation. Different box users have different
  locks. The descriptor stays open through the whole run, including failure
  containment, rather than only around restore extraction. Existing extraction
  and shared-cache locks remain separate.
- **In Core**, API and worker VM managers share complete provisioning/setup results through
  `vm_box_provision_attempts` (migration `0236_vm_box_provision_attempts`). Each
  caller snapshots the current generation **before** waiting for the existing
  `vm-box-setup:<sandboxId>` advisory lease. A waiter consumes that generation's
  immutable result instead of executing a second `ensureBox`. A delayed failed
  follower follows latest state if its cooldown expired or a newer generation
  succeeded; a live failure cooldown is still shared. Completed generations
  are retained for at least one hour, beyond the 15-minute acquisition budget;
  indexed opportunistic cleanup prunes only the currently leased box's old results.
  Success is published only after required assets and post-provision setup have
  finished and durable readiness is `ready` or `ready_degraded`. A later
  independent ensure still performs health/spec reconciliation.

The advisory lease uses one reserved **direct** PostgreSQL session, never a
transaction-pooled connection. Result queries are short main-pool operations;
no database transaction stays open across SSH, and no second dedicated slot is
acquired inside the lease. Permit acquisition is non-queueing: both dedicated
permit saturation and advisory contention use bounded, signal-checked polling,
without entering the global unbounded permit FIFO. Contended callers return the
dedicated slot between attempts, so another box can progress; an acquisition
abort/deadline settles even if both unrelated permit owners remain held. An
already-acquired callback still keeps its permit and lock until it settles.
Idle/session-lifetime client retirement is disabled for the owned session, queries
retain the dedicated statement budget, and a detected session loss fences late
result publication.
Recursive provisioning is rejected before taking another lease/slot.

A successful follower reads the authoritative ready box/machine and creates its
**own local SSH forward**; no process-local endpoint, environment, executor token
or remote stderr is persisted in the flight-result table. It does not repeat the
owner's setup Bash commands. The follower also checks the desired fingerprint
against its own setup spec; a mixed-version mismatch requeues startup rather than
attaching to incompatible setup. Execution startup awaits `ensureSandbox`, whose
ready-generation joins wait up to 30 seconds for pending/reconciling readiness
(also fencing a pending setup invocation), then requeue within the bounded startup
budget rather than admitting a command early. Generic VM `exec` is not an
admission gate: monitors, cleanup and deployment commands must not stall merely
because a background repair has set setup to pending or reconciling.
The exact server refusal `Failed to start bash invocation: bash
invocation is already active` is likewise startup-retryable; other exit-127
failures are not. This never retries an already-started model turn.

A preempt-stop racing resume is also startup-retryable (`box_stop_unverified`).
Both plain ensure and recreate run normal stop reconciliation before provisioning:
only successful socket
`UnitFileState`, all-unit `ActiveState`, and forward-removal proof permits
recreation. The durable `stop_unverified` row is never cleared to force progress.
In particular, `not_found` with `boxProvisioned=true` is a display projection
also used for unverified stops, **not** authoritative stop proof. Known transient
machine statuses keep their longer machine retry schedule; other unverified
stops use three startup delays of 30, 60 and 120 seconds. Their generation cooldown
is capped at 30 seconds, without inheriting an older physical failure streak, so
each retry can actually attempt verification instead of exhausting the budget
while waiting for the lifecycle sweep.

An unchanged ready box reconnects **without** the setup lease or a dedicated
permit. The fast path checks its physical provisioning marker, desired setup
fingerprint, readiness, absence of pending setup invocations, and whether a
scheduled degraded repair is due. It also computes the ordinary asset
content/revocation comparisons without remote writes or Bash; changed or removed
skills, secrets, identity or SSH material fall back to fenced setup. Only then
are a local forward and health check sufficient. Unhealthy or changed boxes take
one lease covering physical ensure and all post-provision setup. No nested
setup lease is acquired.

First-contact exposure retirement during setup/attach uses
that already-established client, not another ensure, and retains its durable
all-or-nothing cleanup acknowledgement. Read-only cleanup sweeps attach to an
existing ready box and do not provision one.

Physical provisioning failures back off for 30 seconds, doubling to a maximum of
15 minutes;
success resets the failure count. Followers/backoff callers receive a sanitized
error identifying the failed attempt and retry time, while the original caller
retains its diagnostic error. Post-physical setup failures carry a
`VmPostProvisionSetupError` with the original diagnostic cause: allowlisted causes
keep their startup code; other setup errors become `sandbox_readiness_pending`.
They reset the physical failure count and have no physical cooldown. Recovery
still passes through durable invocation reconciliation; an unknown remote Bash
outcome is never permission to blindly repeat it. Shared failures preserve the allowlisted
startup
classification for transient `machine_*`, port-busy (75), host-lock timeout (73),
Bash contention, stop-verification and readiness-pending errors. Each uses the same execution retry
schedule as the owner; budget exhaustion still terminates the execution.

Clean API and worker shutdown mark **only their own** running generations failed
with `failureClass=interrupted`, `retryAt=completedAt=now` and failure count zero.
Ownership registration includes inserts crossing shutdown, and late callbacks
cannot publish success. A replacement can provision immediately after acquiring
the released lease. An unclean lost owner leaves a `running` generation: the next
lease owner marks it abandoned with failure count zero and an immediately expired
retry time, then recovers in that same call. Holding the authoritative lease makes
a separate cooldown unnecessary and avoids spending the startup budget before a
real attempt. Both abandoned and interrupted results remain startup-retryable if
a follower observes them before expiry. The idempotent remote script remains
protected by the host lock if its original process is still unwinding. An old owner
cannot overwrite that terminal result. The existing
bind/reaper race remains a safe immediate re-placement exception: it happens
before host provisioning begins.

The manual host-lock wait defaults to **180 seconds**. The validated
`--lock-wait-seconds <nonnegative seconds>` argument survives root re-exec and
sudo `env_reset`; `FICUS_BOX_LOCK_WAIT_SECONDS` is a manual fallback.
For manual non-root runs, re-entry passes the effective wait and the test-only
`FICUS_HOST_ROOT` through `sudo env` argv (not inherited environment); explicit
`--lock-wait-seconds` still wins. No other environment is forwarded this way.
Manual non-root re-entry requires sudo permission for that `env ... bash`
command; a sudoers rule permitting only `bash` will refuse it. In that case,
run manually as root using existing authorized access rather than changing policy.
**Core always passes the argument**, paired with its explicit, unchanged
SSH/stream budget: one quarter of that budget rounded down to seconds, capped
at 180 seconds. This leaves connection, execution and cleanup headroom:

| Caller                                                                   | SSH/stream bound | Maximum lock wait |
| ------------------------------------------------------------------------ | ---------------- | ----------------- |
| Default remove/remnant sweep, restart/park, non-migration restore/stream | 30s              | 7s                |
| Offline runtime capture/restore, operator unit control                   | 120s             | 30s               |
| Nix cache publication                                                    | 180s             | 45s               |
| Physical install                                                         | 300s             | 75s               |
| Migration restore/remove with a 30-minute override                       | 1800s            | 180s              |

Machine-health removals use the same budget-paired removal entrypoint. A waiter
exits on the machine before its caller's deadline; it cannot remain queued and
later remove/restart a box after reporting a lock failure. This does not promise
to cancel an already-acquired remote operation after SSH transport loss.

Standalone Core restart/park, migration quiesce/rollback, operator unit
start/stop/restart and offline runtime restore/capture also hold **the same inode and FD 200** across their systemctl
mutations and readbacks. A manual provision's daemon-reload therefore cannot
interleave with their enable/restart/show sequence. Every production writer of
`vm_box_provision_attempts`, including per-box retention cleanup, holds that
box's lifecycle lease; detected session loss fences further publication.

Timeout exits **73** with
`FICUS_BOX_LOCK_TIMEOUT`, the box user, `holder_pid`, wait and lock path. The PID
is published only by the lock owner; at the timeout boundary it may identify a
just-exited owner. A waiting/timed-out invocation has not entered provisioning and
**must not stop or disable the holder's Docker**. Do not unlink a lock file to
"fix" contention: that can create two independently locked inodes. Investigate
the named holder instead. Locks release with the last owning descriptor, including
on process death. Side-effect-free print modes and unprivileged
`--prepare-nix-cache` do not acquire this lock: service startup can invoke cache
preparation while provisioning owns it. Cache publication remains root-only.

During execution startup, an install exiting 73 becomes `BoxLockTimeoutError`
and startup code `box_lock_timeout`, retaining the holder diagnostic. The
execution and its admission reservation return to `queued`, not terminal failure,
with the existing port-busy retry schedule (10, 20, 40, 80, 160 seconds).
After five retries, persistent contention fails with the original diagnostic.
This does not replay a model turn or a settled operation. Other provisioning
failures remain terminal; exit 75 keeps its existing busy-port behavior.
The shell harness covers non-root `env_reset` re-entry, lock-holder isolation,
and both environment and explicit-argument wait values; the Core startup test
feeds exit 73 through installation into durable execution requeue and exhaustion.

Cancellation/deadlines while acquiring the Core lease never cancel the holder.
After acquisition, work and cleanup must settle before releasing ownership;
there is no timeout race that leaves a mutating callback running after unlock.
Existing bounded SSH provisioning (five minutes) and health polling (four minutes
by default) remain in effect. If a Core DB session dies while remote work is still
unwinding, the host lock remains the final script-level fence.

Regression coverage is synthetic: `scripts/machine/box-provision.test.sh` records
fake-systemctl interleavings, timeout/holder PID and Docker ownership;
`provision-flight*.test.ts` exercises real PostgreSQL/PgBouncer, separate API/worker
VM-manager processes, shared success/failure/backoff, different-box progress,
cancellation, lost sessions and generation fencing. These checks do not provision
or repair a live host or establish that a deployed incident is resolved.

#### Restart/readiness regression evidence (2026-10-28)

Focused regressions cover shared failure execution requeue/exhaustion, owned
shutdown (including an insert/shutdown race), unclean abandonment, pending and
reconciling admission, and two independent VM-manager processes ensuring a fresh
box. The fresh-box test uses real PostgreSQL/PgBouncer leases and setup rows:
the generation stays running while the owner is held in setup; the follower's
first Bash occurs only after owner setup completes and readiness is published.
Two-process preempt-stop/immediate-resume tests cover both recreate and plain
ensure, using the real stop
orchestration and durable rows with synthetic SSH readbacks: failed verification
keeps `stop_unverified`, queues startup rather than provisioning, and only a
subsequent successful authoritative stop allows recreation. The plain-ensure test
waits its actual first 30-second startup delay without clearing either the stop
marker or cooldown. Separate processes also verify that a non-allowlisted owner
setup error remains retryable five seconds later, and an abandoned generation
recovers on its first call without consuming startup retries.
A separate owner-shutdown/replacement-process test provisions within five seconds,
which excludes the former 30-second cooldown. Physical installs, tunnels, assets
and Bash are synthetic; these tests do not launch real VMs or restart services.

The `manager.test.ts` 20-ready-agent reconnect measurement used 40 ms synthetic
health latency and the real setup-lease/dedicated-permit implementation on the
before path:

| Version                              |   N | Measured resume wall time | Peak concurrent health checks | Setup lease calls |
| ------------------------------------ | --: | ------------------------: | ----------------------------: | ----------------: |
| Before                               |  20 |                7,976.5 ms |                             2 |                40 |
| After                                |  20 |                   50.1 ms |                            20 |                 0 |
| After + actual freshness comparisons |  20 |                   47.6 ms |                            20 |                 0 |

The final variant uses the actual asset sync and read-only comparison functions
with synthetic skill contents, transport and stored hashes. Each of the 20 fast-path
reconnects must read current assets; freshness is no longer stubbed to `true`.
An ensure-path Bash-refusal test also exercises a real `runBash` response rather
than relying only on a regex classifier test.

These are synthetic measurements, **not** a production speedup estimate. The
before run included database acquisition/polling; the after path takes no
setup lease. Shared-host pressure also changed between samples, so wall times
are not a controlled host benchmark. The concurrency and lease-count assertions
are the decisive regression proof. No live 20-VM experiment, deployment,
restart, failed-turn replay, or new infrastructure was performed. The reported
historical incident is consistent with the reproduced code defects; without
retained incident records, its exact deployed timeline/root cause remains
unverified.

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

### Box ports: reservation, guard, and busy-port retry

Every box socket and Core's reverse-tunnel callback share the machine's one
loopback. Linux's default ephemeral range (32768-60999) used to contain all of
them, so an outgoing loopback connection could take a box port as its local
port and that box's socket could not bind. Three layers handle this
(`services/machines/box-ports.ts` holds the numbers):

- **Allocation.** `bindMachineBox` hands out the lowest free port in
  `50100-59999` and reuses ports freed by removed boxes. It throws
  `BoxPortRangeExhaustedError` when the range is full. A box row whose port is
  outside the range (allocated before the bound) keeps that port. A stale
  client pointed at a reused port gets a 401, because each box has its own
  token.
- **Kernel reservation.** `bootstrap.sh` and `box-provision.sh` share one
  `ensure_box_port_reservation` block (kept byte-identical, checked by
  `box-ports.test.ts`). It merges `50080,50100-59999` into
  `net.ipv4.ip_local_reserved_ports`, live and in
  `/etc/sysctl.d/90-ficus-box-ports.conf`, and keeps any reservation that was
  already there. Bootstrap runs it on new hosts and on the boot-time drift
  re-bootstrap. Every box provision re-checks it, so existing hosts converge
  without a manual step. `capabilities.boxPorts` reports the result. Local
  deployments on a VM machine reject explicit ports in this set.
- **Port guard.** Each box slice gets `60-ficus-box-ports.conf` with
  `SocketBindDeny=` for the set (IPv4 + IPv6 TCP), which also covers rootless
  docker publishing. A user-mode slice also has `SocketBindAllow=` for the
  box's own port, because its `systemd --user` manager binds the box socket
  from inside that slice. It needs systemd built with `BPF_FRAMEWORK`. Stock
  Ubuntu 24.04 lacks it and ignores the directive, which
  `capabilities.socketBind = unsupported` reports.
- **Busy port.** When the socket cannot start, `box-provision.sh` prints
  systemd's status and journal for the socket plus the port's holders
  (`ss -tanp 'sport = :<port>'`). If the port is held, it exits 75. The
  resume path's `enable --now` does the same. Core raises `BoxPortBusyError`,
  and the execution startup retry requeues the run on its own schedule (10s
  to 160s, five retries) with a stream notice naming the holder. The final
  failure keeps the full reason. Other provisioning failures stay terminal.
  Failed keep-warm ensures back off per agent (2 min, doubling to 15 min).

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


[VM runtime overview](runtime.md)
