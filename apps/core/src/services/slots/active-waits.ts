import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm'
import { agents, db, slotPools, slotWaiters, squads, type DbTx } from '../../db'

/**
 * Authoritative, read-only queued subscriptions. Waiters have no time-based
 * expiry: promotion/cancellation ends them, not age or a claim's lease. Ignore
 * inert pools and invalid owners even before reconciliation repairs old rows.
 * Callers performing a continuation write hold the agent queue lock, shared
 * with claim/subscribe, until that write commits.
 */
export async function listActiveSlotWaits(store: typeof db | DbTx, agentIds: string[]) {
  if (agentIds.length === 0) return []
  return store
    .select({
      waiterId: slotWaiters.id,
      agentId: slotWaiters.ownerAgentId,
      squadId: slotPools.squadId,
      poolId: slotPools.id,
      poolKey: slotPools.key,
      hostShared: slotPools.hostShared,
      queuedAt: slotWaiters.queuedAt,
    })
    .from(slotWaiters)
    .innerJoin(slotPools, eq(slotPools.id, slotWaiters.poolId))
    .innerJoin(squads, eq(squads.id, slotPools.squadId))
    .innerJoin(agents, and(eq(agents.id, slotWaiters.ownerAgentId), eq(agents.squadId, slotPools.squadId)))
    .where(
      and(
        inArray(slotWaiters.ownerAgentId, agentIds),
        eq(slotWaiters.status, 'queued'),
        isNull(slotWaiters.endedAt),
        isNull(slotWaiters.resultingClaimId),
        isNull(slotPools.unregisteredAt),
        isNull(squads.archivedAt),
        notInArray(agents.status, ['dormant', 'terminated'])
      )
    )
    .orderBy(slotPools.key, slotWaiters.id)
}
