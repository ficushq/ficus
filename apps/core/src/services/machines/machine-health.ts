import { consultantSandboxSquadId } from '../sandbox/consultant-sandbox'
import type { AgentStatus } from '@ficus/shared'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { mapWithConcurrency } from '../../lib/infra/mapWithConcurrency'
import { removeBox as removeBoxReal, removeBoxUserOnMachine as removeBoxUserOnMachineReal } from './box-manager'
import { boxUnixUser } from './box-paths'
import { capLastError } from './bootstrap'
import { listAllMachineBoxes as listAllMachineBoxesReal } from './lifecycle-queries'
import { DISK_SAMPLE_PATH } from './machine-metrics-sample'
import { positiveIntEnv } from './placement'
import { getMachineProviderEnsured } from './providers'
import type { MachineProvider } from './provider'
import {
  getMachine as getMachineReal,
  listMachines as listMachinesReal,
  originalSandboxIdFromUnverifiedStopRemnant,
  UNVERIFIED_STOP_REMNANT_PREFIX,
  updateMachine as updateMachineReal,
  upsertMachineBox as upsertMachineBoxReal,
} from './queries'
import type { Machine, MachineBox } from './queries'
import { defaultSshRunner } from './ssh'
import type { SshResult, SshRunner } from './ssh'
import { machineTunnels } from './tunnel-manager'

const log = createLogger('machine-health')

/**
 * Machine-health probe + orphaned-box reconciliation for the VM sandbox runtime.
 *
 * This is the outage primitive the vm runtime was missing: per-BOX recovery is
 * already wired (a `failed` box triggers the recovery watch), but nothing flips
 * the owning MACHINE to `unreachable` when the hardware itself dies, and nothing
 * reclaims the `machine_boxes` rows left behind on a dead machine. This module
 * supplies both, driven from the DB (not process state) so it survives a Core
 * restart.
 */

/**
 * The lastError stamped on the unreachable branch of {@link probeMachineHealth}.
 * `probeMachineHealth` reaches "unreachable" via exactly one path — the live
 * tunnel check failed AND the provider itself reported the machine `gone` (see
 * the reachability signal above) — so this is a CONSTANT, not built from
 * variable probe data. That keeps it byte-identical across repeat failing
 * probes (no spurious change on the row from the automatic sweep re-running
 * every tick), mirroring the determinism the `POST /:id/check` route's own
 * message relies on.
 */
const PROBE_UNREACHABLE_MESSAGE = "reachability probe failed: provider reported 'gone'"

/** The tunnel surface the probe consults (`machineTunnels` satisfies it). */
interface HealthTunnels {
  checkHealth(machineId: string): Promise<boolean>
}

export interface MachineHealthDeps {
  /** Resolve a provider by key (default: the real registry). */
  getProvider?: (key: string) => MachineProvider | Promise<MachineProvider>
  /** Tunnel manager for the live-ControlMaster fast-path (default: `machineTunnels`). */
  tunnels?: HealthTunnels
  /** Persist a status/lastSeenAt flip (default: real `updateMachine`). */
  updateMachine?: typeof updateMachineReal
  /** Enumerate machines for the sweep (default: real `listMachines`). */
  listMachines?: typeof listMachinesReal
  /**
   * Injected clock. Production passes `new Date()`; tests pin it. Kept a dep so
   * the sweep/probe never reach for `Date.now()` directly (the lifecycle loop and
   * its tests need a deterministic timestamp).
   */
  now?: () => Date
  /**
   * Machine-side remnant sweep, fired fire-and-forget ONLY on the
   * unreachable→ready recovery transition (default: real
   * {@link sweepMachineRemnants}). Injected so the probe's wiring is testable
   * without SSH; a failure here can never affect the probe result.
   */
  sweepRemnants?: (machine: Machine) => Promise<unknown>
}

/**
 * Probe one machine's reachability and, for a machine that is currently
 * `ready` or `unreachable`, persist the flip.
 *
 * Reachability signal (in order):
 *  1. A live SSH ControlMaster tunnel is direct proof the machine is up — trust
 *     it and skip the provider round-trip (cheaper, and it corroborates real
 *     end-to-end reach, not just the provider's control-plane view).
 *  2. Otherwise ask `provider.status(machine)`: `gone` → `unreachable`;
 *     `running`/`parked` → reachable (`ready`).
 *
 * Persistence rule: the flip is written ONLY when the machine's current status is
 * `ready` or `unreachable`. A machine that is intentionally `parked` or
 * `terminated` (or still `registered`/`bootstrapping`) is never touched here —
 * flipping a parked machine to `ready`/`unreachable` would fight the operator who
 * parked it, and flipping a mid-bootstrap machine would race provisioning.
 * `lastSeenAt` is a liveness watermark, not a probe timestamp: it is stamped to
 * `now` ONLY when the probe finds the machine `ready` (genuinely reachable), so
 * it keeps reflecting the last time the machine was actually seen — mirroring
 * the `POST /:id/check` route in `routes/machines.ts`. `status` is always
 * written on a persisted probe, and so is `lastError`: cleared to `null` on the
 * ready branch (a successful probe supersedes ANY stale error, including a
 * bootstrap-era one left over from a run that finished long ago) and stamped
 * with a probe-sourced, deterministic message — capped via {@link capLastError}
 * — on the unreachable branch, so the row never keeps blaming an unrelated old
 * bootstrap failure for a fresh reachability blip. This really does mirror the
 * `POST /:id/check` route now (this function runs unattended, on every VM
 * lifecycle tick, so it is the path most likely to leave a stale error behind
 * if it didn't).
 */
export async function probeMachineHealth(
  machine: Machine,
  deps: MachineHealthDeps = {}
): Promise<'ready' | 'unreachable'> {
  // Ensured default: self-heals a registry miss (api registration races
  // secret-store init; a key seeded after boot never reaches a boot-only
  // registration). Injected fakes bypass the self-heal (sync throw propagates).
  const getProvider = deps.getProvider ?? ((key: string) => getMachineProviderEnsured(key))
  const tunnels = deps.tunnels ?? machineTunnels
  const updateMachine = deps.updateMachine ?? updateMachineReal
  const now = deps.now ?? (() => new Date())
  const sweepRemnants = deps.sweepRemnants ?? ((m: Machine) => sweepMachineRemnants(m))

  let reachable: boolean
  if (await tunnels.checkHealth(machine.id)) {
    reachable = true
  } else {
    reachable = (await (await getProvider(machine.provider)).status(machine)) !== 'gone'
  }
  const health: 'ready' | 'unreachable' = reachable ? 'ready' : 'unreachable'

  // Only ready↔unreachable machines are health-flipped. Leave parked/terminated
  // (and still-provisioning) machines exactly as the operator/bootstrap left them.
  // Capture the pre-write status: `updateMachine` may mutate the passed row in
  // place, so the transition check must read the value from BEFORE the write.
  const previousStatus = machine.status
  if (previousStatus === 'ready' || previousStatus === 'unreachable') {
    await updateMachine(
      machine.id,
      health === 'ready'
        ? { lastSeenAt: now(), status: health, lastError: null }
        : { status: health, lastError: capLastError(PROBE_UNREACHABLE_MESSAGE) }
    )
    // Emit ONLY on an actual status transition (AFTER the write). A ready→ready
    // watermark refresh must not fire — the periodic sweep would otherwise spam a
    // status event every tick for every healthy machine.
    if (health !== previousStatus) {
      eventEmitter.emit('machine.status', { machineId: machine.id, status: health })
    }
    // Machine-side remnant sweep — ONLY on the unreachable→ready RECOVERY
    // transition, AFTER the status flip + event, fire-and-forget. A recovered
    // machine may carry box users whose `machine_boxes` row was re-placed off it
    // while it was down (invisible to the row-driven reconciler); reclaim them
    // now. The IIFE swallows BOTH sync and async throws so a sweep failure can
    // never affect the probe result (steady-state ready→ready never sweeps).
    if (previousStatus === 'unreachable' && health === 'ready') {
      void (async () => {
        try {
          await sweepRemnants(machine)
        } catch (err) {
          log.warn(
            `machine remnant sweep failed for machine ${machine.name} (${machine.id}): ${
              err instanceof Error ? err.message : err
            }`
          )
        }
      })()
    }
  }
  return health
}

/** Default fan-out cap for the per-tick health sweep. Overridable via
 *  `FICUS_MACHINE_PROBE_CONCURRENCY` (positive int; invalid → default). */
const DEFAULT_PROBE_CONCURRENCY = 5

/**
 * Probe every `ready`/`unreachable` machine and persist recoveries/failures.
 * Machines in any other status are skipped (see {@link probeMachineHealth}).
 *
 * Probes fan out with a concurrency cap (default {@link DEFAULT_PROBE_CONCURRENCY},
 * env `FICUS_MACHINE_PROBE_CONCURRENCY`) rather than running strictly serially: at
 * fleet scale a handful of dead machines (each a ~10s SSH ConnectTimeout) would
 * otherwise starve the whole tick. Per-machine error isolation is unchanged —
 * each probe is wrapped so one throw is logged and never aborts the sweep, and
 * remnant sweeps stay fire-and-forget inside {@link probeMachineHealth}. Result
 * aggregation is order-insensitive (side effects only), so completion order is
 * irrelevant.
 */
export async function sweepMachineHealth(deps: MachineHealthDeps = {}): Promise<void> {
  const listMachines = deps.listMachines ?? listMachinesReal
  const machines = await listMachines()
  const targets = machines.filter((machine) => machine.status === 'ready' || machine.status === 'unreachable')
  const concurrency = positiveIntEnv('FICUS_MACHINE_PROBE_CONCURRENCY', DEFAULT_PROBE_CONCURRENCY)
  await mapWithConcurrency(targets, concurrency, async (machine) => {
    try {
      await probeMachineHealth(machine, deps)
    } catch (err) {
      log.warn(`probe failed for machine ${machine.name} (${machine.id}): ${err instanceof Error ? err.message : err}`)
    }
  })
}

// ---------------------------------------------------------------------------
// Orphaned-box reconciliation
// ---------------------------------------------------------------------------

/** Minimal owner shapes (`Agent`/`Squad` satisfy them structurally). */
type OwnerAgent = { status: AgentStatus }
type OwnerSquad = { archivedAt: Date | null }

export interface ReconcileOrphansDeps {
  /** All boxes across all machines (default: real `listAllMachineBoxes`). */
  listAllMachineBoxes?: () => Promise<MachineBox[]>
  /**
   * Preloaded machine registry, keyed by id. When supplied it fully replaces
   * the per-box `getMachine` lookup: an id absent from the map is treated
   * exactly as a `null` row was (a box referencing a machine that no longer
   * exists → dead host). Supplied by the vm lifecycle tick, which already
   * lists every machine for the health sweep in the same pass.
   */
  machines?: ReadonlyMap<string, Machine>
  /** Resolve a box's host machine (default: real `getMachine`). */
  getMachine?: typeof getMachineReal
  /** Mark a box row (default: real `upsertMachineBox`). */
  upsertMachineBox?: typeof upsertMachineBoxReal
  /** Tear a box down (default: real box-manager `removeBox`). */
  removeBox?: (sandboxId: string, opts?: { archivePrivate?: boolean; archiveOwnerId?: string }) => Promise<void>
  /** Load the owning agent (default: `Agent.find`). */
  loadAgent?: (id: string) => Promise<OwnerAgent | null>
  /** Load the owning squad (default: `Squad.find`). */
  loadSquad?: (id: string) => Promise<OwnerSquad | null>
}

/**
 * Whether the agent/squad that owns `sandboxId` is terminated (or gone).
 *
 * Owner mapping mirrors the rest of the sandbox layer's `<role>_<id>` convention:
 *  - `agent_<id>`  → the box is reclaimable iff its agent is missing or finally terminated
 *  - `squad_<id>`  → the squad is terminated iff it is missing OR `archivedAt` is set
 *  - `system_manager_*` (and anything else) → NEVER owner-terminated. The
 *    system-manager box is a process-lifetime singleton with no per-owner row to
 *    consult; treating it as "always active" keeps the reconciler from ever
 *    reclaiming it out from under a live system.
 */
export async function isOwnerTerminated(
  sandboxId: string,
  deps: Pick<ReconcileOrphansDeps, 'loadAgent' | 'loadSquad'> = {}
): Promise<boolean> {
  if (sandboxId.startsWith('agent_')) {
    // Only `terminatedAt` is read here — never pay for the eager squad/type loads.
    const loadAgent = deps.loadAgent ?? ((id: string) => Agent.find(id, { eager: false }))
    const agent = await loadAgent(sandboxId.slice('agent_'.length))
    return !agent || agent.status === 'terminated'
  }
  if (sandboxId.startsWith('squad_') || consultantSandboxSquadId(sandboxId)) {
    const loadSquad = deps.loadSquad ?? ((id: string) => Squad.find(id))
    const squad = await loadSquad(consultantSandboxSquadId(sandboxId) ?? sandboxId.slice('squad_'.length))
    return !squad || squad.archivedAt != null
  }
  return false
}

/**
 * A machine is "dead" (unable to host boxes) when it is `unreachable`,
 * `terminated`, or its row is entirely absent (a box referencing a deleted
 * machine). A `parked` machine is NOT dead — it can resume — and a `ready`
 * machine obviously isn't, so boxes on those are left alone here.
 */
function isMachineDead(machine: Machine | null): boolean {
  return !machine || machine.status === 'unreachable' || machine.status === 'terminated'
}

/**
 * Reclaim `machine_boxes` rows stranded on dead machines.
 *
 * For each box, the reclaim predicate is BOTH of:
 *   (a) its machine is dead — `unreachable`/`terminated`/absent (see
 *       {@link isMachineDead}); AND
 *   (b) its owning agent/squad is terminated/gone (see {@link isOwnerTerminated}).
 * When both hold the row is marked `orphaned` (the first code to use that schema
 * status) and then torn down best-effort — private tree archived for agent /
 * system-manager boxes, not for squad boxes (mirrors the manager's teardown).
 *
 * The row is marked `orphaned` BEFORE the teardown so the marker is durable: if
 * the best-effort `removeBox` fails (the dead machine is unreachable, so its SSH
 * teardown legitimately fails), the row is left `orphaned` rather than `ready`,
 * so it is never mistaken for a live box and is retried on the next pass.
 *
 * Crucially, a box on a dead machine whose owner is STILL ACTIVE is LEFT
 * UNTOUCHED. `box-manager.ensureBox` already re-places such a box onto a healthy
 * machine the next time the live session runs; removing it here mid-session would
 * archive+destroy an in-use box (data loss) and race that re-placement. Likewise
 * a box on a healthy (`ready`/`parked`) machine is never this reconciler's
 * concern — explicit teardown owns that path.
 */
export async function reconcileOrphanedBoxes(deps: ReconcileOrphansDeps = {}): Promise<void> {
  const listAllMachineBoxes = deps.listAllMachineBoxes ?? listAllMachineBoxesReal
  const preloaded = deps.machines
  const getMachine = preloaded ? async (id: string) => preloaded.get(id) ?? null : (deps.getMachine ?? getMachineReal)
  const upsertMachineBox = deps.upsertMachineBox ?? upsertMachineBoxReal
  const removeBox =
    deps.removeBox ??
    ((sandboxId: string, opts?: { archivePrivate?: boolean; archiveOwnerId?: string }) =>
      removeBoxReal(sandboxId, opts))

  const boxes = await listAllMachineBoxes()
  for (const box of boxes) {
    try {
      const machine = await getMachine(box.machineId)
      if (box.sandboxId.startsWith(UNVERIFIED_STOP_REMNANT_PREFIX)) {
        if (machine?.status === 'ready') {
          const originalSandboxId = originalSandboxIdFromUnverifiedStopRemnant(box.sandboxId)
          if (!originalSandboxId) {
            log.warn(`unattributable unverified-stop remnant ${box.sandboxId}; retaining for operator recovery`)
            continue
          }
          await removeBox(box.sandboxId, {
            archivePrivate: !originalSandboxId.startsWith('squad_'),
            archiveOwnerId: originalSandboxId,
          })
        }
        continue
      }
      if (!isMachineDead(machine)) continue // healthy host → not our concern; re-ensure/teardown owns it

      if (!(await isOwnerTerminated(box.sandboxId, deps))) {
        // Dead machine but a LIVE owner: leave it — ensureBox re-places it on a
        // healthy machine next run. Removing it now = data loss mid-session.
        continue
      }

      // Dead machine + terminated owner → orphan. Durable marker first, then teardown.
      await upsertMachineBox({
        sandboxId: box.sandboxId,
        machineId: box.machineId,
        unixUser: box.unixUser,
        port: box.port,
        status: 'orphaned',
      })

      // Squad boxes hold no per-agent private tree to preserve; agent /
      // system-manager boxes archive `~/.private` on reclamation.
      const archivePrivate = !box.sandboxId.startsWith('squad_')
      try {
        await removeBox(box.sandboxId, { archivePrivate })
      } catch (err) {
        // Best-effort: the machine is dead, so its remote teardown may fail. The row
        // stays `orphaned` (never resurfaces as live) and is retried next pass.
        log.warn(
          `orphan teardown failed for box ${box.sandboxId} on machine ${box.machineId}: ${
            err instanceof Error ? err.message : err
          }`
        )
      }
    } catch (err) {
      // One box's lookup (getMachine/isOwnerTerminated) throwing must not stall
      // the rest of the pass — mirrors sweepMachineHealth's per-machine isolation.
      // The throw happens before any mutation for this box, so it is left exactly
      // as-is (conservative default) and retried next pass.
      log.warn(
        `orphan reconcile failed for box ${box.sandboxId} on machine ${box.machineId}: ${
          err instanceof Error ? err.message : err
        }`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Machine-side remnant sweep
// ---------------------------------------------------------------------------

/** The single source of truth for a valid box username. Must match
 *  box-provision.sh's removal guard and box-paths' `boxUnixUser`. */
const BOX_USER_RE = /^box_[0-9a-f]{12}$/

/**
 * List the actual `box_<12hex>` unix users present on a machine via
 * `getent passwd`, filtered server-side to real login accounts (uid≥1000) whose
 * name matches the box convention, then RE-VALIDATED client-side against the
 * same strict regex (belt and braces — never trust the remote's output shape).
 *
 * Tolerant by construction: a nonzero exit, empty output, or a runner throw all
 * yield `[]` (an unreachable machine simply has no listable remnants right now).
 */
export async function listMachineBoxUsers(runner: SshRunner, machine: Machine): Promise<string[]> {
  let res
  try {
    res = await runner.run(machine, `getent passwd | awk -F: '$3 >= 1000 && $1 ~ /^box_[0-9a-f]{12}$/ {print $1}'`)
  } catch {
    return []
  }
  if (res.exitCode !== 0) return []
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => BOX_USER_RE.test(name))
}

export interface RemnantSweepDeps {
  /** SSH runner for the listing primitive + default remover (default: `defaultSshRunner`). */
  runner?: SshRunner
  /** List the machine's actual box users (default: real {@link listMachineBoxUsers}). */
  listMachineBoxUsers?: (runner: SshRunner, machine: Machine) => Promise<string[]>
  /** All box rows across all machines (default: real `listAllMachineBoxes`). */
  listRows?: () => Promise<MachineBox[]>
  /** Remove one bare box user on the machine (default: box-manager's `removeBoxUserOnMachine`). */
  remove?: (machine: Machine, unixUser: string) => Promise<void>
}

/** Box users on `machineId`, derived from the current row set. */
async function liveBoxUsers(listRows: () => Promise<MachineBox[]>, machineId: string): Promise<Set<string>> {
  const rows = await listRows()
  return new Set(rows.filter((row) => row.machineId === machineId).map((row) => boxUnixUser(row.sandboxId)))
}

/**
 * Reclaim machine-side box remnants on a RECOVERED machine.
 *
 * `reconcileOrphanedBoxes` is DB-row-driven, so a box re-placed off a machine
 * WHILE IT WAS DOWN leaves its `box_<hash>` unix user / home / unit stranded on
 * that machine once it recovers — invisible to the reconciler forever (a uid +
 * disk leak, possibly a stale sandbox server). This sweeps those:
 *
 *  1. `listed` = the machine's actual box users (getent, strict-regex filtered).
 *  2. `live`   = `boxUnixUser(sandboxId)` for EVERY `machine_boxes` row on THIS
 *     machine, ANY status (a row's box — even 'orphaned'/'stopped' — is never a
 *     remnant).
 *  3. remnants = listed − live. Per remnant: RE-FETCH the rows and re-check
 *     absence (TOCTOU guard — a box bound mid-sweep must survive), re-assert the
 *     strict regex (never hand a non-box name to the remover), then run the
 *     box-provision `--remove` invocation, which archives the whole home BEFORE
 *     `userdel` (data-preserving) and re-asserts its own guards.
 *
 * Best-effort per user: one removal failure is logged and the sweep continues.
 * Returns `{removed, failed}` for tests/observability; emits nothing (no row to
 * update). Only ever call on a machine already confirmed `ready`.
 */
export async function sweepMachineRemnants(
  machine: Machine,
  deps: RemnantSweepDeps = {}
): Promise<{ removed: string[]; failed: string[] }> {
  const runner = deps.runner ?? defaultSshRunner
  const listUsers = deps.listMachineBoxUsers ?? listMachineBoxUsers
  const listRows = deps.listRows ?? listAllMachineBoxesReal
  const remove = deps.remove ?? ((m: Machine, user: string) => removeBoxUserOnMachineReal(m, user, { runner }))

  const listed = await listUsers(runner, machine)
  const live = await liveBoxUsers(listRows, machine.id)

  const removed: string[] = []
  const failed: string[] = []
  for (const user of listed) {
    if (live.has(user)) continue // matches a live row (any status) → never a remnant
    if (!BOX_USER_RE.test(user)) continue // belt and braces: never remove a non-box user

    // TOCTOU guard: a box could have been bound to this user on this machine
    // between the initial diff and now. Re-fetch and re-check before removal.
    const fresh = await liveBoxUsers(listRows, machine.id)
    if (fresh.has(user)) continue

    try {
      await remove(machine, user)
      removed.push(user)
      log.info(`machine remnant sweep: removed ${user} on machine ${machine.name} (${machine.id}) (archived)`)
    } catch (err) {
      failed.push(user)
      log.warn(
        `machine remnant sweep: failed to remove ${user} on machine ${machine.name} (${machine.id}): ${
          err instanceof Error ? err.message : err
        }`
      )
    }
  }
  return { removed, failed }
}

// ---------------------------------------------------------------------------
// Disk-usage sampling (T3 — feeds the platform's storage guard, see
// docs/history/superpowers/specs/2026-08-07-machine-size-catalog-design.md's
// "Storage guard" section)
// ---------------------------------------------------------------------------

/**
 * `--output=used,size` in bytes (`-B1`), stripped of the header via `tail`
 * on the remote side so {@link parseDfOutput} only has to deal with
 * malformed/missing data, not a header it has to skip. GNU coreutils `df`
 * only (Ubuntu droplets) — `--output` is not POSIX/BSD. Samples
 * {@link DISK_SAMPLE_PATH} — see that constant's doc (machine-metrics-
 * sample.ts) for why this is the ONE shared "the disk" definition rather
 * than a second hardcoded path: this is df-level truth only, NOT a per-box
 * accounting (summing individual box homes), it's the whole filesystem's
 * used/total.
 */
const DISK_SAMPLE_COMMAND = `df -B1 --output=used,size ${DISK_SAMPLE_PATH} 2>/dev/null | tail -n +2`

/**
 * Parses one `df -B1 --output=used,size` data line into raw byte counts.
 * Tolerant by construction (mirrors {@link listMachineBoxUsers}): empty
 * output, a non-numeric field, or a nonsensical value (negative used, zero
 * or negative total) all yield `null` rather than throwing — an unreachable
 * or misbehaving machine simply has no disk sample this tick.
 *
 * Takes the LAST non-blank line, so a caller may pass either the raw
 * two-line `df` output (header + one data row) or the header-stripped
 * single line {@link DISK_SAMPLE_COMMAND} actually produces — the data row
 * is always the final one either way.
 */
export function parseDfOutput(stdout: string): { usedBytes: number; totalBytes: number } | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const line = lines[lines.length - 1]
  if (!line) return null

  const parts = line.split(/\s+/)
  if (parts.length < 2) return null

  const usedBytes = Number(parts[0])
  const totalBytes = Number(parts[1])
  if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes)) return null
  if (usedBytes < 0 || totalBytes <= 0) return null

  return { usedBytes, totalBytes }
}

/** 1 GiB in bytes — the unit {@link sampleMachineDiskUsage} floors to. */
const GIB = 1024 ** 3

/**
 * One `df`-level disk-usage sample of `machine`'s box-storage root
 * (see {@link DISK_SAMPLE_PATH}), floored to whole GiB integers.
 *
 * Never throws and never reports zeros for a failed sample: a nonzero exit,
 * a runner throw (unreachable machine), or unparseable output all yield
 * `null` — the caller (services/machines/usage-reporter.ts) treats `null`
 * as "omit the disk fields this tick", exactly like an absent commitSha,
 * rather than reporting a disk that reads as empty.
 */
export async function sampleMachineDiskUsage(
  machine: Machine,
  deps: { runner?: SshRunner } = {}
): Promise<{ usedGb: number; totalGb: number } | null> {
  const runner = deps.runner ?? defaultSshRunner
  let result: SshResult
  try {
    result = await runner.run(machine, DISK_SAMPLE_COMMAND)
  } catch {
    return null
  }
  if (result.exitCode !== 0) return null

  const parsed = parseDfOutput(result.stdout)
  if (!parsed) return null

  return {
    usedGb: Math.floor(parsed.usedBytes / GIB),
    totalGb: Math.floor(parsed.totalBytes / GIB),
  }
}
