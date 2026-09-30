import { cleanupWorktreeForAgent } from '../work-streams/worktree-cleanup-store'
import { createLogger } from '../../lib/infra/logger'
import { Execution } from '../../entities/Execution'
import { Agent } from '../../entities/Agent'
import { getActiveSessionCount, getSession, isSessionReserved } from './session-state'
import { concurrencyLimiter, resolveExecutionConcurrencyKey } from './concurrency-limiter-instance'
import { InflightDeduper } from '../../lib/infra/inflight'
import { areBoxesMigratingLocked, type DbTransaction } from '../machines/queries'
import { getSettingsStore } from '../settings'
import { MAX_CONCURRENT_AGENTS_SETTING_KEY, resolveMaxConcurrentAgents } from './max-concurrent'
import { maintenanceStore } from '../maintenance'
import { executionLifecycleRegistry } from './lifecycle-registry'
import { agents, db, executionAdmissionReservations, executions, instanceMaintenanceState } from '../../db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { admissionProcessIncarnation } from '../maintenance/process-liveness'
import { replaceAdmissionReservationForPickup } from '../maintenance/admission-reservation'
import { acquireAgentQueueLock, loadCurrentAdmission } from './agent-admission'
import { settleExecutionForRemovedAgent } from './orphan-settlement'
import { ACTIVE_EXECUTION_STATUSES } from './status'

const log = createLogger('pickup')

/**
 * The effective instance-wide concurrent-agent cap, resolved FRESH on every
 * call: stored setting > `MAX_CONCURRENT_AGENTS` env var > 30.
 *
 * This must never be hoisted into a module-level constant and its result must
 * never be cached. The entire point of the setting is that an operator changes
 * it from the UI and the very next pickup decision honours it, in a worker
 * that is not restarted. The read is cheap — an in-memory `Map.get` plus an
 * integer parse.
 */
export function getMaxConcurrentAgents(): number {
  return resolveMaxConcurrentAgents(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY))
}

/** The per-agent pickup gate: an agent mid-compaction/reset can't take on new work, and a row that no longer exists never will. */
type PickupAgentEligibility = 'eligible' | 'busy' | 'agent-missing'

async function pickupEligibilityForAgent(agentId: string): Promise<PickupAgentEligibility> {
  const agent = await Agent.find(agentId)
  if (!agent) return 'agent-missing'
  return agent.status !== 'compacting' && agent.status !== 'resetting' ? 'eligible' : 'busy'
}

export type PickupResult =
  | 'started'
  | 'no-capacity'
  | 'lost-race'
  | 'not-queued'
  | 'box-migrating'
  | 'instance-paused'
  | 'work-stream-paused'
  | 'worker-stopping'

let pickupStopped = false

/** The worker is shutting down: start no new turns, and leave queued executions for its successor. */
export function stopExecutionPickup(): void {
  pickupStopped = true
}

export function resetExecutionPickupForTests(): void {
  pickupStopped = false
}

/**
 * The migration-fence check the claim transaction runs — injectable for tests
 * (see {@link setBoxMigratingLockedCheckForTests}); production always uses the
 * real {@link areBoxesMigratingLocked}. MUST be the LOCKING read on the caller's
 * tx handle, never the plain advisory `isBoxMigrating`: only the
 * `machine_boxes` row `FOR UPDATE` lock, held through the claim's commit,
 * serializes pickup against `fenceBoxForMigration` (see that function's
 * consumer-protocol doc for the race a plain read reintroduces).
 */
type BoxMigratingLockedCheck = (tx: DbTransaction, sandboxIds: string[]) => Promise<boolean>
let boxMigratingLockedCheck: BoxMigratingLockedCheck = areBoxesMigratingLocked

/** Test seam: override (or, with no argument, restore) the fence check. */
export function setBoxMigratingLockedCheckForTests(check?: BoxMigratingLockedCheck): void {
  boxMigratingLockedCheck = check ?? areBoxesMigratingLocked
}

type PickupExecutionLockedHook = (tx: DbTransaction, execution: Execution) => Promise<void>
let pickupExecutionLockedHook: PickupExecutionLockedHook | undefined

/** Test seam after execution claim and before reservation replacement. */
export function setPickupExecutionLockedHookForTests(hook?: PickupExecutionLockedHook): void {
  pickupExecutionLockedHook = hook
}

type PickupAdmissionVerifiedHook = (execution: Execution) => void
let pickupAdmissionVerifiedHook: PickupAdmissionVerifiedHook | undefined

export function setPickupAdmissionVerifiedHookForTests(hook?: PickupAdmissionVerifiedHook): void {
  pickupAdmissionVerifiedHook = hook
}

/**
 * Dedupes concurrent attemptPickup calls for the SAME execution id onto one
 * shared guard sequence. This matters beyond wasted work: `concurrencyLimiter`
 * is executionId-keyed, so a second `tryAcquire` for an id already holding a
 * slot is a same-slot no-op (returns true without incrementing), and
 * `release(id)` deletes that one shared slot. Without dedupe, two concurrent
 * callers for the same execution (a real routine, not a corner case — the
 * worker listens on both `execution.created` and `execution.queued`, and
 * `queueExecution` emits both synchronously) would both "acquire" the same
 * slot, one would win the CAS and start running, and the loser's lost-race
 * cleanup would `release()` the slot out from under the running winner —
 * silently under-counting that provider's concurrency for the winner's
 * entire lifetime. Routing every call through this deduper means concurrent
 * duplicate callers share ONE guard sequence and ONE result; only after that
 * shared run settles does the entry clear, so a later, non-concurrent call
 * runs fresh (and safely returns 'not-queued' once the row is no longer
 * queued).
 */
const pickupInflight = new InflightDeduper<PickupResult>()

/**
 * The single queued→running pickup path. Safe to call from anywhere, any
 * number of times, for the same execution — concurrent callers for the same
 * execution id are deduped onto one shared guard sequence and one shared
 * result (see {@link pickupInflight}), and the final claim is a DB-level CAS
 * (`Execution.transitionTo`), so there is exactly one winner.
 *
 * Guard order (the safe superset of the two guard sequences this replaces —
 * see task-5-report.md for the full comparison):
 *   1. execution.status === 'queued' (fast, no I/O)
 *   2. global session-count headroom (getActiveSessionCount() < getMaxConcurrentAgents())
 *   3. per-agent eligibility (not compacting/resetting)
 *   4. per-agent session guard (no active or reserved session for this
 *      agent tied to a DIFFERENT execution)
 *   5. provider concurrency slot (concurrencyLimiter.tryAcquire)
 *   6. the queued→running CAS (execution.transitionTo({kind:'started'})),
 *      whose claim transaction FIRST takes the migration-fence locked read
 *      (areBoxesMigratingLocked on every accessible box row, FOR UPDATE) via
 *      transitionTo's startGuard — a fenced box refuses the claim before the
 *      CAS and surfaces as 'box-migrating' (row stays queued, slot released,
 *      retried on a later tick exactly like 'no-capacity')
 *   7. exec.run() (fire-and-forget; releases the slot itself only if run()'s
 *      returned promise rejects — see entities/Execution.ts's run()).
 *
 * On any post-acquire failure (box-migrating, lost-race, or run() rejecting)
 * the slot this call *newly acquired* is released — never a slot that already
 * belonged to someone else (see the `alreadyHeld` guard in `doAttemptPickup`).
 * 'no-capacity' releases nothing — no slot was ever acquired.
 */
export async function attemptPickup(execution: Execution): Promise<PickupResult> {
  return pickupInflight.run(execution.id, () => doAttemptPickup(execution))
}

async function doAttemptPickup(execution: Execution): Promise<PickupResult> {
  if (execution.status !== 'queued') return 'not-queued'
  if (pickupStopped) return 'worker-stopping'
  const { pausedWorkStreamForAgent } = await import('../work-streams/pause')
  if (await pausedWorkStreamForAgent(execution.agentId)) return 'work-stream-paused'
  // The claim CAS also enforces this against the database clock. This fast
  // path avoids sandbox/admission work on every poll during the backoff.
  if (execution.startupRetryAt && execution.startupRetryAt.getTime() > Date.now()) return 'not-queued'
  if (maintenanceStore.isPausedCached()) {
    await execution.parkForMaintenance(maintenanceStore.cachedGeneration())
    return 'instance-paused'
  }
  // Resolved here, at decision time — NOT captured at module scope.
  if (getActiveSessionCount() >= getMaxConcurrentAgents()) return 'no-capacity'
  const eligibility = await pickupEligibilityForAgent(execution.agentId)
  if (eligibility === 'busy') return 'no-capacity'
  if (eligibility === 'agent-missing') {
    // An execution whose agent ROW is gone can never become eligible: agent ids
    // are UUIDs and are never recreated. Healthy databases cascade these rows
    // away with the agent, so reaching here means an FK-bypassed orphan — the
    // exact shape of the 2026-09-04 dead-fleet incident. Deferring ('no-capacity')
    // would churn forever, nudged by the queue watchdog every ~30s, so settle
    // the row terminally instead of leaving it to churn. A settle that observes
    // a live agent (row recreated in a race) defers as before.
    const outcome = await settleExecutionForRemovedAgent(execution.id)
    return outcome === 'agent-live' ? 'no-capacity' : 'not-queued'
  }

  // Pre-CAS per-agent session guard, checked BEFORE any slot is acquired (so
  // there is nothing to release on this path). Restores the old
  // reserve-before-CAS protection: without this, a queued execution for an
  // agent whose session or reservation is still live for SOME OTHER
  // execution could win the CAS onto a runnerless 'running' row —
  // Execution.run()'s own reserveSession call would then fail against that
  // pre-existing session/reservation, and the row would sit 'running' with
  // no runner until the watchdog's orphan arm finally requeues it, ~3
  // minutes later (see ORPHANED_RUNNING_THRESHOLD_MS in queue-watchdog.ts).
  // Bailing here instead leaves the row 'queued', so it's picked up again on
  // the next 5s poll — far cheaper self-heal.
  //
  // Scoped to "for some OTHER execution" (session/reservation executionId !==
  // this execution's id) rather than a bare isSessionActive/isSessionReserved
  // check on agentId alone: a session or reservation already pinned to THIS
  // execution's own id means this row already won the queued->running CAS
  // elsewhere and this is a stale in-memory handle (e.g. the sequential
  // stale-handle scenario covered elsewhere in this file's tests) — that's a
  // genuine race for the CAS below to detect and report as 'lost-race', not
  // a "this agent is busy with other work" capacity guard.
  //
  // 'no-capacity' is the closest existing result for the foreign case: like
  // the concurrency-cap and per-agent eligibility guards above, this is "not
  // eligible right now," not a lost CAS race (none was attempted for THIS
  // execution) and not a stale row ('not-queued'), so it reuses that
  // semantic rather than adding a new PickupResult variant.
  const activeSession = getSession(execution.agentId)
  const foreignActiveSession = activeSession !== undefined && activeSession.executionId !== execution.id
  const foreignReservation = isSessionReserved(execution.agentId) && !isSessionReserved(execution.agentId, execution.id)
  if (foreignActiveSession || foreignReservation) return 'no-capacity'

  const key = await resolveExecutionConcurrencyKey(execution)

  // The agent's box, for the migration-fence check inside the claim
  // transaction below. Resolved BEFORE tryAcquire so a resolution failure
  // (e.g. a subagent whose parent row vanished between the eligibility check and
  // here) can never leak a newly-acquired slot — and swallowed to
  // 'no-capacity' (matching resolveExecutionConcurrencyKey's discipline)
  // rather than thrown: a rejection out of attemptPickup would be unhandled
  // on the event path (worker's pickupIfQueued) and would abort the rest of
  // the poll sweep's queued list. Deferring leaves the row queued; a later
  // tick retries (and 'not-queued'/agent-gone rows fall out on their own).
  let sandboxIds: string[]
  try {
    const agent = await execution.mustGetAgent()
    const { completeDormancyIfPending, completeWake, wakeInTransaction } = await import('../agent/lifecycle')
    if (agent.status === 'dormant') {
      // Pickup is a serial sweep: make one completion attempt and defer rather
      // than letting a stuck external teardown block every queued execution.
      if (!(await completeDormancyIfPending(agent.id, { timeoutMs: 0 }))) return 'no-capacity'
      await agent.reload()
    }
    const wakeMetadata = agent.metadata as Record<string, unknown> | null
    if (wakeMetadata?.wakeCompletionPending === true) {
      if (typeof wakeMetadata.wakeCompletionId !== 'string') return 'no-capacity'
      if (!(await completeWake(agent.id, agent, wakeMetadata.wakeCompletionId))) return 'no-capacity'
    }
    // A TERMINATED agent can never satisfy resolveLiveSandboxOwner's liveness
    // check, so deferring here does not mean "retry later" — it means "retry
    // forever". The comment above assumes agent-gone rows fall out on their own,
    // but a terminated agent's row still EXISTS: mustGetAgent succeeds and only
    // the ancestry check fails, identically, on every tick. Observed in
    // production for two days on an execution queued 1.1s AFTER its agent was
    // terminated — re-nudged by the queue watchdog every ~30s and re-attempted
    // every ~5s, forever. This is a permanent condition, not a capacity one, so
    // settle the row instead of leaving it to churn. The dedicated settle
    // primitive — NOT Execution.fail() — because the generic failure
    // disposition would write the agent back to 'idle', resurrecting the
    // terminated agent; see orphan-settlement.ts.
    if (agent.status === 'terminated') {
      log.warn(`Execution ${execution.id} belongs to terminated agent ${agent.id}; settling it as agent-removed`)
      const outcome = await settleExecutionForRemovedAgent(execution.id)
      return outcome === 'agent-live' ? 'no-capacity' : 'not-queued'
    }
    if (agent.status === 'dormant') {
      if (!execution.wakeEligible) return 'no-capacity'
      const woke = await db.transaction(async (tx) => {
        await acquireAgentQueueLock(tx, agent.id)
        return wakeInTransaction(tx, agent.id)
      })
      if (woke && !(await completeWake(agent.id, agent, woke))) return 'no-capacity'
    }
    sandboxIds = await agent.getExecutionSandboxIds()
  } catch (error) {
    log.warn(`Could not resolve sandbox for execution ${execution.id}, deferring pickup:`, error)
    return 'no-capacity'
  }

  // The inflight deduper only collapses *concurrent* calls for the same
  // execution id. A SEQUENTIAL stale-handle call (e.g. pickupQueuedExecutions
  // iterating an Execution.list snapshot while a different trigger already
  // picked up and fully settled one of those rows mid-sweep) still reaches
  // here with an in-memory execution.status that's stale-'queued'. If a slot
  // for this id already exists, it belongs to that other, already-running
  // winner — tryAcquire below will just no-op onto it (matching
  // provider/modelId), NOT create a new one we own. Track that up front so
  // every failure path below releases only a slot THIS call actually
  // acquired, never one it merely observed.
  const alreadyHeld = concurrencyLimiter.hasSlot(execution.id)

  if (key && !concurrencyLimiter.tryAcquire(execution.id, key.provider, key.modelId)) {
    return 'no-capacity'
  }

  // Migration fence, checked INSIDE the claim transaction via transitionTo's
  // startGuard: the locked read (machine_boxes FOR UPDATE) runs before the
  // queued->running CAS and its lock is held through the claim's commit, so
  // pickup serializes with fenceBoxForMigration's set-then-recheck — either
  // this claim commits first (the fence's recheck sees it and backs off) or
  // the fence commits first (this read sees migrating=true and defers). A
  // plain pre-CAS isBoxMigrating read would race the fence transaction and
  // could start a turn under a live migration.
  let fenced = false
  let workStreamPaused = false
  let instancePaused = false
  let pausedGeneration: number | undefined
  let wokeDuringStart: string | null = null
  const startGuard = async (tx: DbTransaction): Promise<boolean> => {
    // Lock maintenance before the machine boxes for a stable global order.
    const maintenance = await maintenanceStore.readLocked(tx)
    if (maintenance.state.effective) {
      instancePaused = true
      pausedGeneration = maintenance.state.generation
      return false
    }
    await acquireAgentQueueLock(tx, execution.agentId)
    if (await cleanupWorktreeForAgent(execution.agentId, tx)) return false
    if (await pausedWorkStreamForAgent(execution.agentId, tx)) {
      workStreamPaused = true
      return false
    }
    const [agentLifecycle] = await tx
      .select({ status: agents.status, pendingDormancyAt: agents.pendingDormancyAt })
      .from(agents)
      .where(eq(agents.id, execution.agentId))
      .for('update')
    if (!agentLifecycle || agentLifecycle.status === 'terminated' || agentLifecycle.pendingDormancyAt) return false
    if (agentLifecycle.status === 'dormant') {
      if (!execution.wakeEligible) return false
      const { wakeInTransaction } = await import('../agent/lifecycle')
      wokeDuringStart = await wakeInTransaction(tx, execution.agentId)
    }
    const activeRows = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.agentId, execution.agentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
    if (activeRows.length !== 1 || activeRows[0]?.id !== execution.id) return false
    let admission = await loadCurrentAdmission(tx, execution.agentId)
    if (!admission) {
      const [legacy] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.executionId, execution.id),
            sql`${executionAdmissionReservations.agentId} IS NULL`,
            sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
          )
        )
        .for('update')
      if (legacy) {
        const [backfilled] = await tx
          .update(executionAdmissionReservations)
          .set({ agentId: execution.agentId, updatedAt: new Date() })
          .where(eq(executionAdmissionReservations.executionId, execution.id))
          .returning()
        admission = backfilled
      }
    }
    if (!admission || admission.executionId !== execution.id || admission.state !== 'queued') return false
    pickupAdmissionVerifiedHook?.(execution)
    if (await boxMigratingLockedCheck(tx, sandboxIds)) {
      fenced = true
      return false
    }
    return true
  }

  let started: boolean
  try {
    started = await execution.transitionTo(
      { kind: 'started' },
      {
        startGuard,
        afterStarted: async (tx, claimedExecution) => {
          const [maintenance] = await tx
            .select({
              generation: instanceMaintenanceState.generation,
              holderRevision: instanceMaintenanceState.holderRevision,
            })
            .from(instanceMaintenanceState)
            .where(eq(instanceMaintenanceState.id, 'global'))
          if (!maintenance) throw new Error('Instance maintenance singleton is not initialized')
          if (!claimedExecution.runnerClaimToken) throw new Error('Started execution is missing its runner claim token')
          await pickupExecutionLockedHook?.(tx, execution)
          await replaceAdmissionReservationForPickup(tx, {
            executionId: execution.id,
            agentId: execution.agentId,
            token: claimedExecution.runnerClaimToken,
            ownerId: 'worker',
            ownerIncarnation: admissionProcessIncarnation,
            generation: maintenance.generation,
            holderRevision: maintenance.holderRevision,
          })
        },
      }
    )
  } catch (error) {
    // Note: transitionTo's DB write may have already committed (the CAS won)
    // before a post-commit step (e.g. finishAgentWrite) threw — in that case
    // this isn't actually a lost race, it's a claimed-but-runnerless
    // 'running' row. That row is healed by the watchdog's orphan arm (see
    // requeueOrphanedRunningExecutions in queue-watchdog.ts), same as the
    // reserveSession-after-CAS race it already covers.
    log.error(`Failed to claim execution ${execution.id}:`, error)

    if (key && !alreadyHeld) concurrencyLimiter.release(execution.id)
    return 'lost-race'
  }

  if (!started) {
    if (key && !alreadyHeld) concurrencyLimiter.release(execution.id)
    if (instancePaused) {
      await execution.parkForMaintenance(pausedGeneration ?? maintenanceStore.cachedGeneration())
      return 'instance-paused'
    }
    // The box-migration refusal leaves the row queued for a later tick; a
    // genuine lost CAS means another worker owns the row now.
    return workStreamPaused ? 'work-stream-paused' : fenced ? 'box-migrating' : 'lost-race'
  }

  if (wokeDuringStart) {
    try {
      const { completeWake } = await import('../agent/lifecycle')
      if (!(await completeWake(execution.agentId, undefined, wokeDuringStart))) {
        throw new Error(`Agent ${execution.agentId} wake was superseded`)
      }
    } catch (error) {
      log.warn(`Wake completion failed for execution ${execution.id}; requeueing`, error)
      await execution.requeue().catch((requeueError) => log.error(`Failed to requeue ${execution.id}`, requeueError))
      if (key && !alreadyHeld) concurrencyLimiter.release(execution.id)
      return 'no-capacity'
    }
  }

  const lifecycle = executionLifecycleRegistry.registerProvisional(
    execution.id,
    execution.agentId,
    maintenanceStore.cachedGeneration()
  )
  if (!lifecycle.interruptRequested) {
    lifecycle.markRunnerStarted()
    execution
      .run()
      .catch((error) => {
        if (key && !alreadyHeld) concurrencyLimiter.release(execution.id)
        log.error(`Failed to execute execution ${execution.id}:`, error)
      })
      .finally(() => {
        lifecycle.markRunnerFinished()
        const active = getSession(execution.agentId)
        if (!active || active.executionId !== execution.id) lifecycle.settle()
      })
  } else {
    lifecycle.markRunnerFinished()
  }

  return 'started'
}

/**
 * Iterate a stable candidate snapshot until the sweep fills its global slots.
 * Candidate-local refusals (including a saturated provider) do not consume a
 * global slot and therefore must not prevent later providers from being tried.
 */
export async function sweepQueuedExecutionCandidates<T>(
  candidates: readonly T[],
  slotsAvailable: number,
  pickup: (candidate: T) => Promise<PickupResult>
): Promise<number> {
  let pickedUp = 0

  for (const candidate of candidates) {
    if (pickedUp >= slotsAvailable) break
    if ((await pickup(candidate)) === 'started') pickedUp++
  }

  return pickedUp
}

/**
 * Poll sweep: list queued executions and attempt pickup for each, up to the
 * available capacity. Returns the number actually started.
 */
export async function pickupQueuedExecutions(limit?: number): Promise<number> {
  const slotsAvailable = limit ?? getMaxConcurrentAgents() - getActiveSessionCount()
  if (slotsAvailable <= 0) return 0

  const queuedExecutions = await Execution.list({ status: 'queued' })
  return sweepQueuedExecutionCandidates(queuedExecutions, slotsAvailable, attemptPickup)
}
