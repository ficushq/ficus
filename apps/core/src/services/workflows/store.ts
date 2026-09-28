import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  advanceWorkflowRun,
  createWorkflowRun,
  workflowCommandSchema,
  workflowSourceSchema,
  type WorkflowRun,
} from '@ficus/shared'
import { db, workStreamFlowRuns, workStreamFlowTransitions, workStreams } from '../../db'
import { resolveStoredWorkflow, workflowFingerprint, WorkflowError } from './catalog'

const requestIdentity = z.object({ requestId: z.string().uuid(), actorKey: z.string().trim().min(1).max(500) }).strict()

/**
 * Optional preparation-only persistence boundary, not mounted as an execution API.
 * Activated runs must go through execution.ts, which authorizes participants,
 * pins participant settings, and commits dispatch intents with every transition.
 */
export async function prepareWorkStreamFlow(
  workStreamId: string,
  input: unknown,
  identity: z.infer<typeof requestIdentity>
) {
  const { requestId, actorKey } = requestIdentity.parse(identity)
  const source = workflowSourceSchema.parse(input)
  const fingerprint = workflowFingerprint({ source, actorKey })
  return db.transaction(async (tx) => {
    // All flow writes lock parent then run, matching preparation and transitions.
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
    if (!stream) throw new WorkflowError('Work stream not found', 404)
    const [existing] = await tx
      .select()
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    if (existing) {
      if (existing.createRequestId === requestId && existing.createRequestHash === fingerprint) return existing
      throw new WorkflowError('Work stream already has a prepared flow', 409)
    }
    if (stream.status !== 'queued' || stream.assigneeAgentId || stream.agentIds?.length)
      throw new WorkflowError('Only an unassigned queued work stream can prepare a flow', 409)
    const resolved = await resolveStoredWorkflow(source, tx)
    const state = createWorkflowRun(resolved.definition)
    const [row] = await tx
      .insert(workStreamFlowRuns)
      .values({
        workStreamId,
        createRequestId: requestId,
        createRequestHash: fingerprint,
        source: resolved,
        state,
        createdBy: actorKey,
      })
      .returning()
    return row!
  })
}

export interface WorkflowTransitionReceipt {
  version: number
  stateStatus: WorkflowRun['status']
  activeAttemptId: number | null
}

/**
 * Trusted internal operation: caller authorization is not inferred from actorKey.
 * Persistence and retry semantics only; this never assigns/wakes agents or marks
 * a stream done. Do not expose it directly as an agent-facing API.
 */
export async function persistWorkflowTransition(
  workStreamId: string,
  input: unknown,
  identity: z.infer<typeof requestIdentity>
): Promise<WorkflowTransitionReceipt> {
  const { requestId, actorKey } = requestIdentity.parse(identity)
  const command = workflowCommandSchema.parse(input)
  const fingerprint = workflowFingerprint({ command, actorKey })
  return db.transaction(async (tx) => {
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
    if (!stream) throw new WorkflowError('Work stream not found', 404)
    const [run] = await tx
      .select()
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, workStreamId))
      .for('update')
    if (run?.activated) throw new WorkflowError('Use the execution engine for activated flows', 409)
    if (!run) throw new WorkflowError('Prepared flow not found', 404)
    const [prior] = await tx
      .select()
      .from(workStreamFlowTransitions)
      .where(
        and(
          eq(workStreamFlowTransitions.workStreamId, workStreamId),
          eq(workStreamFlowTransitions.requestId, requestId)
        )
      )
    if (prior) {
      if (prior.requestHash !== fingerprint)
        throw new WorkflowError('Request ID was already used for a different transition', 409)
      return { version: prior.version, stateStatus: prior.stateStatus, activeAttemptId: prior.activeAttemptId }
    }
    if (stream.status === 'done' || stream.status === 'canceled')
      throw new WorkflowError('Work stream is terminal', 409)
    if (run.version !== command.expectedVersion || run.state.version !== run.version)
      throw new WorkflowError('Stale workflow version', 409)
    const state = advanceWorkflowRun(run.state, command)
    await tx
      .update(workStreamFlowRuns)
      .set({ state, version: state.version, updatedAt: new Date() })
      .where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    const receipt = { version: state.version, stateStatus: state.status, activeAttemptId: state.activeAttemptId }
    await tx
      .insert(workStreamFlowTransitions)
      .values({ workStreamId, requestId, requestHash: fingerprint, command, actorKey, ...receipt })
    return receipt
  })
}
