import { admissionBlockingWaits, admissionBlockedSince, admissionBlockedStreamIds } from './wait-scope'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  WORK_STREAM_ADMITTED_STATUSES,
  compareByEffectivePriorityThenCreatedAt,
  computeEffectivePriorities,
  isLiveAgentStatus,
  type AgentStatus,
  type ExecutionStatus,
} from '@ficus/shared'
import { db } from '../../db'
import { executions, squads, workStreams, workStreamWaits } from '../../db/schema'
import { WorkStream, type WorkStreamRow } from '../../entities/WorkStream'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { collectWorkStreamAgentIds } from './agent-ids'
import { invalidateContinuationCycle } from './continuation-state'

/** Auto-park grace applied when squads.blocked_grace_minutes is NULL. */
export const DEFAULT_BLOCKED_GRACE_MINUTES = 30

const log = createLogger('work-stream-admission')

/** The drizzle transaction handle (same shape as Execution.ts's TransactionHandle). */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Work-stream admission control: a stream holds a concurrency slot iff its
 * status is in {@link WORK_STREAM_ADMITTED_STATUSES}; `queued` (also the
 * "parked" state) holds nothing. The squad row lock (`SELECT … FOR UPDATE`)
 * is the admission mutex — every count-then-transition runs under it, so
 * concurrent releases can never over-admit (same claim-or-skip discipline as
 * `Execution.transitionTo`/`attemptPickup`: the status-guarded UPDATE is the
 * CAS, losing racers no-op, and the periodic reconciler converges anything
 * missed).
 *
 * No preemption: nothing here ever force-parks an admitted stream, and
 * lowering a cap below the admitted count only blocks new admissions.
 */

export class WorkStreamNotParkableError extends Error {
  constructor(status: string) {
    super(`Only admitted work streams (${WORK_STREAM_ADMITTED_STATUSES.join(', ')}) can be parked; status is ${status}`)
    this.name = 'WorkStreamNotParkableError'
  }
}

export class WorkStreamCapFullError extends Error {
  constructor(title: string, cap: number) {
    super(
      `Cannot admit queued work stream "${title}": the squad's concurrency cap (${cap}) is full. ` +
        `A queued stream is admitted automatically by the scheduler when a slot frees — raise its priority, ` +
        `raise the squad cap, or park an admitted stream to make room.`
    )
    this.name = 'WorkStreamCapFullError'
  }
}

/**
 * Guard for MANUAL queued → admitted status writes (PATCH /:id, `ws update
 * --status`, `ws handoff`): they must obey the same cap as scheduler
 * admission, or a direct status edit silently over-admits (and nothing ever
 * corrects it — the reconciler only promotes, never evicts). Runs inside the
 * caller's transaction: cap null returns after a plain read (unlimited squads
 * unchanged); under a finite cap it takes the squad-row admission mutex,
 * re-reads the stream's status under the lock (a concurrent locked promotion
 * may have already admitted it — the write is then a plain admitted →
 * admitted move and is allowed), and throws {@link WorkStreamCapFullError}
 * when the stream is still queued and every slot is held.
 */
export async function assertManualAdmissionAllowed(
  tx: DbTransaction,
  input: { squadId: string; streamId: string; title: string }
): Promise<void> {
  const [capRow] = await tx
    .select({ cap: squads.maxConcurrentWorkStreams })
    .from(squads)
    .where(eq(squads.id, input.squadId))
  const cap = capRow?.cap ?? null
  if (cap === null) return

  await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, input.squadId)).for('update')
  const [current] = await tx
    .select({ status: workStreams.status })
    .from(workStreams)
    .where(eq(workStreams.id, input.streamId))
  if (current?.status !== 'queued') return // already admitted (or gone) — not a queued->admitted move

  const admitted = await countAdmitted(tx, input.squadId, input.streamId)
  if (admitted >= cap) {
    throw new WorkStreamCapFullError(input.title, cap)
  }
}

async function countAdmitted(tx: DbTransaction, squadId: string, excludeId?: string): Promise<number> {
  const rows = await tx
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(and(eq(workStreams.squadId, squadId), inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES)))
  return rows.filter((r) => r.id !== excludeId).length
}

/**
 * Called inside `WorkStream.create`'s transaction, after the insert (which
 * lands as `pending` = admitted) and after `syncDependencyWaits` has written
 * one open record per unsatisfied dependency.
 *
 * Admissibility here MUST match {@link promoteEligibleQueuedStreams}: a stream
 * is admissible iff it has no open wait AND a slot is free. Creation used to
 * check only the cap, so a stream created with `--depends-on` an unfinished
 * stream was admitted on the spot — it displayed as "waiting on dependency"
 * while holding a slot, and, worse, `WorkStream.create`'s
 * `status !== 'queued'` guard let the assignment notification through, so the
 * assignee was told the work was handed to it and started immediately on work
 * that was supposed to be gated. The wait check below is what makes the two
 * admission paths agree.
 *
 * Ordering matters: the wait check runs BEFORE the cap read, because the cap
 * being `null` (unlimited) must not skip it — an unlimited squad is exactly
 * where the old bug was worst, since it returned 'admitted' unconditionally.
 */
export async function admitOrQueueAtCreation(
  tx: DbTransaction,
  input: { squadId: string; streamId: string }
): Promise<'admitted' | 'queued'> {
  const [blockingWait] = await admissionBlockingWaits(tx, input.streamId)
  if (blockingWait) {
    // No squad lock: demoting a stream that was never counted releases
    // nothing, so there is no admission race to serialize against.
    await tx
      .update(workStreams)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(workStreams.id, input.streamId))
    return 'queued'
  }

  const [capRow] = await tx
    .select({ cap: squads.maxConcurrentWorkStreams })
    .from(squads)
    .where(eq(squads.id, input.squadId))
  const cap = capRow?.cap ?? null
  if (cap === null) return 'admitted'

  // Finite cap: serialize against concurrent creations/promotions.
  await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, input.squadId)).for('update')
  const admitted = await countAdmitted(tx, input.squadId, input.streamId)
  if (admitted < cap) return 'admitted'

  await tx
    .update(workStreams)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(eq(workStreams.id, input.streamId))
  return 'queued'
}

export interface DemotionStopDeps {
  loadAgent?: (id: string) => Promise<{
    id: string
    status: AgentStatus
    getSandboxId: () => Promise<string>
  } | null>
  /** Admitted streams the agent is bound to (assignee or member). */
  listAdmittedStreams?: (agentId: string) => Promise<{ id: string }[]>
  removeSandbox?: (sandboxId: string) => Promise<void>
}

/**
 * The resource release for a stream demoted to `queued`: gracefully stop each
 * bound agent's PERSONAL sandbox unless another admitted stream still binds
 * that agent. Nothing is terminated or archived — `~/.private` and the shared
 * squad workspace stay in place; re-admission lazily cold-starts boxes on the
 * next execution. Best-effort: failures are logged, never thrown (the idle
 * reaper + keepalive gate collect anything missed).
 */
export async function stopSandboxesForDemotedStream(
  ws: Pick<WorkStream, 'id' | 'assigneeAgentId' | 'agentIds'>,
  deps: DemotionStopDeps = {}
): Promise<void> {
  const loadAgent = deps.loadAgent ?? (async (id: string) => (await import('../../entities/Agent')).Agent.find(id))
  const listAdmittedStreams =
    deps.listAdmittedStreams ?? ((agentId: string) => WorkStream.listForAgent(agentId, WORK_STREAM_ADMITTED_STATUSES))
  const removeSandbox =
    deps.removeSandbox ??
    (async (sandboxId: string) => (await import('../sandbox')).getSandboxManager().removeSandbox(sandboxId))

  for (const agentId of collectWorkStreamAgentIds(ws)) {
    try {
      const agent = await loadAgent(agentId)
      if (!agent || !isLiveAgentStatus(agent.status)) continue
      const sandboxId = await agent.getSandboxId()
      // Only personal boxes are gated — subagents (parent's box) and shared
      // system-manager boxes are never stopped here.
      if (sandboxId !== `agent_${agentId}`) continue
      const admitted = await listAdmittedStreams(agentId)
      if (admitted.some((s) => s.id !== ws.id)) continue
      await removeSandbox(sandboxId)
    } catch (err) {
      log.warn(`Failed to stop sandbox for agent ${agentId} of queued work stream ${ws.id}:`, err)
    }
  }
}

/** Shared post-transition side effects for admitted → queued moves. */
export async function handleStreamDemotedToQueued(ws: WorkStream, deps: DemotionStopDeps = {}): Promise<void> {
  await stopSandboxesForDemotedStream(ws, deps)
  try {
    await promoteEligibleQueuedStreams(ws.squadId)
  } catch (err) {
    log.warn(`Post-demotion promotion failed for squad ${ws.squadId}:`, err)
  }
}

export class WorkStreamBusyError extends Error {
  constructor(
    readonly workStreamId: string,
    readonly workStreamTitle: string,
    readonly agentId: string,
    readonly executionId: string,
    readonly executionStatus: Extract<ExecutionStatus, 'running' | 'stopping'>
  ) {
    super(`Cannot park work stream ${workStreamId} ("${workStreamTitle}"): assigned/bound agent ${agentId} has an in-flight ${executionStatus} execution (${executionId}) that may belong to this or another work stream.
Parking would discard its in-flight turn and stop its sandbox.

To park this stream:
  1. Message ${agentId} asking it to stop at a safe point and confirm when it has stopped (commit/push anything in progress first).
  2. Wait for it to report that it has stopped and for its execution to end.
  3. Retry \`ficus workstream park ${workStreamId}\`.

Alternatives that need no coordination: park a different stream to free the slot, or lower this stream's priority so the scheduler prefers the work you want admitted.

Only if the work is genuinely abandonable: \`ficus workstream park ${workStreamId} --preempt-running\` (discards the in-flight turn).`)
    this.name = 'WorkStreamBusyError'
  }
}

type InFlightExecution = {
  id: string
  agentId: string
  status: Extract<ExecutionStatus, 'running' | 'stopping'>
}

type DemotionBinding = Pick<WorkStreamRow, 'id' | 'title' | 'assigneeAgentId' | 'agentIds'>

let demotionLockObserver: ((agentIds: string[]) => Promise<void>) | undefined
let demotionLockStepObserver: ((phase: 'before' | 'after', agentId: string) => Promise<void>) | undefined

/** Test-only lock observer; production callers cannot replace the safety query. */
export function setDemotionLockObserverForTest(observer?: (agentIds: string[]) => Promise<void>): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Demotion lock observer is test-only')
  demotionLockObserver = observer
}

export function setDemotionLockStepObserverForTest(
  observer?: (phase: 'before' | 'after', agentId: string) => Promise<void>
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Demotion lock step observer is test-only')
  demotionLockStepObserver = observer
}

async function lockDemotionAgents(tx: DbTransaction, agentIds: string[]): Promise<void> {
  for (const agentId of [...agentIds].sort()) {
    await demotionLockStepObserver?.('before', agentId)
    await acquireAgentQueueLock(tx, agentId)
    await demotionLockStepObserver?.('after', agentId)
  }
}

/** Guard a manual active -> queued write while its work-stream row is locked. */
export async function guardManualWorkStreamDemotion(
  tx: DbTransaction,
  stream: DemotionBinding,
  preemptRunning = false
): Promise<InFlightExecution | null> {
  const agentIds = collectWorkStreamAgentIds(stream)
  // Queue locks serialize against execution creation. Sort independently of
  // diagnostic preference so overlapping streams cannot deadlock each other.
  await lockDemotionAgents(tx, agentIds)
  await demotionLockObserver?.(agentIds)
  if (agentIds.length === 0) return null

  const assigneeRank = sql<number>`case when ${executions.agentId} = ${stream.assigneeAgentId}::uuid then 0 else 1 end`
  const statusRank = sql<number>`case when ${executions.status} = 'running' then 0 else 1 end`
  const [execution] = await tx
    .select({ id: executions.id, agentId: executions.agentId, status: executions.status })
    .from(executions)
    .where(and(inArray(executions.agentId, agentIds), inArray(executions.status, ['running', 'stopping'])))
    .orderBy(assigneeRank, statusRank, desc(executions.startedAt), desc(executions.id))
    .limit(1)
  const inFlight = (execution as InFlightExecution | undefined) ?? null
  if (inFlight && !preemptRunning) {
    throw new WorkStreamBusyError(stream.id, stream.title, inFlight.agentId, inFlight.id, inFlight.status)
  }
  return inFlight
}

export interface ParkWorkStreamOptions extends DemotionStopDeps {
  preemptRunning?: boolean
}

export interface ParkResult {
  /** The stream AFTER the post-park promotion pass (it may have won its slot back). */
  stream: WorkStream
  /**
   * True when the freed slot went straight back to this stream (it was the
   * highest-priority eligible queued stream — a disruptive no-op park). Callers
   * should surface a warning: park a lower-priority stream, or lower this
   * stream's priority first.
   */
  reAdmitted: boolean
}

/**
 * Park an admitted work stream. Parking a quiescent stream is lossless:
 * prompts, bindings, and files remain. Parking a running stream destroys its
 * in-flight turn and stops its sandbox, so it requires explicit preemption.
 * Transactional claim-or-skip: the stream row is locked, the status guard is
 * re-checked, and continuation is invalidated when leaving `in_progress`.
 */
export async function parkWorkStream(id: string, options: ParkWorkStreamOptions = {}): Promise<ParkResult> {
  const { parkedRow, preemptedExecution } = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    if (!row) throw new Error(`Work stream ${id} not found`)
    if (!WORK_STREAM_ADMITTED_STATUSES.includes(row.status)) {
      throw new WorkStreamNotParkableError(row.status)
    }
    const liveExecution = await guardManualWorkStreamDemotion(tx, row, options.preemptRunning)
    const now = new Date()
    const [updated] = await tx
      .update(workStreams)
      .set({ status: 'queued', updatedAt: now })
      .where(and(eq(workStreams.id, id), inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES)))
      .returning()
    if (!updated) throw new WorkStreamNotParkableError(row.status)
    await invalidateContinuationCycle(tx, id)
    return { parkedRow: updated, preemptedExecution: liveExecution }
  })

  if (preemptedExecution) {
    log.warn(
      `Preempted in-flight work for work stream ${parkedRow.id} ("${parkedRow.title}"): agent ${preemptedExecution.agentId}, execution ${preemptedExecution.id}, status ${preemptedExecution.status}`
    )
  }

  const ws = new WorkStream(parkedRow)
  eventEmitter.emit('workStream.updated', { workStreamId: ws.id, squadId: ws.squadId })
  await handleStreamDemotedToQueued(ws, options)
  // Report the post-promotion truth: at equal effective priority the parked
  // stream's older created_at wins ties (spec), so it can immediately win its
  // own slot back — a park the caller should know achieved nothing.
  const fresh = await WorkStream.mustFind(ws.id)
  return { stream: fresh, reAdmitted: WORK_STREAM_ADMITTED_STATUSES.includes(fresh.status) }
}

interface PromotionScanRow {
  pause?: WorkStreamRow['pause']
  id: string
  title: string
  status: WorkStreamRow['status']
  priority: WorkStreamRow['priority']
  dependsOn: string[] | null
  createdAt: Date
  metadata: unknown
}

/**
 * The in-transaction promotion pass. Caller MUST hold the squad-row lock (the
 * admission mutex) and pass the cap read under it. Eligible = every dependsOn
 * entry is `done` AND the stream has NO open wait (a queued stream parked on
 * a review/question/manual/dependency wait holds no queue position). Each
 * winner is promoted `queued → active` with a status-guarded UPDATE so a
 * concurrent promotion can never double-admit.
 */
async function promoteEligibleWithinTx(
  tx: DbTransaction,
  squadId: string,
  cap: number | null
): Promise<{ promotedRows: WorkStreamRow[]; canceledDepRows: PromotionScanRow[] }> {
  const all: PromotionScanRow[] = await tx
    .select({
      id: workStreams.id,
      title: workStreams.title,
      status: workStreams.status,
      priority: workStreams.priority,
      dependsOn: workStreams.dependsOn,
      createdAt: workStreams.createdAt,
      metadata: workStreams.metadata,
      pause: workStreams.pause,
    })
    .from(workStreams)
    .where(eq(workStreams.squadId, squadId))
    .orderBy(asc(workStreams.createdAt), asc(workStreams.id))

  const queued = all.filter((s) => s.status === 'queued' && !s.pause)
  if (queued.length === 0) return { promotedRows: [], canceledDepRows: [] }

  const admittedCount = all.filter((s) => WORK_STREAM_ADMITTED_STATUSES.includes(s.status)).length
  const freeSlots = cap === null ? queued.length : Math.max(0, cap - admittedCount)

  // Dependencies may live outside this squad — resolve any unknown ids globally.
  const knownIds = new Set(all.map((s) => s.id))
  const externalDepIds = [...new Set(queued.flatMap((s) => s.dependsOn ?? []))].filter((id) => !knownIds.has(id))
  const externalDeps =
    externalDepIds.length > 0
      ? await tx
          .select({ id: workStreams.id, status: workStreams.status })
          .from(workStreams)
          .where(inArray(workStreams.id, externalDepIds))
      : []
  const statusOf = new Map<string, string>([
    ...all.map((s): [string, string] => [s.id, s.status]),
    ...externalDeps.map((s): [string, string] => [s.id, s.status]),
  ])

  const canceledDepRows = queued.filter((s) => (s.dependsOn ?? []).some((d) => statusOf.get(d) === 'canceled'))

  if (freeSlots === 0) return { promotedRows: [], canceledDepRows }

  // Scoped waits hold admission only when every active branch is blocked.
  const hasOpenWait = await admissionBlockedStreamIds(
    tx,
    queued.map((stream) => stream.id)
  )

  const effective = computeEffectivePriorities(
    all.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      status: s.status,
      dependsOn: s.dependsOn ?? [],
    }))
  )

  const eligible = queued
    .filter((s) => !hasOpenWait.has(s.id))
    .filter((s) => (s.dependsOn ?? []).every((d) => statusOf.get(d) === 'done'))
    .map((s) => ({ id: s.id, createdAt: s.createdAt, effective: effective.get(s.id)?.effective ?? s.priority }))
    .sort(compareByEffectivePriorityThenCreatedAt)

  const promotedRows: WorkStreamRow[] = []
  for (const winner of eligible.slice(0, freeSlots)) {
    const [updated] = await tx
      .update(workStreams)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(workStreams.id, winner.id), eq(workStreams.status, 'queued')))
      .returning()
    if (updated) promotedRows.push(updated)
  }
  return { promotedRows, canceledDepRows }
}

/** Post-commit side effects for promoted streams (events + deferred assignment notifications). */
async function emitPromotionEffects(promoted: WorkStream[]): Promise<void> {
  for (const ws of promoted) {
    eventEmitter.emit('workStream.updated', { workStreamId: ws.id, squadId: ws.squadId })
    const { ensureFlowDispatch } = await import('../workflows/execution')
    if (await ensureFlowDispatch(ws.id)) continue
    if (ws.assigneeAgentId) {
      // Deferred from creation (assignment notifications are suppressed while
      // queued so the crew doesn't start work without a slot).
      try {
        const { notifyWorkStreamAssigned } = await import('../squad/work-stream-notifications')
        await notifyWorkStreamAssigned(ws, ws.assigneeAgentId)
      } catch (err) {
        log.warn(`Failed to notify assignee of admitted work stream ${ws.id}:`, err)
      }
      eventEmitter.emit('workStream.assigned', {
        workStreamId: ws.id,
        squadId: ws.squadId,
        agentId: ws.assigneeAgentId,
      })
    }
  }
}

/**
 * Admit eligible queued streams while slots are free, highest effective
 * priority first (ties: created_at, then id). Runs under the squad-row lock.
 * Queued streams stuck behind a *canceled* dependency are flagged + surfaced
 * to the manager exactly once (never silently admitted).
 */
export async function promoteEligibleQueuedStreams(squadId: string): Promise<WorkStream[]> {
  const { promotedRows, canceledDepRows } = await db.transaction(async (tx) => {
    const [squad] = await tx
      .select({ cap: squads.maxConcurrentWorkStreams })
      .from(squads)
      .where(eq(squads.id, squadId))
      .for('update')
    if (!squad) return { promotedRows: [] as WorkStreamRow[], canceledDepRows: [] as PromotionScanRow[] }
    return promoteEligibleWithinTx(tx, squadId, squad.cap)
  })

  const promoted = promotedRows.map((row) => new WorkStream(row))
  await emitPromotionEffects(promoted)
  await surfaceCanceledDependencies(canceledDepRows)

  return promoted
}

export interface AdmissionMaintenanceResult {
  parked: WorkStream[]
  promoted: WorkStream[]
}

/**
 * The admission maintenance pass: uniform grace auto-park, then promotion,
 * under ONE squad-row lock (the #959 admission mutex).
 *
 * Auto-park: an `active` stream with an open wait older than the squad grace
 * (`blocked_grace_minutes`, NULL → 30, 0 = immediate) is parked (→ `queued`).
 * NO exemptions: dependency, question, review and manual waits all park. The
 * overdue comparison uses clock_timestamp(), not now() — now() is frozen at
 * BEGIN, so a deadline judged after the lock wait would use a stale reading
 * (frozen-clock rule).
 *
 * Wait resolution never changes status by itself; a parked stream becomes
 * admissible in place and competes by effective priority then createdAt —
 * which is exactly the promotion half of this pass.
 */
export async function runSquadAdmissionMaintenance(
  squadId: string,
  deps: DemotionStopDeps = {}
): Promise<AdmissionMaintenanceResult> {
  const { parkedRows, promotedRows, canceledDepRows } = await db.transaction(async (tx) => {
    const [squad] = await tx
      .select({ cap: squads.maxConcurrentWorkStreams, grace: squads.blockedGraceMinutes })
      .from(squads)
      .where(eq(squads.id, squadId))
      .for('update')
    if (!squad) {
      return {
        parkedRows: [] as WorkStreamRow[],
        promotedRows: [] as WorkStreamRow[],
        canceledDepRows: [] as PromotionScanRow[],
      }
    }

    const graceMinutes = squad.grace ?? DEFAULT_BLOCKED_GRACE_MINUTES
    const overdue = await tx
      .select({ id: workStreams.id })
      .from(workStreams)
      .where(
        and(
          eq(workStreams.squadId, squadId),
          eq(workStreams.status, 'active'),
          sql`(( ${workStreams.pause} IS NOT NULL AND (${workStreams.pause}->>'parkAt')::timestamptz <= clock_timestamp()) OR (${workStreams.pause} IS NULL AND EXISTS (
            SELECT 1 FROM ${workStreamWaits} w
            WHERE w.work_stream_id = ${workStreams.id}
              AND w.closed_at IS NULL
              AND w.opened_at <= clock_timestamp() - make_interval(mins => ${graceMinutes})
          )))`
        )
      )

    const parkedRows: WorkStreamRow[] = []
    const now = new Date()
    for (const { id } of overdue) {
      const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
      if (!stream?.pause) {
        const since = admissionBlockedSince(await admissionBlockingWaits(tx, id))
        const [clock] = await tx
          .select({ now: sql<Date>`clock_timestamp()` })
          .from(workStreams)
          .where(eq(workStreams.id, id))
        if (since == null || !clock || since > new Date(clock.now).getTime() - graceMinutes * 60_000) continue
      }
      const [updated] = await tx
        .update(workStreams)
        .set({ status: 'queued', updatedAt: now })
        .where(and(eq(workStreams.id, id), eq(workStreams.status, 'active')))
        .returning()
      if (updated) {
        parkedRows.push(updated)
        await invalidateContinuationCycle(tx, id)
      }
    }

    const promotion = await promoteEligibleWithinTx(tx, squadId, squad.cap)
    return { parkedRows, ...promotion }
  })

  const parked = parkedRows.map((row) => new WorkStream(row))
  for (const ws of parked) {
    eventEmitter.emit('workStream.updated', { workStreamId: ws.id, squadId: ws.squadId })
    // Promotion already ran in the same transaction — release resources only
    // (no handleStreamDemotedToQueued, which would re-run promotion).
    await stopSandboxesForDemotedStream(ws, deps)
  }

  const promoted = promotedRows.map((row) => new WorkStream(row))
  await emitPromotionEffects(promoted)
  await surfaceCanceledDependencies(canceledDepRows)

  return { parked, promoted }
}

/**
 * Flag queued streams whose dependency was canceled (not done) and notify the
 * manager/owner once: they need a decision (re-point or cancel) — the stream
 * is never silently admitted with an unmet dependency.
 */
async function surfaceCanceledDependencies(rows: PromotionScanRow[]): Promise<void> {
  for (const row of rows) {
    try {
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {}
      const admission = (metadata.admission as Record<string, unknown> | undefined) ?? {}
      if (admission.canceledDependencyNotifiedAt) continue

      const ws = await WorkStream.find(row.id)
      if (!ws || ws.status !== 'queued') continue

      const nextMetadata = {
        ...ws.metadata,
        admission: {
          ...((ws.metadata.admission as Record<string, unknown> | undefined) ?? {}),
          canceledDependencyNotifiedAt: new Date().toISOString(),
        },
      }
      await db
        .update(workStreams)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(workStreams.id, row.id))

      const { notifyWorkStreamDependencyCanceled } = await import('../squad/work-stream-notifications')
      await notifyWorkStreamDependencyCanceled(await WorkStream.mustFind(row.id))
    } catch (err) {
      log.warn(`Failed to surface canceled dependency for queued work stream ${row.id}:`, err)
    }
  }
}

let handlersRegistered = false

/**
 * Promotion triggers: a slot frees (stream → done/canceled) — which is also
 * the "dependency resolved" signal, since deps resolve by completing.
 * Parking triggers promotion directly in {@link parkWorkStream}; the periodic
 * reconciler is the backstop for anything missed (including cross-squad
 * dependency completions). Idempotent.
 */

/**
 * Post-cap/grace-change admission with bounded retry. The settings update must
 * never fail because promotion hiccuped, but a SWALLOWED transient (a deadlock
 * with a concurrent transaction, a serialization failure) previously meant a
 * raised cap silently admitted nobody until the periodic reconciler — observed
 * as the intermittent "cap raised but stream still queued" CI failure, and in
 * production as a delayed admission after an operator raises the cap. Retry a
 * couple of times before giving up; the reconciler remains the backstop.
 */
export async function runSquadAdmissionMaintenanceWithRetry(
  squadId: string,
  opts: {
    attempts?: number
    /** Injection seam for tests. */
    run?: (squadId: string) => Promise<unknown>
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<{ succeeded: boolean; attempts: number; lastError?: unknown }> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const run = opts.run ?? runSquadAdmissionMaintenance
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await run(squadId)
      return { succeeded: true, attempts: attempt }
    } catch (err) {
      lastError = err
      if (attempt < attempts) await sleep(50 * attempt)
    }
  }
  return { succeeded: false, attempts, lastError }
}

export function registerAdmissionHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  eventEmitter.on('workStream.done', async ({ squadId }) => {
    if (!squadId) return
    await promoteEligibleQueuedStreams(squadId).catch((err) =>
      log.warn(`Admission on workStream.done failed for squad ${squadId}:`, err)
    )
  })
  eventEmitter.on('workStream.canceled', async ({ squadId }) => {
    if (!squadId) return
    await promoteEligibleQueuedStreams(squadId).catch((err) =>
      log.warn(`Admission on workStream.canceled failed for squad ${squadId}:`, err)
    )
  })
}

/**
 * Reconciler pass: run the maintenance pass (grace auto-park + promotion) in
 * every squad that has queued streams OR active streams with an open wait.
 */
export async function runAdmissionReconcilerOnce(): Promise<void> {
  const { maintenanceStore } = await import('../maintenance/store')
  if (maintenanceStore.isPausedCached()) return
  const queuedSquads = await db
    .selectDistinct({ squadId: workStreams.squadId })
    .from(workStreams)
    .where(eq(workStreams.status, 'queued'))
  const waitingActiveSquads = await db
    .selectDistinct({ squadId: workStreams.squadId })
    .from(workStreams)
    .innerJoin(workStreamWaits, eq(workStreamWaits.workStreamId, workStreams.id))
    .where(and(eq(workStreams.status, 'active'), isNull(workStreamWaits.closedAt)))
  const squadIds = [...new Set([...queuedSquads, ...waitingActiveSquads].map((r) => r.squadId))]
  for (const squadId of squadIds) {
    try {
      await runSquadAdmissionMaintenance(squadId)
    } catch (err) {
      log.warn(`Admission reconciler failed for squad ${squadId}:`, err)
    }
  }
}
