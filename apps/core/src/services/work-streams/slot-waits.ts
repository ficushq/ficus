import type { WorkStreamSlotWait } from '@ficus/shared'
import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm'
import { db, executions, slotWaiters, workStreamFlowRuns } from '../../db'
import { listActiveSlotWaits } from '../slots/active-waits'
import { loadHostGroup, resolveHostBudget } from '../slots/host-budget'
import { rankedSlotWaiters } from '../slots/queue-order'

/**
 * Read-only context, not a scheduler wait. A queued subscription belongs to a
 * stream only when it was created during an execution of a STILL-current flow
 * attempt by that attempt's participant. Agent membership alone is insufficient:
 * reused participants and historical/parallel assignments must not borrow waits.
 * Legacy/unattributable subscriptions remain visible in agent chat, not on a
 * stream.
 *
 * Each attributed wait carries the squad's own pool key, its place in the
 * pool's grant order, the queue length and whether the machine host's budget
 * is full. Agent identities and other squads' holders never leave this
 * projection; the host fact is a single boolean.
 */
export async function loadStreamSlotWaits(
  streamIds: string[],
  now: Date = new Date()
): Promise<Map<string, WorkStreamSlotWait>> {
  const result = new Map<string, WorkStreamSlotWait>()
  if (!streamIds.length) return result
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
  if (!waits.length) return result
  // Enqueue-time execution context also excludes a leftover queued waiter from
  // an earlier attempt even when the same agent is reused by the new attempt.
  const origins = await db
    .select({ waiterId: slotWaiters.id, agentId: executions.agentId, context: executions.flowContext })
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
  const waitById = new Map(waits.map((wait) => [wait.waiterId, wait]))
  const attributed: Array<{ streamId: string; attemptId: number; wait: (typeof waits)[number] }> = []
  for (const { waiterId, agentId, context } of origins) {
    const wait = waitById.get(waiterId)
    if (wait && context && current.get(`${context.workStreamId}:${context.attemptId}`) === agentId)
      attributed.push({ streamId: context.workStreamId, attemptId: context.attemptId, wait })
  }
  if (!attributed.length) return result

  // Grant order is computed the way promotion computes it (priority, aging, then first come).
  const poolIds = [...new Set(attributed.map(({ wait }) => wait.poolId))]
  const ranked = await rankedSlotWaiters(db, poolIds, now)
  const orderByPool = new Map<string, string[]>()
  for (const { waiter } of ranked)
    orderByPool.set(waiter.poolId, [...(orderByPool.get(waiter.poolId) ?? []), waiter.id])

  const hostBusyBySquad = new Map<string, boolean | undefined>()
  for (const squadId of new Set(attributed.filter(({ wait }) => wait.hostShared).map(({ wait }) => wait.squadId))) {
    const budget = await resolveHostBudget(db, squadId)
    hostBusyBySquad.set(
      squadId,
      budget ? (await loadHostGroup(db, budget, now)).activeCount >= budget.capacity : undefined
    )
  }

  for (const { streamId, attemptId, wait } of attributed.sort(
    (a, b) => a.wait.queuedAt.getTime() - b.wait.queuedAt.getTime()
  )) {
    // A stream shows its longest wait when several attempts are queued.
    if (result.has(streamId)) continue
    // A waiter granted between the two reads is still shown, last, until the next read.
    const order = orderByPool.get(wait.poolId) ?? []
    const index = order.indexOf(wait.waiterId)
    const hostBusy = wait.hostShared ? hostBusyBySquad.get(wait.squadId) : undefined
    result.set(streamId, {
      poolKey: wait.poolKey,
      attemptId,
      position: index >= 0 ? index + 1 : order.length + 1,
      queuedCount: index >= 0 ? order.length : order.length + 1,
      queuedAt: wait.queuedAt.toISOString(),
      ...(hostBusy !== undefined ? { hostBusy } : {}),
    })
  }
  return result
}
