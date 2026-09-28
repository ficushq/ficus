import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from './identity'
import { requireSecretKeyPermission, requireSecretListAccess } from './require-secret-permission'
import { resetSecretGroups } from '../services/secrets/groups'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
} from '../test-utils'

const PREFIX = 'secret-guard-test'

function buildApp() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.get('/secret/:key', requireSecretKeyPermission('read'), (c) =>
    c.json({ ok: true, authzChecked: c.get('authzChecked') })
  )
  app.get('/secrets', requireSecretListAccess(), (c) => c.json({ ok: true, authzChecked: c.get('authzChecked') }))
  return app
}

async function createUserWithPermissions(permissions: string[]) {
  const user = await createTestUser({ prefix: PREFIX })
  const role = await createTestRole({ prefix: PREFIX, permissions })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
  return user
}

describe('requireSecretKeyPermission / requireSecretListAccess', () => {
  beforeAll(async () => {
    await cleanupTestRbac(PREFIX)
  })

  beforeEach(() => {
    resetSecretGroups()
  })

  afterEach(() => {
    resetSecretGroups()
  })

  afterAll(async () => {
    resetSecretGroups()
    await cleanupTestRbac(PREFIX)
  })

  test('missing identity returns 401', async () => {
    const app = buildApp()

    expect((await app.request('/secret/GITHUB_TOKEN')).status).toBe(401)
    expect((await app.request('/secrets')).status).toBe(401)
  })

  test('authenticated user without secrets permission returns 403', async () => {
    const app = buildApp()
    const user = await createUserWithPermissions(['agents:read'])

    expect((await app.request('/secret/GITHUB_TOKEN', { headers: authHeaders(user.token) })).status).toBe(403)
    expect((await app.request('/secrets', { headers: authHeaders(user.token) })).status).toBe(403)
  })

  test('integration reader can read integration keys but not system keys and can reach list guard', async () => {
    const app = buildApp()
    const user = await createUserWithPermissions(['secrets:read:integration'])

    const allowed = await app.request('/secret/GITHUB_TOKEN', { headers: authHeaders(user.token) })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ ok: true, authzChecked: true })

    expect((await app.request('/secret/FICUS_PASSWORD', { headers: authHeaders(user.token) })).status).toBe(403)

    const list = await app.request('/secrets', { headers: authHeaders(user.token) })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ ok: true, authzChecked: true })
  })

  test('admin can read every key and reach list guard', async () => {
    const app = buildApp()
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })

    expect((await app.request('/secret/GITHUB_TOKEN', { headers: authHeaders(admin.token) })).status).toBe(200)
    expect((await app.request('/secret/FICUS_PASSWORD', { headers: authHeaders(admin.token) })).status).toBe(200)
    expect((await app.request('/secret/UNMATCHED_KEY', { headers: authHeaders(admin.token) })).status).toBe(200)
    expect((await app.request('/secrets', { headers: authHeaders(admin.token) })).status).toBe(200)
  })
})
