import { eventEmitter } from '../../lib/infra/event-emitter'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { isLiveAgentStatus } from '@ficus/shared'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { slotNotificationNotifier } from './notifications'
import { expireAndPromoteLocked, settleInactiveGrantNotifications, type PromotionResult } from './store'

const log = createLogger('slot-reconciliation')
const SLOT_RECONCILIATION_INTERVAL_MS = 30_000
let runner: PeriodicRunner | null = null

interface PoolReconciliationResult {
  squadId: string
  promotion: PromotionResult
  releasedClaims: number
  canceledWaiters: number
  repairedOwners: number
  oldestWaiterAgeMs: number
}

export interface SlotReconciliationSummary {
  poolsProcessed: number
  expiredClaims: number
  timeoutCount: number
  releasedClaims: number
  canceledWaiters: number
  promotedClaims: number
  repairedOwners: number
  activeCount: number
  queueDepth: number
  oldestWaiterAgeMs: number
  maxGrantLatencyMs: number
  oldestNotificationRetryAgeMs: number
  deliveryRetries: number
}

export async function reconcileSlotsOnce(input: { limit?: number } = {}): Promise<SlotReconciliationSummary> {
  const [clock] = await db.execute<{ now: Date }>(sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`)
  if (!clock) throw new Error('Unable to read slot database clock')
  const scanNow = new Date(clock.now)
  const limit = input.limit ?? 100
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT candidate.id
    FROM (
      SELECT pool.id
      FROM slot_pools pool
      JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
      JOIN slot_claims claim ON claim.pool_id = pool.id
      LEFT JOIN agents owner ON owner.id = claim.owner_agent_id
      WHERE claim.status = 'active'
        AND (claim.expires_at <= clock_timestamp()
          OR owner.id IS NULL OR owner.squad_id IS DISTINCT FROM pool.squad_id
          OR owner.status IN ('dormant', 'terminated'))
      UNION
      SELECT pool.id
      FROM slot_pools pool
      JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
      JOIN slot_waiters waiter ON waiter.pool_id = pool.id
      LEFT JOIN agents owner ON owner.id = waiter.owner_agent_id
      WHERE waiter.status = 'queued'
        AND (owner.id IS NULL OR owner.squad_id IS DISTINCT FROM pool.squad_id
          OR owner.status IN ('dormant', 'terminated'))
    ) candidate
    ORDER BY candidate.id
    LIMIT ${limit}
  `)
  const summary: SlotReconciliationSummary = {
    poolsProcessed: 0,
    expiredClaims: 0,
    timeoutCount: 0,
    releasedClaims: 0,
    canceledWaiters: 0,
    promotedClaims: 0,
    repairedOwners: 0,
    activeCount: 0,
    queueDepth: 0,
    oldestWaiterAgeMs: 0,
    maxGrantLatencyMs: 0,
    oldestNotificationRetryAgeMs: 0,
    deliveryRetries: 0,
  }

  for (const candidate of candidates) {
    const result = await db.transaction(async (tx): Promise<PoolReconciliationResult | null> => {
      const [pool] = await tx.select().from(slotPools).where(eq(slotPools.id, candidate.id)).for('update')
      if (!pool) return null
      const [clock] = await tx
        .select({ now: sql<Date>`date_trunc('milliseconds', clock_timestamp())` })
        .from(slotPools)
        .where(eq(slotPools.id, pool.id))
      const now = new Date(clock!.now)
      const activeClaims = await tx
        .select({ id: slotClaims.id, ownerAgentId: slotClaims.ownerAgentId })
        .from(slotClaims)
        .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
      let releasedClaims = 0
      let canceledWaiters = 0
      let repairedOwners = 0
      // pendingDormancyAt deliberately remains valid here until lifecycle
      // commits the dormant CAS; acquisition/renewal reject it sooner, but
      // reconciliation must not revoke state from a still-running owner.
      for (const claim of activeClaims) {
        const [owner] = await tx
          .select({ squadId: agents.squadId, status: agents.status })
          .from(agents)
          .where(eq(agents.id, claim.ownerAgentId))
        if (owner && owner.squadId === pool.squadId && isLiveAgentStatus(owner.status)) {
          continue
        }
        const rows = await tx
          .update(slotClaims)
          .set({ status: 'released', endedAt: now, terminalReason: 'pool_cleanup' })
          .where(and(eq(slotClaims.id, claim.id), eq(slotClaims.status, 'active')))
          .returning({ id: slotClaims.id })
        await settleInactiveGrantNotifications(
          tx,
          rows.map((row) => row.id),
          now
        )
        releasedClaims += rows.length
        repairedOwners += rows.length
      }
      const queuedWaiters = await tx
        .select({ id: slotWaiters.id, ownerAgentId: slotWaiters.ownerAgentId })
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
      for (const waiter of queuedWaiters) {
        const [owner] = await tx
          .select({ squadId: agents.squadId, status: agents.status })
          .from(agents)
          .where(eq(agents.id, waiter.ownerAgentId))
        if (owner && owner.squadId === pool.squadId && isLiveAgentStatus(owner.status)) {
          continue
        }
        const rows = await tx
          .update(slotWaiters)
          .set({ status: 'canceled', endedAt: now, terminalReason: 'pool_cleanup' })
          .where(and(eq(slotWaiters.id, waiter.id), eq(slotWaiters.status, 'queued')))
          .returning({ id: slotWaiters.id })
        canceledWaiters += rows.length
        repairedOwners += rows.length
      }
      const promotion = await expireAndPromoteLocked(tx, pool, now)
      const [oldest] = await tx
        .select({ queuedAt: slotWaiters.queuedAt })
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
        .orderBy(slotWaiters.enqueueSequence, slotWaiters.id)
        .limit(1)
      return {
        squadId: pool.squadId,
        promotion,
        releasedClaims,
        canceledWaiters,
        repairedOwners,
        oldestWaiterAgeMs: oldest ? Math.max(0, now.getTime() - oldest.queuedAt.getTime()) : 0,
      }
    })
    if (!result) continue
    eventEmitter.emit('slots.updated', { squadId: result.squadId })
    summary.poolsProcessed += 1
    summary.expiredClaims += result.promotion.expired
    summary.timeoutCount += result.promotion.expired
    summary.releasedClaims += result.releasedClaims
    summary.canceledWaiters += result.canceledWaiters + result.promotion.canceled
    summary.promotedClaims += result.promotion.promoted
    summary.repairedOwners += result.repairedOwners + result.promotion.canceled
    summary.activeCount += result.promotion.activeCount
    summary.queueDepth += result.promotion.queueDepth
    summary.oldestWaiterAgeMs = Math.max(summary.oldestWaiterAgeMs, result.oldestWaiterAgeMs)
    summary.maxGrantLatencyMs = Math.max(summary.maxGrantLatencyMs, result.promotion.maxGrantLatencyMs)
  }

  const [inventory] = await db.execute<{
    activeCount: number
    queueDepth: number
    oldestWaiterAt: Date | null
  }>(sql`
    SELECT
      (SELECT count(*)::int
       FROM slot_claims claim
       JOIN slot_pools pool ON pool.id = claim.pool_id
       JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
       WHERE claim.status = 'active' AND claim.expires_at > clock_timestamp()
         AND pool.unregistered_at IS NULL) AS "activeCount",
      (SELECT count(*)::int
       FROM slot_waiters waiter
       JOIN slot_pools pool ON pool.id = waiter.pool_id
       JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
       WHERE waiter.status = 'queued' AND pool.unregistered_at IS NULL) AS "queueDepth",
      (SELECT min(waiter.queued_at)
       FROM slot_waiters waiter
       JOIN slot_pools pool ON pool.id = waiter.pool_id
       JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
       WHERE waiter.status = 'queued' AND pool.unregistered_at IS NULL) AS "oldestWaiterAt"
  `)
  summary.activeCount = inventory?.activeCount ?? 0
  summary.queueDepth = inventory?.queueDepth ?? 0
  summary.oldestWaiterAgeMs = inventory?.oldestWaiterAt
    ? Math.max(0, scanNow.getTime() - new Date(inventory.oldestWaiterAt).getTime())
    : 0

  const [oldestNotification] = await db
    .select({ createdAt: slotNotifications.createdAt })
    .from(slotNotifications)
    .where(and(inArray(slotNotifications.status, ['pending', 'delivering']), gt(slotNotifications.attempts, 0)))
    .orderBy(slotNotifications.createdAt)
    .limit(1)
  summary.oldestNotificationRetryAgeMs = oldestNotification
    ? Math.max(0, scanNow.getTime() - oldestNotification.createdAt.getTime())
    : 0
  const delivery = await slotNotificationNotifier.drain({ now: scanNow })
  summary.deliveryRetries = delivery.deliveryRetries
  if (summary.poolsProcessed > 0 || summary.oldestNotificationRetryAgeMs > 0 || delivery.claimed > 0) {
    log.info('Slot reconciliation summary', summary)
  }
  return summary
}

export function startSlotReconciliation(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'slot-reconciliation',
    intervalMs: SLOT_RECONCILIATION_INTERVAL_MS,
    runImmediately: false,
    task: async () => {
      await reconcileSlotsOnce()
    },
  })
  runner.start()
}

export async function stopSlotReconciliation(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
