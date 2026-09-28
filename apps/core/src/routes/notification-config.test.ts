import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { notificationConfigRouter } from './notification-config'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

const prefix = `notification-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/notification-config', notificationConfigRouter)

function withAuth(init?: RequestInit, token = admin.token) {
  return {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), ...authHeaders(token) },
  }
}

async function guardRequest(path: string, init?: RequestInit, token?: string) {
  const headers = new Headers(init?.headers)
  if (token) {
    for (const [key, value] of Object.entries(authHeaders(token))) headers.set(key, value)
  }
  return app.request(path, { ...init, headers })
}

describe('notification-config RBAC guards', () => {
  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  test('own preferences expose the fixed push categories rather than raw routing events', async () => {
    const { PUSH_CATEGORY_IDS } = await import('@ficus/shared')
    const response = await app.request('/notification-config/me', withAuth({}, unprivileged.token))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.pushEvents).toEqual(PUSH_CATEGORY_IDS)
    expect(body.pushEvents).not.toContain('workStream.review')
    expect(body.pushEvents).not.toContain('execution.failed')
  })

  test('own preferences accept an absent body and reject malformed JSON', async () => {
    const absent = await app.request('/notification-config/me', withAuth({ method: 'PUT' }))
    expect(absent.status).toBe(200)

    const malformed = await app.request('/notification-config/me', withAuth({ method: 'PUT', body: '{' }))
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid JSON body' })
  })

  test('requires settings:read for read endpoints', async () => {
    for (const path of ['/notification-config', '/notification-config/template-diff', '/notification-config/export']) {
      expect((await guardRequest(path)).status).toBe(401)
      expect((await guardRequest(path, undefined, unprivileged.token)).status).toBe(403)
    }
  })

  test('allows admin to read notification config', async () => {
    const res = await app.request('/notification-config', withAuth())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rules: [], channels: {} })
  })

  test('requires settings:write for mutating endpoints', async () => {
    const routes: Array<[string, RequestInit]> = [
      [
        '/notification-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules: [], channels: {} }),
        },
      ],
      ['/notification-config/revert-to-template', { method: 'POST' }],
      [
        '/notification-config/revert-template-fields',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ],
      ['/notification-config/disable', { method: 'POST' }],
      ['/notification-config/enable', { method: 'POST' }],
    ]

    for (const [path, init] of routes) {
      expect((await guardRequest(path, init)).status).toBe(401)
      expect((await guardRequest(path, init, unprivileged.token)).status).toBe(403)
    }
  })
})
