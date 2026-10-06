import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { createPushServerConnectionRouter } from './push-server-connection'
import { RelayServerConnection } from '../services/push/server-connection'
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
      manageUrl: 'https://ficus.sh/account/push',
      origin: 'https://example.com',
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
