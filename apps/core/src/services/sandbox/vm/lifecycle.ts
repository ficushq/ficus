import { consultantSandboxSquadId } from '../consultant-sandbox'
/**
 * The `vm-sandbox-lifecycle` periodic loop — the vm-runtime counterpart to the
 * k8s manager's 60s reconciliation loop (k8s/manager.ts:699-721). The vm runtime
 * had NO periodic lifecycle at all; this ties together the slice-4 primitives:
 *
 *   (a) IDLE REAP — enumerate every box from the DB (`listAllMachineBoxes`, not
 *       process state, so it survives a Core restart), decide per box whether to
 *       park it (`shouldParkBox`), and PARK the parkable ones via `stopBox`
 *       (state persists; NEVER `removeBox` — removal is explicit teardown only).
 *   (b) MACHINE HEALTH — `sweepMachineHealth` flips dead machines `unreachable`.
 *   (c) ORPHAN RECONCILE — `reconcileOrphanedBoxes` reclaims rows on dead
 *       machines whose owners are terminated.
 *   (d) EMPTY-MACHINE REAP — `reapEmptyMachines` terminates ready
 *       auto-provisioned VMs that drained (zero boxes) past the idle grace, so
 *       the fleet the packer grows can also shrink.
 *   (e) SPEC DRIFT + WARM — `reconcileSquadSandboxSpecs` + the two warmups.
 *
 * The tick composition (`runVmSandboxLifecycleTick`) is exported separately from
 * the runner so it is unit-testable with injected fakes. Every sub-step is
 * wrapped so one failing step logs and continues — a machine-health error must
 * NOT skip warmup — and each per-box park decision is isolated so one box's
 * keepAlive rejection (`shouldParkBox` does not catch it by design) cannot abort
 * the whole reap sweep.
 */

import { isLiveAgentStatus, type AgentStatus } from '@ficus/shared'
import { join } from 'path'
import { createLogger } from '../../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { isVmRuntime } from '../factory'
import { DEFAULT_IDLE_TIMEOUT_MS } from '../k8s/constants'
import { getSquadIdFromSandbox } from '../types'
import { shouldKeepSquadWarm, type ShouldKeepSquadWarmDeps, type SquadForKeepWarm } from '../keep-warm'
import { shouldParkBox, vmBoxAlwaysOnDefault, type IdleCandidate } from './idle'
import type { VmLifecycleState } from './manager'
import type { BoxLivenessHintResolver } from '../types'
import type { Machine, MachineBox } from '../../machines/queries'
import type { Squad } from '../../../entities/Squad'

const log = createLogger('vm-sandbox-lifecycle')

/** Minimal logger surface used by the tick and the modules it delegates to. */
interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/** Reconcile the vm runtime every 60s — mirrors the k8s manager's cadence. */
const LIFECYCLE_INTERVAL_MS = 60_000

/**
 * Every external effect the tick drives, injected for testability. The
 * production wiring is built lazily in {@link buildProductionTickDeps} so
 * starting the subsystem never eagerly constructs the sandbox manager.
 */
export interface VmLifecycleTickDeps {
  /**
   * All boxes across all machines (DB-driven — survives a Core restart).
   * Called ONCE per tick; the array is handed to every step that needs boxes.
   */
  listAllMachineBoxes: () => Promise<MachineBox[]>
  /**
   * All machines. Called ONCE per tick and handed to the orphan reconcile as a
   * map, replacing its per-box `getMachine` lookup (machines number in the
   * single digits; boxes in the dozens).
   */
  listMachines: () => Promise<Machine[]>
  /** Active, non-anonymous squads. Called ONCE per tick, shared by (e)'s steps. */
  listActiveSquads: () => Promise<Squad[]>
  /**
   * Idle-policy view of a box THIS process tracks, or `undefined` for a box it
   * never ensured. Supplies `lastActivityAt`/`idleTimeoutMs`/`alwaysOn` ONLY —
   * the readiness gate reads the authoritative DB row status, never this
   * (its `.status` is a hardcoded `'ready'`).
   */
  getLifecycleState: (sandboxId: string) => VmLifecycleState | undefined
  /** Keepalive predicate: true while the box should be kept warm. */
  keepAlive: (sandboxId: string) => Promise<boolean>
  /** Park a box (stop the unit, mark the row `stopped`; state persists). */
  stopBox: (sandboxId: string) => Promise<void>
  /** Detach a non-ready machine's unverified stop into a durable remnant row. */
  externalizeUnverifiedStop: (sandboxId: string) => Promise<boolean>
  /** Flip dead machines to `unreachable` / recovered ones back to `ready`. */
  sweepMachineHealth: () => Promise<void>
  /**
   * Reclaim `machine_boxes` rows stranded on dead machines with terminated
   * owners, over the boxes + machines this tick already loaded.
   */
  reconcileOrphanedBoxes: (ctx: { boxes: MachineBox[]; machines: ReadonlyMap<string, Machine> }) => Promise<void>
  /** Terminate ready auto-provisioned machines that drained past the idle grace. */
  reapEmptyMachines: () => Promise<void>
  /** Recreate always-on squad boxes whose immutable spec drifted. */
  reconcileSquadSpecs: (squads?: Squad[]) => Promise<void>
  /** Replay durable setup state into deduplicated incident episodes. */
  reconcileSetupIncidents: () => Promise<void>
  /** Discover physically-ready legacy boxes with no durable setup row. */
  recoverMissingSetups: () => Promise<void>
  /** Reconcile durable setup rows whose backoff is due. */
  recoverDueSetups: () => Promise<void>
  /**
   * The loopback ports currently listening on `machine` — ONE `ss -ltnH` per
   * machine per tick. Under socket activation a box's `.socket` unit holds its
   * port whether or not a server process exists, so this is how the tick learns
   * a box is alive WITHOUT an HTTP probe that would wake it.
   */
  listListeningPorts: (machine: Machine) => Promise<Set<number>>
  /**
   * Persist the sweep's result: stamp `last_listening_at` on every box seen
   * listening. The sweep runs HERE (the worker), but the box-status path the UI
   * polls runs in the API, which has no `ss` of its own — the watermark is how
   * it learns a box is alive without an HTTP probe that would wake it. Optional
   * so a test tick need not wire it; failures are logged and never fail a tick
   * (a missed stamp only means the next status poll probes, as it does today).
   */
  stampBoxesListening?: (sandboxIds: string[], at: Date) => Promise<void>
  /** Keep active squads' boxes warm. */
  warmupSquads: (squads: Squad[] | undefined, resolveBoxLiveness?: BoxLivenessHintResolver) => Promise<void>
  /** Keep work-stream agents' personal boxes warm while their streams are active. */
  warmupWorkStreams: (resolveBoxLiveness?: BoxLivenessHintResolver) => Promise<void>
  /** Injected clock (epoch ms) — pinned in tests. */
  now: () => number
  log: Logger
}

/**
 * Run one lifecycle pass. Each sub-step is wrapped so a failure
 * logs and continues (a machine-health error must not skip warmup), and each
 * per-box park decision is isolated so one box's keepAlive rejection cannot
 * abort the whole reap.
 */
export async function runVmSandboxLifecycleTick(deps: VmLifecycleTickDeps): Promise<void> {
  const now = deps.now()

  // ENTITY LOADS — done ONCE per tick and shared by every step below. Each of
  // (a) idle reap, (c) orphan reconcile and (e)'s two squad steps used to
  // re-issue the same `machine_boxes` / `machines` / active-squads queries, so
  // one tick scanned `machine_boxes` twice, `machines` once per BOX, and listed
  // active squads twice. Loading failures are isolated (null → the steps that
  // need that entity are skipped and logged, the rest of the tick proceeds).
  let boxes: MachineBox[] | null = null
  try {
    boxes = await deps.listAllMachineBoxes()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: listing boxes failed:', err)
  }

  // (a) IDLE REAP — DB-driven, per-box isolated.
  try {
    for (const box of boxes ?? []) {
      try {
        // T1 landmine: boxStatus is the authoritative DB row status. Sourcing it
        // from getLifecycleState() (hardcoded 'ready') would make the readiness
        // gate a no-op and could park a mid-provisioning/drifted box. Use the
        // tracked lifecycle state ONLY for activity/timeout/alwaysOn.
        const state = deps.getLifecycleState(box.sandboxId)
        // Activity is CROSS-PROCESS: this reaper runs in the worker, but a live
        // api-side terminal/exec touches only the api's in-memory copy — which
        // it persists (throttled) to the row's last_activity_at heartbeat. Take
        // max(process-local, row) so the worker neither parks a box mid-use in
        // the api, nor lets a box only this row knows about (api-ensured,
        // worker-untracked) idle forever un-reaped.
        const rowActivity = box.lastActivityAt?.getTime()
        const localActivity = state?.lastActivityAt
        const lastActivityAt =
          localActivity === undefined && rowActivity === undefined
            ? undefined
            : Math.max(localActivity ?? 0, rowActivity ?? 0)
        const candidate: IdleCandidate = {
          sandboxId: box.sandboxId,
          boxStatus: box.status,
          lastActivityAt,
          idleTimeoutMs: state?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          // A TRACKED box (state defined) already carries the resolved
          // alwaysOn manager.ts computed at ensure time (which itself already
          // folds in vmBoxAlwaysOnDefault() — see idle.ts's doc), so this only
          // ever falls back for an UNTRACKED box: one ensured by the OTHER
          // process, or by this process before a worker restart wiped its
          // in-memory map. That fallback must be the SAME vm-wide default
          // policy, not a hardcoded `false` — otherwise a box this reaper
          // simply doesn't happen to have in memory stays parkable at the old
          // 15-minute timeout regardless of the policy (review finding #2).
          alwaysOn: state?.alwaysOn ?? vmBoxAlwaysOnDefault(),
        }
        if (await shouldParkBox(candidate, now, deps.keepAlive)) {
          await deps.stopBox(box.sandboxId) // PARK, never removeBox
        }
      } catch (err) {
        deps.log.warn(`vm-sandbox-lifecycle: park decision failed for box ${box.sandboxId}:`, err)
      }
    }
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: idle reap step failed:', err)
  }

  // (b) MACHINE HEALTH.
  try {
    await deps.sweepMachineHealth()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: machine-health sweep failed:', err)
  }

  // (c) ORPHAN RECONCILE — over the boxes listed above plus a single machine
  // listing (the reconciler used to do a `getMachine` per box). The machine
  // registry is loaded here and reused by the liveness sweep in (e).
  let machines: Map<string, Machine> | null = null
  try {
    if (boxes) {
      machines = new Map((await deps.listMachines()).map((machine) => [machine.id, machine]))
      for (const box of boxes) {
        if (box.status !== 'stop_unverified') continue
        try {
          if (machines.get(box.machineId)?.status === 'ready') await deps.stopBox(box.sandboxId)
          else await deps.externalizeUnverifiedStop(box.sandboxId)
        } catch (error) {
          deps.log.warn(`vm-sandbox-lifecycle: deferred stop verification failed for box ${box.sandboxId}:`, error)
        }
      }
      await deps.reconcileOrphanedBoxes({ boxes, machines })
    } else {
      deps.log.warn('vm-sandbox-lifecycle: skipping orphaned-box reconcile — box listing failed')
    }
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: orphaned-box reconcile failed:', err)
  }

  // (d) EMPTY-MACHINE REAP — after the health sweep (a machine that just went
  // unreachable is no longer 'ready', so it is never reaped as "empty") and the
  // orphan reconcile (whose row deletions start drained machines' idle clocks).
  try {
    await deps.reapEmptyMachines()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: empty-machine reap failed:', err)
  }

  // (e) SPEC DRIFT + WARM — each independently wrapped so a spec-drift failure
  // still lets both warmups run. The active-squad list is fetched ONCE and
  // shared by the spec reconcile and the squad warmup (they each used to run
  // their own identical `Squad.list({status:'active'})`); if that fetch fails
  // both steps fall back to fetching for themselves, exactly as before.
  let squads: Squad[] | undefined
  try {
    squads = await deps.listActiveSquads()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: listing active squads failed:', err)
  }
  try {
    await deps.reconcileSquadSpecs(squads)
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: squad spec reconcile failed:', err)
  }
  try {
    await deps.reconcileSetupIncidents()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: setup incident projection failed:', err)
  }
  try {
    await deps.recoverMissingSetups()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: missing setup recovery failed:', err)
  }
  try {
    await deps.recoverDueSetups()
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: degraded setup recovery failed:', err)
  }
  // LIVENESS SWEEP — one `ss -ltnH` per machine, shared by both warmups below.
  // Without it each warmup ensure HTTP-probes its box, and a probe through the
  // socket unit WAKES a server that deliberately stood down: the keep-warm tick
  // alone would resurrect every idle box on the host once a minute and give
  // back all 1.7 GB the socket layout reclaims. A machine that cannot be swept
  // simply contributes no hints, so its boxes are probed exactly as before.
  const resolveBoxLiveness = await buildBoxLivenessResolver(boxes, machines, deps)

  try {
    await deps.warmupSquads(squads, resolveBoxLiveness)
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: squad sandbox warmup failed:', err)
  }
  try {
    await deps.warmupWorkStreams(resolveBoxLiveness)
  } catch (err) {
    deps.log.warn('vm-sandbox-lifecycle: work-stream agent sandbox warmup failed:', err)
  }
}

/**
 * Map every box whose port is currently listening on its machine to a
 * `'listening'` hint. ONE `ss -ltnH` per machine that actually hosts boxes (not
 * per box), and only for `ready` machines — an unreachable one would just make
 * the tick pay an SSH timeout per pass. Per-machine failures are isolated and
 * non-fatal: a box with no hint is probed, which is the pre-socket behavior.
 *
 * The set is ALSO persisted (`stampBoxesListening`) so the other process gets
 * the benefit: the box-status path the UI polls runs in the API, which cannot
 * run this sweep per poll, and its own health probe would wake the very server
 * this sweep proved is standing by.
 */
async function buildBoxLivenessResolver(
  boxes: MachineBox[] | null,
  machines: ReadonlyMap<string, Machine> | null,
  deps: VmLifecycleTickDeps
): Promise<BoxLivenessHintResolver | undefined> {
  if (!boxes || !machines || boxes.length === 0) return undefined
  const byMachine = new Map<string, MachineBox[]>()
  for (const box of boxes) {
    const list = byMachine.get(box.machineId)
    if (list) list.push(box)
    else byMachine.set(box.machineId, [box])
  }
  const listening = new Set<string>()
  await Promise.all(
    [...byMachine].map(async ([machineId, machineBoxes]) => {
      const machine = machines.get(machineId)
      if (!machine || machine.status !== 'ready') return
      try {
        const ports = await deps.listListeningPorts(machine)
        for (const box of machineBoxes) if (ports.has(box.port)) listening.add(box.sandboxId)
      } catch (err) {
        deps.log.warn(`vm-sandbox-lifecycle: listening-port sweep failed for machine ${machineId}:`, err)
      }
    })
  )
  if (listening.size === 0) return undefined
  if (deps.stampBoxesListening) {
    try {
      await deps.stampBoxesListening([...listening], new Date(deps.now()))
    } catch (err) {
      deps.log.warn('vm-sandbox-lifecycle: stamping listening boxes failed:', err)
    }
  }
  return (sandboxId: string) => (listening.has(sandboxId) ? 'listening' : undefined)
}

/**
 * Wrap a tick with a re-entrancy guard (mirrors the k8s reconcile loop's
 * `reconciling` flag): while a pass is in flight, subsequent invocations are
 * skipped rather than overlapping. Exposed as its own factory so the guard is
 * directly unit-testable.
 */
export function createVmLifecycleTick(deps: VmLifecycleTickDeps): () => Promise<void> {
  let running = false
  return async () => {
    if (running) {
      deps.log.debug('vm-sandbox-lifecycle: skipping tick — previous run still in progress')
      return
    }
    running = true
    try {
      await runVmSandboxLifecycleTick(deps)
    } finally {
      running = false
    }
  }
}

/** Signals the squad-aware keepAlive needs, injected so it stays unit-testable. */
export interface VmKeepAliveDeps {
  /** Load the squad for a `squad_<id>` box (its keep-warm predicate needs it). */
  findSquad: (squadId: string) => Promise<SquadForKeepWarm | null>
  /** The box has an active local deployment (runtime-agnostic, DB-driven). */
  hasActiveLocalDeployments: (sandboxId: string) => Promise<boolean>
  /** The box's work stream has a recently-active member (agent boxes only). */
  hasRecentWorkStreamActivity: (sandboxId: string) => Promise<boolean>
  /** Injected clock (epoch ms) for the recent-activity window. */
  now: () => number
}

/**
 * The reaper's keepAlive predicate. For a SQUAD box it delegates to the shared
 * {@link shouldKeepSquadWarm} (adding the agent-message signal, so a squad the
 * warmup would re-ensure is never parked — killing the park/re-warm churn). For
 * agent / system-manager boxes it keeps the prior generic behavior (`active
 * local deployment ∨ recent work-stream activity`) — the churn is squad-specific
 * and agent warmup is out of scope. A squad box whose row has vanished falls
 * back to the generic signals rather than crashing the sweep.
 */
export function createVmKeepAlive(deps: VmKeepAliveDeps): (sandboxId: string) => Promise<boolean> {
  const keepWarmDeps: ShouldKeepSquadWarmDeps = {
    hasActiveLocalDeployments: deps.hasActiveLocalDeployments,
    hasRecentWorkStreamActivity: deps.hasRecentWorkStreamActivity,
  }
  return async (sandboxId) => {
    const squadId = consultantSandboxSquadId(sandboxId) ?? getSquadIdFromSandbox(sandboxId)
    if (squadId !== null) {
      const squad = await deps.findSquad(squadId)
      // shouldKeepSquadWarm already composes deploy + work-stream, so this is the
      // full squad predicate — no double-checking of the generic signals.
      if (squad) return shouldKeepSquadWarm(squad, deps.now(), keepWarmDeps)
    }
    return (await deps.hasActiveLocalDeployments(sandboxId)) || (await deps.hasRecentWorkStreamActivity(sandboxId))
  }
}

export type VmSetupAgentOwner<TAgent> =
  | { kind: 'live'; agent: TAgent }
  | { kind: 'retire'; lifecycleGeneration: string | null | undefined }

export function classifyVmSetupAgentOwner<
  TAgent extends { status: AgentStatus; metadata: Record<string, unknown> | null },
>(agent: TAgent | null): VmSetupAgentOwner<TAgent> {
  if (agent && isLiveAgentStatus(agent.status)) return { kind: 'live', agent }
  if (agent?.status === 'dormant') {
    const generation = agent.metadata?.dormancyResourceGeneration
    return { kind: 'retire', lifecycleGeneration: typeof generation === 'string' ? generation : null }
  }
  return { kind: 'retire', lifecycleGeneration: undefined }
}

type SetupRetireResult =
  | { kind: 'retired' }
  | { kind: 'unverified' }
  | { kind: 'generation-mismatch'; actualLifecycleGeneration: string | null }

export async function retireVmSetupRecoveryWithConvergence(
  sandboxId: string,
  lifecycleGeneration: string | null | undefined,
  deps: {
    retire: (generation: string | null | undefined) => Promise<SetupRetireResult>
    converge: (agentId: string, expected: string | null, actual: string | null) => Promise<boolean>
    warn: (message: string) => void
  }
): Promise<void> {
  const result = await deps.retire(lifecycleGeneration)
  if (result.kind === 'retired') return
  if (result.kind === 'unverified') {
    deps.warn(`setup retirement remains unverified for ${sandboxId}`)
    return
  }
  const converged = await deps.converge(
    sandboxId.slice('agent_'.length),
    lifecycleGeneration ?? null,
    result.actualLifecycleGeneration
  )
  if (!converged) {
    deps.warn(`setup retirement generation changed concurrently for ${sandboxId}`)
    return
  }
  const retry = await deps.retire(result.actualLifecycleGeneration)
  if (retry.kind !== 'retired')
    deps.warn(`setup retirement remains pending for ${sandboxId} after generation convergence`)
}

export const productionVmSetupAgentOwnerRecovery = {
  classifyAgentOwner: async (agentId: string) => {
    const { Agent } = await import('../../../entities/Agent')
    return classifyVmSetupAgentOwner(await Agent.find(agentId, { eager: false }))
  },
}

export interface VmSetupOwnerRecoveryDeps<TAgent = unknown> {
  reconcileTracked(sandboxId: string): Promise<boolean>
  ensureSquad(squadId: string): Promise<void>
  /** Classify the durable owner before any cached constructive/destructive effect. */
  classifyAgentOwner(agentId: string): Promise<VmSetupAgentOwner<TAgent>>
  ensureAgent(agent: TAgent): Promise<void>
  ensureSystemManager(sandboxId: string): Promise<void>
  ensureConsultants?(squadId: string): Promise<void>
  /**
   * Retire a ready box whose owner is gone. Without this, a box owned by a
   * terminated agent stays 'ready' with no setup row and the sweep re-attempts
   * (and re-fails) recovery on every tick forever — observed live as an
   * "Invalid sandbox ancestry" warn-loop for terminated reviewers.
   */
  retireSetupRecovery(sandboxId: string, lifecycleGeneration: string | null | undefined): Promise<void>
}

export async function recoverVmSetupOwner<TAgent>(
  sandboxId: string,
  deps: VmSetupOwnerRecoveryDeps<TAgent>
): Promise<void> {
  if (sandboxId.startsWith('agent_')) {
    const owner = await deps.classifyAgentOwner(sandboxId.slice('agent_'.length))
    if (owner.kind === 'retire') return deps.retireSetupRecovery(sandboxId, owner.lifecycleGeneration)
    return deps.ensureAgent(owner.agent)
  }
  if (await deps.reconcileTracked(sandboxId)) return
  if (sandboxId.startsWith('squad_')) return deps.ensureSquad(sandboxId.slice('squad_'.length))
  const consultantSquad = consultantSandboxSquadId(sandboxId)
  if (consultantSquad && deps.ensureConsultants) return deps.ensureConsultants(consultantSquad)
  if (sandboxId.startsWith('system_manager_')) return deps.ensureSystemManager(sandboxId)
  throw new Error('unsupported durable sandbox id')
}

/**
 * Build the production tick deps. The sandbox manager is resolved lazily (per
 * call) so `startVmSandboxLifecycle` — which registers a `runImmediately:false`
 * runner — never eagerly constructs it.
 */
export async function buildProductionTickDeps(): Promise<VmLifecycleTickDeps> {
  const { getSandboxManager } = await import('../factory')
  const { listAllMachineBoxes, stampBoxesListening } = await import('../../machines/lifecycle-queries')
  const { listMachines } = await import('../../machines/queries')
  const { externalizeUnverifiedStop, listListeningLoopbackPorts } = await import('../../machines/box-manager')
  const { sweepMachineHealth, reconcileOrphanedBoxes } = await import('../../machines/machine-health')
  const { reapEmptyMachines } = await import('../../machines/machine-reaper')
  const { reconcileSquadSandboxSpecs } = await import('../squad-sandbox-reconcile')
  const { warmupActiveSquadSandboxes } = await import('../squad-warmup')
  const { warmupWorkStreamAgentSandboxes } = await import('../work-stream-warmup')
  const { hasRecentWorkStreamActivityForSandbox } = await import('../work-stream-activity')
  const { hasActiveLocalDeployments } = await import('../../deploy/local-deployment-service')
  const { Squad } = await import('../../../entities/Squad')
  const { convergeDormancyResourceGeneration } = await import('../../../entities/agent-queries')
  const { ensureSquadSandbox } = await import('../ensure')
  const { ensureAgentSandbox } = await import('../agent-warmup')
  const { getHomeDir } = await import('../../../lib/utils/home')
  const { listDueVmSetups, listReadyBoxesMissingVmSetup, reconcileVmSetupIncidents } = await import('./setup-state')

  // Resolve the vm manager per-call (kept a getter so start never constructs it).
  const resolveManager = () => getSandboxManager() as unknown as import('./manager').VmSandboxManager
  const recoverSetup = (sandboxId: string) =>
    recoverVmSetupOwner(sandboxId, {
      reconcileTracked: (id) => resolveManager().reconcileDueSetup(id),
      ensureSquad: (id) => ensureSquadSandbox(id).then(() => undefined),
      classifyAgentOwner: productionVmSetupAgentOwnerRecovery.classifyAgentOwner,
      ensureAgent: (agent) => ensureAgentSandbox(agent).then(() => undefined),
      ensureConsultants: async (id) => {
        const { ensureConsultantSandbox } = await import('../consultant-warmup')
        await ensureConsultantSandbox(id)
      },
      ensureSystemManager: (id) =>
        resolveManager()
          .ensureSandbox(id, {
            workspacePath: join(getHomeDir(), 'private', id),
            k8s: { sandboxType: 'system-manager', alwaysOn: true },
          })
          .then(() => undefined),
      retireSetupRecovery: async (id, lifecycleGeneration) => {
        log.info(`vm-sandbox-lifecycle: retiring setup recovery for unavailable owner: ${id}`)
        await retireVmSetupRecoveryWithConvergence(id, lifecycleGeneration, {
          retire: (generation) => resolveManager().retireSetupRecovery(id, generation),
          converge: convergeDormancyResourceGeneration,
          warn: (message) => log.warn(`vm-sandbox-lifecycle: ${message}`),
        })
      },
    })

  return {
    listAllMachineBoxes,
    listMachines,
    listActiveSquads: () => Squad.list({ status: 'active', includeAnonymous: false }),
    getLifecycleState: (sandboxId) => resolveManager().getLifecycleState(sandboxId),
    // Squad boxes delegate to the SHARED shouldKeepSquadWarm (same predicate the
    // squad warmup uses → no park/re-warm churn); agent / system-manager boxes
    // keep the prior generic keepAlive (active local deployment ∨ recent
    // work-stream activity — both runtime-agnostic, DB-driven). A squad `find`
    // per squad box per tick (once/60s) is a single indexed lookup, not a hot
    // per-item N+1 over an already-loaded list.
    keepAlive: createVmKeepAlive({
      findSquad: (squadId) => Squad.find(squadId),
      hasActiveLocalDeployments,
      hasRecentWorkStreamActivity: hasRecentWorkStreamActivityForSandbox,
      now: () => Date.now(),
    }),
    // Park through the MANAGER, not the bare box-manager stopBox: stopSandbox
    // closes the box's SandboxClient + deletes the in-memory `sandboxes` entry
    // BEFORE parking the box (same box-manager stopBox underneath, so the row
    // still ends 'stopped' and the reaper's DB-row gate is unaffected next tick).
    // Routing to the bare stopBox would strand a live client on a now-cancelled,
    // OS-ephemeral forward port that a later addForward can re-bind for a
    // DIFFERENT box → silent cross-box exec.
    stopBox: async (sandboxId) => {
      const outcome = await resolveManager().stopSandbox(sandboxId)
      if (outcome.kind === 'unverified') {
        log.warn(`vm-sandbox-lifecycle: physical stop remains unverified for ${sandboxId}`)
      }
    },
    externalizeUnverifiedStop,
    sweepMachineHealth: () => sweepMachineHealth(),
    // Reuse the tick's single box listing + machine registry: the reconciler
    // would otherwise re-scan `machine_boxes` and issue a `getMachine` per box.
    reconcileOrphanedBoxes: ({ boxes, machines }) =>
      reconcileOrphanedBoxes({ listAllMachineBoxes: async () => boxes, machines }),
    reapEmptyMachines: () => reapEmptyMachines(),
    reconcileSquadSpecs: (squads) => reconcileSquadSandboxSpecs(log, { manager: resolveManager(), squads }),
    reconcileSetupIncidents: () => reconcileVmSetupIncidents(),
    recoverMissingSetups: async () => {
      for (const sandboxId of await listReadyBoxesMissingVmSetup(8)) {
        try {
          await recoverSetup(sandboxId)
        } catch (err) {
          log.warn(`vm-sandbox-lifecycle: missing setup recovery failed for ${sandboxId}:`, err)
        }
      }
    },
    recoverDueSetups: async () => {
      for (const setup of await listDueVmSetups(new Date(), 8)) {
        try {
          await recoverSetup(setup.sandboxId)
        } catch (err) {
          log.warn(`vm-sandbox-lifecycle: setup recovery failed for ${setup.sandboxId}:`, err)
        }
      }
    },
    listListeningPorts: (machine) => listListeningLoopbackPorts(machine),
    stampBoxesListening: (sandboxIds, at) => stampBoxesListening(sandboxIds, at),
    warmupSquads: (squads, resolveBoxLiveness) => warmupActiveSquadSandboxes(log, { squads, resolveBoxLiveness }),
    warmupWorkStreams: (resolveBoxLiveness) => warmupWorkStreamAgentSandboxes(log, { resolveBoxLiveness }),
    now: () => Date.now(),
    log,
  }
}

/**
 * Run one production lifecycle pass immediately. Called from the worker's vm
 * boot branch to kick a first reconcile at startup (mirrors the k8s branch
 * calling `reconcileSquadPods` at boot), before the periodic runner's first
 * scheduled tick.
 */
export async function runVmSandboxLifecycleFirstPass(): Promise<void> {
  await runVmSandboxLifecycleTick(await buildProductionTickDeps())
}

let runner: PeriodicRunner | null = null

/**
 * Start the `vm-sandbox-lifecycle` subsystem. Inert on non-vm runtimes (the
 * loop is vm-gated and its deps are vm-only), so the worker can register it
 * unconditionally alongside the other subsystems.
 */
export function startVmSandboxLifecycle(): void {
  if (!isVmRuntime()) return
  if (runner) return

  const guardedTick = (async () => {
    const deps = await buildProductionTickDeps()
    return createVmLifecycleTick(deps)
  })()

  runner = createPeriodicRunner({
    name: 'vm-sandbox-lifecycle',
    intervalMs: LIFECYCLE_INTERVAL_MS,
    runImmediately: false,
    task: async () => {
      const tick = await guardedTick
      await tick()
    },
  })
  runner.start()
  log.info(`vm-sandbox-lifecycle started (interval ${LIFECYCLE_INTERVAL_MS}ms)`)
}

/** Stop the subsystem. No-op when not started. */
export async function stopVmSandboxLifecycle(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
