import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  agentExtraScopes,
  agents,
  agentTokens,
  db,
  slotClaims,
  slotNotifications,
  slotPools,
  slotWaiters,
  squads,
} from '../db'
import { authzSentinel, identityMiddleware } from '../middleware'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestAgentToken,
  type TestUser,
} from '../test-utils'
import { registerPool } from '../services/slots'
import { slotResourcesRouter, slotsRouter } from './slots'

const prefix = `slot-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const app = new Hono()
app.use('*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/squads', slotsRouter)
app.route('/api/slots', slotResourcesRouter)

const squadIds: string[] = []
const agentIds: string[] = []
let useUser: TestUser
let writeUser: TestUser

beforeAll(async () => {
  useUser = await createTestUser({ prefix })
  writeUser = await createTestUser({ prefix })
  const useRole = await createTestRole({ prefix, permissions: ['slots:use'] })
  const writeRole = await createTestRole({ prefix, permissions: ['slots:write'] })
  await assignRole({ userId: useUser.id, roleId: useRole.id, scope: 'squad_default' })
  await assignRole({ userId: writeUser.id, roleId: writeRole.id, scope: 'squad_default' })
})

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
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, agentIds))
    await db.delete(agentExtraScopes).where(inArray(agentExtraScopes.agentId, agentIds))
    await db.delete(agents).where(inArray(agents.id, agentIds))
  }
  if (squadIds.length > 0) await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

afterAll(async () => cleanupTestRbac(prefix))

async function squad(name: string): Promise<string> {
  const [row] = await db
    .insert(squads)
    .values({ name: `${prefix}-${name}`, purpose: 'slot route test' })
    .returning()
  squadIds.push(row!.id)
  return row!.id
}

async function agent(squadId: string, permission = 'slots:use', parentAgentId?: string): Promise<TestAgentToken> {
  const [row] = await db.insert(agents).values({ agentTypeId: 'slot-route-test', squadId, parentAgentId }).returning()
  agentIds.push(row!.id)
  if (!parentAgentId) await db.insert(agentExtraScopes).values({ agentId: row!.id, permission })
  return createTestAgentToken({ agentId: row!.id, squadId })
}

function request(method: string, path: string, token?: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      ...(token ? authHeaders(token) : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function register(squadId: string, capacity = 1) {
  return registerPool({ squadId, key: 'tests', capacity, createdBy: 'test' })
}

const anonymousSquad = crypto.randomUUID()
const anonymousRoutes: Array<[string, string]> = [
  ['GET', `/api/squads/${anonymousSquad}/slots`],
  ['GET', `/api/squads/${anonymousSquad}/slots/tests`],
  ['GET', `/api/squads/${anonymousSquad}/slots/tests/history`],
  ['POST', `/api/squads/${anonymousSquad}/slots`],
  ['PATCH', `/api/squads/${anonymousSquad}/slots/tests`],
  ['DELETE', `/api/squads/${anonymousSquad}/slots/tests`],
  ['POST', `/api/squads/${anonymousSquad}/slots/tests/claims`],
  ['POST', `/api/squads/${anonymousSquad}/slots/tests/claims/${crypto.randomUUID()}/renew`],
  ['DELETE', `/api/squads/${anonymousSquad}/slots/tests/claims/${crypto.randomUUID()}`],
  ['POST', `/api/squads/${anonymousSquad}/slots/tests/waiters`],
  ['DELETE', `/api/squads/${anonymousSquad}/slots/tests/waiters/${crypto.randomUUID()}`],
  ['POST', `/api/slots/claims/${crypto.randomUUID()}/renew`],
  ['DELETE', `/api/slots/claims/${crypto.randomUUID()}`],
  ['DELETE', `/api/slots/waiters/${crypto.randomUUID()}`],
]

test('all squad slot routes require an authenticated identity', async () => {
  for (const [method, path] of anonymousRoutes) {
    expect((await request(method, path)).status, `${method} ${path}`).toBe(401)
  }
})

describe('slot route authorization and identity', () => {
  test('use can read but not administer; write can administer and read', async () => {
    const squadId = await squad('permissions')
    expect((await request('GET', `/api/squads/${squadId}/slots`, useUser.token)).status).toBe(200)
    expect((await request('POST', `/api/squads/${squadId}/slots`, useUser.token, { key: 'tests' })).status).toBe(403)
    expect((await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, { key: 'tests' })).status).toBe(201)
    expect((await request('GET', `/api/squads/${squadId}/slots`, writeUser.token)).status).toBe(200)
    const writeAgent = await agent(squadId, 'slots:write')
    expect((await request('POST', `/api/squads/${squadId}/slots/tests/claims`, writeAgent.token)).status).toBe(200)
  })

  test('write user still cannot own claim lifecycle state', async () => {
    const squadId = await squad('non-agent')
    await register(squadId)
    const response = await request('POST', `/api/squads/${squadId}/slots/tests/claims`, writeUser.token)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'agent_identity_required' })
  })

  test('system identities with use scope still cannot own lifecycle state', async () => {
    const squadId = await squad('system-non-agent')
    await register(squadId)
    const systemApp = new Hono()
    systemApp.use('/api/*', async (c, next) => {
      c.set('identity', {
        type: 'system',
        systemTokenId: crypto.randomUUID(),
        name: 'slot-route-test',
        scopes: ['slots:use'],
      })
      await next()
    })
    systemApp.use('/api/*', authzSentinel)
    systemApp.route('/api/squads', slotsRouter)

    const response = await systemApp.request(`/api/squads/${squadId}/slots/tests/claims`, { method: 'POST' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'agent_identity_required' })
  })

  test('agent permission is squad scoped', async () => {
    const ownSquad = await squad('own')
    const otherSquad = await squad('other')
    const token = await agent(ownSquad)
    expect((await request('GET', `/api/squads/${otherSquad}/slots`, token.token)).status).toBe(403)
  })

  test('manager-root authority cannot mutate child-owned opaque state', async () => {
    const squadId = await squad('child-owner')
    await register(squadId)
    const root = await agent(squadId, 'slots:write')
    const child = await agent(squadId, 'slots:use', root.agentId)
    const claimResponse = await request('POST', `/api/squads/${squadId}/slots/tests/claims`, child.token)
    const claim = await claimResponse.json()
    const queuedChild = await agent(squadId, 'slots:use', root.agentId)
    const waiter = await (await request('POST', `/api/squads/${squadId}/slots/tests/waiters`, queuedChild.token)).json()

    for (const [method, path, code] of [
      ['POST', `/api/squads/${squadId}/slots/tests/claims/${claim.claim.id}/renew`, 'claim_not_found'],
      ['DELETE', `/api/squads/${squadId}/slots/tests/claims/${claim.claim.id}`, 'claim_not_found'],
      ['DELETE', `/api/squads/${squadId}/slots/tests/waiters/${waiter.waiter.id}`, 'waiter_not_found'],
    ] as const) {
      const response = await request(method, path, root.token)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code })
    }

    expect(await db.select().from(slotClaims).where(eq(slotClaims.id, claim.claim.id))).toMatchObject([
      { status: 'active' },
    ])
    expect(await db.select().from(slotWaiters).where(eq(slotWaiters.id, waiter.waiter.id))).toMatchObject([
      { status: 'queued' },
    ])
  })
})

test('all eleven handlers complete an authenticated administration and lifecycle flow', async () => {
  const squadId = await squad('complete-flow')
  expect(
    await (await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, { key: 'tests', capacity: 1 })).json()
  ).toMatchObject({ outcome: 'registered', pool: { key: 'tests' } })
  expect(
    await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { claimTimeoutMs: 120_000 })
    ).json()
  ).toMatchObject({ outcome: 'updated', pool: { claimTimeoutMs: 120_000 } })
  expect((await request('GET', `/api/squads/${squadId}/slots`, writeUser.token)).status).toBe(200)
  expect((await request('GET', `/api/squads/${squadId}/slots/tests`, writeUser.token)).status).toBe(200)

  const holder = await agent(squadId)
  const waiter = await agent(squadId)
  const granted = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, holder.token)).json()
  expect(
    await (
      await request('POST', `/api/squads/${squadId}/slots/tests/claims/${granted.claim.id}/renew`, holder.token)
    ).json()
  ).toMatchObject({ outcome: 'renewed' })
  const queued = await (await request('POST', `/api/squads/${squadId}/slots/tests/waiters`, waiter.token)).json()
  expect(
    await (
      await request('DELETE', `/api/squads/${squadId}/slots/tests/waiters/${queued.waiter.id}`, waiter.token)
    ).json()
  ).toMatchObject({ outcome: 'canceled' })
  expect(
    await (
      await request('DELETE', `/api/squads/${squadId}/slots/tests/claims/${granted.claim.id}`, holder.token)
    ).json()
  ).toMatchObject({ outcome: 'released' })
  expect((await request('GET', `/api/squads/${squadId}/slots/tests/history`, writeUser.token)).status).toBe(200)
  expect((await request('DELETE', `/api/squads/${squadId}/slots/tests`, writeUser.token)).status).toBe(200)
})

describe('slot route lifecycle behavior', () => {
  test('dormant and terminated owners retain only cleanup-safe release authority', async () => {
    for (const status of ['dormant', 'terminated'] as const) {
      const squadId = await squad(status)
      await register(squadId)
      const token = await agent(squadId)
      const granted = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, token.token)).json()
      await db.update(agents).set({ status }).where(eq(agents.id, token.agentId))

      expect((await request('GET', `/api/squads/${squadId}/slots`, token.token)).status).toBe(403)
      const released = await request(
        'DELETE',
        `/api/squads/${squadId}/slots/tests/claims/${granted.claim.id}`,
        token.token
      )
      expect(released.status).toBe(200)
      expect(await released.json()).toMatchObject({ outcome: 'released' })
    }
  })

  test('dormant cleanup does not bypass slot permissions', async () => {
    const squadId = await squad('dormant-no-permission')
    const pool = await register(squadId)
    const token = await agent(squadId, 'squads:read')
    const [claim] = await db
      .insert(slotClaims)
      .values({ poolId: pool.id, ownerAgentId: token.agentId, expiresAt: new Date(Date.now() + 60_000) })
      .returning()
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, token.agentId))

    expect(
      (await request('DELETE', `/api/squads/${squadId}/slots/tests/claims/${claim!.id}`, token.token)).status
    ).toBe(403)
    expect((await db.select().from(slotClaims).where(eq(slotClaims.id, claim!.id)))[0]).toMatchObject({
      status: 'active',
    })
  })

  test('dormant owner can cancel its waiter and terminal retries are stable', async () => {
    const squadId = await squad('dormant-waiter')
    await register(squadId)
    const holder = await agent(squadId)
    const target = await agent(squadId)
    await request('POST', `/api/squads/${squadId}/slots/tests/claims`, holder.token)
    const queued = await (await request('POST', `/api/squads/${squadId}/slots/tests/waiters`, target.token)).json()
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, target.agentId))

    const path = `/api/squads/${squadId}/slots/tests/waiters/${queued.waiter.id}`
    expect(await (await request('DELETE', path, target.token)).json()).toMatchObject({ outcome: 'canceled' })
    expect(await (await request('DELETE', path, target.token)).json()).toMatchObject({ outcome: 'canceled' })
  })

  test('release retries return the authoritative terminal outcome', async () => {
    const squadId = await squad('terminal-release')
    await register(squadId)
    const token = await agent(squadId)
    const granted = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, token.token)).json()
    const path = `/api/squads/${squadId}/slots/tests/claims/${granted.claim.id}`
    expect(await (await request('DELETE', path, token.token)).json()).toMatchObject({ outcome: 'released' })
    expect(await (await request('DELETE', path, token.token)).json()).toMatchObject({ outcome: 'already_released' })

    const next = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, token.token)).json()
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, next.claim.id))
    expect(
      await (await request('DELETE', `/api/squads/${squadId}/slots/tests/claims/${next.claim.id}`, token.token)).json()
    ).toMatchObject({ outcome: 'expired' })
  })
})

describe('slot route validation and projections', () => {
  test('rejects malformed bodies, keys, and opaque identifiers', async () => {
    const squadId = await squad('validation')
    const token = await agent(squadId, 'slots:write')
    expect((await request('POST', `/api/squads/${squadId}/slots`, token.token, { key: 'INVALID KEY' })).status).toBe(
      400
    )
    expect(
      (await request('POST', `/api/squads/${squadId}/slots`, token.token, { key: 'tests', capacity: 0 })).status
    ).toBe(400)
    expect(
      (await request('POST', `/api/squads/${squadId}/slots`, token.token, { key: 'tests', capacity: 1001 })).status
    ).toBe(400)
    await register(squadId)
    expect((await request('DELETE', `/api/squads/${squadId}/slots/tests/claims/not-a-uuid`, token.token)).status).toBe(
      404
    )
  })

  test('history is terminal-only, owner-filtered, and strictly paginated', async () => {
    const squadId = await squad('history')
    const pool = await register(squadId)
    const own = await agent(squadId)
    const foreign = await agent(squadId)
    const endedAt = new Date('2026-09-05T08:00:00.000Z')
    await db.insert(slotClaims).values([
      ...Array.from({ length: 51 }, () => ({
        poolId: pool.id,
        ownerAgentId: own.agentId,
        status: 'released' as const,
        expiresAt: endedAt,
        endedAt,
        terminalReason: 'released',
      })),
      ...Array.from({ length: 50 }, () => ({
        poolId: pool.id,
        ownerAgentId: foreign.agentId,
        status: 'released' as const,
        expiresAt: endedAt,
        endedAt,
        terminalReason: 'released',
      })),
    ])
    const [activeClaim] = await db
      .insert(slotClaims)
      .values({ poolId: pool.id, ownerAgentId: foreign.agentId, expiresAt: new Date(Date.now() + 60_000) })
      .returning({ id: slotClaims.id })
    await db.insert(slotWaiters).values({
      poolId: pool.id,
      ownerAgentId: own.agentId,
      status: 'canceled',
      endedAt,
      terminalReason: 'canceled',
    })
    const [queuedWaiter] = await db
      .insert(slotWaiters)
      .values({ poolId: pool.id, ownerAgentId: foreign.agentId })
      .returning({ id: slotWaiters.id })

    const firstResponse = await request('GET', `/api/squads/${squadId}/slots/tests/history`, own.token)
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json()
    expect(Object.keys(first).sort()).toEqual(['hasMore', 'items', 'nextCursor'])
    expect(first.items).toHaveLength(50)
    expect(first.items.every((item: { ownerAgentId: string }) => item.ownerAgentId === own.agentId)).toBe(true)
    expect(first.hasMore).toBe(true)
    const second = await (
      await request(
        'GET',
        `/api/squads/${squadId}/slots/tests/history?cursor=${encodeURIComponent(first.nextCursor)}`,
        own.token
      )
    ).json()
    expect(second.items).toHaveLength(2)
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeNull()
    expect(second.items.every((item: { ownerAgentId: string }) => item.ownerAgentId === own.agentId)).toBe(true)

    const diagnostic = await (
      await request('GET', `/api/squads/${squadId}/slots/tests/history?limit=100`, writeUser.token)
    ).json()
    expect(diagnostic.items).toHaveLength(100)
    expect(diagnostic.hasMore).toBe(true)
    expect(diagnostic.nextCursor).toBeString()
    const diagnosticTail = await (
      await request(
        'GET',
        `/api/squads/${squadId}/slots/tests/history?limit=100&cursor=${encodeURIComponent(diagnostic.nextCursor)}`,
        writeUser.token
      )
    ).json()
    expect(diagnosticTail.items).toHaveLength(2)
    expect(diagnosticTail.hasMore).toBe(false)
    const diagnosticItems = [...diagnostic.items, ...diagnosticTail.items]
    expect(new Set(diagnosticItems.map((item: { ownerAgentId: string }) => item.ownerAgentId))).toEqual(
      new Set([own.agentId, foreign.agentId])
    )
    expect(diagnosticItems.map((item: { id: string }) => item.id)).not.toContain(activeClaim!.id)
    expect(diagnosticItems.map((item: { id: string }) => item.id)).not.toContain(queuedWaiter!.id)
    expect(await (await request('GET', `/api/squads/${squadId}/slots/tests/history`, useUser.token)).json()).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    })

    for (const limit of ['0', '101', '1.5', 'Infinity']) {
      expect(
        (await request('GET', `/api/squads/${squadId}/slots/tests/history?limit=${limit}`, own.token)).status
      ).toBe(400)
    }
    const replay = await request(
      'GET',
      `/api/squads/${squadId}/slots/tests/history?cursor=${encodeURIComponent(first.nextCursor)}`,
      writeUser.token
    )
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ code: 'invalid_cursor' })
  })

  test('ordinary projections redact foreign actionable IDs while write diagnostics reveal them', async () => {
    const squadId = await squad('redaction')
    await register(squadId, 2)
    const first = await agent(squadId)
    const second = await agent(squadId)
    const firstClaim = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, first.token)).json()
    const secondClaim = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, second.token)).json()

    const ordinary = await (await request('GET', `/api/squads/${squadId}/slots/tests`, first.token)).json()
    expect(ordinary.holders.find((holder: { id?: string }) => holder.id === firstClaim.claim.id)).toBeDefined()
    expect(ordinary.holders.some((holder: { id?: string }) => holder.id === secondClaim.claim.id)).toBe(false)
    expect(ordinary.holders.every((holder: { ownerShortId?: string }) => holder.ownerShortId?.length === 8)).toBe(true)

    const diagnostics = await (await request('GET', `/api/squads/${squadId}/slots/tests`, writeUser.token)).json()
    expect(diagnostics.holders.map((holder: { id: string }) => holder.id).sort()).toEqual(
      [firstClaim.claim.id, secondClaim.claim.id].sort()
    )
  })
})

describe('UUID-addressed claim and waiter routes', () => {
  test('resolve the squad from the id alone and complete renew, release, and unsubscribe', async () => {
    const squadId = await squad('uuid-ops')
    await register(squadId, 1)
    const holder = await agent(squadId)
    const queuer = await agent(squadId)

    const claimed = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, holder.token)).json()
    expect(claimed.outcome).toBe('granted')
    const claimId = claimed.claim.id

    // No squad and no pool key in any of these paths.
    const renewed = await request('POST', `/api/slots/claims/${claimId}/renew`, holder.token)
    expect(renewed.status).toBe(200)
    expect((await renewed.json()).outcome).toBe('renewed')

    const queued = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, queuer.token)).json()
    expect(queued.outcome).toBe('queued')
    const unsubscribed = await request('DELETE', `/api/slots/waiters/${queued.waiter.id}`, queuer.token)
    expect(unsubscribed.status).toBe(200)
    expect((await unsubscribed.json()).outcome).toBe('canceled')

    const released = await request('DELETE', `/api/slots/claims/${claimId}`, holder.token)
    expect(released.status).toBe(200)
    expect((await released.json()).outcome).toBe('released')
  })

  test('answer 404, not 403, for a caller with no authority in the resolved squad', async () => {
    const ownerSquad = await squad('uuid-owner')
    const otherSquad = await squad('uuid-other')
    await register(ownerSquad, 1)
    const holder = await agent(ownerSquad)
    const outsider = await agent(otherSquad)

    const claimed = await (await request('POST', `/api/squads/${ownerSquad}/slots/tests/claims`, holder.token)).json()
    const claimId = claimed.claim.id

    // A guessed id from another squad must be indistinguishable from a
    // nonexistent one, so ids cannot be probed across squads.
    const foreign = await request('DELETE', `/api/slots/claims/${claimId}`, outsider.token)
    expect(foreign.status).toBe(404)
    const unknown = await request('DELETE', `/api/slots/claims/${crypto.randomUUID()}`, outsider.token)
    expect(unknown.status).toBe(404)
    expect(await foreign.json()).toEqual(await unknown.json())

    // The real owner is unaffected.
    expect((await request('DELETE', `/api/slots/claims/${claimId}`, holder.token)).status).toBe(200)
  })

  test('reject a malformed id as 404 without touching the database', async () => {
    const outsider = await agent(await squad('uuid-malformed'))
    expect((await request('POST', '/api/slots/claims/not-a-uuid/renew', outsider.token)).status).toBe(404)
    expect((await request('DELETE', '/api/slots/waiters/not-a-uuid', outsider.token)).status).toBe(404)
  })
})

describe('claim auto-subscribe', () => {
  test('queues a blocked claim by default and reports unavailable with subscribe=false', async () => {
    const squadId = await squad('auto-subscribe')
    await register(squadId, 1)
    const holder = await agent(squadId)
    const queuer = await agent(squadId)
    const decliner = await agent(squadId)
    await request('POST', `/api/squads/${squadId}/slots/tests/claims`, holder.token)

    const queued = await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, queuer.token)).json()
    expect(queued.outcome).toBe('queued')
    expect(queued.waiter.id).toBeTruthy()

    const declined = await (
      await request('POST', `/api/squads/${squadId}/slots/tests/claims?subscribe=false`, decliner.token)
    ).json()
    expect(declined.outcome).toBe('unavailable')
    expect(declined.waiter).toBeUndefined()
  })
})

describe('slot administration mutation responses', () => {
  test('register, update, and unregister expose stable outcome and message fields', async () => {
    const squadId = await squad('admin-responses')
    const registerResponse = await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, {
      key: 'tests',
      capacity: 2,
      claimTimeoutMs: 120_000,
    })
    expect(registerResponse.status).toBe(201)
    const registered = await registerResponse.json()
    expect(registered.outcome).toBe('registered')
    expect(typeof registered.message).toBe('string')
    expect(registered.message.length).toBeGreaterThan(0)
    expect(registered.pool).toMatchObject({
      squadId,
      key: 'tests',
      capacity: 2,
      claimTimeoutMs: 120_000,
      unregisteredAt: null,
    })
    expect(typeof registered.pool.id).toBe('string')

    const updated = await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { capacity: 3 })
    ).json()
    expect(updated.outcome).toBe('updated')
    expect(typeof updated.message).toBe('string')
    expect(updated.message.length).toBeGreaterThan(0)
    expect(updated.pool).toMatchObject({ id: registered.pool.id, key: 'tests', capacity: 3, claimTimeoutMs: 120_000 })

    const unregistered = await (await request('DELETE', `/api/squads/${squadId}/slots/tests`, writeUser.token)).json()
    expect(unregistered.outcome).toBe('unregistered')
    expect(typeof unregistered.message).toBe('string')
    expect(unregistered.message.length).toBeGreaterThan(0)
    expect(unregistered.pool).toMatchObject({ id: registered.pool.id, key: 'tests' })
    expect(unregistered.pool.unregisteredAt).not.toBeNull()
  })

  test('administration error status semantics are unchanged', async () => {
    const squadId = await squad('admin-response-errors')
    await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, { key: 'tests' })
    const duplicate = await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, { key: 'tests' })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ code: 'pool_exists' })

    const missing = await request('PATCH', `/api/squads/${squadId}/slots/absent`, writeUser.token, { capacity: 2 })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'pool_not_found' })
  })
})

describe('archived squad inertness', () => {
  test('every squad-scoped slot route denies an archived squad despite retained permissions', async () => {
    const squadId = await squad('archived-inert')
    await register(squadId)
    // A squad-scoped role assignment outlives archival; it must not revive slot access.
    const scopedRole = await createTestRole({ prefix, permissions: ['slots:write'] })
    await assignRole({ userId: writeUser.id, roleId: scopedRole.id, scope: 'squad', squadId })
    const now = new Date()
    await db.update(squads).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(eq(squads.id, squadId))

    const claimId = crypto.randomUUID()
    const waiterId = crypto.randomUUID()
    const routes: Array<[string, string]> = [
      ['GET', `/api/squads/${squadId}/slots`],
      ['GET', `/api/squads/${squadId}/slots/tests`],
      ['GET', `/api/squads/${squadId}/slots/tests/history`],
      ['POST', `/api/squads/${squadId}/slots`],
      ['PATCH', `/api/squads/${squadId}/slots/tests`],
      ['DELETE', `/api/squads/${squadId}/slots/tests`],
      ['POST', `/api/squads/${squadId}/slots/tests/claims`],
      ['POST', `/api/squads/${squadId}/slots/tests/claims/${claimId}/renew`],
      ['DELETE', `/api/squads/${squadId}/slots/tests/claims/${claimId}`],
      ['POST', `/api/squads/${squadId}/slots/tests/waiters`],
      ['DELETE', `/api/squads/${squadId}/slots/tests/waiters/${waiterId}`],
    ]
    for (const [method, path] of routes) {
      const response = await request(
        method,
        path,
        writeUser.token,
        method === 'POST' || method === 'PATCH' ? {} : undefined
      )
      expect(response.status, `${method} ${path}`).toBe(410)
      expect(await response.json(), `${method} ${path}`).toEqual({ error: 'Squad is archived' })
    }
  })

  test('UUID-addressed routes answer 404 for archived squads without revealing state', async () => {
    const squadId = await squad('archived-resource')
    const pool = await register(squadId, 1)
    const holder = await agent(squadId)
    const claim = await db
      .insert(slotClaims)
      .values({ poolId: pool.id, ownerAgentId: holder.agentId, expiresAt: new Date(Date.now() + 60_000) })
      .returning()
    const now = new Date()
    await db.update(squads).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(eq(squads.id, squadId))

    const renewed = await request('POST', `/api/slots/claims/${claim[0]!.id}/renew`, holder.token)
    expect(renewed.status).toBe(404)
    expect(await renewed.json()).toMatchObject({ code: 'claim_not_found' })
    const released = await request('DELETE', `/api/slots/claims/${claim[0]!.id}`, holder.token)
    expect(released.status).toBe(404)
    expect(await released.json()).toMatchObject({ code: 'claim_not_found' })
  })

  test('archival denial stays invisible to callers without squad permission', async () => {
    const squadId = await squad('archived-foreign')
    const stranger = await createTestUser({ prefix })
    const now = new Date()
    await db.update(squads).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(eq(squads.id, squadId))

    const response = await request('GET', `/api/squads/${squadId}/slots`, stranger.token)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Forbidden' })
  })
})

describe('slot pool usage guidance and enabled state', () => {
  test('register accepts guidance and list/get return it with the enabled state', async () => {
    const squadId = await squad('usage-register')
    const created = await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, {
      key: 'tests',
      usage: '  Claim before DB-backed tests.  ',
    })
    expect(created.status).toBe(201)
    const body = await created.json()
    expect(body.pool).toMatchObject({ usage: 'Claim before DB-backed tests.', disabledAt: null })
    expect(body.message).toContain('usage guidance')

    const [listed] = await (await request('GET', `/api/squads/${squadId}/slots`, useUser.token)).json()
    expect(listed).toMatchObject({ key: 'tests', usage: 'Claim before DB-backed tests.', enabled: true })
    expect(await (await request('GET', `/api/squads/${squadId}/slots/tests`, useUser.token)).json()).toMatchObject({
      usage: 'Claim before DB-backed tests.',
      enabled: true,
    })
  })

  test('rejects oversized guidance and an empty update', async () => {
    const squadId = await squad('usage-validation')
    const tooLong = 'x'.repeat(1001)
    expect(
      (await request('POST', `/api/squads/${squadId}/slots`, writeUser.token, { key: 'tests', usage: tooLong })).status
    ).toBe(400)
    await register(squadId)
    expect(
      (await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { usage: tooLong })).status
    ).toBe(400)
    expect((await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, {})).status).toBe(400)
    expect(
      (await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { enabled: 'no' })).status
    ).toBe(400)
  })

  test('partial PATCH changes or clears guidance without resending capacity or timeout', async () => {
    const squadId = await squad('usage-patch')
    await registerPool({ squadId, key: 'tests', capacity: 2, claimTimeoutMs: 120_000, createdBy: 'test' })

    const set = await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { usage: 'Claim before builds.' })
    ).json()
    expect(set).toMatchObject({
      outcome: 'updated',
      pool: { capacity: 2, claimTimeoutMs: 120_000, usage: 'Claim before builds.' },
    })
    expect(set.message).toContain('updated usage guidance')

    const cleared = await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { usage: null })
    ).json()
    expect(cleared.pool).toMatchObject({ capacity: 2, claimTimeoutMs: 120_000, usage: null })
    expect(cleared.message).toContain('no usage guidance')

    // Existing callers that send capacity/timeout keep working and keep guidance.
    await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { usage: 'Kept.' })
    const resized = await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, {
        capacity: 4,
        claimTimeoutMs: 180_000,
      })
    ).json()
    expect(resized.pool).toMatchObject({ capacity: 4, claimTimeoutMs: 180_000, usage: 'Kept.' })
  })

  test('PATCH enabled toggles enforcement; claims on a disabled pool answer disabled', async () => {
    const squadId = await squad('enabled-patch')
    await register(squadId)
    const holder = await agent(squadId)
    const waiter = await agent(squadId)
    expect(
      (await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, holder.token)).json()).outcome
    ).toBe('granted')
    expect(
      (await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, waiter.token)).json()).outcome
    ).toBe('queued')

    // Using the pool is not enough to change its enforcement.
    expect(
      (await request('PATCH', `/api/squads/${squadId}/slots/tests`, useUser.token, { enabled: false })).status
    ).toBe(403)
    const disabled = await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { enabled: false })
    ).json()
    expect(disabled.outcome).toBe('updated')
    expect(disabled.pool.disabledAt).not.toBeNull()
    expect(disabled.message).toContain('is disabled')
    expect(disabled.message).toContain('1 queued waiter was canceled and notified')

    const [listed] = await (await request('GET', `/api/squads/${squadId}/slots`, useUser.token)).json()
    expect(listed).toMatchObject({ enabled: false, activeCount: 1, queuedCount: 0 })

    for (const path of [`/api/squads/${squadId}/slots/tests/claims`, `/api/squads/${squadId}/slots/tests/waiters`]) {
      const response = await request('POST', path, waiter.token)
      expect(response.status).toBe(200)
      expect((await response.json()).outcome).toBe('disabled')
    }

    const enabled = await (
      await request('PATCH', `/api/squads/${squadId}/slots/tests`, writeUser.token, { enabled: true })
    ).json()
    expect(enabled.pool.disabledAt).toBeNull()
    expect(enabled.message).toContain('is enabled')
    expect(
      (await (await request('POST', `/api/squads/${squadId}/slots/tests/claims`, waiter.token)).json()).outcome
    ).toBe('queued')
  })
})
