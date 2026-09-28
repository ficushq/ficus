import { createLogger } from '../../lib/infra/logger'
import { isVmRuntime as isVmRuntimeReal } from '../sandbox/runtime'
import { migrateBox as migrateBoxReal } from './box-migrate'
import type { MigrateResult } from './box-migrate'
import {
  DEFAULT_MAX_MACHINES,
  packedMachineName,
  positiveIntEnv,
  provisionCapped,
  resolveMachineUnitCapacity,
  unitWeightForSandboxId,
} from './placement'
import type { ProvisionMachineOpts } from './placement'
import {
  countMachines as countMachinesReal,
  queryReadySharedMachineLoads as queryReadySharedMachineLoadsReal,
} from './queries'
import type { Machine } from './queries'

const log = createLogger('rebalance')

/**
 * Manual fleet rebalance on top of the migrateBox primitive: re-pack EXISTING
 * boxes so the packed shared pool satisfies its two placement invariants again
 * after a weight/capacity change (the packer only ever places NEW boxes — a
 * `FICUS_UNIT_WEIGHT_*` / `FICUS_MACHINE_UNIT_CAPACITY` change can leave live boxes
 * co-located in ways placement would now refuse):
 *
 *  (a) unit budget — Σ unitWeightForSandboxId over a VM's boxes ≤ the machine
 *      unit capacity;
 *  (b) squad exclusivity — a `squad_` box shares its VM with NOTHING else
 *      (squads are VM-exclusive anchors; their ~/workspace never migrates).
 *
 * `planRebalance` is the PURE half — reads the fleet, returns the plan, touches
 * nothing — so a dry run is exact: `rebalanceFleet({ dryRun: true })` is the
 * plan the real run would execute. Squad boxes never move; evacuees are chosen
 * lightest-first among a violating VM's non-squad boxes, and each is targeted
 * best-fit (smallest surviving free capacity, resolvePacked's tie-break)
 * against the fleet's VIRTUAL state — capacities shrink as earlier evacuees
 * are assigned — so the plan is self-consistent within one pass.
 *
 * Mirroring resolvePacked's over-capacity guard, a lone non-squad box heavier
 * than the capacity is NOT a violation (the packer deliberately gives such a
 * box its own VM; evacuating it to a fresh VM would reproduce the violation
 * forever), and shedding stops once a VM is down to a single non-squad box for
 * the same reason. Violations no legal move can fix (squads never move) are
 * surfaced in {@link RebalancePlan.unresolvable} instead of being silently
 * skipped.
 */

/** Synthetic target-id prefix for moves whose target must be provisioned. */
const PROVISION_TARGET_PREFIX = 'provision:'

function isProvisionTarget(machineId: string): boolean {
  return machineId.startsWith(PROVISION_TARGET_PREFIX)
}

/**
 * A second EXECUTING rebalance was refused because one is already running in
 * this process. Overlapping executes are never safe to interleave: each would
 * provision its OWN fresh machines for its provision groups (the per-box
 * migrating fence prevents double-MOVES, but nothing else prevents
 * double-PROVISION of billed VMs — the empty-machine reaper only reclaims the
 * losers later). Dry runs are read-only and are never refused.
 */
export class RebalanceInProgressError extends Error {
  constructor() {
    super('a rebalance is already in progress; retry when it completes (dry runs are not blocked)')
    this.name = 'RebalanceInProgressError'
  }
}

/** In-process single-flight guard for the EXECUTE path (see the error above). */
let executeInFlight = false

export interface RebalanceMove {
  sandboxId: string
  fromMachineId: string
  /** A concrete ready machine id, or a synthetic provision GROUP id
   *  (`provision:0`, `provision:1`, …): no existing VM fits, so the executing
   *  loop provisions ONE fresh shared machine per distinct group and migrates
   *  every move carrying that id onto it. The planner packs provision evacuees
   *  best-fit onto these virtual new VMs (each with the full machine unit
   *  capacity), so a weight/capacity shrink consolidates onto the fewest new
   *  machines instead of fanning out one VM per evacuee. */
  toMachineId: string
}

export interface RebalancePlan {
  moves: RebalanceMove[]
  /** Boxes whose migrate was refused by a live turn (`active-turn`). Always empty
   *  from the pure planner — activity is only discovered under migrateBox's fence. */
  skippedActive: string[]
  /** Evacuees with no fitting VM and no cap headroom to provision one. */
  unplaceable: string[]
  /** Machine ids left violating an invariant that NO legal move can fix, since
   *  squads never move — e.g. two squad boxes sharing a VM, or a lone squad box
   *  heavier than the machine capacity. Surfaced so a dry run over a fleet the
   *  planner cannot heal doesn't read as "fleet healthy". */
  unresolvable: string[]
}

/** All external effects, injectable for tests; each defaults to production. */
export interface RebalanceDeps {
  isVmRuntime?: () => boolean
  queryReadyMachineLoads?: () => Promise<Array<{ machine: Machine; boxSandboxIds: string[] }>>
  countMachines?: () => Promise<number>
  /** Fleet cap; defaults to `FICUS_MAX_MACHINES` (or {@link DEFAULT_MAX_MACHINES}). */
  maxMachines?: number
  provisionMachine?: (opts: ProvisionMachineOpts) => Promise<Machine>
  migrateBox?: (sandboxId: string, targetMachineId: string) => Promise<MigrateResult>
}

interface VmState {
  machine: Machine
  /** Non-squad boxes, the only movable kind, lightest-first. */
  movable: Array<{ sandboxId: string; weight: number }>
  hasSquad: boolean
  boxCount: number
  /** Σ weight of the boxes VIRTUALLY on this VM — shrinks as evacuees leave,
   *  grows as the plan assigns evacuees to it. */
  used: number
}

/** resolvePacked's deterministic tie-break: (createdAt, id) ascending. */
function byMachineAge(a: VmState, b: VmState): number {
  return (
    a.machine.createdAt.getTime() - b.machine.createdAt.getTime() ||
    (a.machine.id < b.machine.id ? -1 : a.machine.id > b.machine.id ? 1 : 0)
  )
}

/**
 * Order moves so a machine's OUTBOUND moves execute before its INBOUND ones:
 * a move into M waits until every move out of M has run, so a VM that both
 * sheds and receives is never transiently pushed over capacity by an inbound
 * landing first (which, if M's own outbound then failed, would leave M over
 * capacity until the next run). Kahn-style and stable — moves whose target has
 * no pending outbound (including all `provision:` targets) keep plan order. A
 * genuine cycle (A→B and B→A, possible with mixed weights) has no compliant
 * ordering; fall back to plan order for it — the final state is still valid
 * and a failure mid-cycle heals on the next run.
 */
function orderOutboundFirst(moves: RebalanceMove[]): RebalanceMove[] {
  const pendingOutbound = new Map<string, number>()
  for (const move of moves) {
    pendingOutbound.set(move.fromMachineId, (pendingOutbound.get(move.fromMachineId) ?? 0) + 1)
  }
  const pending = [...moves]
  const ordered: RebalanceMove[] = []
  while (pending.length > 0) {
    const readyIdx = pending.findIndex((m) => (pendingOutbound.get(m.toMachineId) ?? 0) === 0)
    const [move] = pending.splice(readyIdx === -1 ? 0 : readyIdx, 1)
    ordered.push(move)
    pendingOutbound.set(move.fromMachineId, (pendingOutbound.get(move.fromMachineId) ?? 1) - 1)
  }
  return ordered
}

/**
 * Compute the fleet's re-pack plan — pure: no migrate, no provision, reads only.
 * See the module doc for the invariants and selection rules. vm-runtime only.
 */
export async function planRebalance(deps: RebalanceDeps = {}): Promise<RebalancePlan> {
  if (!(deps.isVmRuntime ?? isVmRuntimeReal)()) {
    throw new Error('rebalanceFleet is only available on the VM sandbox runtime')
  }

  const capacity = resolveMachineUnitCapacity()
  const loads = await (deps.queryReadyMachineLoads ?? queryReadySharedMachineLoadsReal)()

  const states: VmState[] = loads
    .map(({ machine, boxSandboxIds }) => {
      const weighed = boxSandboxIds.map((sandboxId) => ({ sandboxId, weight: unitWeightForSandboxId(sandboxId) }))
      return {
        machine,
        movable: weighed
          .filter((b) => !b.sandboxId.startsWith('squad_'))
          .sort((a, b) => a.weight - b.weight || (a.sandboxId < b.sandboxId ? -1 : 1)),
        hasSquad: weighed.some((b) => b.sandboxId.startsWith('squad_')),
        boxCount: weighed.length,
        used: weighed.reduce((sum, b) => sum + b.weight, 0),
      }
    })
    .sort(byMachineAge)

  // 1. Evacuee selection, per violating VM: a squad VM sheds ALL its non-squad
  // co-tenants; an over-budget VM sheds its lightest non-squad boxes until it
  // fits OR only one (the heaviest — necessarily over-weight, the packer's
  // tolerated own-VM shape) remains. A lone over-weight non-squad box is not a
  // violation at all (see module doc); a VM still violating after shedding all
  // it legally can (two squads; a lone over-weight squad) is unresolvable.
  const evacuees: Array<{ sandboxId: string; weight: number; from: VmState }> = []
  const unresolvable: string[] = []
  for (const state of states) {
    const loneNonSquad = state.boxCount === 1 && !state.hasSquad
    const violating = (state.used > capacity && !loneNonSquad) || (state.hasSquad && state.boxCount > 1)
    if (!violating) continue
    let remaining = state.boxCount
    for (const box of state.movable) {
      if (!state.hasSquad && (state.used <= capacity || remaining === 1)) break
      evacuees.push({ ...box, from: state })
      state.used -= box.weight
      remaining--
    }
    const stillOverCapacity = state.used > capacity && !(remaining === 1 && !state.hasSquad)
    if (stillOverCapacity || (state.hasSquad && remaining > 1)) unresolvable.push(state.machine.id)
  }

  // 2. Target assignment against the VIRTUAL fleet state (a target's free
  // capacity shrinks as evacuees land on it). Squad VMs are never targets, even
  // with spare units — invariant (b) — and a box never "moves" to its own VM.
  // An evacuee no existing VM can host is best-fit packed onto the VIRTUAL new
  // VMs this plan already promises (each one machine the executor will
  // provision, counting once against the fleet cap); a fresh virtual VM is
  // created only when the evacuee fits none — and, mirroring resolvePacked's
  // over-capacity fall-through, a fresh VM accepts its first box even when the
  // box alone exceeds the capacity (a squad co-tenant heavier than any VM still
  // MUST move somewhere).
  const moves: RebalanceMove[] = []
  const unplaceable: string[] = []
  const virtualNewUsed: number[] = [] // index = provision group id
  let machineCount: number | null = null
  const maxMachines = deps.maxMachines ?? positiveIntEnv('FICUS_MAX_MACHINES', DEFAULT_MAX_MACHINES)

  for (const evacuee of evacuees) {
    const candidates = states.filter((s) => s !== evacuee.from && !s.hasSquad && capacity - s.used >= evacuee.weight)
    if (candidates.length > 0) {
      // Best-fit: the eligible VM with the SMALLEST free capacity (fullest), like
      // resolvePacked, so evacuees consolidate instead of spreading.
      candidates.sort((a, b) => capacity - a.used - (capacity - b.used) || byMachineAge(a, b))
      const target = candidates[0]
      target.used += evacuee.weight
      moves.push({
        sandboxId: evacuee.sandboxId,
        fromMachineId: evacuee.from.machine.id,
        toMachineId: target.machine.id,
      })
      continue
    }

    // Best-fit among the virtual new VMs already planned (smallest free wins;
    // ties keep the earliest group).
    let group = -1
    let bestFree = Number.POSITIVE_INFINITY
    for (let i = 0; i < virtualNewUsed.length; i++) {
      const free = capacity - virtualNewUsed[i]
      if (free >= evacuee.weight && free < bestFree) {
        bestFree = free
        group = i
      }
    }
    if (group === -1) {
      // A new virtual VM counts against the fleet cap alongside every machine
      // that exists and every provision this plan already promises.
      machineCount ??= await (deps.countMachines ?? countMachinesReal)()
      if (machineCount + virtualNewUsed.length >= maxMachines) {
        unplaceable.push(evacuee.sandboxId)
        continue
      }
      group = virtualNewUsed.length
      virtualNewUsed.push(0)
    }
    virtualNewUsed[group] += evacuee.weight
    moves.push({
      sandboxId: evacuee.sandboxId,
      fromMachineId: evacuee.from.machine.id,
      toMachineId: `${PROVISION_TARGET_PREFIX}${group}`,
    })
  }

  return { moves: orderOutboundFirst(moves), skippedActive: [], unplaceable, unresolvable }
}

/**
 * Plan, then execute: each move runs through {@link migrateBox} SEQUENTIALLY,
 * in the plan's outbound-before-inbound order. Each distinct `provision:<n>`
 * group is resolved to ONE freshly provisioned shared machine the first time
 * it appears (sequential, so no provisioning storm); a group whose provisioning
 * throws fails ALL of its moves (recorded as `provision-failed`, not retried)
 * and the loop continues with the rest of the plan. One move's failure is
 * logged and recorded (`failed`), never aborts the loop; a migrate refused by
 * a live turn (`active-turn`) rolls into `skippedActive`. `dryRun` returns the
 * plan with NO effects. Idempotent: a fleet with no violations plans zero moves.
 *
 * Each result carries `targetMachineId`, the REAL machine the move aimed at:
 * the move's `toMachineId` for an existing VM, or the machine actually
 * provisioned for the move's `provision:<n>` group (absent only when that
 * provisioning failed — there is no machine to name).
 *
 * Executes are single-flight per process ({@link RebalanceInProgressError});
 * dry runs never take or check the guard.
 */
export async function rebalanceFleet(
  opts: { dryRun?: boolean } = {},
  deps: RebalanceDeps = {}
): Promise<RebalancePlan & { results: Array<{ sandboxId: string; result: MigrateResult; targetMachineId?: string }> }> {
  if (opts.dryRun) {
    const plan = await planRebalance(deps)
    return { ...plan, results: [] }
  }

  if (executeInFlight) throw new RebalanceInProgressError()
  executeInFlight = true
  try {
    return await executeRebalance(deps)
  } finally {
    executeInFlight = false
  }
}

/** The execute path of {@link rebalanceFleet}; caller holds the single-flight guard. */
async function executeRebalance(
  deps: RebalanceDeps
): Promise<RebalancePlan & { results: Array<{ sandboxId: string; result: MigrateResult; targetMachineId?: string }> }> {
  const plan = await planRebalance(deps)

  const migrate =
    deps.migrateBox ?? ((sandboxId: string, targetMachineId: string) => migrateBoxReal(sandboxId, targetMachineId))
  const results: Array<{ sandboxId: string; result: MigrateResult; targetMachineId?: string }> = []
  const skippedActive = [...plan.skippedActive]

  // One machine per provision group, resolved lazily on the group's first move;
  // `null` records a group whose provisioning failed so later moves in the same
  // group fail fast instead of re-provisioning.
  const provisionedByGroup = new Map<string, string | null>()
  const resolveProvisionGroup = async (groupId: string): Promise<string | null> => {
    if (provisionedByGroup.has(groupId)) return provisionedByGroup.get(groupId) ?? null
    let machineId: string | null = null
    try {
      const machine = await provisionCapped(
        {
          ...(deps.countMachines ? { countMachines: deps.countMachines } : {}),
          ...(deps.provisionMachine ? { provisionMachine: deps.provisionMachine } : {}),
          ...(deps.maxMachines !== undefined ? { maxMachines: deps.maxMachines } : {}),
        },
        { name: packedMachineName(), purpose: 'shared', scope: 'shared' }
      )
      machineId = machine.id
    } catch (err) {
      log.warn(
        `rebalance: provisioning for group ${groupId} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    provisionedByGroup.set(groupId, machineId)
    return machineId
  }

  for (const move of plan.moves) {
    let targetMachineId = move.toMachineId
    if (isProvisionTarget(move.toMachineId)) {
      const resolved = await resolveProvisionGroup(move.toMachineId)
      if (resolved === null) {
        results.push({ sandboxId: move.sandboxId, result: { moved: false, reason: 'provision-failed' } })
        continue
      }
      targetMachineId = resolved
    }

    let result: MigrateResult
    try {
      result = await migrate(move.sandboxId, targetMachineId)
    } catch (err) {
      // Contain the failure to this move: the rest of the plan still runs (each
      // move is independent — migrateBox leaves a failed box intact on its old
      // machine). Shape the throw as a structured non-move.
      log.warn(
        `rebalance: move of ${move.sandboxId} (${move.fromMachineId} → ${move.toMachineId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      result = { moved: false, reason: 'failed' }
    }
    results.push({ sandboxId: move.sandboxId, result, targetMachineId })
    if (!result.moved && result.reason === 'active-turn') skippedActive.push(move.sandboxId)
  }

  return { ...plan, skippedActive, results }
}
