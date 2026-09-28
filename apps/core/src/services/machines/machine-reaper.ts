import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { positiveIntEnv } from './placement'
import { getMachineProviderEnsured } from './providers'
import type { MachineProvider } from './provider'
import {
  claimMachineForReaping as claimMachineForReapingReal,
  deleteMachine as deleteMachineReal,
  listMachineBoxes as listMachineBoxesReal,
  listMachines as listMachinesReal,
  restoreMachineFromReaping as restoreMachineFromReapingReal,
  stampMachineEmptySinceIfDrained as stampMachineEmptySinceIfDrainedReal,
} from './queries'
import type { Machine } from './queries'
import { machineTunnels } from './tunnel-manager'

const log = createLogger('machine-reaper')

/**
 * Empty-machine reaper — the fleet-side counterpart of the box idle reaper.
 *
 * The box reaper PARKS idle boxes and owner termination/archival deletes their
 * `machine_boxes` rows, but nothing reclaimed the MACHINE those rows drained
 * off, so an auto-provisioning fleet could only ever grow. This pass terminates
 * a machine once it has sat empty past a grace period, completing the dumb
 * packer's story: pack units on, free units off, terminate the drained VM.
 *
 * Deliberately DUMB — no rebalancing, no affinity, no bin-repacking. A machine
 * is reaped iff ALL of:
 *  - `status='ready'` — or `'reaping'`, this reaper's own claim marker left by
 *    a crashed pass (see the recovery note below). An unreachable/parked/
 *    bootstrapping machine is never touched — the health sweep and the operator
 *    own those states;
 *  - `autoProvisioned` — tau created the VM unattended (placement's
 *    defaultProvisionMachine), so tau may reclaim it unattended. User-registered
 *    machines (BYO SSH, and operator exe-provisions via POST /api/machines,
 *    which are otherwise row-identical to packer VMs) are NEVER auto-terminated;
 *  - `provider='exe'` (belt on top of the marker: only billed cloud VMs are
 *    worth terminating, and BYO rows must never reach `provider.terminate`);
 *  - `purpose != 'dedicated'` — a dedicated VM exists for exactly one box and is
 *    torn down with its owner, not by idle accounting. Legacy pre-packer
 *    `squad`/`commons` VMs (backfilled autoProvisioned) ARE eligible — reaping
 *    them once drained is how the pre-packer fleet finally shrinks;
 *  - `empty_since` is set and older than the grace ({@link resolveMachineIdleGraceMs}).
 *    The marker is stamped when the machine loses its LAST box (deleteMachineBox)
 *    and cleared on every bind. A ready, eligible machine that is EMPTY but
 *    carries a null marker (see the stamp pass below) has its clock STARTED this
 *    pass and is only ever terminated a full grace later.
 *
 * ## Terminate is serialized against bind by a CLAIM, not a re-check
 * Placement can resolve an empty-but-within-grace machine and bind onto it —
 * with the squad=full-VM weights an EMPTY VM is exactly what a squad placement
 * targets, so this population genuinely races. Before touching the provider the
 * reaper CLAIMS the machine in one transaction ({@link claimMachineForReaping}):
 * machines-row FOR UPDATE (the same lock bindMachineBox takes) → re-verify
 * eligibility against the locked row → in-transaction zero-box count → flip
 * `status` to `'reaping'`. Only a committed claim proceeds to
 * `provider.terminate`; bindMachineBox REJECTS any non-'ready' machine under
 * that same lock, so either the bind lands first (the claim sees the box and
 * aborts — correct, the machine is saved) or the claim lands first (the bind
 * throws MachineNotReadyError and its caller re-places onto another machine).
 * There is no interleaving in which a VM is terminated with a live box.
 * `'reaping'` machines are invisible to placement (its queries filter
 * `status='ready'`).
 *
 * ## Crash recovery — a stale `'reaping'` is re-eligible, never stranded
 * A worker that dies between claim and terminate/restore leaves the row
 * `'reaping'`. Such a machine cannot gain a box (binds reject it), so the
 * recovery is simply that `'reaping'` rows stay reap candidates: the next pass
 * re-claims (re-verifying zero boxes under the lock; the claim is a no-op
 * status write) and re-terminates. The reaper is the only writer of
 * `'reaping'` and runs single-threaded in the worker, so re-eligibility never
 * double-terminates a live reap. On a FAILED terminate the pass restores the
 * row to `'ready'` ({@link restoreMachineFromReaping}) so binds may land again
 * and the next pass retries — the row is deleted only after a successful
 * terminate, preserving the no-billed-orphan-without-a-row property.
 *
 * ## Stamp pass — empty machines with a null marker get a clock, not an exemption
 * Two drain paths bypass deleteMachineBox's last-box stamp and would otherwise
 * leave a ready, auto-provisioned, ZERO-box VM reaper-exempt (billed) forever:
 * a bind REPOINTING a box's row off its old machine (ensureBox re-place off a
 * dead machine / explicit migrate), and a VM provisioned but never bound (the
 * caller failed between provision and bind). When this pass sees an eligible
 * ready machine with zero boxes and `empty_since IS NULL`, it stamps
 * `empty_since = now` under the same lock + zero-count discipline
 * ({@link stampMachineEmptySinceIfDrained}) — no terminate on that pass. The
 * machine is reaped a full grace later unless a bind (which clears the marker)
 * saves it; a genuinely fresh VM whose first bind lands within the grace
 * (normally milliseconds after provision) is therefore still safe.
 *
 * Termination mirrors the DELETE /api/machines/:id route: provider.terminate →
 * best-effort ControlMaster close → delete the row → emit `machine.deleted`.
 * No secret is ever dropped — exe VMs share the account key
 * (EXE_PROVIDER_SSH_KEY), which every other exe VM still references. Failures
 * are per-machine: one machine's failed terminate is logged, its claim rolled
 * back to 'ready', and the sweep continues.
 */

/** Default grace a machine may sit empty before it is reaped (10 min). */
export const DEFAULT_MACHINE_IDLE_GRACE_MS = 10 * 60_000

/** How long a machine may sit empty before the reaper terminates it —
 *  `FICUS_MACHINE_IDLE_GRACE_MS` (positive-int env, same rule as the other knobs),
 *  else {@link DEFAULT_MACHINE_IDLE_GRACE_MS}. */
export function resolveMachineIdleGraceMs(): number {
  return positiveIntEnv('FICUS_MACHINE_IDLE_GRACE_MS', DEFAULT_MACHINE_IDLE_GRACE_MS)
}

/** The tunnel surface the reaper needs (`machineTunnels` satisfies it). */
interface ReaperTunnels {
  closeMachine(machine: Machine): Promise<void>
}

/** All external effects, injectable for tests; each defaults to production. */
export interface ReapEmptyMachinesDeps {
  listMachines?: typeof listMachinesReal
  listMachineBoxes?: typeof listMachineBoxesReal
  claimMachine?: typeof claimMachineForReapingReal
  restoreMachine?: typeof restoreMachineFromReapingReal
  stampEmptySince?: typeof stampMachineEmptySinceIfDrainedReal
  getProvider?: (key: string) => MachineProvider | Promise<MachineProvider>
  deleteMachine?: typeof deleteMachineReal
  tunnels?: ReaperTunnels
  /** Injected clock (epoch ms) — pinned in tests. */
  now?: () => number
  /** Grace override; defaults to {@link resolveMachineIdleGraceMs}. */
  graceMs?: number
}

/**
 * Reap-eligibility predicate — everything except the zero-box count, which only
 * the claim transaction can answer authoritatively. Also the IN-TRANSACTION
 * re-check {@link claimMachineForReaping} runs against the locked row, so it
 * must depend on row fields + clock alone. Exported for direct unit testing.
 *
 * `'reaping'` is accepted alongside `'ready'`: it is this reaper's own claim
 * marker, and treating it as still-eligible is the crash recovery (a claimed
 * machine whose pass died is re-claimed and re-terminated next pass; it cannot
 * have gained a box because binds reject non-ready machines).
 */
export function isReapCandidate(machine: Machine, nowMs: number, graceMs: number): boolean {
  if (machine.status !== 'ready' && machine.status !== 'reaping') return false
  if (!machine.autoProvisioned) return false // user-owned (BYO or operator-provisioned) — never
  if (machine.provider !== 'exe') return false // belt: only billed cloud VMs
  if (machine.purpose === 'dedicated') return false // torn down with its owner, never by idling
  if (!machine.emptySince) return false // hosting, or unmarked-empty (the stamp pass owns it) — wait for the clock
  return nowMs - machine.emptySince.getTime() > graceMs
}

/**
 * Stamp-eligibility predicate: a machine the reaper would reap EXCEPT that its
 * idle clock never started (`empty_since` null). Status must be exactly
 * `'ready'` here — an unmarked `'reaping'` row cannot exist (claims require a
 * marker), and no other status may have its clock started. The zero-box check
 * is the stamp transaction's job. Exported for direct unit testing.
 */
export function isUnmarkedDrainCandidate(machine: Machine): boolean {
  return (
    machine.status === 'ready' &&
    machine.autoProvisioned &&
    machine.provider === 'exe' &&
    machine.purpose !== 'dedicated' &&
    machine.emptySince === null
  )
}

/**
 * One reap pass: claim + terminate every eligible machine that is still empty
 * at claim time, and start the idle clock on eligible empty machines whose
 * marker is null. Runs from the worker's vm lifecycle tick (lifecycle.ts).
 */
export async function reapEmptyMachines(deps: ReapEmptyMachinesDeps = {}): Promise<void> {
  const listMachines = deps.listMachines ?? listMachinesReal
  const listMachineBoxes = deps.listMachineBoxes ?? listMachineBoxesReal
  const claimMachine = deps.claimMachine ?? claimMachineForReapingReal
  const restoreMachine = deps.restoreMachine ?? restoreMachineFromReapingReal
  const stampEmptySince = deps.stampEmptySince ?? stampMachineEmptySinceIfDrainedReal
  // Ensured default: self-heals a registry miss (api registration races
  // secret-store init; a key seeded after boot never reaches a boot-only
  // registration). Injected fakes bypass the self-heal (sync throw propagates).
  const getProvider = deps.getProvider ?? ((key: string) => getMachineProviderEnsured(key))
  const deleteMachine = deps.deleteMachine ?? deleteMachineReal
  const tunnels = deps.tunnels ?? machineTunnels
  const nowMs = (deps.now ?? Date.now)()
  const graceMs = deps.graceMs ?? resolveMachineIdleGraceMs()

  const machines = await listMachines()
  for (const machine of machines) {
    try {
      // Stamp pass: an eligible EMPTY machine with a null marker gets its idle
      // clock started (repoint-drained or provisioned-but-never-bound — see the
      // module doc). The cheap box-list read pre-filters; the stamp transaction
      // re-checks status/marker/count authoritatively under the row lock. Never
      // terminates on this pass — reap-eligibility begins a full grace later.
      if (isUnmarkedDrainCandidate(machine)) {
        const boxes = await listMachineBoxes(machine.id)
        if (boxes.length > 0) continue
        if (await stampEmptySince(machine.id, new Date(nowMs))) {
          log.info(
            `machine ${machine.name} (${machine.id}) is empty with no idle marker ` +
              `(repoint-drained or never bound); started its idle clock`
          )
        }
        continue
      }

      if (!isReapCandidate(machine, nowMs, graceMs)) continue

      // Cheap pre-filter before taking the row lock: a machine that visibly
      // hosts boxes cannot be claimed anyway.
      const boxes = await listMachineBoxes(machine.id)
      if (boxes.length > 0) continue

      // CLAIM: FOR UPDATE the machines row, re-verify eligibility + zero boxes
      // in-transaction, flip status to 'reaping'. A bind that raced us either
      // committed first (claim returns false — the machine is saved) or will
      // reject on the 'reaping' status. Only a committed claim may terminate.
      const claimed = await claimMachine(machine.id, (row) => isReapCandidate(row, nowMs, graceMs))
      if (!claimed) continue

      try {
        // Terminate the billed VM first; only a successful terminate may delete
        // the row (a kept row is retried next pass — never an invisible paid orphan).
        await (await getProvider(machine.provider)).terminate(machine)
      } catch (err) {
        // Failed terminate: roll the claim back to 'ready' so binds may land
        // again and the next pass retries. If even the restore fails the row
        // stays 'reaping' — still recovered, since 'reaping' rows remain
        // reap-eligible (see the crash-recovery note).
        await restoreMachine(machine.id).catch((restoreErr) => {
          log.warn(
            `failed to restore machine ${machine.name} (${machine.id}) to ready after a failed ` +
              `terminate (row left 'reaping'; next pass re-claims): ${String(restoreErr)}`
          )
        })
        log.warn(
          `failed to terminate empty machine ${machine.name} (${machine.id}); restored to ready for ` +
            `retry next pass: ${err instanceof Error ? err.message : String(err)}`
        )
        continue
      }

      // Best-effort: drop the shared ControlMaster so no process keeps a live
      // master (and its forwards) to a terminated VM. The socket dies with the
      // VM anyway, so a failure here must not block reclaiming the row.
      await tunnels.closeMachine(machine).catch((err) => {
        log.warn(`failed to close tunnels for reaped machine ${machine.name} (${machine.id}): ${String(err)}`)
      })
      // NO secret cleanup: exe VMs share the account key (EXE_PROVIDER_SSH_KEY),
      // which every other exe VM references — never delete it.
      await deleteMachine(machine.id)
      eventEmitter.emit('machine.deleted', { machineId: machine.id })
      log.info(
        `reaped empty machine ${machine.name} (${machine.id}): empty since ` +
          `${machine.emptySince!.toISOString()} (grace ${graceMs}ms)`
      )
    } catch (err) {
      // Per-machine isolation: one machine's failure (query hiccup, provider
      // registry miss) is logged and retried next pass; the sweep continues.
      log.warn(
        `failed to reap empty machine ${machine.name} (${machine.id}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}
