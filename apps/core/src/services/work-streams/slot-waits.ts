import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm'
import { db, executions, slotWaiters, workStreamFlowRuns } from '../../db'
import { listActiveSlotWaits } from '../slots/active-waits'

/**
 * Read-only context, not a scheduler wait. A queued subscription belongs to a
 * stream only when it was created during an execution of a STILL-current flow
 * attempt by that attempt's participant. Agent membership alone is insufficient:
 * reused participants and historical/parallel assignments must not borrow waits.
 * Legacy/unattributable subscriptions remain visible in agent chat, not on a
 * stream. No pool names, identities or queue details leave this projection.
 */
export async function loadSlotWaitingStreams(streamIds: string[]): Promise<Set<string>> {
  const waiting = new Set<string>()
  if (!streamIds.length) return waiting
  const runs = await db
    .select({
      id: workStreamFlowRuns.workStreamId,
      state: workStreamFlowRuns.state,
      attemptAgents: workStreamFlowRuns.attemptAgents,
    })
    .from(workStreamFlowRuns)
    .where(and(inArray(workStreamFlowRuns.workStreamId, streamIds), eq(workStreamFlowRuns.activated, true)))
  const current = new Map<string, string>()
  for (const run of runs) {
    if (run.state.status !== 'running') continue
    for (const attempt of run.state.attempts) {
      const agentId = run.attemptAgents[String(attempt.id)]
      if (attempt.status === 'running' && agentId) current.set(`${run.id}:${attempt.id}`, agentId)
    }
  }
  const waits = await listActiveSlotWaits(db, [...new Set(current.values())])
  if (!waits.length) return waiting
  // Enqueue-time execution context also excludes a leftover queued waiter from
  // an earlier attempt even when the same agent is reused by the new attempt.
  const origins = await db
    .select({ agentId: executions.agentId, context: executions.flowContext })
    .from(slotWaiters)
    .innerJoin(
      executions,
      and(
        eq(executions.agentId, slotWaiters.ownerAgentId),
        lte(executions.startedAt, slotWaiters.queuedAt),
        or(isNull(executions.endedAt), gte(executions.endedAt, slotWaiters.queuedAt))
      )
    )
    .where(
      inArray(
        slotWaiters.id,
        waits.map((wait) => wait.waiterId)
      )
    )
  for (const { agentId, context } of origins) {
    if (context && current.get(`${context.workStreamId}:${context.attemptId}`) === agentId)
      waiting.add(context.workStreamId)
  }
  return waiting
}
