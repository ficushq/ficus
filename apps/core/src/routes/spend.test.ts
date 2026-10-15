import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SpendBreakdown, SpendSummary } from '@ficus/shared'
import { identityMiddleware } from '../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import spendRouter from './spend'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/spend', spendRouter)

const prefix = `spend-route-${crypto.randomUUID()}`
let admin: TestUser
let providerReader: TestUser
let spendReader: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  providerReader = await createTestUser({ prefix })
  spendReader = await createTestUser({ prefix })
  const providerRole = await createTestRole({ prefix, permissions: ['provider-auth:read', 'settings:read'] })
  const spendRole = await createTestRole({ prefix: `${prefix}-usage`, permissions: ['usage:read'] })
  await assignRole({ userId: providerReader.id, roleId: providerRole.id, scope: 'system' })
  await assignRole({ userId: spendReader.id, roleId: spendRole.id, scope: 'system' })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
  await cleanupTestRbac(`${prefix}-usage`)
})

const get = (path: string, user: TestUser) => app.request(path, { headers: authHeaders(user.token) })

describe('spend API', () => {
  test('admins and holders of usage:read can read it', async () => {
    const summary = await get('/api/spend/summary', admin)
    expect(summary.status).toBe(200)
    const body = (await summary.json()) as SpendSummary
    expect(body.totals).toMatchObject({ calls: expect.any(Number), totalUsd: expect.any(Number) })
    expect(Array.isArray(body.series)).toBe(true)
    expect(body.meta.retentionDays).toBe(180)

    const breakdown = await get(
      '/api/spend/breakdown?by=feature&by2=billing&limit=5&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z',
      spendReader
    )
    expect(breakdown.status).toBe(200)
    expect(((await breakdown.json()) as SpendBreakdown).by2).toBe('billing')
  })

  test('provider-auth and settings readers without usage:read are refused', async () => {
    expect((await get('/api/spend/summary', providerReader)).status).toBe(403)
    expect((await get('/api/spend/breakdown?by=model', providerReader)).status).toBe(403)
  })

  test('rejects bad dimensions, filters and ranges', async () => {
    expect((await get('/api/spend/breakdown?by=colour', admin)).status).toBe(400)
    expect((await get('/api/spend/breakdown', admin)).status).toBe(400)
    expect((await get('/api/spend/summary?billing=free', admin)).status).toBe(400)
    expect((await get('/api/spend/summary?from=yesterday', admin)).status).toBe(400)
    expect((await get('/api/spend/summary?from=2025-01-01T00:00:00Z&to=2026-10-01T00:00:00Z', admin)).status).toBe(400)
    expect((await get('/api/spend/summary?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z', admin)).status).toBe(400)
  })

  test('no bundled role grants usage:read', () => {
    const roles = readFileSync(join(import.meta.dir, '../../../../config/roles/defaults.yaml'), 'utf8')
    expect(roles).not.toContain('usage:read')
  })
})
