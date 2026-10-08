import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { createPushServerConnectionRouter } from './push-server-connection'
import { pushRouter } from './push'
import { RelayServerConnection } from '../services/push/server-connection'
import { relayConnectionSecretKey } from '../services/push/relay'
import { getSecretStore } from '../services/secrets'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
const prefix = `relay-connection-${crypto.randomUUID()}`
const service = new RelayServerConnection()
const app = new Hono().use('*', identityMiddleware).route('/connection', createPushServerConnectionRouter(service))
let admin: TestUser
let user: TestUser
beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  user = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})
describe('relay connection authorization', () => {
  test('denies agents even if they otherwise have settings permissions', async () => {
    const agentApp = new Hono()
    agentApp.use('*', async (c, next) => {
      c.set('identity', { type: 'agent', agentId: crypto.randomUUID(), squadId: crypto.randomUUID(), userId: admin.id })
      await next()
    })
    agentApp.route('/connection', createPushServerConnectionRouter(service))
    expect((await agentApp.request('/connection')).status).toBe(403)
    expect((await agentApp.request('/connection', { method: 'DELETE' })).status).toBe(403)
  })
  test('requires settings authority for connection read and write', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(
        (
          await app.request('/connection', {
            method,
            headers: authHeaders(user.token),
            ...(method === 'POST' ? { body: JSON.stringify({ name: 'Example' }) } : {}),
          })
        ).status
      ).toBe(403)
    }
  })
  test('allows administrator read without returning a credential and disables caching', async () => {
    const spy = spyOn(service, 'status').mockResolvedValue({
      managed: false,
      configured: false,
      connected: false,
      baseUrl: 'https://ficus.sh',
      manageUrl: 'https://ficus.sh/account/pro',
      origin: 'https://example.com',
      connection: null,
    })
    try {
      const response = await app.request('/connection', { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).not.toHaveProperty('token')
    } finally {
      spy.mockRestore()
    }
  })
  test('gives administrators the connection record', async () => {
    const connection = {
      connectedAt: '2026-10-06T18:02:00.000Z',
      connectedBy: 'Noah',
      accountEmail: 'owner@example.com',
    }
    const spy = spyOn(service, 'status').mockResolvedValue({
      managed: false,
      configured: true,
      connected: false,
      baseUrl: 'https://ficus.sh',
      manageUrl: 'https://ficus.sh/account/pro',
      origin: 'https://example.com',
      setupError: undefined,
      connection,
      error: 'Could not reach Ficus Cloud. Try again shortly.',
    })
    try {
      const response = await app.request('/connection', { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      expect((await response.json()).connection).toEqual(connection)
    } finally {
      spy.mockRestore()
    }
  })
  test('the member-readable relay configuration never carries the connection record', async () => {
    const store = getSecretStore()
    await store.initialize()
    const key = relayConnectionSecretKey()
    const recordKey = key.replace('__push-relay-connection:', '__push-relay-connection-record:')
    const instanceId = crypto.randomUUID()
    await store.set(key, `ficus_pri_${instanceId}_${'a'.repeat(43)}`, 'test')
    await store.set(
      recordKey,
      JSON.stringify({ connectedAt: '2026-10-06T18:02:00.000Z', connectedBy: 'Noah', accountEmail: 'owner@x.com' }),
      'test'
    )
    try {
      const members = new Hono().use('*', identityMiddleware).route('/api/push', pushRouter)
      const response = await members.request('/api/push/relay-config', { headers: authHeaders(user.token) })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ enabled: true, instanceId })
      expect(body).not.toHaveProperty('connection')
      expect(JSON.stringify(body)).not.toMatch(/owner@x\.com|Noah|connectedAt/)
    } finally {
      await store.delete(key)
      await store.delete(recordKey)
    }
  })
  test('rejects malformed request bodies before contacting Cloud', async () => {
    const spy = spyOn(service, 'start')
    try {
      for (const body of ['{', JSON.stringify({ name: 'Example', origin: 'https://attacker.example' })]) {
        const response = await app.request('/connection', {
          method: 'POST',
          headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
          body,
        })
        expect(response.status).toBe(400)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
