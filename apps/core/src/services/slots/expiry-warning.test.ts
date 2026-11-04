import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { agents, db, executions, inbox, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { queueSlotExpiryWarnings, renderSlotNotification, SlotNotificationNotifier } from './notifications'
import { reconcileSlotsOnce } from './reconciliation'
import { claimSlot, registerPool, releaseSlot, renewSlot, setSlotPromptDrainEnabledForTest } from './store'

beforeAll(() => setSlotPromptDrainEnabledForTest(false))
afterAll(() => setSlotPromptDrainEnabledForTest(true))

const squadIds: string[] = []
const agentIds: string[] = []
const MINUTE = 60_000

afterEach(async () => {
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

async function createHeldClaim(claimTimeoutMs = 60 * MINUTE) {
  const squad = await Squad.create({ name: `slot-expiry-warning-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test', claimTimeoutMs })
  const [holder] = await db
    .insert(agents)
    .values({ agentTypeId: 'slot-expiry-warning-test', squadId: squad.id })
    .returning()
  agentIds.push(holder!.id)
  const claim = await claimSlot(squad.id, 'tests', holder!.id)
  if (claim.outcome !== 'granted') throw new Error('bad fixture')
  return { squad, pool, holder: holder!, claimId: claim.claim.id! }
}

/** Move the claim's expiry relative to the database clock's present. */
async function expireIn(claimId: string, ms: number): Promise<Date> {
  const expiresAt = new Date(Date.now() + ms)
  await db.update(slotClaims).set({ expiresAt }).where(eq(slotClaims.id, claimId))
  return expiresAt
}

async function warnings(claimId: string) {
  return db
    .select()
    .from(slotNotifications)
    .where(and(eq(slotNotifications.claimId, claimId), eq(slotNotifications.kind, 'expiring')))
    .orderBy(slotNotifications.createdAt)
}

async function drain(notificationId: string) {
  return new SlotNotificationNotifier().drain({ now: new Date(), notificationId })
}

test('a claim is warned only once it is within ten minutes of expiry', async () => {
  const { claimId } = await createHeldClaim()

  await queueSlotExpiryWarnings()
  expect(await warnings(claimId)).toHaveLength(0)

  await expireIn(claimId, 11 * MINUTE)
  await queueSlotExpiryWarnings()
  expect(await warnings(claimId)).toHaveLength(0)

  const expiresAt = await expireIn(claimId, 9 * MINUTE)
  await queueSlotExpiryWarnings()
  const [warning] = await warnings(claimId)
  expect(warning).toMatchObject({ status: 'pending', claimExpiresAt: expiresAt })
})

test('a short claim timeout is warned at a quarter of the timeout', async () => {
  const { claimId } = await createHeldClaim(4 * MINUTE)

  await expireIn(claimId, 90_000)
  await queueSlotExpiryWarnings()
  expect(await warnings(claimId)).toHaveLength(0)

  await expireIn(claimId, 50_000)
  await queueSlotExpiryWarnings()
  expect(await warnings(claimId)).toHaveLength(1)
})

test('the sweep delivers exactly one wake-eligible warning per expiry window', async () => {
  const { holder, claimId } = await createHeldClaim()
  const expiresAt = await expireIn(claimId, 5 * MINUTE)

  await reconcileSlotsOnce()
  await reconcileSlotsOnce()
  await queueSlotExpiryWarnings()

  const rows = await warnings(claimId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ status: 'delivered', lastErrorCode: null })
  const messages = await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))
  expect(messages).toHaveLength(1)
  expect(messages[0]!.subject).toBe('Slot expiring soon: tests (renew or release)')
  expect(messages[0]!.metadata).toMatchObject({ source: 'slot', claimId, wakeEligible: true })
  expect(messages[0]!.content).toContain(`expires at ${expiresAt.toISOString()}`)
  expect(messages[0]!.content).toContain(`ficus slot renew ${claimId}`)
  expect(messages[0]!.content).toContain(`ficus slot release ${claimId}`)
  expect(messages[0]!.content).toContain('slot pool "tests"')
})

test('renewing after a warning opens a new window that is warned again', async () => {
  const { squad, holder, claimId } = await createHeldClaim()
  await expireIn(claimId, 5 * MINUTE)
  await queueSlotExpiryWarnings()
  const [first] = await warnings(claimId)
  await drain(first!.id)

  const renewed = await renewSlot(squad.id, 'tests', holder.id, claimId)
  expect(renewed.outcome).toBe('renewed')
  await queueSlotExpiryWarnings()
  expect(await warnings(claimId)).toHaveLength(1)

  const nextExpiry = await expireIn(claimId, 3 * MINUTE)
  await queueSlotExpiryWarnings()
  const rows = await warnings(claimId)
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({ status: 'pending', claimExpiresAt: nextExpiry })
  await drain(rows[1]!.id)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))).toHaveLength(2)
})

test('a renewal before delivery drops the stale warning without sending it', async () => {
  const { squad, holder, claimId } = await createHeldClaim()
  await expireIn(claimId, 5 * MINUTE)
  await queueSlotExpiryWarnings()
  const [pending] = await warnings(claimId)

  await renewSlot(squad.id, 'tests', holder.id, claimId)
  await drain(pending!.id)

  expect((await warnings(claimId))[0]).toMatchObject({ status: 'delivered', lastErrorCode: 'claim_renewed' })
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))).toHaveLength(0)
})

test('released and already expired claims are never warned', async () => {
  const released = await createHeldClaim()
  await expireIn(released.claimId, 5 * MINUTE)
  await releaseSlot(released.squad.id, 'tests', released.holder.id, released.claimId)

  const lapsed = await createHeldClaim()
  await expireIn(lapsed.claimId, -MINUTE)

  await queueSlotExpiryWarnings()
  expect(await warnings(released.claimId)).toHaveLength(0)
  expect(await warnings(lapsed.claimId)).toHaveLength(0)
})

test('releasing a claim settles its undelivered warning without sending it', async () => {
  const { squad, holder, claimId } = await createHeldClaim()
  await expireIn(claimId, 5 * MINUTE)
  await queueSlotExpiryWarnings()
  const [pending] = await warnings(claimId)

  await releaseSlot(squad.id, 'tests', holder.id, claimId)
  expect((await warnings(claimId))[0]).toMatchObject({ status: 'delivered', lastErrorCode: 'claim_inactive' })
  await drain(pending!.id)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))).toHaveLength(0)
})

test('warning text names the pool, claim and exact renew and release commands', () => {
  const expiresAt = new Date('2026-11-04T19:00:00.000Z')
  const text = renderSlotNotification({
    notificationId: 'n',
    poolId: 'p',
    poolKey: 'production-change',
    squadId: 's',
    claimId: 'claim-1',
    waiterId: null,
    recipientAgentId: 'a',
    kind: 'expiring',
    idempotencyKey: 'k',
    claimToken: 't',
    attempts: 1,
    expiresAt,
  })
  expect(text).toBe(
    [
      'Your claim claim-1 on slot pool "production-change" expires at 2026-11-04T19:00:00.000Z.',
      'If you still need it, renew it now: ficus slot renew claim-1',
      'If the protected work is finished, release it now: ficus slot release claim-1',
      'If it expires, the capacity is freed but nothing you started under it is stopped: you would have to clean up and claim again.',
    ].join('\n')
  )
})
