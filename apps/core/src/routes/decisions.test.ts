import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { DecisionFeatureView } from '@ficus/shared'
import { db, settings } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { DECISION_FEATURES_KEY } from '../services/decisions/store'
import { getSettingsStore, resetSettingsStore } from '../services/settings'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'
import decisionsRouter from './decisions'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/decisions', decisionsRouter)

const prefix = `decisions-route-${crypto.randomUUID()}`
let admin: TestUser
let prior: (typeof settings.$inferSelect)[] = []

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

beforeEach(async () => {
  prior = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [DECISION_FEATURES_KEY]))
  await db.delete(settings).where(inArray(settings.key, [DECISION_FEATURES_KEY]))
  resetSettingsStore()
  await getSettingsStore().initialize()
})

afterEach(async () => {
  await db.delete(settings).where(inArray(settings.key, [DECISION_FEATURES_KEY]))
  if (prior.length) await db.insert(settings).values(prior)
  resetSettingsStore()
})

const put = (id: string, value: string) =>
  app.request(`/api/decisions/features/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  })

describe('decision feature switches', () => {
  test('a sub-feature has its own switch, and reports its parent', async () => {
    const response = await put('tool-results-shell', 'off')
    expect(response.status).toBe(200)
    const features = (await response.json()) as DecisionFeatureView[]
    expect(features.find((feature) => feature.id === 'tool-results-shell')).toMatchObject({
      parent: 'tool-results',
      switch: 'off',
      enabled: false,
    })
    expect(features.find((feature) => feature.id === 'tool-results')?.switch).toBe('auto')
    expect((await put('tool-results-shell', 'auto')).status).toBe(200)
  })

  test('features without an instance switch are refused', async () => {
    expect((await put('github-firewall', 'off')).status).toBe(400)
    expect((await put('nonsense', 'off')).status).toBe(400)
  })
})
