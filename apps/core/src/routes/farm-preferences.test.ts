import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { farmPreferencesRouter } from './farm-preferences'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'
import { db, farmPreferences, users } from '../db'

const prefix = `farm-prefs-${crypto.randomUUID()}`
let a: TestUser
let b: TestUser
const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/farm-preferences', farmPreferencesRouter)
const get = (user: TestUser) => app.request('/farm-preferences/me', { headers: authHeaders(user.token) })
const patch = (user: TestUser, body: unknown) =>
  app.request('/farm-preferences/me', {
    method: 'PATCH',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
beforeAll(async () => {
  a = await createTestUser({ prefix })
  b = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})

test('anonymous access cannot read or change farm settings', async () => {
  for (const method of ['GET', 'PATCH'])
    expect((await app.request('/farm-preferences/me', { method })).status).toBe(401)
})

test('no settings yet is empty; each caller reads and changes only their own', async () => {
  expect(await (await get(a)).json()).toEqual({ userId: a.id, settings: {} })
  const saved = await patch(a, { expectedUserId: a.id, settings: { style: 'blueprint' } })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ userId: a.id, settings: { style: 'blueprint' } })
  expect(await (await get(a)).json()).toEqual({ userId: a.id, settings: { style: 'blueprint' } })
  expect(await (await get(b)).json()).toEqual({ userId: b.id, settings: {} })
  expect((await patch(a, { expectedUserId: a.id, settings: { style: 'sketchbook' } })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, settings: { style: 'sketchbook' } })
  expect(await db.select().from(farmPreferences).where(eq(farmPreferences.userId, a.id))).toHaveLength(1)
})

test('a change leaves the settings it does not name as they were', async () => {
  expect((await patch(a, { expectedUserId: a.id, settings: { style: 'futurist' } })).status).toBe(200)
  const unchanged = await patch(a, { expectedUserId: a.id, settings: {} })
  expect(await unchanged.json()).toEqual({ userId: a.id, settings: { style: 'futurist' } })
  // Two clients saving different settings: neither undoes the other.
  expect((await patch(a, { expectedUserId: a.id, settings: { sound: true } })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, settings: { style: 'futurist', sound: true } })
  expect((await patch(a, { expectedUserId: a.id, settings: { style: 'blueprint' } })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, settings: { style: 'blueprint', sound: true } })
  expect((await patch(a, { expectedUserId: a.id, settings: { sound: false } })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, settings: { style: 'blueprint', sound: false } })
})

test('stored keys the current code does not know are not returned', async () => {
  const legacy = await createTestUser({ prefix })
  await db.insert(farmPreferences).values({
    userId: legacy.id,
    settings: { style: 'nostalgic', retired: true } as never,
  })
  expect(await (await get(legacy)).json()).toEqual({ userId: legacy.id, settings: { style: 'nostalgic' } })
  const changed = await patch(legacy, { expectedUserId: legacy.id, settings: { style: 'blueprint' } })
  expect(await changed.json()).toEqual({ userId: legacy.id, settings: { style: 'blueprint' } })
})

test('identity precondition rejects writes sent with a different account session', async () => {
  expect((await patch(b, { expectedUserId: a.id, settings: { style: 'futurist' } })).status).toBe(409)
  expect((await patch(b, { settings: { style: 'futurist' } })).status).toBe(409)
  expect(await (await get(b)).json()).toEqual({ userId: b.id, settings: {} })
})

test('rejects unknown settings, invalid values, malformed and oversized bodies without changing anything', async () => {
  const before = await (await get(a)).json()
  const malformed = await app.request('/farm-preferences/me', {
    method: 'PATCH',
    headers: authHeaders(a.token),
    body: '{',
  })
  expect(malformed.status).toBe(400)
  // Old style names are the farm's to map; the account only stores current ids.
  for (const settings of [
    { style: 'grid' },
    { style: '' },
    { style: null },
    { style: 'blueprint', zoom: 2 },
    { sound: 'on' },
    null,
    'blueprint',
    ['style'],
  ])
    expect((await patch(a, { expectedUserId: a.id, settings })).status).toBe(400)
  expect(
    (await patch(a, { expectedUserId: a.id, settings: { style: 'futurist' }, padding: 'x'.repeat(5000) })).status
  ).toBe(413)
  expect(await (await get(a)).json()).toEqual(before)
})

test('user deletion cascades the farm settings row', async () => {
  const removable = await createTestUser({ prefix })
  await patch(removable, { expectedUserId: removable.id, settings: { style: 'futurist' } })
  await db.delete(users).where(eq(users.id, removable.id))
  expect(await db.select().from(farmPreferences).where(eq(farmPreferences.userId, removable.id))).toHaveLength(0)
})
