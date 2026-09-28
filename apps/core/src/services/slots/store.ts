import { eventEmitter } from '../../lib/infra/event-emitter'
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import { isLiveAgentStatus } from '@ficus/shared'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import type { DbTx } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import {
  DEFAULT_SLOT_CLAIM_TIMEOUT_MS,
  MAX_SLOT_CAPACITY,
  MAX_SLOT_CLAIM_TIMEOUT_MS,
  MIN_SLOT_CLAIM_TIMEOUT_MS,
  SLOT_KEY_PATTERN,
  SlotServiceError,
  type SlotAcquirePoolSnapshot,
  type SlotAcquireResult,
  type SlotClaimView,
  type SlotPoolSummary,
  type SlotPoolView,
  type SlotReleaseResult,
  type SlotRenewResult,
  type SlotUnsubscribeResult,
  type SlotGrantedClaimStatus,
  type SlotResourceContext,
  type SlotViewer,
  type SlotWaiterView,
} from './types'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { slotNotificationNotifier } from './notifications'

type SlotPoolRow = typeof slotPools.$inferSelect
type SlotClaimRow = typeof slotClaims.$inferSelect
type SlotWaiterRow = typeof slotWaiters.$inferSelect
const log = createLogger('slot-store')

let cleanupAfterDiscoveryHook: (() => Promise<void>) | undefined
let projectionAfterClaimsHook: (() => Promise<void>) | undefined
let afterPoolLockHook: ((operation: string) => Promise<void>) | undefined

export function setSlotProjectionAfterClaimsHookForTest(hook: (() => Promise<void>) | undefined): void {
  projectionAfterClaimsHook = hook
}

export function setSlotAfterPoolLockHookForTest(hook: ((operation: string) => Promise<void>) | undefined): void {
  afterPoolLockHook = hook
}

export function setSlotCleanupAfterDiscoveryHookForTest(hook: (() => Promise<void>) | undefined): void {
  cleanupAfterDiscoveryHook = hook
}

let promptDrainEnabled = true

/** Tests suppress the prompt drain to keep outbox-state assertions deterministic. */
export function setSlotPromptDrainEnabledForTest(enabled: boolean): void {
  promptDrainEnabled = enabled
}

/**
 * Promptly drain the durable slot notification outbox. Call ONLY after the
 * granting transaction has committed — never while a slot pool FOR UPDATE lock
 * is held. Best-effort by design: a failure here can neither roll back the
 * committed grant nor lose the outbox row, which the reconciliation drain
 * retries on its interval.
 */
export function drainSlotNotificationsSoon(): void {
  if (!promptDrainEnabled) return
  try {
    slotNotificationNotifier.drainSoon()
  } catch (error) {
    // Never propagate into the caller: the grant is already committed and the
    // durable outbox row survives for the reconciliation drain to retry.
    log.warn('Prompt slot notification drain could not be scheduled', error)
  }
}

function drainSlotOutboxIfGranted(promotion: PromotionResult): void {
  if (promotion.promoted > 0 || promotion.expired > 0) drainSlotNotificationsSoon()
}

export interface RegisterPoolInput {
  squadId: string
  key: string
  capacity?: number
  claimTimeoutMs?: number
  createdBy: string
}

export interface UpdatePoolInput {
  capacity?: number
  claimTimeoutMs?: number
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase()
}

function validateKey(key: string): string {
  const normalized = normalizeKey(key)
  if (!SLOT_KEY_PATTERN.test(normalized)) {
    throw new SlotServiceError('invalid_slot_key', `Invalid slot pool key: ${key}`, 400)
  }
  return normalized
}

function validateCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_SLOT_CAPACITY) {
    throw new SlotServiceError(
      'invalid_capacity',
      `Slot pool capacity must be between 1 and ${MAX_SLOT_CAPACITY}.`,
      400
    )
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_SLOT_CLAIM_TIMEOUT_MS || timeoutMs > MAX_SLOT_CLAIM_TIMEOUT_MS) {
    throw new SlotServiceError(
      'invalid_timeout',
      `Slot claim timeout must be between ${MIN_SLOT_CLAIM_TIMEOUT_MS} and ${MAX_SLOT_CLAIM_TIMEOUT_MS} milliseconds.`,
      400
    )
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Slot state belongs to squad lifecycle: once a squad is archived its pools are
 * inert even if pool/state retirement is still retrying. The subquery keeps
 * FOR UPDATE scoped to pool rows only (never locks the squads row).
 */
const liveSquadExists = sql`EXISTS (SELECT 1 FROM squads live_squads
  WHERE live_squads.id = ${slotPools.squadId} AND live_squads.archived_at IS NULL)`

export async function registerPool(input: RegisterPoolInput): Promise<SlotPoolRow> {
  const key = validateKey(input.key)
  const capacity = input.capacity ?? 1
  const claimTimeoutMs = input.claimTimeoutMs ?? DEFAULT_SLOT_CLAIM_TIMEOUT_MS
  validateCapacity(capacity)
  validateTimeout(claimTimeoutMs)

  try {
    return await db.transaction(async (tx) => {
      // A FOR SHARE squad lock serializes against archival: if archive wins,
      // its pool retirement (which runs before archive commits) unregisters
      // whatever this transaction inserted, and vice versa this insert never
      // lands in an already-archived squad.
      const [squad] = await tx
        .select({ id: squads.id, archivedAt: squads.archivedAt })
        .from(squads)
        .where(eq(squads.id, input.squadId))
        .for('share')
      if (!squad || squad.archivedAt) {
        throw new SlotServiceError('squad_not_found', 'Squad was not found or is archived.', 404)
      }
      const [existing] = await tx
        .select({ id: slotPools.id })
        .from(slotPools)
        .where(and(eq(slotPools.squadId, input.squadId), eq(slotPools.key, key), isNull(slotPools.unregisteredAt)))
        .limit(1)
      if (existing) throw new SlotServiceError('pool_exists', `Slot pool "${key}" is already registered.`, 409)
      const [pool] = await tx
        .insert(slotPools)
        .values({ squadId: input.squadId, key, capacity, claimTimeoutMs, createdBy: input.createdBy })
        .returning()
      return pool!
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SlotServiceError('pool_exists', `Slot pool "${key}" is already registered.`, 409)
    }
    throw error
  }
}

async function lockActivePool(tx: DbTx, squadId: string, key: string): Promise<SlotPoolRow> {
  const normalized = validateKey(key)
  const [pool] = await tx
    .select()
    .from(slotPools)
    .where(
      and(
        eq(slotPools.squadId, squadId),
        eq(slotPools.key, normalized),
        isNull(slotPools.unregisteredAt),
        liveSquadExists
      )
    )
    .for('update')
  if (!pool) throw new SlotServiceError('pool_not_found', `Slot pool "${normalized}" was not found.`, 404)
  return pool
}

export interface PromotionResult {
  expired: number
  promoted: number
  canceled: number
  activeCount: number
  queueDepth: number
  maxGrantLatencyMs: number
  oldestWaiterAgeMs: number
}

function acquirePoolSnapshot(pool: SlotPoolRow, promotion: PromotionResult): SlotAcquirePoolSnapshot {
  const activeCount = promotion.activeCount
  return {
    key: pool.key,
    capacity: pool.capacity,
    activeCount,
    availableCount: Math.max(0, pool.capacity - activeCount),
    queuedCount: promotion.queueDepth,
  }
}

interface UpdatePoolTransactionResult {
  updated: SlotPoolRow
  promotion: PromotionResult
}

interface UnregisterPoolTransactionResult {
  archived: SlotPoolRow
  promotion: PromotionResult
}

type PromotedOperation<T> = { response: T; promotion: PromotionResult }
type SlotGrantedTransaction = {
  outcome: 'granted'
  pool: SlotPoolRow
  claim: SlotClaimRow
  promotion: PromotionResult
}
type SlotQueuedTransaction = {
  outcome: 'queued'
  pool: SlotPoolRow
  waiter: SlotWaiterRow
  promotion: PromotionResult
}
type SlotAcquireTransaction =
  | SlotGrantedTransaction
  | SlotQueuedTransaction
  | { outcome: 'unavailable'; pool: SlotPoolRow; promotion: PromotionResult }
type SlotSubscribeTransaction = SlotGrantedTransaction | SlotQueuedTransaction

export async function settleInactiveGrantNotifications(tx: DbTx, claimIds: string[], now: Date): Promise<void> {
  if (claimIds.length === 0) return
  await tx
    .update(slotNotifications)
    .set({
      status: 'delivered',
      deliveredAt: now,
      claimedAt: null,
      claimToken: null,
      lastErrorCode: 'claim_inactive',
      updatedAt: now,
    })
    .where(
      and(
        inArray(slotNotifications.claimId, claimIds),
        eq(slotNotifications.kind, 'granted'),
        inArray(slotNotifications.status, ['pending', 'delivering'])
      )
    )
}

export async function expireAndPromoteLocked(tx: DbTx, pool: SlotPoolRow, now: Date): Promise<PromotionResult> {
  const expired = await tx
    .update(slotClaims)
    .set({ status: 'expired', endedAt: now, terminalReason: 'timed_out' })
    .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active'), lte(slotClaims.expiresAt, now)))
    .returning({ id: slotClaims.id, ownerAgentId: slotClaims.ownerAgentId })
  if (expired.length > 0) {
    await settleInactiveGrantNotifications(
      tx,
      expired.map((claim) => claim.id),
      now
    )
    await tx
      .insert(slotNotifications)
      .values(
        expired.map((claim) => ({
          poolId: pool.id,
          claimId: claim.id,
          recipientAgentId: claim.ownerAgentId,
          kind: 'expired' as const,
          idempotencyKey: `slot-expired:v1:${claim.id}`,
          nextAttemptAt: now,
        }))
      )
      .onConflictDoNothing({ target: slotNotifications.idempotencyKey })
  }

  const [{ count: initialCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(slotClaims)
    .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
  let activeCount = initialCount ?? 0
  let promoted = 0
  let canceled = 0
  let maxGrantLatencyMs = 0

  while (activeCount < pool.capacity) {
    const [waiter] = await tx
      .select()
      .from(slotWaiters)
      .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
      .orderBy(asc(slotWaiters.enqueueSequence), asc(slotWaiters.id))
      .limit(1)
    if (!waiter) break

    // Deliberately non-locking: lifecycle cleanup already follows agent lock -> pool lock.
    // The squads join fences promotion: an archived squad's pool can never grant
    // capacity, even while idempotent pool/state retirement is retrying.
    const [owner] = await tx
      .select({
        squadId: agents.squadId,
        status: agents.status,
        pendingDormancyAt: agents.pendingDormancyAt,
        squadArchivedAt: squads.archivedAt,
      })
      .from(agents)
      .innerJoin(squads, eq(squads.id, agents.squadId))
      .where(eq(agents.id, waiter.ownerAgentId))
    if (owner && owner.squadId === pool.squadId && owner.squadArchivedAt) {
      await tx
        .update(slotWaiters)
        .set({ status: 'canceled', endedAt: now, terminalReason: 'squad_archived' })
        .where(and(eq(slotWaiters.id, waiter.id), eq(slotWaiters.status, 'queued')))
      canceled += 1
      continue
    }
    if (!owner || owner.squadId !== pool.squadId || !isLiveAgentStatus(owner.status) || owner.pendingDormancyAt) {
      await tx
        .update(slotWaiters)
        .set({ status: 'canceled', endedAt: now, terminalReason: 'agent_dormant' })
        .where(and(eq(slotWaiters.id, waiter.id), eq(slotWaiters.status, 'queued')))
      canceled += 1
      continue
    }

    const [claim] = await tx
      .insert(slotClaims)
      .values({
        poolId: pool.id,
        ownerAgentId: waiter.ownerAgentId,
        claimedAt: now,
        expiresAt: new Date(now.getTime() + pool.claimTimeoutMs),
      })
      .returning()
    const transitioned = await tx
      .update(slotWaiters)
      .set({ status: 'granted', resultingClaimId: claim!.id, endedAt: now, terminalReason: 'granted' })
      .where(and(eq(slotWaiters.id, waiter.id), eq(slotWaiters.status, 'queued')))
      .returning({ id: slotWaiters.id })
    if (transitioned.length === 0) throw new Error('Slot waiter changed while its pool was locked')
    await tx
      .insert(slotNotifications)
      .values({
        poolId: pool.id,
        claimId: claim!.id,
        recipientAgentId: waiter.ownerAgentId,
        kind: 'granted',
        idempotencyKey: `slot-grant:v1:${claim!.id}`,
        nextAttemptAt: now,
      })
      .onConflictDoNothing({ target: slotNotifications.idempotencyKey })
    activeCount += 1
    promoted += 1
    maxGrantLatencyMs = Math.max(maxGrantLatencyMs, now.getTime() - waiter.queuedAt.getTime())
  }

  const [queue] = await tx
    .select({ count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${slotWaiters.queuedAt})` })
    .from(slotWaiters)
    .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
  return {
    expired: expired.length,
    promoted,
    canceled,
    activeCount,
    queueDepth: queue?.count ?? 0,
    maxGrantLatencyMs,
    oldestWaiterAgeMs: queue?.oldest ? Math.max(0, now.getTime() - new Date(queue.oldest).getTime()) : 0,
  }
}

function emitSlotSummary(squadId: string, operation: string, promotion: PromotionResult, releasedClaims = 0): void {
  eventEmitter.emit('slots.updated', { squadId })
  log.info('Slot operation summary', {
    squadId,
    operation,
    queueDepth: promotion.queueDepth,
    oldestWaiterAgeMs: promotion.oldestWaiterAgeMs,
    grantCount: promotion.promoted,
    maxGrantLatencyMs: promotion.maxGrantLatencyMs,
    activeCount: promotion.activeCount,
    expiredClaims: promotion.expired,
    releasedClaims,
    timeoutCount: promotion.expired,
    canceledWaiters: promotion.canceled,
  })
}

function mergePromotion(left: PromotionResult, right: PromotionResult): PromotionResult {
  return {
    expired: left.expired + right.expired,
    promoted: left.promoted + right.promoted,
    canceled: left.canceled + right.canceled,
    activeCount: right.activeCount,
    queueDepth: right.queueDepth,
    maxGrantLatencyMs: Math.max(left.maxGrantLatencyMs, right.maxGrantLatencyMs),
    oldestWaiterAgeMs: right.oldestWaiterAgeMs,
  }
}

export async function updatePool(squadId: string, key: string, input: UpdatePoolInput): Promise<SlotPoolRow> {
  if (input.capacity === undefined && input.claimTimeoutMs === undefined) {
    throw new SlotServiceError('invalid_capacity', 'Capacity or claim timeout is required.', 400)
  }
  if (input.capacity !== undefined) validateCapacity(input.capacity)
  if (input.claimTimeoutMs !== undefined) validateTimeout(input.claimTimeoutMs)

  const result = await db.transaction(async (tx): Promise<UpdatePoolTransactionResult> => {
    const pool = await lockActivePool(tx, squadId, key)
    await afterPoolLockHook?.('update')
    const now = await databaseNow(tx, pool.id)
    const [updated] = await tx
      .update(slotPools)
      .set({
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
        ...(input.claimTimeoutMs === undefined ? {} : { claimTimeoutMs: input.claimTimeoutMs }),
        updatedAt: now,
      })
      .where(eq(slotPools.id, pool.id))
      .returning()
    const promotion = await expireAndPromoteLocked(tx, updated!, now)
    return { updated: updated!, promotion }
  })
  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'update', result.promotion)
  return result.updated
}

export async function unregisterPool(squadId: string, key: string): Promise<SlotPoolRow> {
  const result = await db.transaction(async (tx): Promise<UnregisterPoolTransactionResult> => {
    const pool = await lockActivePool(tx, squadId, key)
    await afterPoolLockHook?.('unregister')
    const now = await databaseNow(tx, pool.id)
    const promotion = await expireAndPromoteLocked(tx, pool, now)
    const [claim, waiter] = await Promise.all([
      tx
        .select({ id: slotClaims.id })
        .from(slotClaims)
        .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
        .limit(1),
      tx
        .select({ id: slotWaiters.id })
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
        .limit(1),
    ])
    if (claim.length > 0 || waiter.length > 0) {
      throw new SlotServiceError('pool_busy', `Slot pool "${pool.key}" still has live state.`, 409)
    }
    const [archived] = await tx
      .update(slotPools)
      .set({ unregisteredAt: now, updatedAt: now })
      .where(eq(slotPools.id, pool.id))
      .returning()
    return { archived: archived!, promotion }
  })
  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'unregister', result.promotion)
  return result.archived
}

function claimView(row: typeof slotClaims.$inferSelect, viewer: SlotViewer): SlotClaimView {
  const own = row.ownerAgentId === viewer.agentId
  return {
    ...(own || viewer.diagnostics ? { id: row.id, ownerAgentId: row.ownerAgentId } : {}),
    ownerShortId: row.ownerAgentId.slice(0, 8),
    claimedAt: row.claimedAt,
    expiresAt: row.expiresAt,
  }
}

function waiterView(row: typeof slotWaiters.$inferSelect, viewer: SlotViewer): SlotWaiterView {
  const own = row.ownerAgentId === viewer.agentId
  return {
    ...(own || viewer.diagnostics ? { id: row.id, ownerAgentId: row.ownerAgentId } : {}),
    ownerShortId: row.ownerAgentId.slice(0, 8),
    queuedAt: row.queuedAt,
  }
}

async function projectPool(poolId: string, viewer: SlotViewer): Promise<SlotPoolView | null> {
  return db.transaction(
    async (tx): Promise<SlotPoolView | null> => {
      const [pool] = await tx
        .select()
        .from(slotPools)
        .where(and(eq(slotPools.id, poolId), isNull(slotPools.unregisteredAt)))
      if (!pool) return null
      const [clock] = await tx.execute<{ now: Date }>(sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`)
      if (!clock) throw new Error('Unable to read slot database clock')
      const now = new Date(clock.now)
      const claims = await tx
        .select()
        .from(slotClaims)
        .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active'), gt(slotClaims.expiresAt, now)))
        .orderBy(asc(slotClaims.claimedAt), asc(slotClaims.id))
      await projectionAfterClaimsHook?.()
      const waiters = await tx
        .select()
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
        .orderBy(asc(slotWaiters.enqueueSequence), asc(slotWaiters.id))
      const holders = claims.map((claim) => claimView(claim, viewer))
      const callerClaimRow = viewer.agentId ? claims.find((claim) => claim.ownerAgentId === viewer.agentId) : undefined
      const callerWaiterRow = viewer.agentId
        ? waiters.find((waiter) => waiter.ownerAgentId === viewer.agentId)
        : undefined
      return {
        id: pool.id,
        squadId: pool.squadId,
        key: pool.key,
        capacity: pool.capacity,
        claimTimeoutMs: pool.claimTimeoutMs,
        activeCount: claims.length,
        availableCount: Math.max(0, pool.capacity - claims.length),
        queuedCount: waiters.length,
        holders,
        ...(callerClaimRow ? { callerClaim: claimView(callerClaimRow, viewer) } : {}),
        ...(callerWaiterRow ? { callerWaiter: waiterView(callerWaiterRow, viewer) } : {}),
        oldestWaiterAgeMs: waiters[0] ? Math.max(0, now.getTime() - waiters[0].queuedAt.getTime()) : null,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  )
}

export async function listPools(squadId: string, viewer: SlotViewer): Promise<SlotPoolSummary[]> {
  const pools = await db
    .select()
    .from(slotPools)
    .where(and(eq(slotPools.squadId, squadId), isNull(slotPools.unregisteredAt), liveSquadExists))
    .orderBy(asc(slotPools.key))
  const projected: SlotPoolView[] = []
  // Project sequentially so one listing cannot monopolize the small shared
  // connection pool with one repeatable-read transaction per registered pool.
  for (const pool of pools) {
    const view = await projectPool(pool.id, viewer)
    if (view) projected.push(view)
  }
  return projected
}

export async function getPool(squadId: string, key: string, viewer: SlotViewer): Promise<SlotPoolView> {
  const normalized = validateKey(key)
  const [pool] = await db
    .select()
    .from(slotPools)
    .where(
      and(
        eq(slotPools.squadId, squadId),
        eq(slotPools.key, normalized),
        isNull(slotPools.unregisteredAt),
        liveSquadExists
      )
    )
  if (!pool) throw new SlotServiceError('pool_not_found', `Slot pool "${normalized}" was not found.`, 404)
  const projected = await projectPool(pool.id, viewer)
  if (!projected) throw new SlotServiceError('pool_not_found', `Slot pool "${normalized}" was not found.`, 404)
  return projected
}

async function databaseNow(tx: DbTx, poolId: string): Promise<Date> {
  const [clock] = await tx
    .select({ now: sql<Date>`date_trunc('milliseconds', clock_timestamp())` })
    .from(slotPools)
    .where(eq(slotPools.id, poolId))
  if (!clock) throw new Error('Unable to read slot database clock')
  return new Date(clock.now)
}

async function requireLiveOwner(tx: DbTx, squadId: string, agentId: string): Promise<void> {
  const [agent] = await tx
    .select({ squadId: agents.squadId, status: agents.status, pendingDormancyAt: agents.pendingDormancyAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .for('update')
  if (!agent || agent.squadId !== squadId) {
    throw new SlotServiceError('agent_not_in_squad', 'Agent is not a member of this squad.', 403)
  }
  if (!isLiveAgentStatus(agent.status) || agent.pendingDormancyAt) {
    throw new SlotServiceError('agent_not_live', 'Dormant or terminating agents cannot claim slots.', 409)
  }
}

/**
 * Claim capacity, joining the FIFO queue when none is free.
 *
 * Claim and subscribe were separate round trips: a blocked `claim` told the
 * caller to run `subscribe`, so every contended acquisition cost two commands
 * and a turn in between. Queueing is now the default and `subscribe: false`
 * preserves immediate-only semantics for callers that must not wait.
 */
export async function claimSlot(
  squadId: string,
  key: string,
  agentId: string,
  options: { subscribe?: boolean } = {}
): Promise<SlotAcquireResult> {
  const subscribe = options.subscribe ?? true
  const result = await db.transaction(async (tx): Promise<SlotAcquireTransaction> => {
    await acquireAgentQueueLock(tx, agentId)
    await requireLiveOwner(tx, squadId, agentId)
    const pool = await lockActivePool(tx, squadId, key)
    await afterPoolLockHook?.('claim')
    const now = await databaseNow(tx, pool.id)

    const promotion = await expireAndPromoteLocked(tx, pool, now)

    const [existingClaim] = await tx
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.status, 'active')))
      .limit(1)
    if (existingClaim) return { outcome: 'granted' as const, pool, claim: existingClaim, promotion }

    const [existingWaiter] = await tx
      .select()
      .from(slotWaiters)
      .where(
        and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.ownerAgentId, agentId), eq(slotWaiters.status, 'queued'))
      )
      .limit(1)
    if (existingWaiter) return { outcome: 'queued' as const, pool, waiter: existingWaiter, promotion }

    const [{ count: activeCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
    const [olderWaiter] = await tx
      .select({ id: slotWaiters.id })
      .from(slotWaiters)
      .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
      .limit(1)
    if ((activeCount ?? 0) >= pool.capacity || olderWaiter) {
      if (!subscribe) return { outcome: 'unavailable' as const, pool, promotion }
      const [waiter] = await tx
        .insert(slotWaiters)
        .values({ poolId: pool.id, ownerAgentId: agentId, queuedAt: now })
        .returning()
      return {
        outcome: 'queued' as const,
        pool,
        waiter: waiter!,
        promotion: { ...promotion, queueDepth: promotion.queueDepth + 1 },
      }
    }

    const expiresAt = new Date(now.getTime() + pool.claimTimeoutMs)
    const [claim] = await tx
      .insert(slotClaims)
      .values({ poolId: pool.id, ownerAgentId: agentId, claimedAt: now, expiresAt })
      .returning()
    return {
      outcome: 'granted' as const,
      pool,
      claim: claim!,
      promotion: { ...promotion, activeCount: promotion.activeCount + 1 },
    }
  })

  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'claim', result.promotion)
  const pool = acquirePoolSnapshot(result.pool, result.promotion)
  if (result.outcome === 'granted') {
    return {
      outcome: 'granted',
      message: `Slot claim granted for "${result.pool.key}".`,
      pool,
      claim: { id: result.claim.id, expiresAt: result.claim.expiresAt },
    }
  }
  if (result.outcome === 'queued') {
    return {
      outcome: 'queued',
      message: `No capacity is available for "${result.pool.key}"; you are queued.`,
      pool,
      waiter: { id: result.waiter.id },
    }
  }
  return { outcome: 'unavailable', message: `No capacity is available for "${result.pool.key}".`, pool }
}

export async function subscribeSlot(squadId: string, key: string, agentId: string): Promise<SlotAcquireResult> {
  const result = await db.transaction(async (tx): Promise<SlotSubscribeTransaction> => {
    await acquireAgentQueueLock(tx, agentId)
    await requireLiveOwner(tx, squadId, agentId)
    const pool = await lockActivePool(tx, squadId, key)
    await afterPoolLockHook?.('subscribe')
    const now = await databaseNow(tx, pool.id)
    const promotion = await expireAndPromoteLocked(tx, pool, now)

    const [existingClaim] = await tx
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.status, 'active')))
      .limit(1)
    if (existingClaim) return { outcome: 'granted' as const, pool, claim: existingClaim, promotion }

    const [existingWaiter] = await tx
      .select()
      .from(slotWaiters)
      .where(
        and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.ownerAgentId, agentId), eq(slotWaiters.status, 'queued'))
      )
      .limit(1)
    if (existingWaiter) return { outcome: 'queued' as const, pool, waiter: existingWaiter, promotion }

    const [{ count: activeCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
    if ((activeCount ?? 0) < pool.capacity) {
      const [claim] = await tx
        .insert(slotClaims)
        .values({
          poolId: pool.id,
          ownerAgentId: agentId,
          claimedAt: now,
          expiresAt: new Date(now.getTime() + pool.claimTimeoutMs),
        })
        .returning()
      return {
        outcome: 'granted' as const,
        pool,
        claim: claim!,
        promotion: { ...promotion, activeCount: promotion.activeCount + 1 },
      }
    }

    const [waiter] = await tx
      .insert(slotWaiters)
      .values({ poolId: pool.id, ownerAgentId: agentId, queuedAt: now })
      .returning()
    return {
      outcome: 'queued' as const,
      pool,
      waiter: waiter!,
      promotion: { ...promotion, queueDepth: promotion.queueDepth + 1 },
    }
  })

  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'subscribe', result.promotion)
  const pool = acquirePoolSnapshot(result.pool, result.promotion)
  if (result.outcome === 'granted') {
    return {
      outcome: 'granted',
      message: `Slot claim granted for "${result.pool.key}".`,
      pool,
      claim: { id: result.claim.id, expiresAt: result.claim.expiresAt },
    }
  }
  return {
    outcome: 'queued',
    message: `Waiting for slot pool "${result.pool.key}".`,
    pool,
    waiter: { id: result.waiter.id },
  }
}

export async function releaseSlot(
  squadId: string,
  key: string,
  agentId: string,
  claimId: string
): Promise<SlotReleaseResult> {
  const result = await db.transaction(async (tx): Promise<PromotedOperation<SlotReleaseResult>> => {
    await acquireAgentQueueLock(tx, agentId)
    const [ownedClaim] = await tx
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.id, claimId), eq(slotClaims.ownerAgentId, agentId)))
      .limit(1)
    if (!ownedClaim) throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)

    const [pool] = await tx
      .select()
      .from(slotPools)
      .where(and(eq(slotPools.id, ownedClaim.poolId), liveSquadExists))
      .for('update')
    const normalized = validateKey(key)
    if (!pool || pool.squadId !== squadId || pool.key !== normalized) {
      throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
    }
    await afterPoolLockHook?.('release')
    const now = await databaseNow(tx, pool.id)
    const initialPromotion = await expireAndPromoteLocked(tx, pool, now)
    const [current] = await tx
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.id, claimId), eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.poolId, pool.id)))
    if (!current) throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
    if (current.status === 'expired') {
      return {
        response: { outcome: 'expired' as const, message: 'The slot claim has expired.', claimId },
        promotion: initialPromotion,
      }
    }
    if (current.status === 'released') {
      return {
        response: { outcome: 'already_released' as const, message: 'The slot claim was already released.', claimId },
        promotion: initialPromotion,
      }
    }

    const released = await tx
      .update(slotClaims)
      .set({ status: 'released', endedAt: now, terminalReason: 'released' })
      .where(
        and(
          eq(slotClaims.id, claimId),
          eq(slotClaims.poolId, pool.id),
          eq(slotClaims.ownerAgentId, agentId),
          eq(slotClaims.status, 'active')
        )
      )
      .returning({ id: slotClaims.id })
    await settleInactiveGrantNotifications(
      tx,
      released.map((claim) => claim.id),
      now
    )
    const finalPromotion = await expireAndPromoteLocked(tx, pool, now)
    return {
      response: { outcome: 'released' as const, message: 'The slot claim was released.', claimId },
      promotion: mergePromotion(initialPromotion, finalPromotion),
    }
  })
  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'release', result.promotion, result.response.outcome === 'released' ? 1 : 0)
  return result.response
}

export async function renewSlot(
  squadId: string,
  key: string,
  agentId: string,
  claimId: string
): Promise<SlotRenewResult> {
  const result = await db.transaction(async (tx): Promise<PromotedOperation<SlotRenewResult>> => {
    await acquireAgentQueueLock(tx, agentId)
    await requireLiveOwner(tx, squadId, agentId)
    const [ownedClaim] = await tx
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.id, claimId), eq(slotClaims.ownerAgentId, agentId)))
      .limit(1)
    if (!ownedClaim) throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
    const [pool] = await tx
      .select()
      .from(slotPools)
      .where(and(eq(slotPools.id, ownedClaim.poolId), liveSquadExists))
      .for('update')
    const normalized = validateKey(key)
    if (!pool || pool.squadId !== squadId || pool.key !== normalized) {
      throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
    }
    await afterPoolLockHook?.('renew')
    const now = await databaseNow(tx, pool.id)
    const promotion = await expireAndPromoteLocked(tx, pool, now)
    const [current] = await tx
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.id, claimId), eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.poolId, pool.id)))
    if (!current) throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
    if (current.status === 'expired') {
      return {
        response: {
          outcome: 'expired' as const,
          message: 'The slot claim has expired.',
          claimId,
          expiresAt: current.expiresAt,
        },
        promotion,
      }
    }
    if (current.status === 'released') {
      return {
        response: {
          outcome: 'already_released' as const,
          message: 'The slot claim was already released.',
          claimId,
          expiresAt: current.expiresAt,
        },
        promotion,
      }
    }

    const expiresAt = new Date(now.getTime() + pool.claimTimeoutMs)
    await tx
      .update(slotClaims)
      .set({ expiresAt })
      .where(
        and(
          eq(slotClaims.id, claimId),
          eq(slotClaims.poolId, pool.id),
          eq(slotClaims.ownerAgentId, agentId),
          eq(slotClaims.status, 'active')
        )
      )
    return {
      response: { outcome: 'renewed' as const, message: 'The slot claim was renewed.', claimId, expiresAt },
      promotion,
    }
  })
  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'renew', result.promotion)
  return result.response
}

/**
 * Resolve the squad and pool a claim belongs to, from the claim id alone.
 *
 * Claim and waiter ids are globally unique, so making callers repeat the pool
 * key and squad id on release/renew/unsubscribe was pure ceremony: it could
 * only ever agree with the stored row or produce a confusing mismatch error.
 * The caller's authority is still checked against the squad resolved HERE, so a
 * caller who guesses an id from another squad gets the same 404 as for an id
 * that does not exist, and learns nothing about it.
 */
export async function resolveClaimContext(claimId: string): Promise<SlotResourceContext> {
  const [row] = await db
    .select({ squadId: slotPools.squadId, key: slotPools.key })
    .from(slotClaims)
    .innerJoin(slotPools, eq(slotPools.id, slotClaims.poolId))
    .where(eq(slotClaims.id, claimId))
    .limit(1)
  if (!row) throw new SlotServiceError('claim_not_found', 'Slot claim was not found.', 404)
  return row
}

/** {@link resolveClaimContext} for waiters. */
export async function resolveWaiterContext(waiterId: string): Promise<SlotResourceContext> {
  const [row] = await db
    .select({ squadId: slotPools.squadId, key: slotPools.key })
    .from(slotWaiters)
    .innerJoin(slotPools, eq(slotPools.id, slotWaiters.poolId))
    .where(eq(slotWaiters.id, waiterId))
    .limit(1)
  if (!row) throw new SlotServiceError('waiter_not_found', 'Slot waiter was not found.', 404)
  return row
}

export async function unsubscribeSlot(
  squadId: string,
  key: string,
  agentId: string,
  waiterId: string
): Promise<SlotUnsubscribeResult> {
  const result = await db.transaction(async (tx): Promise<PromotedOperation<SlotUnsubscribeResult>> => {
    await acquireAgentQueueLock(tx, agentId)
    const [ownedWaiter] = await tx
      .select()
      .from(slotWaiters)
      .where(and(eq(slotWaiters.id, waiterId), eq(slotWaiters.ownerAgentId, agentId)))
      .limit(1)
    if (!ownedWaiter) throw new SlotServiceError('waiter_not_found', 'Slot waiter was not found.', 404)
    const [pool] = await tx
      .select()
      .from(slotPools)
      .where(and(eq(slotPools.id, ownedWaiter.poolId), liveSquadExists))
      .for('update')
    const normalized = validateKey(key)
    if (!pool || pool.squadId !== squadId || pool.key !== normalized) {
      throw new SlotServiceError('waiter_not_found', 'Slot waiter was not found.', 404)
    }
    await afterPoolLockHook?.('unsubscribe')
    const now = await databaseNow(tx, pool.id)
    const promotion = await expireAndPromoteLocked(tx, pool, now)
    const [current] = await tx
      .select()
      .from(slotWaiters)
      .where(and(eq(slotWaiters.id, waiterId), eq(slotWaiters.ownerAgentId, agentId), eq(slotWaiters.poolId, pool.id)))
    if (!current) throw new SlotServiceError('waiter_not_found', 'Slot waiter was not found.', 404)
    if (current.resultingClaimId) {
      // Report the claim's LIVE state. A granted waiter whose claim has since
      // been released or expired owes nothing, and telling the caller they still
      // hold capacity sends them to release a claim that no longer exists.
      const [grantedClaim] = await tx
        .select({ status: slotClaims.status })
        .from(slotClaims)
        .where(eq(slotClaims.id, current.resultingClaimId))
        .limit(1)
      const claimStatus: SlotGrantedClaimStatus = grantedClaim?.status ?? 'released'
      return {
        response: {
          outcome: 'already_granted' as const,
          message:
            claimStatus === 'active'
              ? 'The waiter was already granted; release its claim explicitly.'
              : `The waiter was already granted and its claim is ${claimStatus}; nothing to release.`,
          waiterId,
          claimId: current.resultingClaimId,
          claimStatus,
        },
        promotion,
      }
    }
    if (current.status === 'canceled') {
      return {
        response: { outcome: 'canceled' as const, message: 'The slot waiter was already canceled.', waiterId },
        promotion,
      }
    }

    await tx
      .update(slotWaiters)
      .set({ status: 'canceled', endedAt: now, terminalReason: 'canceled' })
      .where(
        and(
          eq(slotWaiters.id, waiterId),
          eq(slotWaiters.poolId, pool.id),
          eq(slotWaiters.ownerAgentId, agentId),
          eq(slotWaiters.status, 'queued')
        )
      )
    const finalPromotion = await expireAndPromoteLocked(tx, pool, now)
    return {
      response: { outcome: 'canceled' as const, message: 'The slot waiter was canceled.', waiterId },
      promotion: mergePromotion(promotion, finalPromotion),
    }
  })
  drainSlotOutboxIfGranted(result.promotion)
  emitSlotSummary(squadId, 'unsubscribe', result.promotion)
  return result.response
}

export async function discoverAgentSlotPoolIds(tx: DbTx, agentId: string): Promise<string[]> {
  // One PostgreSQL statement gives both sides the same READ COMMITTED snapshot.
  // A concurrent queued -> granted transition therefore leaves either the old
  // waiter or the new claim discoverable.
  const affectedPools = await tx.execute<{ poolId: string }>(sql`
    SELECT pool_id AS "poolId"
    FROM slot_claims
    WHERE owner_agent_id = ${agentId} AND status = 'active'
    UNION
    SELECT pool_id AS "poolId"
    FROM slot_waiters
    WHERE owner_agent_id = ${agentId} AND status = 'queued'
  `)
  return affectedPools.map((row) => row.poolId).sort()
}

export interface AgentSlotCleanupSummary {
  released: number
  canceled: number
  promoted: number
}

export async function cleanupAgentSlotsInTransaction(
  tx: DbTx,
  agentId: string,
  reason: 'agent_dormant' | 'pool_cleanup'
): Promise<AgentSlotCleanupSummary> {
  const poolIds = await discoverAgentSlotPoolIds(tx, agentId)
  await cleanupAfterDiscoveryHook?.()
  const summary: AgentSlotCleanupSummary = { released: 0, canceled: 0, promoted: 0 }
  for (const poolId of poolIds) {
    const [pool] = await tx.select().from(slotPools).where(eq(slotPools.id, poolId)).for('update')
    if (!pool) continue
    const now = await databaseNow(tx, pool.id)
    const released = await tx
      .update(slotClaims)
      .set({ status: 'released', endedAt: now, terminalReason: reason })
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.status, 'active')))
      .returning({ id: slotClaims.id })
    await settleInactiveGrantNotifications(
      tx,
      released.map((claim) => claim.id),
      now
    )
    await tx
      .update(slotWaiters)
      .set({ status: 'canceled', endedAt: now, terminalReason: reason })
      .where(
        and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.ownerAgentId, agentId), eq(slotWaiters.status, 'queued'))
      )
    const promotion = await expireAndPromoteLocked(tx, pool, now)
    summary.released += released.length
    summary.promoted += promotion.promoted
    summary.canceled += promotion.canceled
  }
  return summary
}

export interface SquadSlotRetirementSummary {
  poolsRetired: number
  claimsReleased: number
  waitersCanceled: number
}

/**
 * Durably and idempotently retire every slot pool of a squad inside the
 * caller's archival transaction: active claims are released, queued waiters
 * canceled, undelivered grant notices settled (never delivered), and pools
 * unregistered. Deliberately performs no promotion and enqueues no new
 * notifications — an archived squad must stop granting and notifying.
 *
 * Lock ordering: only pool rows are locked here (agent locks are never taken),
 * which cannot cycle with the agent-lock -> pool-lock order every other slot
 * writer follows. Status guards make re-runs exactly-once no-ops.
 */
export async function retireSquadSlotStateInTransaction(
  tx: DbTx,
  squadId: string,
  now: Date
): Promise<SquadSlotRetirementSummary> {
  const pools = await tx
    .select()
    .from(slotPools)
    .where(eq(slotPools.squadId, squadId))
    .orderBy(asc(slotPools.id))
    .for('update')
  const summary: SquadSlotRetirementSummary = { poolsRetired: 0, claimsReleased: 0, waitersCanceled: 0 }
  for (const pool of pools) {
    const released = await tx
      .update(slotClaims)
      .set({ status: 'released', endedAt: now, terminalReason: 'squad_archived' })
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
      .returning({ id: slotClaims.id })
    await settleInactiveGrantNotifications(
      tx,
      released.map((claim) => claim.id),
      now
    )
    const canceled = await tx
      .update(slotWaiters)
      .set({ status: 'canceled', endedAt: now, terminalReason: 'squad_archived' })
      .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
      .returning({ id: slotWaiters.id })
    const retired = await tx
      .update(slotPools)
      .set({ unregisteredAt: now, updatedAt: now })
      .where(and(eq(slotPools.id, pool.id), isNull(slotPools.unregisteredAt)))
      .returning({ id: slotPools.id })
    summary.claimsReleased += released.length
    summary.waitersCanceled += canceled.length
    summary.poolsRetired += retired.length
  }
  return summary
}
