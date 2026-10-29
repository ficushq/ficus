import { and, eq, isNull } from 'drizzle-orm'
import {
  manualInputRequestSchema,
  manualWaitDecisionSchema,
  taskInputSummary,
  taskInputLabel,
  workspaceTaskPathSchema,
  type ManualInputRequest,
  type ManualWaitDecision,
  type WorkStreamWaitCreatedBy,
} from '@ficus/shared'
import { db, squads, workStreams, workStreamWaits } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { decideRecovery, openRecoveryWait, type RecoveryActor } from './store'
import { notifyFlowWaitResolution } from '../work-streams/wait-scope'
import { validateConfigDeclaration } from './task-declarations'
import { eventEmitter } from '../../lib/infra/event-emitter'

export async function requestStructuredInput(
  workStreamId: string,
  input: ManualInputRequest,
  attribution: {
    createdBy: WorkStreamWaitCreatedBy
    createdByAgentId?: string | null
    createdByUserId?: string | null
  }
) {
  const request = manualInputRequestSchema.parse(input)
  const stream = await WorkStream.mustFind(workStreamId)
  if (request.kind === 'continue') {
    if (!attribution.createdByAgentId) throw new Error('Only the originating worker may request a recovery wait')
    const record = await openRecoveryWait(
      request.recoveryId,
      request.expectedRecoveryVersion,
      attribution.createdByAgentId,
      workStreamId
    )
    const [wait] = record.waitId
      ? await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, record.waitId))
      : []
    if (!wait) throw new Error('Recovery wait could not be opened')
    return wait
  }
  if (request.kind === 'provide') await validateConfigDeclaration(request, workStreamId, stream.squadId)
  const summary = taskInputSummary(request)
  return stream.block({
    scope: request.scope,
    flowAttemptId: request.flowAttemptId,
    message: summary.text,
    structured: { request, summary, version: 0 },
    actor: request.actor ?? 'human',
    ...attribution,
  })
}

export async function resolveStructuredInput(
  workStreamId: string,
  waitId: string,
  input: ManualWaitDecision,
  actor: RecoveryActor
) {
  const decision = manualWaitDecisionSchema.parse(input)
  const [candidate] = await db
    .select()
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.id, waitId), eq(workStreamWaits.workStreamId, workStreamId)))
  if (!candidate?.structured) throw new Error('Structured input wait not found')
  if (candidate.closedAt) throw new Error('Input wait is already closed')
  if (candidate.structured.request.kind === 'continue') {
    await decideRecovery(candidate.structured.request.recoveryId, decision, actor, { id: waitId, workStreamId })
    const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, waitId))
    return wait!
  }
  const closed = await db.transaction(async (tx) => {
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
    if (!stream || ['done', 'canceled'].includes(stream.status)) throw new Error('Work stream is terminal or missing')
    const [wait] = await tx
      .select()
      .from(workStreamWaits)
      .where(and(eq(workStreamWaits.id, waitId), eq(workStreamWaits.workStreamId, workStreamId)))
      .for('update')
    if (!wait?.structured || wait.closedAt) throw new Error('Input wait is already closed or missing')
    if (wait.structured.version !== decision.expectedVersion)
      throw new Error('Input version changed; refresh before deciding')
    if (wait.actor === 'owner') {
      const [squad] = await tx.select().from(squads).where(eq(squads.id, stream.squadId))
      if (!actor.agentId || actor.agentId !== (stream.ownerAgentId ?? squad?.managerAgentId))
        throw new Error('Only the authorized owner agent may resolve this input')
    } else if (!actor.userId) throw new Error('Only a human may resolve this input')
    const request = wait.structured.request
    let note: string
    if (request.kind === 'decide' && decision.action === 'choose') {
      const option = request.options.find((option) => option.id === decision.optionId)
      if (!option) throw new Error('Select one declared option')
      note = `Selected: ${option.label}`
    } else if (request.kind === 'provide' && decision.action === 'provide') {
      const value = request.input.type === 'file' ? workspaceTaskPathSchema.parse(decision.value) : decision.value
      note = `${taskInputLabel(request.input)}: ${value}`
    } else throw new Error('Decision does not match the input kind')
    const [updated] = await tx
      .update(workStreamWaits)
      .set({
        closedAt: new Date(),
        resolution: 'cleared',
        resolutionNote: note,
        structured: { ...wait.structured, version: wait.structured.version + 1 },
      })
      .where(and(eq(workStreamWaits.id, wait.id), isNull(workStreamWaits.closedAt)))
      .returning()
    return updated!
  })
  const stream = await WorkStream.mustFind(workStreamId)
  if (!(await notifyFlowWaitResolution(workStreamId, [closed], actor.agentId))) {
    const { notifyWorkStreamResponded } = await import('../squad/work-stream-notifications')
    await notifyWorkStreamResponded(stream, 'manual', closed.resolutionNote ?? undefined, 'sent_back', actor.agentId)
  }
  eventEmitter.emit('workStream.updated', { workStreamId, squadId: stream.squadId })
  const { promoteEligibleQueuedStreams } = await import('../work-streams/admission')
  await promoteEligibleQueuedStreams(stream.squadId)
  return closed
}
