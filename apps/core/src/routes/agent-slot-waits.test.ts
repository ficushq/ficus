import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agents, inbox, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../db'
import { authzSentinel, identityMiddleware } from '../middleware'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { agentsRouter } from './agents'
import {
  claimSlot,
  registerPool,
  releaseSlot,
  renewSlot,
  setSlotPromptDrainEnabledForTest,
  unsubscribeSlot,
} from '../services/slots/store'
import { listActiveSlotHolds } from '../services/slots/active-holds'
import { reconcileSlotsOnce } from '../services/slots/reconciliation'
import { eventEmitter } from '../lib/infra/event-emitter'

const prefix = `agent-slot-waits-${crypto.randomUUID()}`
const app = new Hono()
app.use('*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/agents', agentsRouter)
let reader: TestUser
let agentOnly: TestUser
let slotOnly: TestUser
let foreign: TestUser
let squadId: string
let agentId: string
let holderId: string
let poolIds: string[] = []
let unsubscribe: (() => void) | undefined

beforeAll(async () => {
  ;[reader, agentOnly, slotOnly, foreign] = await Promise.all(
    Array.from({ length: 4 }, () => createTestUser({ prefix }))
  )
})
afterAll(async () => cleanupTestRbac(prefix))
afterEach(async () => {
  unsubscribe?.()
  unsubscribe = undefined
  setSlotPromptDrainEnabledForTest(true)
  if (poolIds.length) {
    await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
    await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
  }
  poolIds = []
  if (squadId) {
    await db.delete(inbox).where(inArray(inbox.recipientId, [agentId, holderId]))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

async function fixture() {
  setSlotPromptDrainEnabledForTest(false)
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Test' }).returning()
  squadId = squad.id
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: prefix, squadId },
      { agentTypeId: prefix, squadId },
    ])
    .returning()
  ;[agentId, holderId] = rows.map((row) => row.id)
  for (const [user, permissions] of [
    [reader, ['agents:read', 'slots:use']],
    [agentOnly, ['agents:read']],
    [slotOnly, ['slots:write']],
  ] as const) {
    const role = await createTestRole({ prefix, permissions: [...permissions] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  }
}
async function pool(key: string) {
  const result = await registerPool({ squadId, key, createdBy: 'test' })
  poolIds.push(result.id)
  const held = await claimSlot(squadId, key, holderId)
  const wait = await claimSlot(squadId, key, agentId)
  if (held.outcome !== 'granted' || wait.outcome !== 'queued') throw new Error('Expected contested pool')
  return { pool: result, held, wait }
}
const get = (user?: TestUser, id = agentId) =>
  app.request(`/api/agents/${id}/slot-waits`, { headers: user ? authHeaders(user.token) : {} })

describe('agent queued slot projection', () => {
  test('returns only the viewed agent queued pool keys, not holders or other agents', async () => {
    await fixture()
    const second = await pool('second')
    await pool('first')
    const response = await get(reader)
    expect(response.status).toBe(200)
    const waits = await response.json()
    expect(waits.map((wait: { poolKey: string }) => wait.poolKey)).toEqual(['first', 'second'])
    expect(Object.keys(waits[0]).sort()).toEqual(['poolKey', 'queuedAt', 'waiterId'])
    expect(await (await get(reader, holderId)).json()).toEqual([])
    await releaseSlot(squadId, 'second', holderId, second.held.claim.id)
    expect((await (await get(reader)).json()).map((wait: { poolKey: string }) => wait.poolKey)).toEqual(['first'])
  })

  test('requires both agent visibility and slot permission in the same squad', async () => {
    await fixture()
    await pool('private-pool')
    for (const user of [undefined, foreign, agentOnly, slotOnly]) {
      const response = await get(user)
      expect([401, 403]).toContain(response.status)
      expect(await response.text()).not.toContain('private-pool')
    }
    expect([403, 404]).toContain((await get(reader, crypto.randomUUID())).status)
  })

  test('does not expose another user owned agent even with squad permissions', async () => {
    await fixture()
    await pool('private-pool')
    await db.update(agents).set({ ownerUserId: foreign.id, squadId: null }).where(eq(agents.id, agentId))
    const response = await get(reader)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('private-pool')
  })

  for (const invalid of ['unsubscribed', 'unregistered', 'archived', 'dormant', 'foreign owner'] as const) {
    test(`omits ${invalid} waiters even before repair`, async () => {
      await fixture()
      const queued = await pool('capacity')
      if (invalid === 'unsubscribed') await unsubscribeSlot(squadId, 'capacity', agentId, queued.wait.waiter.id)
      if (invalid === 'unregistered')
        await db.update(slotPools).set({ unregisteredAt: new Date() }).where(eq(slotPools.id, queued.pool.id))
      if (invalid === 'archived') await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, squadId))
      if (invalid === 'dormant') await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, agentId))
      if (invalid === 'foreign owner')
        await db
          .update(slotWaiters)
          .set({ ownerAgentId: crypto.randomUUID() })
          .where(eq(slotWaiters.id, queued.wait.waiter.id))
      expect(await (await get(reader)).json()).toEqual([])
    })
  }

  test('emits content-free squad invalidations after enqueue, unsubscribe and promotion commit', async () => {
    await fixture()
    const events: Array<{ squadId: string }> = []
    unsubscribe = eventEmitter.on('slots.updated', (data) => {
      if (data.squadId === squadId) events.push(data)
    })
    const queued = await pool('capacity')
    expect(events.length).toBeGreaterThan(0)
    expect(await (await get(reader)).json()).toHaveLength(1)
    events.length = 0
    await unsubscribeSlot(squadId, 'capacity', agentId, queued.wait.waiter.id)
    expect(events).toEqual([{ squadId }])
    expect(await (await get(reader)).json()).toEqual([])
    await claimSlot(squadId, 'capacity', agentId)
    events.length = 0
    await releaseSlot(squadId, 'capacity', holderId, queued.held.claim.id)
    expect(events).toEqual([{ squadId }])
    expect(await (await get(reader)).json()).toEqual([])
  })

  test('reconciliation expiry promotes the waiter and invalidates the queued projection', async () => {
    await fixture()
    const queued = await pool('capacity')
    const events: Array<{ squadId: string }> = []
    unsubscribe = eventEmitter.on('slots.updated', (data) => {
      if (data.squadId === squadId) events.push(data)
    })
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, queued.held.claim.id))
    await reconcileSlotsOnce()
    expect(events).toEqual([{ squadId }])
    expect(await (await get(reader)).json()).toEqual([])
  })
})

const getHolds = (user?: TestUser, id = agentId) =>
  app.request(`/api/agents/${id}/slot-holds`, { headers: user ? authHeaders(user.token) : {} })

describe('agent held slot projection', () => {
  test('projects only safe names and expiry of live claims owned by the viewed agent', async () => {
    await fixture()
    const second = await pool('second')
    await pool('first')
    expect((await getHolds(reader)).status).toBe(200)
    expect(await (await getHolds(reader)).json()).toEqual([])
    const response = await getHolds(reader, holderId)
    expect(response.status).toBe(200)
    const holds = await response.json()
    expect(holds.map((hold: { poolKey: string }) => hold.poolKey)).toEqual(['first', 'second'])
    expect(Object.keys(holds[0]).sort()).toEqual(['expiresAt', 'poolKey'])
    expect(Number.isFinite(Date.parse(holds[0].expiresAt))).toBe(true)
    await releaseSlot(squadId, 'second', holderId, second.held.claim.id)
    expect((await (await getHolds(reader)).json()).map((hold: { poolKey: string }) => hold.poolKey)).toEqual(['second'])
    expect((await (await get(reader)).json()).map((wait: { poolKey: string }) => wait.poolKey)).toEqual(['first'])
  })

  test('grant, renewal and expiry use existing content-free invalidations', async () => {
    await fixture()
    const events: Array<{ squadId: string }> = []
    unsubscribe = eventEmitter.on('slots.updated', (data) => {
      if (data.squadId === squadId) events.push(data)
    })
    const held = await pool('capacity')
    expect(events.length).toBeGreaterThan(0)
    await db.update(slotPools).set({ claimTimeoutMs: 120_000 }).where(eq(slotPools.id, held.pool.id))
    events.length = 0
    const renewed = await renewSlot(squadId, 'capacity', holderId, held.held.claim.id)
    expect(events).toEqual([{ squadId }])
    expect(await (await getHolds(reader, holderId)).json()).toEqual([
      { poolKey: 'capacity', expiresAt: renewed.expiresAt.toISOString() },
    ])
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, held.held.claim.id))
    expect(await (await getHolds(reader, holderId)).json()).toEqual([])
    events.length = 0
    await reconcileSlotsOnce()
    expect(events).toEqual([{ squadId }])
    expect(await (await getHolds(reader, holderId)).json()).toEqual([])
    expect(await (await getHolds(reader)).json()).toHaveLength(1)
  })

  test('deleted owners and claims cannot survive the live projection', async () => {
    await fixture()
    const held = await pool('capacity')
    expect(await listActiveSlotHolds(db, [])).toEqual([])
    await db.delete(slotClaims).where(eq(slotClaims.id, held.held.claim.id))
    expect(await listActiveSlotHolds(db, [holderId])).toEqual([])
    await db.delete(slotWaiters).where(eq(slotWaiters.poolId, held.pool.id))
    const again = await claimSlot(squadId, 'capacity', holderId)
    expect(again.outcome).toBe('granted')
    await db.delete(agents).where(eq(agents.id, holderId))
    expect(await listActiveSlotHolds(db, [holderId])).toEqual([])
  })

  test('requires agent visibility and slot permission without leaking names', async () => {
    await fixture()
    await pool('private-pool')
    for (const user of [undefined, foreign, agentOnly, slotOnly]) {
      const response = await getHolds(user, holderId)
      expect([401, 403]).toContain(response.status)
      expect(await response.text()).not.toContain('private-pool')
    }
    expect([403, 404]).toContain((await getHolds(reader, crypto.randomUUID())).status)
    await db.update(agents).set({ ownerUserId: foreign.id, squadId: null }).where(eq(agents.id, holderId))
    expect((await getHolds(reader, holderId)).status).toBe(403)
  })

  test('slot permissions from another squad cannot authorize names or mismatched claim ownership', async () => {
    await fixture()
    await pool('private-pool')
    const [other] = await db
      .insert(squads)
      .values({ name: `${prefix}-other`, purpose: 'Test' })
      .returning()
    try {
      const role = await createTestRole({ prefix, permissions: ['slots:use'] })
      await assignRole({ userId: agentOnly.id, roleId: role.id, scope: 'squad', squadId: other.id })
      const response = await getHolds(agentOnly, holderId)
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain('private-pool')
      await db.update(agents).set({ squadId: other.id }).where(eq(agents.id, holderId))
      expect(await listActiveSlotHolds(db, [holderId])).toEqual([])
    } finally {
      await db.update(agents).set({ squadId }).where(eq(agents.id, holderId))
      await db.delete(squads).where(eq(squads.id, other.id))
    }
  })

  test('slot write with agent visibility authorizes the same safe projection', async () => {
    await fixture()
    await pool('capacity')
    const role = await createTestRole({ prefix, permissions: ['agents:read'] })
    await assignRole({ userId: slotOnly.id, roleId: role.id, scope: 'squad', squadId })
    const response = await getHolds(slotOnly, holderId)
    expect(response.status).toBe(200)
    expect((await response.json()).map((row: { poolKey: string }) => row.poolKey)).toEqual(['capacity'])
  })

  test('squadless visible agents have no held context', async () => {
    await fixture()
    await db.update(agents).set({ ownerUserId: reader.id, squadId: null }).where(eq(agents.id, agentId))
    expect(await (await getHolds(reader)).json()).toEqual([])
  })

  for (const invalid of [
    'expired',
    'released',
    'ended',
    'unregistered',
    'archived',
    'dormant',
    'terminated',
    'foreign squad',
    'deleted owner',
  ] as const) {
    test(`omits ${invalid} claims before reconciliation`, async () => {
      await fixture()
      const held = await pool('capacity')
      if (invalid === 'expired')
        await db
          .update(slotClaims)
          .set({ expiresAt: new Date(0) })
          .where(eq(slotClaims.id, held.held.claim.id))
      if (invalid === 'released')
        await db.update(slotClaims).set({ status: 'released' }).where(eq(slotClaims.id, held.held.claim.id))
      if (invalid === 'ended')
        await db.update(slotClaims).set({ endedAt: new Date() }).where(eq(slotClaims.id, held.held.claim.id))
      if (invalid === 'unregistered')
        await db.update(slotPools).set({ unregisteredAt: new Date() }).where(eq(slotPools.id, held.pool.id))
      if (invalid === 'archived') await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, squadId))
      if (invalid === 'dormant' || invalid === 'terminated')
        await db.update(agents).set({ status: invalid }).where(eq(agents.id, holderId))
      if (invalid === 'foreign squad')
        await db.update(agents).set({ squadId: null, ownerUserId: reader.id }).where(eq(agents.id, holderId))
      if (invalid === 'deleted owner') await db.delete(agents).where(eq(agents.id, holderId))
      const response = await getHolds(reader, invalid === 'deleted owner' ? agentId : holderId)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    })
  }
})
