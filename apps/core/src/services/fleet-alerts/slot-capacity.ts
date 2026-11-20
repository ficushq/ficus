import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { effectivePoolCapacity, loadHostGroup, resolveHostBudget } from '../slots/host-budget'
import {
  listOpenSlotCapacityWaitPoolIds,
  observeSlotCapacityWait,
  type SlotCapacityWaitDetails,
  type SlotCapacityWaitObservation,
} from './store'

const log = createLogger('fleet-slot-capacity')

/**
 * How far past the pool's claim timeout the oldest queued waiter must be
 * before its queue counts as abnormally long. Within the timeout, every
 * holder that does not renew has released or expired, so the queue moved.
 */
export const SLOT_CAPACITY_WAIT_MARGIN_MS = 15 * 60_000

export interface SlotQueueReading {
  poolId: string
  squadId: string
  details: SlotCapacityWaitDetails
}

interface QueueRow extends Record<string, unknown> {
  poolId: string
  squadId: string
  poolKey: string
  capacity: number
  capacityFollowsHost: boolean
  hostShared: boolean
  claimTimeoutMs: number
  queuedCount: number
  oldestQueuedAt: Date | string
  activeCount: number
}

/**
 * Every enforced pool of a live squad with a queue: its length, its oldest
 * wait and who holds capacity, as counts. Waiters of dormant, terminated or
 * foreign owners are left out, matching the work-stream slot-wait projection.
 */
export async function readSlotQueues(now: Date): Promise<SlotQueueReading[]> {
  const at = now.toISOString()
  const rows = await db.execute<QueueRow>(sql`
    SELECT pool.id AS "poolId", pool.squad_id AS "squadId", pool.key AS "poolKey", pool.capacity,
      pool.capacity_follows_host AS "capacityFollowsHost", pool.host_shared AS "hostShared",
      pool.claim_timeout_ms AS "claimTimeoutMs",
      count(*)::int AS "queuedCount", min(waiter.queued_at) AS "oldestQueuedAt",
      (SELECT count(*)::int FROM slot_claims AS claim
        WHERE claim.pool_id = pool.id AND claim.status = 'active'
          AND claim.expires_at > ${at}::timestamptz) AS "activeCount"
    FROM slot_pools AS pool
    JOIN squads AS squad ON squad.id = pool.squad_id AND squad.status = 'active' AND squad.archived_at IS NULL
    JOIN slot_waiters AS waiter ON waiter.pool_id = pool.id
    JOIN agents AS owner ON owner.id = waiter.owner_agent_id AND owner.squad_id = pool.squad_id
    WHERE pool.unregistered_at IS NULL AND pool.disabled_at IS NULL
      AND waiter.status = 'queued' AND waiter.ended_at IS NULL AND waiter.resulting_claim_id IS NULL
      AND waiter.queued_at <= ${at}::timestamptz
      AND owner.status NOT IN ('dormant', 'terminated')
    GROUP BY pool.id
    ORDER BY pool.id
  `)
  const readings: SlotQueueReading[] = []
  for (const row of rows) {
    const budget = row.hostShared ? await resolveHostBudget(db, row.squadId) : null
    const host = budget ? await loadHostGroup(db, budget, now) : null
    const hostActiveCount = host?.activeCount
    readings.push({
      poolId: row.poolId,
      squadId: row.squadId,
      details: {
        poolKey: row.poolKey,
        queuedCount: Number(row.queuedCount),
        oldestQueuedAt: new Date(row.oldestQueuedAt).toISOString(),
        claimTimeoutMs: Number(row.claimTimeoutMs),
        capacity: effectivePoolCapacity(row, budget),
        activeCount: Number(row.activeCount),
        hostShared: row.hostShared,
        ...(budget && host
          ? {
              hostCapacity: budget.capacity,
              hostActiveCount,
              hostHeldByOtherSquads: Math.max(0, host.activeCount - (host.heldBySquad.get(row.squadId) ?? 0)),
            }
          : {}),
      },
    })
  }
  return readings
}

/** True once the oldest waiter has outlasted the claim timeout plus the margin. */
export function isSlotQueueOverdue(details: SlotCapacityWaitDetails, now: Date): boolean {
  return (
    now.getTime() - new Date(details.oldestQueuedAt).getTime() >= details.claimTimeoutMs + SLOT_CAPACITY_WAIT_MARGIN_MS
  )
}

export interface SlotCapacityReconcileDeps {
  readQueues?: (now: Date) => Promise<SlotQueueReading[]>
  listOpenPoolIds?: () => Promise<string[]>
  observe?: (input: SlotCapacityWaitObservation) => Promise<string | undefined>
}

/**
 * Open or refresh a long-queue incident for each overdue pool and close the
 * ones whose queue has moved. This never claims, cancels or reorders anything.
 */
export async function reconcileSlotCapacityWaits(
  input: { now: Date },
  deps: SlotCapacityReconcileDeps = {}
): Promise<void> {
  const observe = deps.observe ?? observeSlotCapacityWait
  const [readings, open] = await Promise.all([
    (deps.readQueues ?? readSlotQueues)(input.now),
    (deps.listOpenPoolIds ?? listOpenSlotCapacityWaitPoolIds)(),
  ])
  const overdue = readings.filter((reading) => isSlotQueueOverdue(reading.details, input.now))
  const overdueIds = new Set(overdue.map((reading) => reading.poolId))
  await Promise.all([
    ...overdue.map((reading) =>
      observe({ status: 'waiting', ...reading, now: input.now }).catch((error) =>
        log.warn(`Recording the long queue of slot pool ${reading.poolId} failed:`, error)
      )
    ),
    ...open
      .filter((poolId) => !overdueIds.has(poolId))
      .map((poolId) =>
        observe({ status: 'clear', poolId, now: input.now }).catch((error) =>
          log.warn(`Closing the long-queue incident of slot pool ${poolId} failed:`, error)
        )
      ),
  ])
}
