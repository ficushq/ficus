# VM runtime lifecycle

## Park / stop / remove semantics

- **Park (`stopBox` / `stopSandbox`).** Disable the box's socket persistently,
  stop its socket/proxy/server activation chain, and cancel its `-L` forward.
  Mark the box row `stopped` only after successful commands and readbacks of the
  disabled socket and inactive units, so a host reboot or user-manager restart
  cannot re-enable a verified parked box. **On-disk state persists** —
  the home, `~/workspace`, and `~/.private` are untouched, so a later ensure
  resumes the box in seconds (enable/start socket + restart server + retunnel),
  not the minutes an image-pull + pod-boot costs. **Park is reversible** — this is exactly what the
  idle-policy loop (§ Lifecycle below) does to an inactive box, and exactly what
  a later ensure undoes.
- **Unverified park recovery.** If the recorded machine is not ready, or a
  stop/disable command, state readback, or tunnel removal fails, Core writes
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


[VM runtime overview](runtime.md)
