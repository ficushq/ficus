import { z } from 'zod'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { activeWorkflowAttempts } from '@ficus/shared'
import {
  db,
  inbox,
  agentQuestions,
  executions,
  workStreams,
  workStreamFlowRuns,
  workStreamWaits,
  workflowBindings,
} from '../../db'
import type { DbHandle, OpenWaitInput, WorkStreamWaitRow } from './waits'

export async function resolveWaitAttempt(store: DbHandle, input: OpenWaitInput): Promise<number | null> {
  if (input.scope === 'stream') {
    if (input.flowAttemptId != null) throw new Error('A whole-stream wait cannot target a flow attempt')
    return null
  }
  // Dependencies and legacy review gates keep their whole-stream semantics.
  if (input.type === 'dependency' || input.type === 'review') {
    if (input.scope === 'attempt' || input.flowAttemptId != null)
      throw new Error('Use a flow human-approval step for scoped reviews; dependencies block the whole stream')
    return null
  }
  const [run] = await store
    .select()
    .from(workStreamFlowRuns)
    .where(eq(workStreamFlowRuns.workStreamId, input.workStreamId))
  const active = run?.activated ? activeWorkflowAttempts(run.state) : []
  const attempt =
    input.flowAttemptId != null
      ? active.find((entry) => entry.id === input.flowAttemptId)
      : active.find(
          (entry) => input.createdByAgentId && run!.attemptAgents[String(entry.id)] === input.createdByAgentId
        )
  if (attempt) {
    if (input.createdByAgentId && run!.attemptAgents[String(attempt.id)] !== input.createdByAgentId)
      throw new Error('An agent can only block its own active attempt; use stream scope for shared blockers')
    return attempt.id
  }
  if (
    input.scope === 'attempt' ||
    input.flowAttemptId != null ||
    (run?.activated && input.createdByAgentId && Object.values(run.attemptAgents).includes(input.createdByAgentId))
  )
    throw new Error('The wait must target a currently active flow attempt')
  return null
}

export async function waitsForAttempt(store: DbHandle, workStreamId: string, attemptId: number) {
  const waits = await store
    .select()
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.workStreamId, workStreamId), isNull(workStreamWaits.closedAt)))
  return waits.filter((wait) => wait.flowAttemptId == null || wait.flowAttemptId === attemptId)
}

/** Used by continuation checks; a sibling's wait does not block this agent. */
export async function waitsForAgent(store: DbHandle, workStreamId: string, agentId: string) {
  const [run] = await store.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  if (run?.activated) {
    const attempts = activeWorkflowAttempts(run.state).filter(
      (entry) => run.attemptAgents[String(entry.id)] === agentId
    )
    if (attempts.length === 0)
      return store
        .select()
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.workStreamId, workStreamId),
            isNull(workStreamWaits.closedAt),
            isNull(workStreamWaits.flowAttemptId)
          )
        )
    return (await Promise.all(attempts.map((attempt) => waitsForAttempt(store, workStreamId, attempt.id)))).flat()
  }
  return store
    .select()
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.workStreamId, workStreamId), isNull(workStreamWaits.closedAt)))
}

/** Only park/withhold admission when no branch can make progress. */
export async function admissionBlockingWaits(store: DbHandle, workStreamId: string): Promise<WorkStreamWaitRow[]> {
  const waits = await store
    .select()
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.workStreamId, workStreamId), isNull(workStreamWaits.closedAt)))
  if (waits.length === 0) return waits
  const global = waits.filter((wait) => wait.flowAttemptId == null)
  if (global.length > 0) return global
  const [run] = await store.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  if (!run?.activated) return waits
  const attempts = activeWorkflowAttempts(run.state)
  return attempts.some((attempt) => !waits.some((wait) => wait.flowAttemptId === attempt.id)) ? [] : waits
}

/** A response to an abandoned attempt remains in history and must not wake a reused session. */
export async function isCurrentWaitAttempt(store: DbHandle, workStreamId: string, attemptId: number, agentId?: string) {
  const [run] = await store.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  return (
    !!run?.activated &&
    activeWorkflowAttempts(run.state).some(
      (attempt) => attempt.id === attemptId && (!agentId || run.attemptAgents[String(attempt.id)] === agentId)
    )
  )
}

/** The last runnable branch must have been blocked for the full grace period. */
export function admissionBlockedSince(waits: WorkStreamWaitRow[]): number | null {
  if (waits.length === 0) return null
  const global = waits.filter((wait) => wait.flowAttemptId == null)
  if (global.length) return Math.min(...global.map((wait) => wait.openedAt.getTime()))
  const earliest = new Map<number, number>()
  for (const wait of waits)
    earliest.set(wait.flowAttemptId!, Math.min(earliest.get(wait.flowAttemptId!) ?? Infinity, wait.openedAt.getTime()))
  return Math.max(...earliest.values())
}

export async function notifyFlowWaitResolution(
  workStreamId: string,
  waits: WorkStreamWaitRow[],
  actorAgentId?: string | null
) {
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  if (!run?.activated) return false
  const { ensureFlowDispatch } = await import('../workflows/execution')
  await ensureFlowDispatch(workStreamId)
  const { InboxMessage } = await import('../../entities/InboxMessage')
  for (const wait of waits) {
    for (const attempt of activeWorkflowAttempts(run.state)) {
      if (wait.flowAttemptId != null && wait.flowAttemptId !== attempt.id) continue
      const agentId = run.attemptAgents[String(attempt.id)]
      if (!agentId || agentId === actorAgentId) continue
      await InboxMessage.sendOnce(
        {
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          subject: `Input resolved for ${attempt.stepId}`,
          content: `Work stream ${workStreamId}, step ${attempt.stepId} (attempt ${attempt.id})\nWait resolved: ${wait.message ?? 'Requested input'}\n\n${wait.resolutionNote ?? 'The blocker was cleared.'}`,
          deliveryMode: 'steer',
          metadata: { source: 'workflow-wait-resolution', workStreamId, attemptId: attempt.id },
        },
        `flow-wait:${wait.id}:${attempt.id}`
      )
    }
  }
  return true
}

export class FlowWaitSupersededError extends Error {
  constructor() {
    super('The flow attempt was superseded. The response is retained in history without waking an agent.')
  }
}

export async function flowInboxTargets(store: DbHandle, messageIds: string[]) {
  messageIds = messageIds.filter((id) => z.string().uuid().safeParse(id).success)
  if (!messageIds.length) return []
  const rows = await store.select({ metadata: inbox.metadata }).from(inbox).where(inArray(inbox.id, messageIds))
  const targets: Array<{ workStreamId: string; attemptId: number; assignment: boolean }> = []
  for (const row of rows) {
    const metadata = row.metadata as {
      source?: string
      workStreamId?: string
      attemptId?: number
      questionId?: string
    } | null
    if (
      (metadata?.source === 'workflow' || metadata?.source === 'workflow-wait-resolution') &&
      metadata.workStreamId &&
      metadata.attemptId
    )
      targets.push({
        workStreamId: metadata.workStreamId,
        attemptId: metadata.attemptId,
        assignment: metadata.source === 'workflow',
      })
    if (metadata?.source === 'agent-question-answer' && metadata.questionId) {
      const [origin] = await store
        .select({ flowContext: executions.flowContext })
        .from(agentQuestions)
        .innerJoin(executions, eq(executions.id, agentQuestions.executionId))
        .where(eq(agentQuestions.id, metadata.questionId))
      if (origin?.flowContext) targets.push({ ...origin.flowContext, assignment: false })
      else {
        const waits = await store
          .select()
          .from(workStreamWaits)
          .where(and(eq(workStreamWaits.type, 'question'), eq(workStreamWaits.referenceId, metadata.questionId)))
        for (const wait of waits)
          if (wait.flowAttemptId != null)
            targets.push({ workStreamId: wait.workStreamId, attemptId: wait.flowAttemptId, assignment: false })
      }
    }
  }
  return targets
}

/** Call before the agent queue lock; flow revisions use the same stream row lock. */
export async function lockFlowInboxDelivery(store: DbHandle, agentId: string, messageIds: string[] = []) {
  const targets = await flowInboxTargets(store, messageIds)
  const validIds = messageIds.filter((id) => z.string().uuid().safeParse(id).success)
  const integrationMessages = validIds.length
    ? (
        await store.select({ id: inbox.id, metadata: inbox.metadata }).from(inbox).where(inArray(inbox.id, validIds))
      ).filter((row) => row.metadata?.source === 'integration-output')
    : []
  const ids = [
    ...new Set([
      ...targets.map((target) => target.workStreamId),
      ...integrationMessages
        .map((row) => String(row.metadata?.workStreamId))
        .filter((id) => z.string().uuid().safeParse(id).success),
    ]),
  ].sort()
  for (const id of ids)
    await store.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, id)).for('update')
  if (integrationMessages.length) {
    const { isCurrentIntegrationDelivery } = await import('../integrations/outputs/runtime')
    for (const row of integrationMessages) {
      const deliveryId = String(row.metadata?.integrationDeliveryId)
      if (
        !z.string().uuid().safeParse(deliveryId).success ||
        !(await isCurrentIntegrationDelivery(store, deliveryId, agentId, row.id))
      )
        throw new FlowWaitSupersededError()
    }
  }
  for (const target of targets) {
    if (!(await isCurrentWaitAttempt(store, target.workStreamId, target.attemptId, agentId)))
      throw new FlowWaitSupersededError()
    if (target.assignment && (await waitsForAttempt(store, target.workStreamId, target.attemptId)).length)
      throw new Error('The flow attempt is waiting for input')
  }
}

/** One wait read and, only for scoped waits, one flow read per scheduler batch. */
async function loadWaitScopes(store: DbHandle, ids: string[]) {
  const byStream = new Map<string, WorkStreamWaitRow[]>()
  if (!ids.length) return { byStream, runs: new Map<string, typeof workStreamFlowRuns.$inferSelect>() }
  const waits = await store
    .select()
    .from(workStreamWaits)
    .where(and(inArray(workStreamWaits.workStreamId, ids), isNull(workStreamWaits.closedAt)))
  for (const wait of waits) byStream.set(wait.workStreamId, [...(byStream.get(wait.workStreamId) ?? []), wait])
  const scopedIds = [...new Set(waits.filter((wait) => wait.flowAttemptId != null).map((wait) => wait.workStreamId))]
  const runs = scopedIds.length
    ? await store.select().from(workStreamFlowRuns).where(inArray(workStreamFlowRuns.workStreamId, scopedIds))
    : []
  return { byStream, runs: new Map(runs.map((run) => [run.workStreamId, run])) }
}

export async function waitingAssigneeStreamIds(
  store: DbHandle,
  streams: Array<{ id: string; assigneeAgentId: string | null }>
) {
  const { byStream, runs } = await loadWaitScopes(
    store,
    streams.map((stream) => stream.id)
  )
  return new Set(
    streams
      .filter((stream) => {
        const waits = byStream.get(stream.id) ?? []
        const run = runs.get(stream.id)
        if (!run?.activated) return waits.length > 0
        const own = new Set(
          activeWorkflowAttempts(run.state)
            .filter((attempt) => run.attemptAgents[String(attempt.id)] === stream.assigneeAgentId)
            .map((attempt) => attempt.id)
        )
        return waits.some((wait) => wait.flowAttemptId == null || own.has(wait.flowAttemptId))
      })
      .map((stream) => stream.id)
  )
}

export async function admissionBlockedStreamIds(store: DbHandle, ids: string[]) {
  const { byStream, runs } = await loadWaitScopes(store, ids)
  return new Set(
    ids.filter((id) => {
      const waits = byStream.get(id) ?? []
      if (!waits.length) return false
      if (waits.some((wait) => wait.flowAttemptId == null)) return true
      const run = runs.get(id)
      return (
        !run?.activated ||
        activeWorkflowAttempts(run.state).every((attempt) => waits.some((wait) => wait.flowAttemptId === attempt.id))
      )
    })
  )
}

/** Question mutations must take the same flow-before-agent order as inbox acceptance and pause. */
export async function lockAgentFlowStream(store: DbHandle, agentId: string) {
  const [binding] = await store
    .select({ workStreamId: workflowBindings.workStreamId })
    .from(workflowBindings)
    .where(eq(workflowBindings.agentId, agentId))
  if (binding)
    await store
      .select({ id: workStreams.id })
      .from(workStreams)
      .where(eq(workStreams.id, binding.workStreamId))
      .for('update')
}
