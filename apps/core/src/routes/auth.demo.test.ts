import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { pairingCodes, secrets, users } from '../db/schema'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { DEMO_REVIEWER_ACCESS_ENV, DEMO_REVIEWER_EMAIL, DEMO_REVIEWER_SECRET_KEY } from '../services/demo/access'
import { cleanupTestRbac, createTestUser } from '../test-utils'
import { authRouter } from './auth'

const prefix = `auth-demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SECRET = 'a-reviewer-secret-with-enough-length'

function app() {
  const router = new Hono()
  router.route('/api/auth', authRouter)
  return router
}

const post = (secret: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://demo.example.test' },
  body: JSON.stringify({ secret }),
})

describe('reviewer access routes', () => {
  const originalFlag = process.env[DEMO_REVIEWER_ACCESS_ENV]
  const originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY

  beforeAll(async () => {
    await db.delete(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
    // Storing a secret needs the at-rest key; tests run without one by default.
    process.env.FICUS_ENCRYPTION_KEY = 'b'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()
    await getSecretStore().set(DEMO_REVIEWER_SECRET_KEY, SECRET, 'test')
  })
  afterEach(() => {
    if (originalFlag === undefined) delete process.env[DEMO_REVIEWER_ACCESS_ENV]
    else process.env[DEMO_REVIEWER_ACCESS_ENV] = originalFlag
  })
  afterAll(async () => {
    await db.delete(secrets).where(eq(secrets.key, DEMO_REVIEWER_SECRET_KEY))
    if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
    resetSecretStore()
    await db.delete(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
    await cleanupTestRbac(prefix)
  })

  it('does not exist, and is not advertised, on an instance that has not opted in', async () => {
    delete process.env[DEMO_REVIEWER_ACCESS_ENV]
    const res = await app().request('/api/auth/demo/pair', post(SECRET))
    expect(res.status).toBe(404)
    const status = await (await app().request('/api/auth/status')).json()
    expect(status.demoReviewerAccess).toBe(false)
  })

  it('advertises the page, rejects a bad code, and explains an unseeded account', async () => {
    process.env[DEMO_REVIEWER_ACCESS_ENV] = '1'
    const status = await (await app().request('/api/auth/status')).json()
    expect(status.demoReviewerAccess).toBe(true)

    const wrong = await app().request('/api/auth/demo/pair', post('nope'))
    expect(wrong.status).toBe(401)
    const unseeded = await app().request('/api/auth/demo/pair', post(SECRET))
    expect(unseeded.status).toBe(503)
    expect((await unseeded.json()).error).toBe('demo_not_seeded')
  })

  it('mints a pairing code for the demo account that the app can claim once', async () => {
    process.env[DEMO_REVIEWER_ACCESS_ENV] = '1'
    const demo = await createTestUser({ email: DEMO_REVIEWER_EMAIL, prefix })
    const res = await app().request('/api/auth/demo/pair', post(SECRET))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.serverUrl).toBe('https://demo.example.test')
    expect(typeof body.code).toBe('string')
    expect(body.status).toBeUndefined()

    const claim = await app().request('/api/auth/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: body.code, name: 'Reviewer iPhone', platform: 'ios' }),
    })
    expect(claim.status).toBe(200)
    expect((await claim.json()).user.id).toBe(demo.id)
    await db.delete(pairingCodes).where(eq(pairingCodes.userId, demo.id))
  })
})
