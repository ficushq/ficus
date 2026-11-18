import { priorityRank } from '@ficus/shared'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { slotPools, slotWaiters, workStreams, type db, type DbTx } from '../../db'

type Reader = typeof db | DbTx
type SlotWaiterRow = typeof slotWaiters.$inferSelect

/**
 * A waiter gains one priority level for each full interval it has been queued,
 * up to critical. Without it a low-priority waiter never reaches the front of
 * a pool that higher-priority work keeps busy. Within a level the order is
 * still first come, so an aged waiter goes ahead of newer waiters of the level
 * it has reached.
 */
export const SLOT_WAIT_AGING_INTERVAL_MS = 30 * 60 * 1000
const TOP_RANK = priorityRank('critical')

/** Work-stream priority rank after aging. */
export function agedSlotRank(baseRank: number, queuedAt: Date, now: Date): number {
  const waited = Math.max(0, now.getTime() - queuedAt.getTime())
  return Math.min(TOP_RANK, baseRank + Math.floor(waited / SLOT_WAIT_AGING_INTERVAL_MS))
}

export interface RankedSlotWaiter {
  waiter: SlotWaiterRow
  rank: number
}

async function databaseClock(reader: Reader): Promise<Date> {
  const [clock] = await reader.execute<{ now: Date }>(sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`)
  if (!clock) throw new Error('Unable to read slot database clock')
  return new Date(clock.now)
}

/**
 * Queued waiters of the given pools, best first.
 *
 * An agent competes at the highest stored priority of its active work streams
 * in the pool's squad (assignee or crew member, matching
 * WorkStream.listForAgent), raised by aging. Agents without active work use
 * normal priority. Ties preserve enqueue order. Read current
 * membership/priorities in the caller's transaction at grant time; no execution
 * timing or priority snapshot is needed.
 */
export async function rankedSlotWaiters(reader: Reader, poolIds: string[], now: Date): Promise<RankedSlotWaiter[]> {
  if (poolIds.length === 0) return []
  const waiters = await reader
    .select()
    .from(slotWaiters)
    .where(and(inArray(slotWaiters.poolId, poolIds), eq(slotWaiters.status, 'queued')))
    .orderBy(asc(slotWaiters.enqueueSequence), asc(slotWaiters.id))
  if (waiters.length === 0) return []

  const memberships = await reader
    .select({ waiterId: slotWaiters.id, priority: workStreams.priority })
    .from(slotWaiters)
    .innerJoin(slotPools, eq(slotPools.id, slotWaiters.poolId))
    .innerJoin(
      workStreams,
      or(
        eq(workStreams.assigneeAgentId, slotWaiters.ownerAgentId),
        sql`${slotWaiters.ownerAgentId} = ANY(${workStreams.agentIds})`
      )
    )
    .where(
      and(
        inArray(slotWaiters.poolId, poolIds),
        eq(slotWaiters.status, 'queued'),
        eq(workStreams.squadId, slotPools.squadId),
        eq(workStreams.status, 'active')
      )
    )

  const base = new Map<string, number>()
  for (const membership of memberships) {
    const rank = priorityRank(membership.priority)
    base.set(membership.waiterId, Math.max(base.get(membership.waiterId) ?? rank, rank))
  }
  // Stable sort preserves the database's sequence/id ordering within each rank.
  return waiters
    .map((waiter) => ({
      waiter,
      rank: agedSlotRank(base.get(waiter.id) ?? priorityRank('normal'), waiter.queuedAt, now),
    }))
    .sort((a, b) => b.rank - a.rank)
}

/** One pool's queued waiters in grant order. `now` defaults to the database clock. */
export async function orderedSlotWaiters(reader: Reader, pool: { id: string }, now?: Date): Promise<SlotWaiterRow[]> {
  return (await rankedSlotWaiters(reader, [pool.id], now ?? (await databaseClock(reader)))).map(({ waiter }) => waiter)
}
