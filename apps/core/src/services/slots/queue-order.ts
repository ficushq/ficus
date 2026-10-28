import { priorityRank } from '@ficus/shared'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import { slotWaiters, workStreams, type DbTx } from '../../db'

/**
 * An agent competes at the highest stored priority of its active work streams
 * in this squad (assignee or crew member, matching WorkStream.listForAgent).
 * Agents without active work use normal priority. Ties preserve enqueue order.
 * Read current membership/priorities in the caller's transaction at grant time;
 * no execution timing or priority snapshot is needed.
 */
export async function orderedSlotWaiters(tx: DbTx, pool: { id: string; squadId: string }) {
  const waiters = await tx
    .select()
    .from(slotWaiters)
    .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
    .orderBy(asc(slotWaiters.enqueueSequence), asc(slotWaiters.id))
  if (waiters.length < 2) return waiters

  const memberships = await tx
    .select({ waiterId: slotWaiters.id, priority: workStreams.priority })
    .from(slotWaiters)
    .innerJoin(
      workStreams,
      or(
        eq(workStreams.assigneeAgentId, slotWaiters.ownerAgentId),
        sql`${slotWaiters.ownerAgentId} = ANY(${workStreams.agentIds})`
      )
    )
    .where(
      and(
        eq(slotWaiters.poolId, pool.id),
        eq(slotWaiters.status, 'queued'),
        eq(workStreams.squadId, pool.squadId),
        eq(workStreams.status, 'active')
      )
    )

  const ranks = new Map<string, number>()
  for (const membership of memberships) {
    const rank = priorityRank(membership.priority)
    ranks.set(membership.waiterId, Math.max(ranks.get(membership.waiterId) ?? rank, rank))
  }
  // Stable sort preserves the database's sequence/id ordering within each rank.
  return waiters.sort(
    (a, b) => (ranks.get(b.id) ?? priorityRank('normal')) - (ranks.get(a.id) ?? priorityRank('normal'))
  )
}
