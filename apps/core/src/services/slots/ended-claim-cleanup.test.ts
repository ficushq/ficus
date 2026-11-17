import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { agents, db, executions, inbox, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { heldSlotClaimIds } from '../sandbox/bash-ownership'
import { setSlotEndedClaimCleanupForTest, type EndedClaimCleanupInput } from './ended-claim-cleanup'
import { SlotNotificationNotifier } from './notifications'
import { claimSlot, registerPool, releaseSlot, setSlotPromptDrainEnabledForTest } from './store'

const squadIds: string[] = []
const agentIds: string[] = []
const ended: EndedClaimCleanupInput[] = []

beforeAll(() => setSlotPromptDrainEnabledForTest(false))
afterAll(() => setSlotPromptDrainEnabledForTest(true))
beforeEach(() => setSlotEndedClaimCleanupForTest((claim) => ended.push(claim)))

afterEach(async () => {
  setSlotEndedClaimCleanupForTest(undefined)
  ended.length = 0
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

async function fixture(poolKeys: string[] = ['tests']) {
  const squad = await Squad.create({ name: `slot-ended-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  for (const key of poolKeys) await registerPool({ squadId: squad.id, key, createdBy: 'test' })
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: 'slot-ended-test', squadId: squad.id },
      { agentTypeId: 'slot-ended-test', squadId: squad.id },
    ])
    .returning()
  agentIds.push(...rows.map((row) => row.id))
  return { squad, holder: rows[0]!, other: rows[1]! }
}

async function claim(squadId: string, key: string, agentId: string): Promise<string> {
  const result = await claimSlot(squadId, key, agentId)
  if (result.outcome !== 'granted') throw new Error('bad fixture')
  return result.claim.id!
}

test('releasing a claim starts the stop of what its owner started under it, once', async () => {
  const { squad, holder } = await fixture()
  const claimId = await claim(squad.id, 'tests', holder.id)

  expect((await releaseSlot(squad.id, 'TESTS', holder.id, claimId)).outcome).toBe('released')
  expect(ended).toEqual([
    { claimId, agentId: holder.id, squadId: squad.id, poolKey: 'tests', reason: 'claim-released' },
  ])

  // A repeated release ended nothing new.
  expect((await releaseSlot(squad.id, 'tests', holder.id, claimId)).outcome).toBe('already_released')
  expect(ended).toHaveLength(1)
})

test('an expired claim is stopped when its expiry notice is delivered, not by a late release', async () => {
  const { squad, holder } = await fixture()
  const claimId = await claim(squad.id, 'tests', holder.id)
  await db
    .update(slotClaims)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(slotClaims.id, claimId))

  // The release notices the expiry; the claim was not released, so it starts nothing itself.
  expect((await releaseSlot(squad.id, 'tests', holder.id, claimId)).outcome).toBe('expired')
  expect(ended).toEqual([])

  const [notice] = await db.select().from(slotNotifications).where(eq(slotNotifications.claimId, claimId))
  expect(notice?.kind).toBe('expired')
  await new SlotNotificationNotifier().drain({ now: new Date(Date.now() + 1_000), notificationId: notice!.id })
  expect(ended).toEqual([{ claimId, agentId: holder.id, squadId: squad.id, poolKey: 'tests', reason: 'claim-expired' }])
  const [message] = await db.select().from(inbox).where(eq(inbox.recipientId, holder.id))
  expect(message?.content).toContain('Ficus is stopping the background processes your commands started')
})

test('a grant notice never stops anything', async () => {
  const { squad, holder, other } = await fixture()
  const claimId = await claim(squad.id, 'tests', holder.id)
  const queued = await claimSlot(squad.id, 'tests', other.id)
  expect(queued.outcome).toBe('queued')
  await releaseSlot(squad.id, 'tests', holder.id, claimId)
  ended.length = 0

  const [grant] = await db.select().from(slotNotifications).where(eq(slotNotifications.recipientAgentId, other.id))
  expect(grant?.kind).toBe('granted')
  await new SlotNotificationNotifier().drain({ now: new Date(Date.now() + 1_000), notificationId: grant!.id })
  expect(ended).toEqual([])
})

test('a command is attributed to every claim its agent holds, and to no ended or foreign claim', async () => {
  const { squad, holder, other } = await fixture(['tests', 'builds', 'deploys'])
  const tests = await claim(squad.id, 'tests', holder.id)
  const builds = await claim(squad.id, 'builds', holder.id)
  const deploys = await claim(squad.id, 'deploys', holder.id)
  await claim(squad.id, 'tests', other.id).catch(() => undefined)

  expect(await heldSlotClaimIds(holder.id)).toEqual([tests, builds, deploys].sort())

  await releaseSlot(squad.id, 'builds', holder.id, builds)
  // Past its expiry but not yet marked expired by any slot transaction.
  await db
    .update(slotClaims)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(slotClaims.id, deploys))
  expect(await heldSlotClaimIds(holder.id)).toEqual([tests])
  expect(await heldSlotClaimIds(crypto.randomUUID())).toEqual([])
})
