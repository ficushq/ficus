import { eventEmitter } from '../../lib/infra/event-emitter'
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, db, executions, inbox, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { makeDormant, setDormancyEffectHookForTest } from '../agent/lifecycle'
import {
  claimSlot,
  registerPool,
  releaseSlot,
  setSlotPromptDrainEnabledForTest,
  subscribeSlot,
  updatePool,
} from './store'
import { reconcileSlotsOnce } from './reconciliation'

// Keep drain timing deterministic: reconciliation owns its own inline drain.
beforeAll(() => setSlotPromptDrainEnabledForTest(false))
afterAll(() => setSlotPromptDrainEnabledForTest(true))

const squadIds: string[] = []
const agentIds: string[] = []
let unsubscribeSlots: (() => void) | undefined

afterEach(async () => {
  unsubscribeSlots?.()
  unsubscribeSlots = undefined
  setSystemTime()
  setDormancyEffectHookForTest(undefined)
  const poolIds =
    squadIds.length === 0
      ? []
      : (await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))).map(
          (row) => row.id
        )
  if (poolIds.length > 0) {
    await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
    await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
  }
  if (agentIds.length > 0) {
    await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
    await db.delete(executions).where(inArray(executions.agentId, agentIds))
    await db.delete(agents).where(inArray(agents.id, agentIds))
  }
  if (squadIds.length > 0) await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

async function createAgents(squadId: string, count: number) {
  const rows = await db
    .insert(agents)
    .values(Array.from({ length: count }, () => ({ agentTypeId: 'slot-reconcile-test', squadId })))
    .returning()
  agentIds.push(...rows.map((row) => row.id))
  return rows
}

test('pending termination preserves capacity until dormant CAS then promotes exactly once', async () => {
  setDormancyEffectHookForTest(async () => {})
  const squad = await Squad.create({ name: `slot-reconcile-pending-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [holder, successor] = await createAgents(squad.id, 2)
  const held = await claimSlot(squad.id, 'tests', holder!.id)
  const queued = await subscribeSlot(squad.id, 'tests', successor!.id)
  if (held.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
  const [execution] = await db.insert(executions).values({ agentId: holder!.id, status: 'running' }).returning()
  const projectedHolder = new Agent(holder!)
  const events: string[] = []
  unsubscribeSlots = eventEmitter.on('slots.updated', (data) => {
    if (data.squadId === squad.id) events.push(data.squadId)
  })

  await makeDormant(projectedHolder)
  expect((await Agent.mustFind(holder!.id)).status).not.toBe('dormant')
  expect((await Agent.mustFind(holder!.id)).pendingDormancyAt).not.toBeNull()
  await expect(reconcileSlotsOnce()).resolves.toMatchObject({ poolsProcessed: 0, activeCount: 1, queueDepth: 1 })
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(
        and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, holder!.id), eq(slotClaims.status, 'active'))
      )
  ).toHaveLength(1)

  await db.update(executions).set({ status: 'completed', endedAt: new Date() }).where(eq(executions.id, execution!.id))
  await projectedHolder.reload()
  await makeDormant(projectedHolder)
  await reconcileSlotsOnce()
  await reconcileSlotsOnce()

  expect((await Agent.mustFind(holder!.id)).status).toBe('dormant')
  expect(events).toEqual([squad.id])
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(
        and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, successor!.id), eq(slotClaims.status, 'active'))
      )
  ).toHaveLength(1)
  expect(
    await db
      .select()
      .from(slotNotifications)
      .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'granted')))
  ).toHaveLength(1)
})

test('reconciliation inventory includes healthy non-candidate pools', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-inventory-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [holder, waiter] = await createAgents(squad.id, 2)
  await claimSlot(squad.id, 'tests', holder!.id)
  await subscribeSlot(squad.id, 'tests', waiter!.id)

  await expect(reconcileSlotsOnce()).resolves.toMatchObject({
    poolsProcessed: 0,
    activeCount: 1,
    queueDepth: 1,
  })
})

test('reconciliation discovers DB-overdue claims despite a skewed Core clock', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-skew-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [owner] = await createAgents(squad.id, 1)
  const granted = await claimSlot(squad.id, 'tests', owner!.id)
  if (granted.outcome !== 'granted') throw new Error('bad fixture')
  await db
    .update(slotClaims)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(slotClaims.id, granted.claim.id!))
  setSystemTime(new Date('2000-01-01T00:00:00Z'))

  await expect(reconcileSlotsOnce()).resolves.toMatchObject({
    poolsProcessed: 1,
    expiredClaims: 1,
    timeoutCount: 1,
  })
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
  ).toHaveLength(0)
})

test('reconciliation cancels dormant waiters without disturbing a live holder', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-waiter-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [holder, waiter] = await createAgents(squad.id, 2)
  await claimSlot(squad.id, 'tests', holder!.id)
  const queued = await subscribeSlot(squad.id, 'tests', waiter!.id)
  if (queued.outcome !== 'queued') throw new Error('bad fixture')
  await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, waiter!.id))

  await expect(reconcileSlotsOnce()).resolves.toMatchObject({
    poolsProcessed: 1,
    canceledWaiters: 1,
    repairedOwners: 1,
    activeCount: 1,
  })
  expect((await db.select().from(slotWaiters).where(eq(slotWaiters.id, queued.waiter.id!)))[0]).toMatchObject({
    status: 'canceled',
    terminalReason: 'pool_cleanup',
  })
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
  ).toHaveLength(1)
})

test('notification retry age is measured from durable creation, not the moving backoff deadline', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-retry-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [owner] = await createAgents(squad.id, 1)
  const granted = await claimSlot(squad.id, 'tests', owner!.id)
  if (granted.outcome !== 'granted') throw new Error('bad fixture')
  await db.insert(slotNotifications).values({
    poolId: pool.id,
    claimId: granted.claim.id!,
    recipientAgentId: owner!.id,
    kind: 'granted',
    idempotencyKey: `retry-age:${granted.claim.id}`,
    status: 'pending',
    attempts: 2,
    createdAt: sql`clock_timestamp() - interval '10 minutes'`,
    nextAttemptAt: sql`clock_timestamp() + interval '10 minutes'`,
  })

  const summary = await reconcileSlotsOnce()
  expect(summary.oldestNotificationRetryAgeMs).toBeGreaterThanOrEqual(9 * 60_000)
  expect(summary.deliveryRetries).toBe(0)
})

test('reconciliation repairs dormant ownership, promotes once, and is idempotent', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [holder, successor] = await createAgents(squad.id, 2)
  await claimSlot(squad.id, 'tests', holder!.id)
  await subscribeSlot(squad.id, 'tests', successor!.id)
  await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, holder!.id))

  const first = await reconcileSlotsOnce()
  const second = await reconcileSlotsOnce()

  expect(first).toMatchObject({ poolsProcessed: 1, releasedClaims: 1, promotedClaims: 1, repairedOwners: 1 })
  expect(second.poolsProcessed).toBe(0)
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(
        and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, successor!.id), eq(slotClaims.status, 'active'))
      )
  ).toHaveLength(1)
  expect(
    await db
      .select()
      .from(slotNotifications)
      .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'granted')))
  ).toHaveLength(1)
})

test('reconciliation settlement: repairing an ineligible owner settles its undelivered grant directly', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-settle-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [holder] = await createAgents(squad.id, 1)
  const claim = await claimSlot(squad.id, 'tests', holder!.id)
  if (claim.outcome !== 'granted') throw new Error('bad fixture')
  // Future-dated retry so no drain — including reconciliation's own — can mask
  // the store-side fence under test: only the repair itself settles the row.
  const [notification] = await db
    .insert(slotNotifications)
    .values({
      poolId: pool.id,
      claimId: claim.claim.id!,
      recipientAgentId: holder!.id,
      kind: 'granted',
      idempotencyKey: `reconcile-settle:${claim.claim.id}`,
      nextAttemptAt: new Date(Date.now() + 60_000),
    })
    .returning()
  await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, holder!.id))

  const summary = await reconcileSlotsOnce()

  expect(summary.releasedClaims).toBeGreaterThanOrEqual(1)
  expect((await db.select().from(slotClaims).where(eq(slotClaims.id, claim.claim.id!)))[0]).toMatchObject({
    status: 'released',
    terminalReason: 'pool_cleanup',
  })
  expect(
    (await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification!.id)))[0]
  ).toMatchObject({ status: 'delivered', lastErrorCode: 'claim_inactive', claimToken: null })
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, holder!.id))).toHaveLength(0)
})

async function expireClaimInDatabase(claimId: string) {
  await db
    .update(slotClaims)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(slotClaims.id, claimId))
}

test('a timed-out claim reminds its owner exactly once to clean up heavy work', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-reminder-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'shared-box-intensive', createdBy: 'test' })
  const [owner] = await createAgents(squad.id, 1)
  const granted = await claimSlot(squad.id, 'shared-box-intensive', owner!.id)
  if (granted.outcome !== 'granted') throw new Error('bad fixture')
  await expireClaimInDatabase(granted.claim.id!)

  // Reconciliation reruns (and its drain retries) must never duplicate the reminder.
  await expect(reconcileSlotsOnce()).resolves.toMatchObject({ expiredClaims: 1 })
  await reconcileSlotsOnce()
  await reconcileSlotsOnce()

  const [claim] = await db.select().from(slotClaims).where(eq(slotClaims.id, granted.claim.id!))
  expect(claim).toMatchObject({ status: 'expired', terminalReason: 'timed_out' })
  const messages = await db.select().from(inbox).where(eq(inbox.recipientId, owner!.id))
  expect(messages).toHaveLength(1)
  const content = messages[0]!.content
  expect(content).toContain(granted.claim.id!)
  expect(content).toContain('"shared-box-intensive"')
  expect(content).toContain(`expired at ${claim!.expiresAt.toISOString()}`)
  expect(content).toContain('not released or renewed')
  expect(content).toContain('test:db:down')
  expect(content).toContain('docker')
  expect(content).toContain('background jobs')
  expect(content).toContain(`ficus slot claim shared-box-intensive --squad ${squad.id}`)
  expect(content).toContain('ficus slot release')
  expect(messages[0]!.deliveryMode).toBe('steer')
  expect(
    await db
      .select()
      .from(slotNotifications)
      .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'expired')))
  ).toMatchObject([{ status: 'delivered', inboxId: messages[0]!.id }])
})

test('a released claim gets no expiry reminder', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-released-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [owner] = await createAgents(squad.id, 1)
  const granted = await claimSlot(squad.id, 'tests', owner!.id)
  if (granted.outcome !== 'granted') throw new Error('bad fixture')
  await expect(releaseSlot(squad.id, 'tests', owner!.id, granted.claim.id!)).resolves.toMatchObject({
    outcome: 'released',
  })
  await expireClaimInDatabase(granted.claim.id!)

  await reconcileSlotsOnce()
  await reconcileSlotsOnce()

  expect(
    await db
      .select()
      .from(slotNotifications)
      .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'expired')))
  ).toHaveLength(0)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, owner!.id))).toHaveLength(0)
})

test('an expired claim whose owner no longer exists settles its reminder without sending', async () => {
  const squad = await Squad.create({ name: `slot-reconcile-gone-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const [missing, terminated, next] = await createAgents(squad.id, 3)
  await updatePool(squad.id, 'tests', { capacity: 3 })
  const missingClaim = await claimSlot(squad.id, 'tests', missing!.id)
  const terminatedClaim = await claimSlot(squad.id, 'tests', terminated!.id)
  if (missingClaim.outcome !== 'granted' || terminatedClaim.outcome !== 'granted') throw new Error('bad fixture')
  await expireClaimInDatabase(missingClaim.claim.id!)
  await expireClaimInDatabase(terminatedClaim.claim.id!)
  await db.delete(agents).where(eq(agents.id, missing!.id))
  await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, terminated!.id))

  // A live acquisition expires both claims before reconciliation repairs owners.
  await expect(claimSlot(squad.id, 'tests', next!.id)).resolves.toMatchObject({ outcome: 'granted' })
  await reconcileSlotsOnce()
  await reconcileSlotsOnce()

  const reminders = await db
    .select()
    .from(slotNotifications)
    .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'expired')))
  expect(reminders.map((row) => [row.recipientAgentId, row.status, row.lastErrorCode, row.inboxId]).toSorted()).toEqual(
    [
      [missing!.id, 'delivered', 'recipient_missing', null],
      [terminated!.id, 'delivered', 'recipient_terminated', null],
    ].toSorted()
  )
  expect(
    await db
      .select()
      .from(inbox)
      .where(inArray(inbox.recipientId, [missing!.id, terminated!.id]))
  ).toHaveLength(0)
})
