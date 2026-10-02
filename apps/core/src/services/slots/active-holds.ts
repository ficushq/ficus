import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { agents, db, slotClaims, slotPools, squads, type DbTx } from '../../db'

/** Read-only live ownership, using the lease clock rather than execution state.
 * Invalid owners/pools are excluded even before lifecycle reconciliation runs.
 * This projection intentionally contains no claim authority or capacity facts.
 */
export async function listActiveSlotHolds(store: typeof db | DbTx, agentIds: string[]) {
  if (!agentIds.length) return []
  return store
    .select({ poolKey: slotPools.key, expiresAt: slotClaims.expiresAt })
    .from(slotClaims)
    .innerJoin(slotPools, eq(slotPools.id, slotClaims.poolId))
    .innerJoin(squads, eq(squads.id, slotPools.squadId))
    .innerJoin(agents, and(eq(agents.id, slotClaims.ownerAgentId), eq(agents.squadId, slotPools.squadId)))
    .where(
      and(
        inArray(slotClaims.ownerAgentId, agentIds),
        eq(slotClaims.status, 'active'),
        isNull(slotClaims.endedAt),
        sql`${slotClaims.expiresAt} > clock_timestamp()`,
        isNull(slotPools.unregisteredAt),
        isNull(squads.archivedAt),
        notInArray(agents.status, ['dormant', 'terminated'])
      )
    )
    .orderBy(slotPools.key)
}
