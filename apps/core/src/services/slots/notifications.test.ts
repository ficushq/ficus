import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, db, executions, inbox, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import {
  claimSlot,
  cleanupAgentSlotsInTransaction,
  registerPool,
  releaseSlot,
  setSlotPromptDrainEnabledForTest,
  subscribeSlot,
} from './store'
import { renderSlotNotification, slotNotificationNotifier, SlotNotificationNotifier } from './notifications'

const squadIds: string[] = []
const agentIds: string[] = []

// Outbox-state assertions stay deterministic: the prompt drain stays off except
// in the tests that explicitly exercise it.
beforeAll(() => setSlotPromptDrainEnabledForTest(false))
afterAll(() => setSlotPromptDrainEnabledForTest(true))

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

async function createContestedFixture() {
  const squad = await Squad.create({ name: `slot-notice-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: 'slot-notice-test', squadId: squad.id },
      { agentTypeId: 'slot-notice-test', squadId: squad.id },
    ])
    .returning()
  agentIds.push(...rows.map((row) => row.id))
  const holder = rows[0]!
  const waiter = rows[1]!
  const claim = await claimSlot(squad.id, 'tests', holder.id)
  const queued = await subscribeSlot(squad.id, 'tests', waiter.id)
  if (claim.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
  return { squad, holder, waiter, pool, claim }
}

async function createFixture() {
  const { squad, holder, waiter, pool, claim } = await createContestedFixture()
  await releaseSlot(squad.id, 'tests', holder.id, claim.claim.id!)
  const [notification] = await db.select().from(slotNotifications).where(eq(slotNotifications.poolId, pool.id))
  return { squad, holder, waiter, pool, notification: notification! }
}

test('promotion commits its outbox row before inbox delivery and drains once', async () => {
  const { waiter, pool, notification } = await createFixture()
  expect(await db.select().from(slotNotifications).where(eq(slotNotifications.poolId, pool.id))).toHaveLength(1)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(0)

  const notifier = new SlotNotificationNotifier()
  await notifier.drain({ now: notification!.nextAttemptAt, notificationId: notification.id })
  await notifier.drain({
    now: new Date(notification.nextAttemptAt.getTime() + 120_000),
    notificationId: notification.id,
  })

  const messages = await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))
  expect(messages).toHaveLength(1)
  expect(messages[0]!.content).toContain('YOU MUST RELEASE THIS CLAIM AS SOON AS YOU ARE DONE.')
  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]).toMatchObject(
    {
      status: 'delivered',
    }
  )
})

test('cleanup atomically settles a stale grant notice for the revoked claim', async () => {
  const { waiter, notification } = await createFixture()
  await db.transaction(async (tx) => {
    await cleanupAgentSlotsInTransaction(tx, waiter.id, 'agent_dormant')
  })

  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]).toMatchObject(
    {
      status: 'delivered',
      lastErrorCode: 'claim_inactive',
      claimToken: null,
    }
  )
  await new SlotNotificationNotifier().drain({ now: notification!.nextAttemptAt, notificationId: notification.id })
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(0)
})

test('delivery revalidates claim status and settles stale grants without sending', async () => {
  const { waiter, notification } = await createFixture()
  await db
    .update(slotClaims)
    .set({ status: 'released', endedAt: new Date(), terminalReason: 'released' })
    .where(eq(slotClaims.id, notification.claimId))

  await new SlotNotificationNotifier().drain({ now: notification!.nextAttemptAt, notificationId: notification.id })

  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]).toMatchObject(
    {
      status: 'delivered',
      lastErrorCode: 'claim_inactive',
    }
  )
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(0)
})

test('terminated and missing recipients settle terminally instead of retrying', async () => {
  const { waiter, notification } = await createFixture()
  await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, waiter.id))
  await new SlotNotificationNotifier().drain({ now: notification!.nextAttemptAt, notificationId: notification.id })
  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]).toMatchObject(
    {
      status: 'delivered',
      lastErrorCode: 'recipient_terminated',
    }
  )

  const [missing] = await db
    .insert(slotNotifications)
    .values({
      poolId: notification.poolId,
      claimId: notification.claimId,
      recipientAgentId: crypto.randomUUID(),
      kind: 'granted',
      idempotencyKey: `missing:${notification.claimId}`,
      nextAttemptAt: new Date(0),
    })
    .returning()
  await new SlotNotificationNotifier().drain({ now: notification!.nextAttemptAt, notificationId: missing!.id })
  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, missing!.id)))[0]).toMatchObject({
    status: 'delivered',
    lastErrorCode: 'recipient_missing',
  })
})

test('two drainers claim a due notification at most once', async () => {
  const { waiter, notification } = await createFixture()
  const now = notification.nextAttemptAt
  const results = await Promise.all([
    new SlotNotificationNotifier().drain({ now, notificationId: notification.id }),
    new SlotNotificationNotifier().drain({ now, notificationId: notification.id }),
  ])

  expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(1)
})

test('notifier outage retains the row with bounded backoff and later recovers it', async () => {
  const { waiter, notification } = await createFixture()
  const now = notification.nextAttemptAt
  const unavailable = new SlotNotificationNotifier({
    sendOnce: async () => {
      throw new Error('notifier unavailable')
    },
  })
  await expect(unavailable.drain({ now, notificationId: notification.id })).resolves.toMatchObject({
    claimed: 1,
    delivered: 0,
  })
  const [pending] = await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id))
  expect(pending).toMatchObject({ status: 'pending', attempts: 1 })
  expect(pending!.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime())
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(0)

  await expect(
    new SlotNotificationNotifier().drain({
      now: new Date(now.getTime() + 61_000),
      notificationId: notification.id,
    })
  ).resolves.toMatchObject({ claimed: 1, delivered: 1, deliveryRetries: 1 })
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(1)
})

test('a crash after sendOnce is recovered without duplicating the durable inbox winner', async () => {
  const { waiter, notification } = await createFixture()
  const crashing = new SlotNotificationNotifier({
    afterSendOnce: async () => {
      throw new Error('injected crash')
    },
  })
  await expect(crashing.drain({ now: notification!.nextAttemptAt, notificationId: notification.id })).rejects.toThrow(
    'injected crash'
  )
  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]).toMatchObject(
    {
      status: 'delivering',
      attempts: 1,
    }
  )

  await new SlotNotificationNotifier().drain({
    now: new Date(notification.nextAttemptAt.getTime() + 120_000),
    notificationId: notification.id,
  })

  expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(1)
  expect((await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]).toMatchObject(
    {
      status: 'delivered',
      attempts: 2,
    }
  )
})

test('expiry text states that ownership is invalid without claiming external work stopped', async () => {
  const { notification } = await createFixture()
  const [claim] = await db.select().from(slotClaims).where(eq(slotClaims.id, notification.claimId))
  const text = renderSlotNotification({
    notificationId: notification.id,
    poolId: notification.poolId,
    poolKey: 'tests',
    squadId: crypto.randomUUID(),
    claimId: notification.claimId,
    recipientAgentId: notification.recipientAgentId,
    kind: 'expired',
    idempotencyKey: notification.idempotencyKey,
    claimToken: crypto.randomUUID(),
    attempts: 1,
    expiresAt: claim!.expiresAt,
  })
  expect(text).toContain(`expired at ${claim!.expiresAt.toISOString()}`)
  expect(text).toContain('You no longer hold this capacity')
  expect(text).toContain('Tau did not stop any work you started under this claim')
})

test('grant text gives the release and renew commands the CLI accepts', async () => {
  const { notification } = await createFixture()
  const [claim] = await db.select().from(slotClaims).where(eq(slotClaims.id, notification.claimId))
  const text = renderSlotNotification({
    notificationId: notification.id,
    poolId: notification.poolId,
    poolKey: 'tests',
    squadId: crypto.randomUUID(),
    claimId: notification.claimId,
    recipientAgentId: notification.recipientAgentId,
    kind: 'granted',
    idempotencyKey: notification.idempotencyKey,
    claimToken: crypto.randomUUID(),
    attempts: 1,
    expiresAt: claim!.expiresAt,
  })
  // `ficus slot release|renew <claim-id>`: the pool and squad are not arguments.
  expect(text).toContain(`Release: ficus slot release ${notification.claimId}\n`)
  expect(text).toMatch(new RegExp(`Renew: ficus slot renew ${notification.claimId}$`))
})

test('delivery to a dormant recipient is durable and does not wake it', async () => {
  const { waiter, notification } = await createFixture()
  await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, waiter.id))

  await new SlotNotificationNotifier().drain({ now: notification!.nextAttemptAt, notificationId: notification.id })

  expect((await db.select().from(agents).where(eq(agents.id, waiter.id)))[0]!.status).toBe('dormant')
  expect(await db.select().from(executions).where(eq(executions.agentId, waiter.id))).toHaveLength(0)
  const messages = await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))
  expect(messages).toHaveLength(1)
  expect(messages[0]!.metadata.wakeEligible).toBe(false)
})

describe('prompt drain after a granting transaction commits', () => {
  test('release schedules exactly one prompt drain after the grant commits', async () => {
    setSlotPromptDrainEnabledForTest(true)
    const { squad, holder, waiter, pool, claim } = await createContestedFixture()
    const original = slotNotificationNotifier.drainSoon.bind(slotNotificationNotifier)
    const originalDrain = slotNotificationNotifier.drain
    const drained = Promise.withResolvers<void>()
    slotNotificationNotifier.drain = async (input) => {
      try {
        // Due times are stamped by PostgreSQL. Use that clock after the granting
        // transaction commits, rather than racing a slightly skewed host clock.
        const [clock] = await db.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)
        const result = await originalDrain.call(slotNotificationNotifier, { ...input, now: new Date(clock!.now) })
        drained.resolve()
        return result
      } catch (error) {
        drained.reject(error)
        throw error
      }
    }
    const committedAtSchedule: Array<Promise<boolean>> = []
    let scheduled = 0
    slotNotificationNotifier.drainSoon = () => {
      scheduled += 1
      // The prompt drain may only be scheduled once the grant is committed.
      committedAtSchedule.push(
        db
          .select({ id: slotNotifications.id })
          .from(slotNotifications)
          .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'granted')))
          .then((rows) => rows.length === 1)
      )
      original()
    }
    try {
      const released = await releaseSlot(squad.id, 'tests', holder.id, claim.claim.id!)
      expect(released.outcome).toBe('released')
      expect(scheduled).toBe(1)
      expect(await Promise.all(committedAtSchedule)).toEqual([true])
      // Delivery follows promptly instead of waiting for the reconciliation tick.
      await drained.promise
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(1)
    } finally {
      slotNotificationNotifier.drainSoon = original
      slotNotificationNotifier.drain = originalDrain
      setSlotPromptDrainEnabledForTest(false)
    }
  })

  test('a failing prompt drain cannot roll back the grant or lose the outbox row', async () => {
    setSlotPromptDrainEnabledForTest(true)
    const { squad, holder, waiter, pool, claim } = await createContestedFixture()
    const original = slotNotificationNotifier.drainSoon.bind(slotNotificationNotifier)
    slotNotificationNotifier.drainSoon = () => {
      throw new Error('prompt drain scheduling failed')
    }
    try {
      const released = await releaseSlot(squad.id, 'tests', holder.id, claim.claim.id!)
      expect(released.outcome).toBe('released')
      const [notification] = await db
        .select()
        .from(slotNotifications)
        .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'granted')))
      expect(notification).toMatchObject({ status: 'pending' })
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(0)
      // The durable outbox survives the failed prompt drain and still delivers.
      await new SlotNotificationNotifier().drain({ now: notification!.nextAttemptAt, notificationId: notification!.id })
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, waiter.id))).toHaveLength(1)
    } finally {
      slotNotificationNotifier.drainSoon = original
      setSlotPromptDrainEnabledForTest(false)
    }
  })
})

describe('store-side settlement of undelivered grants', () => {
  /**
   * Each fixture pins the notification's next attempt into the future so no
   * drain — prompt or reconciliation — can mask the store-side fence: only the
   * settlement written by the terminalizing operation itself can turn the row
   * delivered. Deleting any fence must leave its row pending and these red.
   */
  async function undeliveredGrantFixture() {
    const squad = await Squad.create({ name: `slot-settle-${crypto.randomUUID()}`, purpose: 'test' })
    squadIds.push(squad.id)
    const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const rows = await db
      .insert(agents)
      .values([
        { agentTypeId: 'slot-settle-test', squadId: squad.id },
        { agentTypeId: 'slot-settle-test', squadId: squad.id },
      ])
      .returning()
    agentIds.push(...rows.map((row) => row.id))
    const holder = rows[0]!
    const other = rows[1]!
    const claim = await claimSlot(squad.id, 'tests', holder.id)
    if (claim.outcome !== 'granted') throw new Error('bad fixture')
    const [notification] = await db
      .insert(slotNotifications)
      .values({
        poolId: pool.id,
        claimId: claim.claim.id!,
        recipientAgentId: holder.id,
        kind: 'granted',
        idempotencyKey: `settle:${claim.claim.id}`,
        nextAttemptAt: new Date(Date.now() + 60_000),
      })
      .returning()
    return { squad, pool, holder, other, claim, notification: notification! }
  }

  test('expiry settlement: an expiring claim settles its undelivered grant directly', async () => {
    const { squad, holder, other, claim, notification } = await undeliveredGrantFixture()
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(slotClaims.id, claim.claim.id!))

    const acquired = await claimSlot(squad.id, 'tests', other.id)
    expect(acquired.outcome).toBe('granted')

    expect((await db.select().from(slotClaims).where(eq(slotClaims.id, claim.claim.id!)))[0]).toMatchObject({
      status: 'expired',
    })
    expect(
      (await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]
    ).toMatchObject({ status: 'delivered', lastErrorCode: 'claim_inactive', claimToken: null })
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))).toHaveLength(0)
  })

  test('release settlement: releasing a claim settles its undelivered grant directly', async () => {
    const { squad, holder, claim, notification } = await undeliveredGrantFixture()

    const released = await releaseSlot(squad.id, 'tests', holder.id, claim.claim.id!)
    expect(released.outcome).toBe('released')

    expect(
      (await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification.id)))[0]
    ).toMatchObject({ status: 'delivered', lastErrorCode: 'claim_inactive', claimToken: null })
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))).toHaveLength(0)
  })
})
