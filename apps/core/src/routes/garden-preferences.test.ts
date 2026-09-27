import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { gardenPreferencesRouter } from './garden-preferences'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'
import { db, gardenPreferences, users } from '../db'

const prefix = `garden-prefs-${crypto.randomUUID()}`
let a: TestUser
let b: TestUser
const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/garden-preferences', gardenPreferencesRouter)
const get = (user: TestUser) => app.request('/garden-preferences/me', { headers: authHeaders(user.token) })
const put = (user: TestUser, body: unknown) =>
  app.request('/garden-preferences/me', {
    method: 'PUT',
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

test('anonymous access cannot read or change a garden preference', async () => {
  for (const method of ['GET', 'PUT'])
    expect((await app.request('/garden-preferences/me', { method })).status).toBe(401)
})

test('no choice is null; each caller reads and writes only their own style', async () => {
  expect(await (await get(a)).json()).toEqual({ userId: a.id, style: null })
  expect((await put(a, { expectedUserId: a.id, style: 'blueprint' })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, style: 'blueprint' })
  expect(await (await get(b)).json()).toEqual({ userId: b.id, style: null })
  expect((await put(a, { expectedUserId: a.id, style: 'sketchbook' })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, style: 'sketchbook' })
  expect(await db.select().from(gardenPreferences).where(eq(gardenPreferences.userId, a.id))).toHaveLength(1)
})

test('identity precondition rejects writes sent with a different account session', async () => {
  expect((await put(b, { expectedUserId: a.id, style: 'futurist' })).status).toBe(409)
  expect((await put(b, { style: 'futurist' })).status).toBe(409)
  expect(await (await get(b)).json()).toEqual({ userId: b.id, style: null })
})

test('rejects unknown styles, malformed and oversized bodies without changing the choice', async () => {
  const before = await (await get(a)).json()
  const malformed = await app.request('/garden-preferences/me', {
    method: 'PUT',
    headers: authHeaders(a.token),
    body: '{',
  })
  expect(malformed.status).toBe(400)
  // Old names are the garden's to map; the account only stores current style ids.
  for (const style of ['grid', 'farm', '', null, 3, { id: 'blueprint' }])
    expect((await put(a, { expectedUserId: a.id, style })).status).toBe(400)
  expect((await put(a, { expectedUserId: a.id, style: 'futurist', padding: 'x'.repeat(2000) })).status).toBe(413)
  expect(await (await get(a)).json()).toEqual(before)
})

test('user deletion cascades the garden preference row', async () => {
  const removable = await createTestUser({ prefix })
  await put(removable, { expectedUserId: removable.id, style: 'futurist' })
  await db.delete(users).where(eq(users.id, removable.id))
  expect(await db.select().from(gardenPreferences).where(eq(gardenPreferences.userId, removable.id))).toHaveLength(0)
})
