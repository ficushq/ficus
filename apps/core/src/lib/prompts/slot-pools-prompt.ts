import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, slotPools, squads } from '../../db'
import { effectivePoolCapacity, resolveHostBudget } from '../../services/slots/host-budget'
import { createLogger } from '../infra/logger'
import { renderSlotPoolsPrompt, type SlotPoolPromptEntry } from './slot-pools-render'

export {
  renderSlotPoolsPrompt,
  slotPoolsPromptFallback,
  SLOT_COORDINATION_GUIDANCE,
  SLOT_POOLS_PROMPT_TOKEN,
  type SlotPoolPromptEntry,
} from './slot-pools-render'

const log = createLogger('slot-pools-prompt')

/**
 * Active (registered, enabled) pools of a live squad, ordered by key. Disabled
 * pools are not enforced, so agents must not be told to claim them.
 */
export async function loadSlotPoolPromptEntries(squadId: string): Promise<SlotPoolPromptEntry[]> {
  const pools = await db
    .select({
      key: slotPools.key,
      capacity: slotPools.capacity,
      claimTimeoutMs: slotPools.claimTimeoutMs,
      usage: slotPools.usage,
      hostShared: slotPools.hostShared,
      capacityFollowsHost: slotPools.capacityFollowsHost,
    })
    .from(slotPools)
    .innerJoin(squads, eq(squads.id, slotPools.squadId))
    .where(
      and(
        eq(slotPools.squadId, squadId),
        isNull(slotPools.unregisteredAt),
        isNull(slotPools.disabledAt),
        isNull(squads.archivedAt)
      )
    )
    .orderBy(asc(slotPools.key))
  const budget = pools.some((pool) => pool.hostShared) ? await resolveHostBudget(db, squadId) : null
  return pools.map(({ hostShared, capacityFollowsHost, ...pool }) => {
    if (!hostShared || !budget) return pool
    const follows = capacityFollowsHost
    return {
      ...pool,
      capacity: effectivePoolCapacity({ ...pool, hostShared, capacityFollowsHost }, budget),
      hostCapacity: budget.capacity,
      ...(follows ? { capacityFollowsHost: true as const } : {}),
    }
  })
}

/**
 * The generated "Slot Pools" prompt section for a squad, or '' when it has no
 * active pools. A failed read degrades to no section rather than failing the
 * agent's session setup; the slot routes still enforce admission.
 */
export async function buildSlotPoolsPrompt(squadId: string): Promise<string> {
  try {
    return renderSlotPoolsPrompt(await loadSlotPoolPromptEntries(squadId))
  } catch (error) {
    log.warn('Slot pools prompt section unavailable', { squadId, error })
    return ''
  }
}
