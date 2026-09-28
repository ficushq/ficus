import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import type { WorkStreamWait, WorkStreamWaitResolution, WorkStreamWaitType } from '@ficus/shared'
import { db } from '../../db'
import { workStreams, workStreamWaits } from '../../db/schema'

export type WorkStreamWaitRow = InferSelectModel<typeof workStreamWaits>

/** The drizzle transaction handle (same shape as admission.ts's). */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** Either the root client or a transaction — every writer here composes into callers' transactions. */
export type DbHandle = DbTransaction | typeof db

export function toWaitJson(row: WorkStreamWaitRow): WorkStreamWait {
  return {
    id: row.id,
    flowAttemptId: row.flowAttemptId ?? null,
    workStreamId: row.workStreamId,
    type: row.type,
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
  scope?: 'stream' | 'attempt'
  flowAttemptId?: number | null
  resolutionHandler?: 'workflow'
  workStreamId: string
  type: WorkStreamWaitType
  referenceId?: string | null
  message?: string | null
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

  const safeMessage = input.message ?? null
  const [created] = await dbx
    .insert(workStreamWaits)
    .values({
      workStreamId: input.workStreamId,
      flowAttemptId,
      type: input.type,
      referenceId: input.referenceId ?? null,
      resolutionHandler: input.resolutionHandler ?? null,
      message: safeMessage,
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
  opts: { note?: string | null; closedAt?: Date } = {}
): Promise<WorkStreamWaitRow[]> {
  const conditions = [isNull(workStreamWaits.closedAt)]
  if (filter.waitId) conditions.push(eq(workStreamWaits.id, filter.waitId))
  if (filter.workStreamId) conditions.push(eq(workStreamWaits.workStreamId, filter.workStreamId))
  if (filter.type) conditions.push(eq(workStreamWaits.type, filter.type))
  if (filter.referenceId) conditions.push(eq(workStreamWaits.referenceId, filter.referenceId))
  if (conditions.length === 1) {
    throw new Error('closeOpenWaits requires at least one filter beyond "open"')
  }
  const safeNote = opts.note ?? null
  return dbx
    .update(workStreamWaits)
    .set({ closedAt: opts.closedAt ?? new Date(), resolution, resolutionNote: safeNote })
    .where(and(...conditions))
    .returning()
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
 * - open one wait per unsatisfied dependency that has no open wait yet
 * - close (`satisfied`) open waits whose dependency is now done
 * - close (`cleared`) open waits whose edge was removed
 * Terminal streams get no new waits.
 */
export async function syncDependencyWaits(tx: DbHandle, workStreamId: string, dependsOn: string[]): Promise<void> {
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

  const deps = [...new Set(dependsOn)]
  const depStatuses =
    deps.length > 0
      ? await tx
          .select({ id: workStreams.id, status: workStreams.status })
          .from(workStreams)
          .where(inArray(workStreams.id, deps))
      : []
  const statusOf = new Map(depStatuses.map((d) => [d.id, d.status]))

  const [self] = await tx
    .select({ status: workStreams.status })
    .from(workStreams)
    .where(eq(workStreams.id, workStreamId))
  const selfTerminal = !self || self.status === 'done' || self.status === 'canceled'

  const openByRef = new Map(openDepWaits.map((w) => [w.referenceId, w]))

  // Close: edge removed -> cleared; dependency done -> satisfied.
  const removed = openDepWaits.filter((w) => !deps.includes(w.referenceId)).map((w) => w.id)
  if (removed.length > 0) {
    await tx
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'cleared', resolutionNote: 'dependency edge removed' })
      .where(and(inArray(workStreamWaits.id, removed), isNull(workStreamWaits.closedAt)))
  }
  const satisfied = openDepWaits
    .filter((w) => deps.includes(w.referenceId) && statusOf.get(w.referenceId) === 'done')
    .map((w) => w.id)
  if (satisfied.length > 0) {
    await tx
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'satisfied' })
      .where(and(inArray(workStreamWaits.id, satisfied), isNull(workStreamWaits.closedAt)))
  }

  // Open: unsatisfied (not done) dependency without an open wait.
  if (!selfTerminal) {
    const toOpen = deps.filter((dep) => statusOf.get(dep) !== 'done' && !openByRef.has(dep))
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
