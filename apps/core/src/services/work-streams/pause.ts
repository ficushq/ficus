import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { activeWorkflowAttempts } from '@ficus/shared'
import { db, workStreams, squads, executions, workStreamFlowRuns, type DbTx } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { Execution } from '../../entities/Execution'
import { InboxMessage } from '../../entities/InboxMessage'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import { invalidateContinuationCycle, resetContinuationCycle } from './continuation-state'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { promoteEligibleQueuedStreams } from './admission'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('work-stream-pause')
export const pauseWorkStreamSchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
    parkAfterMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  })
  .strict()
export class WorkStreamPausedError extends Error {
  constructor(readonly workStreamId: string) {
    super(`Work stream ${workStreamId} is paused. Wait for explicit resume.`)
  }
}
export async function pausedWorkStreamForAgent(agentId: string, store: DbTx | typeof db = db) {
  const [row] = await store
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        inArray(workStreams.status, ['active', 'queued']),
        isNotNull(workStreams.pause),
        or(eq(workStreams.assigneeAgentId, agentId), sql`${workStreams.agentIds} @> ARRAY[${agentId}]::uuid[]`)
      )
    )
    .limit(1)
  return row?.id ?? null
}
export async function assertAgentWorkStreamNotPaused(agentId: string, tx: DbTx) {
  const id = await pausedWorkStreamForAgent(agentId, tx)
  if (id) throw new WorkStreamPausedError(id)
}

export async function pauseWorkStream(workStreamId: string, input: unknown = {}, expectedPauseId?: string) {
  const options = pauseWorkStreamSchema.parse(input)
  const existing = await WorkStream.mustFind(workStreamId)
  const id = existing.id
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, existing.squadId)).for('update')
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    if (!stream || !['active', 'queued'].includes(stream.status)) throw new Error('Only unfinished work can be paused')
    if (expectedPauseId && stream.pause?.id !== expectedPauseId) return { stream, live: [] }
    const crew = [
      ...new Set([...(stream.agentIds ?? []), ...(stream.assigneeAgentId ? [stream.assigneeAgentId] : [])]),
    ].sort()
    // Serialize with queue acceptance and pickup. Do not acquire stream/agent row locks after this point.
    for (const agentId of crew) await acquireAgentQueueLock(tx, agentId)
    const live = crew.length
      ? await tx
          .select()
          .from(executions)
          .where(and(inArray(executions.agentId, crew), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      : []
    if (stream.pause) return { stream, live }
    const [clock] = await tx
      .select({ now: sql<string>`clock_timestamp()::text` })
      .from(workStreams)
      .where(eq(workStreams.id, id))
    const pausedAt = new Date(clock!.now).toISOString()
    const pause = {
      id: crypto.randomUUID(),
      pausedAt,
      reason: options.reason || null,
      parkAt: options.parkAfterMinutes
        ? new Date(new Date(pausedAt).getTime() + options.parkAfterMinutes * 60000).toISOString()
        : null,
      agentIds: [...new Set(live.map((entry) => entry.agentId))],
    }
    const [updated] = await tx
      .update(workStreams)
      .set({ pause, updatedAt: new Date(pausedAt) })
      .where(eq(workStreams.id, id))
      .returning()
    await invalidateContinuationCycle(tx, id)
    return { stream: updated!, live }
  })
  if (!existing.pause) eventEmitter.emit('workStream.updated', { workStreamId: id, squadId: existing.squadId })
  for (const row of result.live) await new Execution(row).requestStopWithSignal()
  return new WorkStream(result.stream)
}

export async function resumeWorkStream(workStreamId: string) {
  const existing = await WorkStream.mustFind(workStreamId)
  const id = existing.id
  // Complete durable stop requests before clearing the hold. A racing duplicate
  // resume must not stop a newer execution or create a new pause episode.
  if (existing.pause) await pauseWorkStream(id, {}, existing.pause.id)
  const callbacks: Array<() => void> = []
  const recipients = await db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, existing.squadId)).for('update')
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    if (!stream || !['active', 'queued'].includes(stream.status)) throw new Error('Only unfinished work can be resumed')
    if (!stream.pause) return []
    const pause = stream.pause
    const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
    const targets = run?.activated
      ? run.state.status === 'running'
        ? activeWorkflowAttempts(run.state).flatMap((attempt) => {
            const agentId = run.attemptAgents[String(attempt.id)]
            return agentId ? [{ agentId, attemptId: attempt.id }] : []
          })
        : []
      : [
          ...new Set([
            ...(stream.assigneeAgentId ? [stream.assigneeAgentId] : []),
            ...pause.agentIds.filter((agentId) => stream.agentIds?.includes(agentId)),
          ]),
        ].map((agentId) => ({ agentId, attemptId: undefined }))
    await tx.update(workStreams).set({ pause: null, updatedAt: new Date() }).where(eq(workStreams.id, id))
    await resetContinuationCycle(tx, id, stream.assigneeAgentId)
    for (const { agentId, attemptId } of targets)
      await InboxMessage.persistSystemAgentOnceInTransaction(
        tx,
        {
          recipientId: agentId,
          subject: 'Work stream resumed',
          content: `Work stream ${id} has been explicitly resumed.${pause.reason ? `\nPrevious pause reason: ${pause.reason}` : ''}`,
          metadata: {
            source: attemptId ? 'workflow' : 'work-stream-resume',
            workStreamResume: true,
            workStreamId: id,
            squadId: stream.squadId,
            ...(attemptId ? { attemptId } : {}),
          },
          recordOnly: true,
          wakeEligible: true,
        },
        `resume:${pause.id}:${agentId}`,
        callbacks
      )
    return targets.map((entry) => entry.agentId)
  })
  callbacks.forEach((callback) => callback())
  eventEmitter.emit('workStream.updated', { workStreamId: id, squadId: existing.squadId })
  await promoteEligibleQueuedStreams(existing.squadId)
  const { ensureFlowDispatch } = await import('../workflows/execution')
  if (!(await ensureFlowDispatch(id))) {
    const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
    for (const agentId of recipients) await deliverInboxMessagesToAgent(agentId)
  }
  return WorkStream.mustFind(id)
}

/** Retry stop effects after a crash without waking agents or sending idle follow-ups. */
export async function reconcileWorkStreamPauses() {
  const rows = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(and(isNotNull(workStreams.pause), inArray(workStreams.status, ['active', 'queued'])))
  for (const { id } of rows) {
    try {
      await pauseWorkStream(id)
    } catch (error) {
      log.warn(`Pause reconciliation deferred for ${id}`, error)
    }
  }
}
