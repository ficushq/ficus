import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  DEFAULT_HOST_POOL_CREATOR,
  DEFAULT_HOST_POOL_KEY,
  DEFAULT_HOST_POOL_TIMEOUT_MS,
  DEFAULT_HOST_POOL_USAGE,
  deriveHostSlotCapacity,
} from './host-budget'
import { registerPool } from './store'
import { SlotServiceError } from './types'

const log = createLogger('slot-default-host-pool')
const SEED_BATCH = 100

/**
 * Give a squad that shares a machine host a host-shared pool by default.
 *
 * Slot pools are opt-in, so a squad whose manager never registered one ran its
 * heavy work ungated, and on a shared machine that work lands on every other
 * squad. A squad whose box is on a machine with a known budget, and that has
 * no slot pool row at all, gets `heavy-work`: host-shared, with no cap of its
 * own, so its capacity is the machine's budget and stays so when that changes.
 *
 * A squad that already has pools is left alone: its manager marks the pool
 * that protects box capacity host-shared instead. A default pool the manager
 * unregisters is not registered again, because its unregistered row stays
 * (retention.ts keeps it). Runs on the slot reconciliation interval.
 */
export async function ensureDefaultHostPools(): Promise<number> {
  const candidates = await db.execute<{ squadId: string; capabilities: { memMb?: number; cpus?: number } | null }>(sql`
    SELECT squad.id AS "squadId", machine.capabilities
    FROM squads squad
    JOIN machine_boxes box ON box.sandbox_id = 'squad_' || squad.id::text
    JOIN machines machine ON machine.id = box.machine_id
    WHERE squad.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM slot_pools pool WHERE pool.squad_id = squad.id)
    ORDER BY squad.id
    LIMIT ${SEED_BATCH}
  `)
  let registered = 0
  for (const candidate of candidates) {
    // Unknown machine size or budgets turned off: nothing to share yet.
    const capacity = deriveHostSlotCapacity(candidate.capabilities)
    if (capacity === null) continue
    try {
      await registerPool({
        squadId: candidate.squadId,
        key: DEFAULT_HOST_POOL_KEY,
        capacity,
        claimTimeoutMs: DEFAULT_HOST_POOL_TIMEOUT_MS,
        usage: DEFAULT_HOST_POOL_USAGE,
        hostShared: true,
        // No cap of its own: it keeps following the machine's budget. The
        // number above is only the fallback should budgets be turned off.
        capacityFollowsHost: true,
        createdBy: DEFAULT_HOST_POOL_CREATOR,
      })
    } catch (error) {
      // Archived meanwhile, or registered by a concurrent sweep.
      if (error instanceof SlotServiceError) continue
      throw error
    }
    registered += 1
    eventEmitter.emit('slots.updated', { squadId: candidate.squadId })
    log.info('Registered the default host-shared slot pool', {
      squadId: candidate.squadId,
      key: DEFAULT_HOST_POOL_KEY,
      capacity,
    })
  }
  return registered
}
