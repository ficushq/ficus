import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { liveActivityTokens, squads, workStreams, workStreamWaits } from '../db/schema'
import { identityMiddleware } from '../middleware/identity'
import { assignRole, createTestRole, authHeaders, cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'
import { subscribeToSquad } from '../services/squad/subscriptions'
import { subscribeToWorkStream } from '../services/work-streams/subscriptions'
import { listWorkStreamNotifyUserIds } from '../services/attention/resolver'
import { registerLiveActivityFanout } from '../services/push/live-activity'
import { pushRouter } from './push'

const prefix = `la-route-${crypto.randomUUID().slice(0, 8)}`

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/push', pushRouter)

let user: TestUser
let other: TestUser
const tokens: string[] = []

function register(body: unknown, as: TestUser) {
  return app.request('/api/push/live-activity', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(as.token) },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  user = await createTestUser({ prefix })
  other = await createTestUser({ prefix })
})

afterAll(async () => {
  for (const token of tokens) await db.delete(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))
  await cleanupTestRbac(prefix)
})

describe('GET /api/push/work-interest', () => {
  test('rejects unauthenticated callers and returns the safe aggregate for a user', async () => {
    expect((await app.request('/api/push/work-interest')).status).toBe(401)
    const response = await app.request('/api/push/work-interest', { headers: authHeaders(user.token) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      totalCount: 0,
      top: [],
      liveActivity: { activeCount: 0, needsYouCount: 0, top: [] },
    })
  })
})

test('default and explicit Show reach widgets and background Live Activities without alert subscriptions', async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-show`, purpose: 'Native passive visibility' })
    .returning()
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId: squad!.id, title: 'Visible work', status: 'active' })
    .returning()
  await db.insert(workStreamWaits).values({ workStreamId: stream!.id, type: 'review' })
  const role = await createTestRole({ prefix, permissions: ['squads:read', 'workstreams:read'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad!.id })
  const token = `${prefix}-show-update`
  tokens.push(token)
  let scheduled = 0
  const sent: unknown[] = []
  const fanout = registerLiveActivityFanout(
    { on: () => () => {} },
    {
      hasApnsConfig: () => true,
      setTimer: () => {
        scheduled++
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
      send: async (_token, payload) => {
        sent.push(payload)
        return { ok: true, status: 200 }
      },
    }
  )
  const snapshot = async (as = user) => {
    const response = await app.request('/api/push/work-interest', { headers: authHeaders(as.token) })
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    expect((await snapshot()).top.map((row: { id: string }) => row.id)).toEqual([stream!.id])
    expect((await snapshot(other)).totalCount).toBe(0)
    expect(await listWorkStreamNotifyUserIds(stream!.id, squad!.id, 'progress')).toEqual([])
    expect((await register({ apnsToken: token, kind: 'update', activityId: 'show-activity' }, user)).status).toBe(201)
    await fanout.onWorkStreamEvent({ squadId: squad!.id, workStreamId: stream!.id })
    expect(scheduled).toBeGreaterThan(0)
    await fanout.flushUser(user.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ event: 'update', contentState: { top: [{ id: stream!.id }] } })
    await subscribeToSquad(squad!.id, user.id, { decisions: 'show', progress: 'show' })
    expect((await snapshot()).totalCount).toBe(1)
    expect(await listWorkStreamNotifyUserIds(stream!.id, squad!.id, 'decisions')).toEqual([])
    await subscribeToWorkStream(stream!.id, user.id, { decisions: 'mute', progress: 'mute' })
    expect((await snapshot()).totalCount).toBe(0)
    await fanout.flushUser(user.id)
    expect(sent.at(-1)).toMatchObject({ event: 'end', contentState: { top: [] } })
  } finally {
    fanout.stop()
    await db.delete(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))
    await db.delete(squads).where(eq(squads.id, squad!.id))
  }
})

describe('POST /api/push/live-activity', () => {
  test('rejects an unauthenticated caller', async () => {
    const response = await app.request('/api/push/live-activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apnsToken: 'nope', kind: 'start' }),
    })
    expect(response.status).toBe(401)
  })

  test('requires an apnsToken', async () => {
    expect((await register({ kind: 'start' }, user)).status).toBe(400)
  })

  test('rejects a kind outside start|update rather than storing an unroutable row', async () => {
    expect((await register({ apnsToken: 'tok-bad-kind', kind: 'device' }, user)).status).toBe(400)
  })

  // An update token that names no activity can never be targeted at one, so it must not be stored.
  test('requires activityId for an update token', async () => {
    const response = await register({ apnsToken: 'tok-no-activity', kind: 'update' }, user)
    expect(response.status).toBe(400)
    const rows = await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, 'tok-no-activity'))
    expect(rows).toHaveLength(0)
  })

  test('registers an update token', async () => {
    const token = `tok-update-${crypto.randomUUID()}`
    tokens.push(token)
    const response = await register({ apnsToken: token, kind: 'update', activityId: 'act-1' }, user)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ kind: 'update', activityId: 'act-1' })
  })

  test('registers a start token with no activity binding', async () => {
    const token = `tok-start-${crypto.randomUUID()}`
    tokens.push(token)
    const response = await register({ apnsToken: token, kind: 'start' }, user)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ kind: 'start', activityId: null })
  })
})

describe('DELETE /api/push/live-activity', () => {
  function unregister(apnsToken: string, as: TestUser) {
    return app.request('/api/push/live-activity', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...authHeaders(as.token) },
      body: JSON.stringify({ apnsToken }),
    })
  }

  test('a user cannot delete another user’s token, and the row survives', async () => {
    const token = `tok-scoped-${crypto.randomUUID()}`
    tokens.push(token)
    await register({ apnsToken: token, kind: 'start' }, user)

    expect((await unregister(token, other)).status).toBe(404)
    expect(await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))).toHaveLength(1)

    expect((await unregister(token, user)).status).toBe(200)
    expect(await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, token))).toHaveLength(0)
  })

  test('404s an unknown token instead of reporting success', async () => {
    expect((await unregister('tok-never-registered', user)).status).toBe(404)
  })
})
