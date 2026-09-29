import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import secretsRouter from './secrets'
import settingsRouter from './settings'
import { identityMiddleware } from '../middleware/identity'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { resetSecretGroups } from '../services/secrets/groups'
import { getSettingsStore, resetSettingsStore } from '../services/settings'
import { db, secrets, settings } from '../db'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { parseJsonBody } from './json-body'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/secrets', secretsRouter)
app.route('/settings', settingsRouter)

const prefix = `b14-secrets-settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser
let operator: TestUser
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const originalFetch = globalThis.fetch

function req(method = 'GET', body?: unknown, token = admin.token) {
  return {
    method,
    headers: { ...authHeaders(token), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }
}

function rawJsonReq(body: string | undefined, token = admin.token) {
  return {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body,
  }
}

describe('parseJsonBody', () => {
  test('rethrows body-consumption failures', async () => {
    const parserApp = new Hono().post('/', async (c) => {
      await c.req.raw.text()
      await parseJsonBody(c)
      return c.body(null, 204)
    })
    const response = await parserApp.request('/', { method: 'POST', body: '{}' })
    expect(response.status).toBe(500)
  })
})

describe('B14 secrets and settings RBAC', () => {
  beforeAll(async () => {
    admin = await createTestAdmin({ prefix, canonicalAdmin: true })
    unprivileged = await createTestUser({ prefix })
    operator = await createTestUser({ prefix })
    const operatorRole = await createTestRole({
      prefix,
      permissions: ['secrets:read:integration', 'secrets:write:integration'],
    })
    await assignRole({ userId: operator.id, roleId: operatorRole.id, scope: 'system' })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = encryptionKey
    await db.delete(secrets)
    await db.delete(settings)
    resetSecretGroups()
    resetSecretStore()
    resetSettingsStore()
    await getSecretStore().initialize()
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.github.com/')) return Response.json({ login: 'octocat' })
      return originalFetch(input, init)
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('denies unauthenticated secrets and settings requests', async () => {
    expect((await app.request('/secrets')).status).toBe(401)
    expect((await app.request('/settings')).status).toBe(401)
  })

  test('hosted exe.dev credentials are absent from lists and cannot be revealed or changed', async () => {
    const previous = process.env.FICUS_MANAGED
    try {
      process.env.FICUS_MANAGED = '1'
      await getSecretStore().set('exe-provider-ssh-key', 'fixture-private-key')
      const listing = await (await app.request('/secrets', req())).json()
      expect(listing.secrets.some((secret: { key: string }) => secret.key === 'exe-provider-ssh-key')).toBe(false)
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await app.request(
          '/secrets/exe-provider-ssh-key',
          req(method, method === 'PUT' ? { value: 'replacement' } : undefined)
        )
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain('fixture-private-key')
      }
      expect(getSecretStore().get('exe-provider-ssh-key')).toBe('fixture-private-key')
    } finally {
      if (previous === undefined) delete process.env.FICUS_MANAGED
      else process.env.FICUS_MANAGED = previous
    }
  })

  test('rejects every internal double-underscore key before generic store access', async () => {
    const internalKey = '__integration-oauth-app:notion'
    expect((await app.request(`/secrets/${internalKey}`, req())).status).toBe(404)
    expect((await app.request(`/secrets/${internalKey}`, req('PUT', { value: 'must-not-write' }))).status).toBe(404)
    expect((await app.request(`/secrets/${internalKey}`, req('DELETE'))).status).toBe(404)
    expect(getSecretStore().get(internalKey)).toBeUndefined()
  })

  test('denies unprivileged secrets read and write', async () => {
    expect((await app.request('/secrets', req('GET', undefined, unprivileged.token))).status).toBe(403)
    expect((await app.request('/secrets/API_KEY', req('PUT', { value: 'redacted' }, unprivileged.token))).status).toBe(
      403
    )
    expect((await app.request('/secrets/API_KEY', req('DELETE', undefined, unprivileged.token))).status).toBe(403)
  })

  test('allows admin to manage secrets without exposing values in list', async () => {
    const put = await app.request('/secrets/API_KEY', req('PUT', { value: 'redacted-secret-value' }))
    expect(put.status).toBe(200)

    const list = await app.request('/secrets', req())
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).not.toContain('redacted-secret-value')

    const get = await app.request('/secrets/API_KEY', req())
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ key: 'API_KEY', value: 'redacted-secret-value' })
  })

  test.each([
    ['malformed token', '{ nope }'],
    ['truncated JSON', '{"value":'],
    ['empty body', ''],
    ['absent body', undefined],
  ])('returns a stable 400 for %s without invoking either store', async (_label, body) => {
    const secretStore = getSecretStore()
    const settingsStore = getSettingsStore()
    const secretSet = spyOn(secretStore, 'set')
    const settingSet = spyOn(settingsStore, 'set')

    const secretResponse = await app.request('/secrets/MALFORMED_JSON_TEST_KEY', rawJsonReq(body))
    const settingResponse = await app.request('/settings/MAX_CONCURRENT_AGENTS', rawJsonReq(body))

    expect(secretResponse.status).toBe(400)
    expect(await secretResponse.json()).toEqual({ error: 'Invalid JSON body' })
    expect(settingResponse.status).toBe(400)
    expect(await settingResponse.json()).toEqual({ error: 'Invalid JSON body' })
    expect(secretSet).not.toHaveBeenCalled()
    expect(settingSet).not.toHaveBeenCalled()
    expect(secretStore.get('MALFORMED_JSON_TEST_KEY')).toBeUndefined()
    expect(settingsStore.getStoredValue('MAX_CONCURRENT_AGENTS')).toBeUndefined()

    secretSet.mockRestore()
    settingSet.mockRestore()
  })

  test('authorization runs before JSON parsing', async () => {
    const malformed = '{"value":'
    expect((await app.request('/secrets/DEPLOY_TEST_TOKEN', rawJsonReq(malformed, unprivileged.token))).status).toBe(
      403
    )
    expect(
      (await app.request('/settings/MAX_CONCURRENT_AGENTS', rawJsonReq(malformed, unprivileged.token))).status
    ).toBe(403)
  })

  test('accepts empty and normal strings for both write routes', async () => {
    const emptySecret = await app.request('/secrets/DEPLOY_TEST_TOKEN', req('PUT', { value: '' }))
    expect(emptySecret.status).toBe(200)
    expect('validation' in ((await emptySecret.json()) as object)).toBe(false)
    expect((await app.request('/settings/LOCAL_AUTO_UPDATE_REMOTE', req('PUT', { value: '' }))).status).toBe(200)
    const normalSecret = await app.request('/secrets/DEPLOY_TEST_TOKEN', req('PUT', { value: 'secret' }))
    expect(normalSecret.status).toBe(200)
    expect('validation' in ((await normalSecret.json()) as object)).toBe(false)
    expect((await app.request('/settings/LOCAL_AUTO_UPDATE_REMOTE', req('PUT', { value: 'origin' }))).status).toBe(200)
    expect(getSecretStore().get('DEPLOY_TEST_TOKEN')).toBe('secret')
    expect(getSettingsStore().getStoredValue('LOCAL_AUTO_UPDATE_REMOTE')).toBe('origin')
  })

  test('rejects non-string values without mutating known or dynamic secrets', async () => {
    const store = getSecretStore()
    const invalidBodies = [
      null,
      [],
      {},
      { value: null },
      { value: 42 },
      { value: true },
      { value: ['secret'] },
      { value: { secret: 'value' } },
    ]

    for (const key of ['DEPLOY_TEST_TOKEN', 'RANDOM_KEY']) {
      await store.set(key, 'original-value', 'test')
      const persistedBefore = (await db.select().from(secrets)).find((secret) => secret.key === key)

      for (const body of invalidBodies) {
        const response = await app.request(`/secrets/${key}`, req('PUT', body))

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Secret value must be a string' })
        expect(store.get(key)).toBe('original-value')
        expect((await db.select().from(secrets)).find((secret) => secret.key === key)).toEqual(persistedBefore)
      }
    }
  })

  test('admin reads and lists all groups including system and unmatched keys', async () => {
    await app.request('/secrets/DEPLOY_TEST_TOKEN', req('PUT', { value: 'gh' }))
    await app.request('/secrets/FICUS_PASSWORD', req('PUT', { value: 'pw' }))
    await app.request('/secrets/RANDOM_KEY', req('PUT', { value: 'r' }))

    const list = await app.request('/secrets', req())
    expect(list.status).toBe(200)
    const keys = ((await list.json()) as { secrets: Array<{ key: string; isSet: boolean }> }).secrets
      .filter((secret) => secret.isSet)
      .map((secret) => secret.key)
    expect(keys).toEqual(expect.arrayContaining(['DEPLOY_TEST_TOKEN', 'FICUS_PASSWORD', 'RANDOM_KEY']))
    expect((await app.request('/secrets/FICUS_PASSWORD', req())).status).toBe(200)
  })

  test('group-limited operator list shows only integration and read/write/delete are scoped', async () => {
    await app.request('/secrets/DEPLOY_TEST_TOKEN', req('PUT', { value: 'gh' }))
    await app.request('/secrets/OPENAI_API_KEY', req('PUT', { value: 'oai' }))
    await app.request('/secrets/FICUS_PASSWORD', req('PUT', { value: 'pw' }))

    const list = await app.request('/secrets', req('GET', undefined, operator.token))
    expect(list.status).toBe(200)
    const setKeys = ((await list.json()) as { secrets: Array<{ key: string; isSet: boolean }> }).secrets
      .filter((secret) => secret.isSet)
      .map((secret) => secret.key)
    expect(setKeys).toContain('DEPLOY_TEST_TOKEN')
    expect(setKeys).not.toContain('OPENAI_API_KEY')
    expect(setKeys).not.toContain('FICUS_PASSWORD')

    expect((await app.request('/secrets/DEPLOY_TEST_TOKEN', req('GET', undefined, operator.token))).status).toBe(200)
    expect((await app.request('/secrets/OPENAI_API_KEY', req('GET', undefined, operator.token))).status).toBe(403)
    expect((await app.request('/secrets/FICUS_PASSWORD', req('GET', undefined, operator.token))).status).toBe(403)

    expect((await app.request('/secrets/GITHUB_DEPLOY_KEY', req('PUT', { value: 'x' }, operator.token))).status).toBe(
      200
    )
    expect((await app.request('/secrets/OPENAI_API_KEY', req('PUT', { value: 'x' }, operator.token))).status).toBe(403)
    expect((await app.request('/secrets/FICUS_PASSWORD', req('DELETE', undefined, operator.token))).status).toBe(403)
    expect((await app.request('/secrets/DEPLOY_TEST_TOKEN', req('DELETE', undefined, operator.token))).status).toBe(200)
  })

  test('unmatched key is admin-only for list read and write', async () => {
    await app.request('/secrets/RANDOM_KEY', req('PUT', { value: 'r' }))

    const list = await app.request('/secrets', req('GET', undefined, operator.token))
    expect(list.status).toBe(200)
    const setKeys = ((await list.json()) as { secrets: Array<{ key: string; isSet: boolean }> }).secrets
      .filter((secret) => secret.isSet)
      .map((secret) => secret.key)
    expect(setKeys).not.toContain('RANDOM_KEY')
    expect((await app.request('/secrets/RANDOM_KEY', req('GET', undefined, operator.token))).status).toBe(403)
    expect((await app.request('/secrets/RANDOM_KEY', req('PUT', { value: 'x' }, operator.token))).status).toBe(403)
  })

  test('self-hosted relay credentials cannot be listed, read, replaced or deleted through tenant APIs', async () => {
    const prior = process.env.FICUS_PUSH_RELAY_TOKEN
    const managed = process.env.FICUS_MANAGED_SECRET_KEYS
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    process.env.FICUS_PUSH_RELAY_TOKEN = 'owned-relay-credential-canary'
    try {
      const list = await app.request('/secrets', req())
      expect(list.status).toBe(200)
      const raw = await list.text()
      expect(raw).not.toContain('FICUS_PUSH_RELAY_TOKEN')
      expect(raw).not.toContain('owned-relay-credential-canary')
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await app.request(
          '/secrets/FICUS_PUSH_RELAY_TOKEN',
          req(method, method === 'PUT' ? { value: 'replacement' } : undefined)
        )
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain('owned-relay-credential-canary')
      }
      expect(process.env.FICUS_PUSH_RELAY_TOKEN).toBe('owned-relay-credential-canary')
    } finally {
      if (prior === undefined) delete process.env.FICUS_PUSH_RELAY_TOKEN
      else process.env.FICUS_PUSH_RELAY_TOKEN = prior
      if (managed === undefined) delete process.env.FICUS_MANAGED_SECRET_KEYS
      else process.env.FICUS_MANAGED_SECRET_KEYS = managed
    }
  })

  test('platform-managed keys are invisible: excluded from list, surfaced as names, and fail closed on read/write/delete', async () => {
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_ID'
    process.env.APNS_KEY_ID = 'platform-delivered'
    try {
      const body = (await (await app.request('/secrets', req())).json()) as {
        secrets: Array<{ key: string }>
        managedKeys: string[]
      }
      // Not a store entry the tenant can see…
      expect(body.secrets.some((s) => s.key === 'APNS_KEY_ID')).toBe(false)
      // …but its NAME is surfaced so the UI can render "Managed by your platform".
      expect(body.managedKeys).toContain('APNS_KEY_ID')

      // Even an admin cannot read/write/delete a managed key — fail closed (403),
      // never leaking the env-delivered value.
      const get = await app.request('/secrets/APNS_KEY_ID', req())
      expect(get.status).toBe(403)
      expect(JSON.stringify(await get.json())).not.toContain('platform-delivered')
      expect((await app.request('/secrets/APNS_KEY_ID', req('PUT', { value: 'x' }))).status).toBe(403)
      expect((await app.request('/secrets/APNS_KEY_ID', req('DELETE'))).status).toBe(403)
    } finally {
      delete process.env.FICUS_MANAGED
      delete process.env.FICUS_MANAGED_SECRET_KEYS
      delete process.env.APNS_KEY_ID
    }
  })

  test('retired Notion OAuth declarations stay managed but are tombstoned from the settings API', async () => {
    for (const key of ['NOTION_OAUTH_CLIENT_ID', 'NOTION_OAUTH_CLIENT_SECRET']) {
      expect((await app.request(`/secrets/${key}`, req('PUT', { value: `${key}-stale-db-value` }))).status).toBe(200)
    }
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = 'NOTION_OAUTH_CLIENT_ID,NOTION_OAUTH_CLIENT_SECRET,SES_ACCESS_KEY_ID'
    try {
      const response = await app.request('/secrets', req())
      const raw = await response.text()
      const body = JSON.parse(raw) as { secrets: Array<{ key: string }>; managedKeys: string[] }
      expect(body.managedKeys).not.toContain('NOTION_OAUTH_CLIENT_ID')
      expect(body.managedKeys).not.toContain('NOTION_OAUTH_CLIENT_SECRET')
      expect(body.managedKeys).toContain('SES_ACCESS_KEY_ID')
      expect(body.secrets.some(({ key }) => key.startsWith('NOTION_OAUTH_'))).toBe(false)
      expect(raw).not.toContain('stale-db-value')
      expect((await app.request('/secrets/NOTION_OAUTH_CLIENT_ID', req())).status).toBe(403)
      expect((await app.request('/secrets/NOTION_OAUTH_CLIENT_SECRET', req())).status).toBe(403)
    } finally {
      delete process.env.FICUS_MANAGED
      delete process.env.FICUS_MANAGED_SECRET_KEYS
      await app.request('/secrets/NOTION_OAUTH_CLIENT_ID', req('DELETE'))
      await app.request('/secrets/NOTION_OAUTH_CLIENT_SECRET', req('DELETE'))
    }
  })

  test('a key superseded by a managed key is managed too: hidden, named, and fails closed on read/write/delete', async () => {
    // The platform delivers the APNs .p8 as a file + a managed APNS_KEY_P8_FILE
    // env var, but the INLINE APNS_KEY_P8 wins at resolve time — so leaving it
    // writable would let a tenant override the platform's push credential.
    // A tenant row already exists here (a self-host that became managed).
    expect((await app.request('/secrets/APNS_KEY_P8', req('PUT', { value: 'tenant-supplied-pem' }))).status).toBe(200)

    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_P8_FILE,APNS_KEY_ID'
    process.env.APNS_KEY_P8_FILE = '/etc/tau/artifacts/apns_key.p8'
    try {
      const res = await app.request('/secrets', req())
      const raw = await res.text()
      const body = JSON.parse(raw) as { secrets: Array<{ key: string }>; managedKeys: string[] }
      // Hidden from the list (so the UI row — and with it the whole APNs
      // category — disappears) and surfaced by NAME only.
      expect(body.secrets.some((s) => s.key === 'APNS_KEY_P8')).toBe(false)
      expect(body.managedKeys).toContain('APNS_KEY_P8')
      expect(body.managedKeys).toContain('APNS_KEY_P8_FILE')
      expect(raw).not.toContain('tenant-supplied-pem')

      // The override hazard: a write must be REFUSED, not merely hidden.
      const get = await app.request('/secrets/APNS_KEY_P8', req())
      expect(get.status).toBe(403)
      expect(JSON.stringify(await get.json())).not.toContain('tenant-supplied-pem')
      expect((await app.request('/secrets/APNS_KEY_P8', req('PUT', { value: 'override' }))).status).toBe(403)
      expect((await app.request('/secrets/APNS_KEY_P8', req('DELETE'))).status).toBe(403)
    } finally {
      delete process.env.FICUS_MANAGED
      delete process.env.FICUS_MANAGED_SECRET_KEYS
      delete process.env.APNS_KEY_P8_FILE
    }
  })

  test('self-hosted: a superseded key stays a normal editable secret', async () => {
    // Neither APNS_KEY_P8 nor APNS_KEY_P8_FILE is managed — nothing changes.
    expect((await app.request('/secrets/APNS_KEY_P8', req('PUT', { value: 'self-hosted-pem' }))).status).toBe(200)

    const body = (await (await app.request('/secrets', req())).json()) as {
      secrets: Array<{ key: string; isSet: boolean }>
      managedKeys: string[]
    }
    expect(body.managedKeys).toEqual([])
    expect(body.secrets.find((s) => s.key === 'APNS_KEY_P8')?.isSet).toBe(true)

    const get = await app.request('/secrets/APNS_KEY_P8', req())
    expect(get.status).toBe(200)
    expect(((await get.json()) as { value: string }).value).toBe('self-hosted-pem')
    expect((await app.request('/secrets/APNS_KEY_P8', req('DELETE'))).status).toBe(200)
  })

  test('list reports whether this instance is platform-managed, without leaking any value or path', async () => {
    // Self-hosted: no FICUS_MANAGED, nothing is managed.
    const selfHosted = (await (await app.request('/secrets', req())).json()) as {
      managed: boolean
      managedKeys: string[]
    }
    expect(selfHosted.managed).toBe(false)
    expect(selfHosted.managedKeys).toEqual([])

    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_ID'
    // A platform-provided credential that is NOT a managed env var: delivered as
    // a file the tenant's setup config points at. The flag must not expose it.
    await app.request('/secrets/exe-provider-ssh-key', req('PUT', { value: 'PRIVATE-KEY-BODY' }))
    try {
      const res = await app.request('/secrets', req())
      expect(res.status).toBe(200)
      const raw = await res.text()
      const body = JSON.parse(raw) as { managed: boolean; managedKeys: string[] }
      expect(body.managed).toBe(true)
      // The flag is a boolean and nothing more: no secret value, no key path.
      expect(raw).not.toContain('PRIVATE-KEY-BODY')
      expect(raw).not.toContain('/root/tau-setup')
      expect(raw).not.toContain('ssh_key_path')
    } finally {
      delete process.env.FICUS_MANAGED
      delete process.env.FICUS_MANAGED_SECRET_KEYS
    }
  })

  // do-machine-mode-part2 Task 7: the web Secrets & Keys section hides the
  // exe.dev SSH key row on a not-exe-backed instance (the do_droplet
  // default). `exeBacked` is the server-owned signal it hides on — see
  // services/machines/provider-credentials.ts's isExeBacked.
  //
  // The initial `notExeBacked` assertion depends on the shared test DB
  // having no pre-existing 'exe'-provider machine row (isExeBacked falls
  // back to machineExistsWithProvider('exe') once no key is configured,
  // and that query is deliberately global/unscoped). If this ever flakes
  // true on a clean key, check for a leaked exe machine row from another
  // test before suspecting this route.
  test('list reports whether this instance is exe-backed, both directions', async () => {
    const notExeBacked = (await (await app.request('/secrets', req())).json()) as { exeBacked: boolean }
    expect(notExeBacked.exeBacked).toBe(false)

    await app.request('/secrets/exe-provider-ssh-key', req('PUT', { value: 'PRIVATE-KEY-BODY' }))
    try {
      const res = await app.request('/secrets', req())
      const raw = await res.text()
      const body = JSON.parse(raw) as { exeBacked: boolean }
      expect(body.exeBacked).toBe(true)
      expect(raw).not.toContain('PRIVATE-KEY-BODY')
    } finally {
      await app.request('/secrets/exe-provider-ssh-key', req('DELETE'))
    }
  })

  test('read-only group permission does not grant write access', async () => {
    const reader = await createTestUser({ prefix })
    const readerRole = await createTestRole({ prefix, permissions: ['secrets:read:integration'] })
    await assignRole({ userId: reader.id, roleId: readerRole.id, scope: 'system' })

    await app.request('/secrets/DEPLOY_TEST_TOKEN', req('PUT', { value: 'gh' }))

    expect((await app.request('/secrets/DEPLOY_TEST_TOKEN', req('GET', undefined, reader.token))).status).toBe(200)
    expect((await app.request('/secrets/DEPLOY_TEST_TOKEN', req('PUT', { value: 'x' }, reader.token))).status).toBe(403)
    expect((await app.request('/secrets/DEPLOY_TEST_TOKEN', req('DELETE', undefined, reader.token))).status).toBe(403)
  })

  test('denies unprivileged settings read and write', async () => {
    expect((await app.request('/settings', req('GET', undefined, unprivileged.token))).status).toBe(403)
    expect(
      (await app.request('/settings/FEATURE_FLAG', req('PUT', { value: 'true' }, unprivileged.token))).status
    ).toBe(403)
    expect((await app.request('/settings/FEATURE_FLAG', req('DELETE', undefined, unprivileged.token))).status).toBe(403)
  })

  test('allows admin to manage settings', async () => {
    expect((await app.request('/settings/FEATURE_FLAG', req('PUT', { value: 'true' }))).status).toBe(200)
    const get = await app.request('/settings/FEATURE_FLAG', req())
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ key: 'FEATURE_FLAG', value: 'true' })
  })
})
