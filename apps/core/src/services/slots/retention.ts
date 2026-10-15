import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'

const log = createLogger('slot-retention')

/**
 * Bounded terminal retention for slot coordination history.
 *
 * Terminal rows exist only for idempotent recovery answers (release/renew/
 * unsubscribe retries, exactly-once terminalization audits) and for delivery
 * bookkeeping. Following the squad-activity maintenance conventions, terminal
 * rows older than RETENTION_DAYS are pruned hourly in bounded batches, using
 * database time so a skewed application clock can never delete fresh history.
 *
 * The recovery/idempotency window is therefore 30 days: a terminal answer older
 * than that converges to its not-found equivalent, which is also correct for
 * callers because no claim can outlive its 24-hour maximum timeout.
 *
 * Delete order respects the foreign keys: notifications and waiters reference
 * claims and pools, pool_disabled notifications reference waiters, claims
 * reference pools. A terminal waiter is only deleted once no notification
 * still points at it. A terminal claim is only deleted
 * once no waiter or notification still points at it, and a pool only once no
 * child row remains, so the prune never violates a RESTRICT constraint
 * mid-pass. Active, queued, pending, and delivering state is never touched.
 */
export const SLOT_TERMINAL_RETENTION_DAYS = 30
export const SLOT_PRUNE_INTERVAL_MS = 60 * 60_000
export const SLOT_PRUNE_BATCH_SIZE = 1_000
export const SLOT_PRUNE_MAX_BATCHES = 5

export interface SlotTerminalPruneSummary {
  notifications: number
  waiters: number
  claims: number
  pools: number
}

/** Retention floor, truncated to UTC midnight like the activity retention floor. */
export function slotTerminalRetentionFloor(now: Date): Date {
  const floor = new Date(now)
  floor.setUTCDate(floor.getUTCDate() - SLOT_TERMINAL_RETENTION_DAYS)
  floor.setUTCHours(0, 0, 0, 0)
  return floor
}

async function pruneBatches(
  victims: ReturnType<typeof sql>,
  table: string,
  batchSize: number,
  maxBatches: number
): Promise<number> {
  let count = 0
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await db.execute<{ id: string }>(sql`
      WITH candidates AS (${victims})
      DELETE FROM ${sql.raw(table)} target USING candidates
      WHERE target.id = candidates.id
      RETURNING target.id
    `)
    count += deleted.length
    if (deleted.length < batchSize) break
  }
  return count
}

async function slotDatabaseNow(): Promise<Date> {
  const [clock] = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() now`)
  if (!clock) throw new Error('Unable to read slot database clock')
  return new Date(clock.now)
}

export async function pruneTerminalSlotState(
  input: { now?: Date; batchSize?: number; maxBatches?: number } = {}
): Promise<SlotTerminalPruneSummary> {
  // Smaller injected limits exercise the same SQL/FK boundary without creating
  // 15,000 rows in a unit regression. Production defaults remain pinned.
  const batchSize = input.batchSize ?? SLOT_PRUNE_BATCH_SIZE
  const maxBatches = input.maxBatches ?? SLOT_PRUNE_MAX_BATCHES
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > SLOT_PRUNE_BATCH_SIZE ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > SLOT_PRUNE_MAX_BATCHES
  )
    throw new Error('Invalid slot prune limits')
  const resolved = input.now ?? (await slotDatabaseNow())
  const floor = slotTerminalRetentionFloor(resolved).toISOString()

  const notifications = await pruneBatches(
    sql`SELECT id FROM slot_notifications
      WHERE status = 'delivered' AND delivered_at < ${floor}::timestamptz
      ORDER BY id LIMIT ${batchSize}`,
    'slot_notifications',
    batchSize,
    maxBatches
  )
  const waiters = await pruneBatches(
    sql`SELECT id FROM slot_waiters
      WHERE status <> 'queued' AND ended_at < ${floor}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM slot_notifications notice WHERE notice.waiter_id = slot_waiters.id)
      ORDER BY id LIMIT ${batchSize}`,
    'slot_waiters',
    batchSize,
    maxBatches
  )
  const claims = await pruneBatches(
    sql`SELECT claim.id FROM slot_claims claim
      WHERE claim.status <> 'active' AND claim.ended_at < ${floor}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM slot_waiters waiter WHERE waiter.resulting_claim_id = claim.id)
        AND NOT EXISTS (SELECT 1 FROM slot_notifications notice WHERE notice.claim_id = claim.id)
      ORDER BY claim.id LIMIT ${batchSize}`,
    'slot_claims',
    batchSize,
    maxBatches
  )
  const pools = await pruneBatches(
    sql`SELECT pool.id FROM slot_pools pool
      WHERE pool.unregistered_at IS NOT NULL AND pool.unregistered_at < ${floor}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM slot_claims claim WHERE claim.pool_id = pool.id)
        AND NOT EXISTS (SELECT 1 FROM slot_waiters waiter WHERE waiter.pool_id = pool.id)
        AND NOT EXISTS (SELECT 1 FROM slot_notifications notice WHERE notice.pool_id = pool.id)
      ORDER BY pool.id LIMIT ${batchSize}`,
    'slot_pools',
    batchSize,
    maxBatches
  )
  const summary: SlotTerminalPruneSummary = { notifications, waiters, claims, pools }
  if (notifications + waiters + claims + pools > 0) {
    log.info('Slot terminal retention pruned rows older than the floor', { floor, ...summary })
  }
  return summary
}

let runner: PeriodicRunner | null = null

export function startSlotTerminalRetention(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'slot-terminal-retention',
    intervalMs: SLOT_PRUNE_INTERVAL_MS,
    runImmediately: false,
    task: async () => {
      await pruneTerminalSlotState()
    },
  })
  runner.start()
}

export async function stopSlotTerminalRetention(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
