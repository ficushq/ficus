import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import {
  WORK_STREAM_ADMITTED_STATUSES,
  assertHumanAnswerableRequest,
  manualInputRequestSchema,
  RECOVERY_ATTEMPT_BUDGET,
  taskInputSummary,
  isDependencyEdgeSatisfied,
  workStreamWaitActor,
  type WorkStreamWait,
  type WorkStreamWaitActor,
  type WorkStreamWaitResolution,
  type WorkStreamWaitType,
} from '@ficus/shared'
import { db } from '../../db'
import { workStreams, workStreamWaits, recoveryEpisodes } from '../../db/schema'
import { loadReadyDependencyIds, pendingReadyDependencyIds, unlockReadyEdge } from './dependency-edges'

export type WorkStreamWaitRow = InferSelectModel<typeof workStreamWaits>

/** The drizzle transaction handle (same shape as admission.ts's). */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** Either the root client or a transaction — every writer here composes into callers' transactions. */
export type DbHandle = DbTransaction | typeof db

export function toWaitJson(row: WorkStreamWaitRow): WorkStreamWait {
  return {
    id: row.id,
    ...(row.structured ? { structured: row.structured } : {}),
    flowAttemptId: row.flowAttemptId ?? null,
    workStreamId: row.workStreamId,
    type: row.type,
    // Manual waits only; an unknown stored value reads as human.
    ...(row.type === 'manual' ? { actor: workStreamWaitActor(row) } : {}),
    ...(row.type === 'manual' && row.actorChanges?.length ? { actorChanges: row.actorChanges } : {}),
    referenceId: row.referenceId,
    ...(row.resolutionHandler ? { resolutionHandler: row.resolutionHandler } : {}),
    message: row.message,
    createdBy: row.createdBy,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    completesOnApproval: row.completesOnApproval,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    resolution: (row.resolution as WorkStreamWaitResolution | null) ?? null,
    resolutionNote: row.resolutionNote,
  }
}

export interface OpenWaitInput {
  structured?: import('@ficus/shared').StructuredManualWait
  scope?: 'stream' | 'attempt'
  flowAttemptId?: number | null
  resolutionHandler?: 'workflow'
  workStreamId: string
  type: WorkStreamWaitType
  referenceId?: string | null
  message?: string | null
  /** Manual waits: who must act. Defaults to human. */
  actor?: WorkStreamWaitActor
  createdBy?: 'system' | 'agent' | 'manager' | 'operator'
  createdByAgentId?: string | null
  createdByUserId?: string | null
  /**
   * Review waits only (default true): approving the wait completes the
   * stream in the same transaction. False = mid-work checkpoint review.
   */
  completesOnApproval?: boolean
  openedAt?: Date
}

/**
 * Open a wait record. For `review`, at most one open wait may exist per
 * stream (partial unique index): an existing open review wait is returned
 * as-is with `alreadyOpen: true` — the handoff verb is idempotent. Callers
 * that need race-safety hold the stream row lock; the unique index is the
 * backstop (a losing racer's insert throws).
 */
export async function openWait(
  dbx: DbHandle,
  input: OpenWaitInput
): Promise<{ wait: WorkStreamWaitRow; alreadyOpen: boolean }> {
  const { resolveWaitAttempt } = await import('./wait-scope')
  const flowAttemptId = await resolveWaitAttempt(dbx, input)
  if (input.type === 'review') {
    const [existing] = await dbx
      .select()
      .from(workStreamWaits)
      .where(
        and(
          eq(workStreamWaits.workStreamId, input.workStreamId),
          eq(workStreamWaits.type, 'review'),
          isNull(workStreamWaits.closedAt)
        )
      )
    if (existing) return { wait: existing, alreadyOpen: true }
  }

  if (
    input.type === 'manual' &&
    input.resolutionHandler !== 'workflow' &&
    (input.createdBy === 'agent' ||
      (input.createdByAgentId && input.createdBy !== 'system' && input.createdBy !== 'manager')) &&
    !input.structured
  ) {
    throw new Error('A typed continue, decide or provide request is required; free-text waits are not accepted')
  }
  if (input.type === 'manual' && !input.structured && input.createdBy === 'manager')
    assertHumanAnswerableRequest([input.message ?? ''])
  let structured = input.structured
  let actor = input.actor ?? 'human'
  if (structured) {
    const request = manualInputRequestSchema.parse(structured.request)
    if (input.type !== 'manual' || input.resolutionHandler)
      throw new Error('Structured input cannot replace a workflow or non-manual wait')
    if (request.kind === 'continue') {
      const [record] = await dbx.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, request.recoveryId))
      if (
        !record ||
        record.workStreamId !== input.workStreamId ||
        record.flowAttemptId !== flowAttemptId ||
        record.agentId !== input.createdByAgentId ||
        record.version !== request.expectedRecoveryVersion ||
        record.state.cycleFailures !== RECOVERY_ATTEMPT_BUDGET ||
        !['waiting-manager', 'waiting-owner'].includes(record.state.state)
      ) {
        throw new Error('Recovery must be exhausted and belong to this exact wait scope')
      }
      const { recoverySummary } = await import('../recovery/policy')
      structured = { request, summary: recoverySummary(record.state), version: record.version }
      actor = record.state.ownerEscalated ? 'human' : 'manager'
    } else {
      if (input.createdByAgentId) {
        const { assertNoPendingRecovery } = await import('../recovery/store')
        await assertNoPendingRecovery(dbx, input.createdByAgentId)
      }
      structured = { request, summary: taskInputSummary(request), version: 0 }
      actor = request.actor ?? 'human'
    }
  }
  const safeMessage = structured?.summary.text ?? input.message ?? null
  const [created] = await dbx
    .insert(workStreamWaits)
    .values({
      workStreamId: input.workStreamId,
      flowAttemptId,
      type: input.type,
      referenceId: input.referenceId ?? null,
      resolutionHandler: input.resolutionHandler ?? null,
      message: safeMessage,
      structured: structured ?? null,
      actor,
      createdBy: input.createdBy ?? 'system',
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      completesOnApproval: input.completesOnApproval ?? true,
      ...(input.openedAt ? { openedAt: input.openedAt } : {}),
    })
    .returning()
  return { wait: created, alreadyOpen: false }
}

export interface CloseWaitsFilter {
  workStreamId?: string
  type?: WorkStreamWaitType
  referenceId?: string
  waitId?: string
}

/**
 * Close every OPEN wait matching the filter (guarded on `closed_at IS NULL`,
 * so concurrent closers settle on exactly one winner per row). Returns the
 * rows this call closed.
 */
export async function closeOpenWaits(
  dbx: DbHandle,
  filter: CloseWaitsFilter,
  resolution: WorkStreamWaitResolution,
  opts: {
    note?: string | null
    closedAt?: Date
    /** Trusted flow supersession only, never an API field. */ allowStructured?: boolean
  } = {}
): Promise<WorkStreamWaitRow[]> {
  const conditions = [isNull(workStreamWaits.closedAt)]
  if (filter.waitId) conditions.push(eq(workStreamWaits.id, filter.waitId))
  if (filter.workStreamId) conditions.push(eq(workStreamWaits.workStreamId, filter.workStreamId))
  if (filter.type) conditions.push(eq(workStreamWaits.type, filter.type))
  if (filter.referenceId) conditions.push(eq(workStreamWaits.referenceId, filter.referenceId))
  if (conditions.length === 1) {
    throw new Error('closeOpenWaits requires at least one filter beyond "open"')
  }
  if (!opts.allowStructured && (filter.type === 'manual' || filter.waitId)) {
    const [structured] = await dbx
      .select({ id: workStreamWaits.id })
      .from(workStreamWaits)
      .where(and(...conditions, sql`${workStreamWaits.structured} IS NOT NULL`))
      .limit(1)
    if (structured)
      throw new Error('Use the typed input decision endpoint; generic unblock cannot resolve structured waits')
  }
  const safeNote = opts.note ?? null
  const closed = await dbx
    .update(workStreamWaits)
    .set({ closedAt: opts.closedAt ?? new Date(), resolution, resolutionNote: safeNote })
    .where(and(...conditions))
    .returning()
  // Terminal transitions and explicit authorized replanning retire the old
  // episode. Its attempts remain auditable, but cannot hold a replacement task.
  const recoveryIds = closed.flatMap((wait) =>
    wait.structured?.request.kind === 'continue' ? [wait.structured.request.recoveryId] : []
  )
  if (recoveryIds.length)
    await dbx
      .update(recoveryEpisodes)
      .set({
        state: sql`jsonb_set(${recoveryEpisodes.state}, '{state}', '"resolved"'::jsonb)`,
        version: sql`${recoveryEpisodes.version} + 1`,
        updatedAt: new Date(),
      })
      .where(inArray(recoveryEpisodes.id, recoveryIds))
  return closed
}

/** Open waits for one stream, newest first. */
export async function listOpenWaits(dbx: DbHandle, workStreamId: string): Promise<WorkStreamWaitRow[]> {
  const rows = await dbx
    .select()
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.workStreamId, workStreamId), isNull(workStreamWaits.closedAt)))
    .orderBy(desc(workStreamWaits.openedAt))
  return rows
}

/** Open waits for a set of streams, grouped by stream id (newest first within each). */
export async function listOpenWaitsForStreams(
  workStreamIds: string[],
  dbx: DbHandle = db
): Promise<Map<string, WorkStreamWaitRow[]>> {
  const result = new Map<string, WorkStreamWaitRow[]>()
  if (workStreamIds.length === 0) return result
  const rows = await dbx
    .select()
    .from(workStreamWaits)
    .where(and(inArray(workStreamWaits.workStreamId, workStreamIds), isNull(workStreamWaits.closedAt)))
    .orderBy(desc(workStreamWaits.openedAt))
  for (const row of rows) {
    const list = result.get(row.workStreamId)
    if (list) list.push(row)
    else result.set(row.workStreamId, [row])
  }
  return result
}

/** All review waits for one stream (open + closed), newest first. Closed rows = completed rounds. */
export async function listReviewHistory(dbx: DbHandle, workStreamId: string): Promise<WorkStreamWaitRow[]> {
  const rows = await dbx
    .select()
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.workStreamId, workStreamId), eq(workStreamWaits.type, 'review')))
    .orderBy(desc(workStreamWaits.openedAt))
  return rows
}

/**
 * The full wait audit trail for a stream — EVERY wait of every type, open and
 * closed, newest first. Resolving a wait never deletes its row (it stamps
 * closedAt/resolution/resolutionNote), so this is the durable, auditable record
 * of everything a stream ever waited on and how each was resolved. Surfaced on
 * the detail endpoint as `waitHistory`; `reviewHistory` is the review-typed
 * subset of it.
 */
export async function listWaitHistory(dbx: DbHandle, workStreamId: string): Promise<WorkStreamWaitRow[]> {
  const rows = await dbx
    .select()
    .from(workStreamWaits)
    .where(eq(workStreamWaits.workStreamId, workStreamId))
    .orderBy(desc(workStreamWaits.openedAt))
  return rows
}

/**
 * Reconcile a stream's SYSTEM-maintained dependency waits against its
 * authoritative `dependsOn` edge list (called in the same transaction as the
 * create/update that set the edges):
 * - unlock `ready` edges whose dependency is ready right now
 * - open one wait per unsatisfied dependency that has no open wait yet
 * - close (`satisfied`) open waits whose edge is now satisfied
 * - close (`cleared`) open waits whose edge was removed
 * An edge is satisfied when its dependency is done, or when it is a `ready`
 * edge that has unlocked (for a queued stream, an unlock it never started on
 * does not survive the dependency being canceled; an admitted stream has
 * started on it). Terminal streams get no new waits or unlocks.
 */
export async function syncDependencyWaits(tx: DbHandle, workStreamId: string, dependsOn: string[]): Promise<void> {
  const deps = [...new Set(dependsOn)]
  const [self] = await tx
    .select({ status: workStreams.status, dependencyEdges: workStreams.dependencyEdges })
    .from(workStreams)
    .where(eq(workStreams.id, workStreamId))
  const selfTerminal = !self || self.status === 'done' || self.status === 'canceled'
  const edges = { ...(self?.dependencyEdges ?? {}) }

  const depStatuses =
    deps.length > 0
      ? await tx
          .select({ id: workStreams.id, status: workStreams.status })
          .from(workStreams)
          .where(inArray(workStreams.id, deps))
      : []
  const statusOf = new Map(depStatuses.map((d) => [d.id, d.status]))

  if (!selfTerminal) {
    const pending = pendingReadyDependencyIds({ dependsOn: deps, dependencyEdges: edges }).filter(
      (dep) => statusOf.get(dep) !== 'done'
    )
    const ready = await loadReadyDependencyIds(tx, pending)
    for (const dep of pending) {
      if (!ready.has(dep)) continue
      const at = new Date()
      if (await unlockReadyEdge(tx, workStreamId, dep, at))
        edges[dep] = { ...edges[dep], readyUnlockedAt: at.toISOString() }
    }
  }
  // An admitted stream has started on every edge it unlocked, whether or not its stack
  // decision is recorded yet: a cancel in that window is a notice, never a new wait.
  const selfAdmitted = !!self && (WORK_STREAM_ADMITTED_STATUSES as readonly string[]).includes(self.status)
  const satisfiedDep = (dep: string) =>
    (selfAdmitted && edges[dep]?.condition === 'ready' && !!edges[dep]?.readyUnlockedAt) ||
    isDependencyEdgeSatisfied(edges, dep, statusOf.get(dep))

  const openDepWaits = (
    await tx
      .select()
      .from(workStreamWaits)
      .where(
        and(
          eq(workStreamWaits.workStreamId, workStreamId),
          eq(workStreamWaits.type, 'dependency'),
          isNull(workStreamWaits.closedAt)
        )
      )
  ).filter((w): w is WorkStreamWaitRow & { referenceId: string } => w.referenceId !== null)
  const openByRef = new Map(openDepWaits.map((w) => [w.referenceId, w]))

  // Close: edge removed -> cleared; edge satisfied -> satisfied.
  const removed = openDepWaits.filter((w) => !deps.includes(w.referenceId)).map((w) => w.id)
  if (removed.length > 0) {
    await tx
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'cleared', resolutionNote: 'dependency edge removed' })
      .where(and(inArray(workStreamWaits.id, removed), isNull(workStreamWaits.closedAt)))
  }
  const satisfied = openDepWaits
    .filter((w) => deps.includes(w.referenceId) && satisfiedDep(w.referenceId))
    .map((w) => w.id)
  if (satisfied.length > 0) {
    await tx
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'satisfied' })
      .where(and(inArray(workStreamWaits.id, satisfied), isNull(workStreamWaits.closedAt)))
  }

  // Open: unsatisfied dependency without an open wait.
  if (!selfTerminal) {
    const toOpen = deps.filter((dep) => !satisfiedDep(dep) && !openByRef.has(dep))
    for (const dep of toOpen) {
      await tx.insert(workStreamWaits).values({
        workStreamId,
        type: 'dependency',
        referenceId: dep,
        createdBy: 'system',
      })
    }
  }
}

/**
 * A dependency reached `done`: close (`satisfied`) every open dependency wait
 * referencing it. MUST run in the same transaction as the dependency's
 * terminal transition (spec: crash between dep-done and wait-close is a
 * non-event because there is no between).
 */
export async function closeDependencyWaitsForCompletedStream(
  tx: DbHandle,
  completedStreamId: string
): Promise<WorkStreamWaitRow[]> {
  return closeOpenWaits(tx, { type: 'dependency', referenceId: completedStreamId }, 'satisfied')
}
