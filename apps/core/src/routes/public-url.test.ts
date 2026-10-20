import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { db, settingAuditLog, settings } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { csrfProtection } from '../middleware/csrf'
import { SESSION_COOKIE_NAME } from '../services/auth/session-cookie'
import { getSettingsStore } from '../services/settings/store'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { createPublicUrlRouter } from './public-url'
import settingsRouter from './settings'
import type { PublicAppUrlChangeImpact } from '../services/public-url/impact'

const KEY = 'PUBLIC_APP_URL'
const ENV_KEYS = ['APP_URL', 'PUBLIC_URL', 'FICUS_MANAGED', 'FICUS_LOCAL_APP_URL', 'APP_BASE_PATH'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const prefix = `public-url-${crypto.randomUUID()}`
const app = new Hono()
  .use('/api/*', csrfProtection)
  .use('*', identityMiddleware)
  .route('/api/public-url', createPublicUrlRouter())
  .route('/api/settings', settingsRouter)
let admin: TestUser
let user: TestUser

function json(token: string, method: string, body: unknown, extra: Record<string, string> = {}) {
  return {
    method,
    headers: { ...authHeaders(token), 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  }
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  user = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await db.delete(settings).where(eq(settings.key, KEY))
  await db.delete(settingAuditLog).where(eq(settingAuditLog.key, KEY))
  await getSettingsStore().refreshKey(KEY)
})

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('public url routes', () => {
  test('runtime config is readable by any signed-in user; status needs settings authority', async () => {
    clearEnv()
    process.env.FICUS_LOCAL_APP_URL = 'http://localhost:61896'
    const runtime = await app.request('/api/public-url', { headers: authHeaders(user.token) })
    expect(runtime.status).toBe(200)
    expect(await runtime.json()).toEqual({
      url: 'http://localhost:61896',
      localUrl: 'http://localhost:61896',
      source: 'local-default',
    })

    expect((await app.request('/api/public-url/status', { headers: authHeaders(user.token) })).status).toBe(403)
    const status = await app.request('/api/public-url/status', { headers: authHeaders(admin.token) })
    expect(status.status).toBe(200)
    expect(status.headers.get('Cache-Control')).toBe('no-store')
    expect(await status.json()).toMatchObject({
      version: 'unset',
      source: 'local-default',
      locked: false,
      lastChange: null,
      mobileReady: false,
    })
  })

  test('non-admins cannot preview or write', async () => {
    clearEnv()
    expect(
      (await app.request('/api/public-url/preview', json(user.token, 'POST', { url: 'https://x.example' }))).status
    ).toBe(403)
    expect(
      (
        await app.request(
          '/api/public-url',
          json(user.token, 'PUT', { url: 'https://x.example', expectedVersion: 'unset' })
        )
      ).status
    ).toBe(403)
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
  })

  test('agents are refused even when acting for an administrator', async () => {
    clearEnv()
    const agentApp = new Hono()
      .use('*', async (c, next) => {
        c.set('identity', {
          type: 'agent',
          agentId: crypto.randomUUID(),
          squadId: crypto.randomUUID(),
          userId: admin.id,
        })
        await next()
      })
      .route('/api/public-url', createPublicUrlRouter())
    const put = await agentApp.request('/api/public-url', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.example', expectedVersion: 'unset' }),
    })
    expect(put.status).toBe(403)
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
  })

  test('admin sets, conflicts on a stale version, and clears with the current version', async () => {
    clearEnv()
    const first = await app.request(
      '/api/public-url',
      json(admin.token, 'PUT', { url: ' https://Ficus.Example.com/ ', expectedVersion: 'unset' })
    )
    expect(first.status).toBe(200)
    const saved = (await first.json()) as {
      url: string
      source: string
      version: string
      lastChange: { actor: string }
    }
    expect(saved).toMatchObject({ url: 'https://ficus.example.com', source: 'setting', mobileReady: true })
    expect(saved.lastChange.actor).toBe(`Test User ${prefix}`)

    const stale = await app.request(
      '/api/public-url',
      json(admin.token, 'PUT', { url: 'https://other.example', expectedVersion: 'unset' })
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ currentVersion: saved.version })
    expect(getSettingsStore().getStoredValue(KEY)).toBe('https://ficus.example.com')

    const cleared = await app.request(
      '/api/public-url',
      json(admin.token, 'PUT', { url: null, expectedVersion: saved.version })
    )
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ source: 'none', version: 'unset' })
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
  })

  test('rejects invalid values and malformed bodies', async () => {
    clearEnv()
    for (const url of [
      'ftp://x.example',
      'https://u:p@x.example',
      'https://x.example/?q=1',
      'https://x.example/a\\b',
    ]) {
      const res = await app.request('/api/public-url', json(admin.token, 'PUT', { url, expectedVersion: 'unset' }))
      expect(res.status).toBe(400)
    }
    expect((await app.request('/api/public-url', json(admin.token, 'PUT', { url: 'https://x.example' }))).status).toBe(
      400
    )
    expect(
      (
        await app.request(
          '/api/public-url',
          json(admin.token, 'PUT', { url: 'https://x.example', expectedVersion: 'unset', extra: 1 })
        )
      ).status
    ).toBe(400)
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
  })

  test('environment and managed locks refuse writes', async () => {
    clearEnv()
    process.env.APP_URL = 'https://env.example'
    const locked = await app.request(
      '/api/public-url',
      json(admin.token, 'PUT', { url: 'https://x.example', expectedVersion: 'unset' })
    )
    expect(locked.status).toBe(403)
    expect(((await locked.json()) as { error: string }).error).toContain('server environment')
    const status = await (await app.request('/api/public-url/status', { headers: authHeaders(admin.token) })).json()
    expect(status).toMatchObject({
      url: 'https://env.example',
      source: 'environment',
      locked: true,
      lockedBy: 'environment',
    })

    clearEnv()
    process.env.FICUS_MANAGED = '1'
    const managed = await app.request(
      '/api/public-url',
      json(admin.token, 'PUT', { url: 'https://x.example', expectedVersion: 'unset' })
    )
    expect(managed.status).toBe(403)
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
  })

  test('the generic settings route cannot bypass the managed write path', async () => {
    clearEnv()
    const put = await app.request(`/api/settings/${KEY}`, json(admin.token, 'PUT', { value: 'https://x.example' }))
    expect(put.status).toBe(400)
    const del = await app.request(`/api/settings/${KEY}`, { method: 'DELETE', headers: authHeaders(admin.token) })
    expect(del.status).toBe(400)
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
  })

  test('cookie-authenticated writes need the CSRF header', async () => {
    clearEnv()
    const cookie = { Cookie: `${SESSION_COOKIE_NAME}=${admin.token}`, 'Content-Type': 'application/json' }
    const body = JSON.stringify({ url: 'https://x.example', expectedVersion: 'unset' })
    const withoutHeader = await app.request('/api/public-url', { method: 'PUT', headers: cookie, body })
    expect(withoutHeader.status).toBe(403)
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
    const withHeader = await app.request('/api/public-url', {
      method: 'PUT',
      headers: { ...cookie, [CSRF_HEADER]: '1' },
      body,
    })
    expect(withHeader.status).toBe(200)
    expect(getSettingsStore().getStoredValue(KEY)).toBe('https://x.example')
  })

  test('preview reports impact without writing', async () => {
    clearEnv()
    process.env.FICUS_LOCAL_APP_URL = 'http://localhost:61896'
    const res = await app.request(
      '/api/public-url/preview',
      json(admin.token, 'POST', { url: 'https://ficus.example.com' })
    )
    expect(res.status).toBe(200)
    const preview = (await res.json()) as { normalizedUrl: string; impact: PublicAppUrlChangeImpact }
    expect(preview.normalizedUrl).toBe('https://ficus.example.com')
    expect(preview.impact).toMatchObject({ relayReconnectRequired: true, originChanged: true, mobileReady: true })
    expect(preview.impact.oauthCallbacks[0]).toEqual({
      label: 'GitHub OAuth callback',
      before: 'http://localhost:61896/settings/integrations/oauth/callback/github',
      after: 'https://ficus.example.com/settings/integrations/oauth/callback/github',
    })
    expect(preview.impact.webhooks.map((w) => w.after)).toEqual([
      'https://ficus.example.com/api/webhooks/github',
      'https://ficus.example.com/api/webhooks/linear',
    ])
    expect(getSettingsStore().getStoredValue(KEY)).toBeUndefined()
    expect((await app.request('/api/public-url/preview', json(admin.token, 'POST', { url: 'ftp://x' }))).status).toBe(
      400
    )
  })
})
