import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type WorkStreamPriority } from '@ficus/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads, workStreams } from '../../db'
import { Squad } from '../../entities/Squad'
import { orderedSlotWaiters } from './queue-order'
import {
  claimSlot,
  getPool,
  registerPool,
  releaseSlot,
  setSlotPromptDrainEnabledForTest,
  subscribeSlot,
  updatePool,
} from './store'

let squadId: string
let poolId: string
let holder: { agentId: string; claimId: string }
const extraSquadIds: string[] = []

async function agent() {
  const [row] = await db
    .insert(agents)
    .values({ squadId, agentTypeId: 'slot-priority-test', status: 'idle' })
    .returning()
  return row!.id
}

beforeEach(async () => {
  setSlotPromptDrainEnabledForTest(false)
  squadId = (await Squad.create({ name: `slot-priority-${crypto.randomUUID()}`, purpose: 'test' })).id
  poolId = (await registerPool({ squadId, key: 'tests', createdBy: 'test' })).id
  const agentId = await agent()
  const result = await claimSlot(squadId, 'tests', agentId)
  if (result.outcome !== 'granted') throw new Error('holder not granted')
  holder = { agentId, claimId: result.claim.id }
})

afterEach(async () => {
  setSlotPromptDrainEnabledForTest(true)
  await db.delete(slotNotifications).where(eq(slotNotifications.poolId, poolId))
  await db.delete(slotWaiters).where(eq(slotWaiters.poolId, poolId))
  await db.delete(slotClaims).where(eq(slotClaims.poolId, poolId))
  await db.delete(slotPools).where(eq(slotPools.id, poolId))
  await db.delete(workStreams).where(inArray(workStreams.squadId, [squadId, ...extraSquadIds]))
  await db.delete(agents).where(eq(agents.squadId, squadId))
  await db.delete(squads).where(inArray(squads.id, [squadId, ...extraSquadIds]))
  extraSquadIds.length = 0
})

async function enqueue(priority?: WorkStreamPriority, viaClaim = false) {
  const agentId = await agent()
  let streamId: string | undefined
  if (priority) {
    const [stream] = await db
      .insert(workStreams)
      .values({ squadId, title: 'test', priority, agentIds: [agentId] })
      .returning()
    streamId = stream!.id
  }
  const result = await (viaClaim ? claimSlot : subscribeSlot)(squadId, 'tests', agentId)
  if (result.outcome !== 'queued') throw new Error('waiter not queued')
  return { agentId, streamId, waiterId: result.waiter.id }
}

async function queue() {
  return db.transaction(async (tx) =>
    (await orderedSlotWaiters(tx, { id: poolId, squadId })).map((waiter) => waiter.id)
  )
}

async function releaseHolder() {
  await releaseSlot(squadId, 'tests', holder.agentId, holder.claimId)
}

for (const trigger of ['release', 'expiry', 'capacity'] as const) {
  test(`${trigger} promotes by current work-stream priority then FIFO`, async () => {
    const low = await enqueue('low')
    const normal = await enqueue('normal')
    const highA = await enqueue('high', true)
    const highB = await enqueue('high')
    const critical = await enqueue('critical', true)
    const expected = [critical, highA, highB, normal, low]
    expect(await queue()).toEqual(expected.map((w) => w.waiterId))
    if (trigger === 'release') await releaseHolder()
    else if (trigger === 'expiry') {
      await db
        .update(slotClaims)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(slotClaims.id, holder.claimId))
      // A new claimant must not jump the existing priority queue.
      expect((await claimSlot(squadId, 'tests', await agent(), { subscribe: false })).outcome).toBe('unavailable')
    } else await updatePool(squadId, 'tests', { capacity: 2 })
    const [granted] = await db.select().from(slotWaiters).where(eq(slotWaiters.id, critical.waiterId))
    expect(granted!.status).toBe('granted')
    expect(await queue()).toEqual(expected.slice(1).map((w) => w.waiterId))
    await releaseSlot(squadId, 'tests', critical.agentId, granted!.resultingClaimId!)
    const [firstHigh] = await db.select().from(slotWaiters).where(eq(slotWaiters.id, highA.waiterId))
    expect(firstHigh!.status).toBe('granted')
    expect(await queue()).toEqual([highB, normal, low].map((w) => w.waiterId))
  })
}

test('priority edits reorder waiting subscriptions without preempting holders or resetting FIFO', async () => {
  const first = await enqueue('low')
  const second = await enqueue('high')
  await db.update(workStreams).set({ priority: 'high' }).where(eq(workStreams.id, first.streamId!))
  expect(await queue()).toEqual([first.waiterId, second.waiterId])
  expect((await subscribeSlot(squadId, 'tests', first.agentId)).outcome).toBe('queued')
  expect((await getPool(squadId, 'tests', { diagnostics: true })).holders[0]!.id).toBe(holder.claimId)
  await releaseHolder()
  expect(await queue()).toEqual([second.waiterId])
})

test('agents without active work use normal priority and keep FIFO ties; oldest age is independent of rank', async () => {
  const low = await enqueue('low')
  const standalone = await enqueue()
  const normal = await enqueue('normal')
  const high = await enqueue('high')
  // The oldest subscription need not be the highest-priority one.
  await db
    .update(slotWaiters)
    .set({ queuedAt: sql`clock_timestamp() - interval '10 minutes'` })
    .where(eq(slotWaiters.id, low.waiterId))
  expect(await queue()).toEqual([high, standalone, normal, low].map((w) => w.waiterId))
  expect((await getPool(squadId, 'tests', { diagnostics: true })).oldestWaiterAgeMs).toBeGreaterThanOrEqual(600_000)
  await releaseHolder()
  expect(await queue()).toEqual([standalone, normal, low].map((w) => w.waiterId))
})

for (const invalid of ['removed-member', 'other-squad', 'done', 'canceled', 'owner-only'] as const) {
  test(`does not borrow critical priority from ${invalid}`, async () => {
    const normal = await enqueue()
    const unrelated = await enqueue('critical')
    if (invalid === 'removed-member' || invalid === 'owner-only')
      await db
        .update(workStreams)
        .set({ agentIds: [], ownerAgentId: invalid === 'owner-only' ? unrelated.agentId : null })
        .where(eq(workStreams.id, unrelated.streamId!))
    if (invalid === 'other-squad') {
      const other = await Squad.create({ name: `slot-other-${crypto.randomUUID()}`, purpose: 'test' })
      extraSquadIds.push(other.id)
      await db.update(workStreams).set({ squadId: other.id }).where(eq(workStreams.id, unrelated.streamId!))
    }
    if (invalid === 'done' || invalid === 'canceled')
      await db.update(workStreams).set({ status: invalid }).where(eq(workStreams.id, unrelated.streamId!))
    expect(await queue()).toEqual([normal.waiterId, unrelated.waiterId])
    await releaseHolder()
    expect(await queue()).toEqual([unrelated.waiterId])
  })
}

test('uses the highest priority across crew membership and assignment, including work joined after subscribing', async () => {
  const high = await enqueue('high')
  const multiple = await enqueue('low')
  expect(await queue()).toEqual([high.waiterId, multiple.waiterId])
  const [critical] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: 'another work stream',
      priority: 'critical',
      assigneeAgentId: multiple.agentId,
    })
    .returning()
  expect(await queue()).toEqual([multiple.waiterId, high.waiterId])
  // Removing only the high-priority assignment restores the remaining low priority.
  await db.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, critical!.id))
  expect(await queue()).toEqual([high.waiterId, multiple.waiterId])
  await db
    .update(workStreams)
    .set({ agentIds: [multiple.agentId] })
    .where(eq(workStreams.id, critical!.id))
  await releaseHolder()
  expect(await queue()).toEqual([high.waiterId])
})
