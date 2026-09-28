import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from './identity'
import { signImageUrl, __resetSigningKeyForTests } from '../services/images/signing'
import { resetSecretStore } from '../services/secrets'

const PASSWORD = 'test-password-xyz'
const ID = '11111111-1111-1111-1111-111111111111'

function buildApp() {
  const app = new Hono()
  app.use('/api/*', identityMiddleware)
  app.get('/api/images/:id', (c) => c.json({ id: c.req.param('id') }))
  app.post('/api/images', (c) => c.json({ ok: true }))
  app.get('/api/protected', (c) => c.json({ ok: true }))
  return app
}

describe('identityMiddleware signed image URLs', () => {
  const origEnc = process.env.FICUS_ENCRYPTION_KEY
  const origPw = process.env.FICUS_PASSWORD

  beforeEach(() => {
    process.env.FICUS_PASSWORD = PASSWORD
    process.env.FICUS_ENCRYPTION_KEY = 'b'.repeat(64)
    resetSecretStore()
    __resetSigningKeyForTests()
  })

  afterEach(() => {
    if (origEnc === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = origEnc
    if (origPw === undefined) delete process.env.FICUS_PASSWORD
    else process.env.FICUS_PASSWORD = origPw
    resetSecretStore()
    __resetSigningKeyForTests()
  })

  it('allows GET /api/images/:id with a valid signature and no bearer token', async () => {
    const signed = signImageUrl(ID)
    expect(signed).not.toBeNull()

    const res = await buildApp().request(`/api/images/${ID}?exp=${signed!.exp}&sig=${signed!.sig}`)

    expect(res.status).toBe(200)
  })

  it('rejects missing, expired, and tampered image signatures', async () => {
    const app = buildApp()
    const expired = signImageUrl(ID, { expSeconds: Math.floor(Date.now() / 1000) - 1 })
    const valid = signImageUrl(ID)
    expect(expired).not.toBeNull()
    expect(valid).not.toBeNull()

    const missing = await app.request(`/api/images/${ID}`)
    const expiredRes = await app.request(`/api/images/${ID}?exp=${expired!.exp}&sig=${expired!.sig}`)
    const tampered = await app.request(`/api/images/${ID}?exp=${valid!.exp}&sig=${valid!.sig.slice(0, -2)}xx`)

    expect(missing.status).toBe(401)
    expect(expiredRes.status).toBe(401)
    expect(tampered.status).toBe(401)
  })

  it('still accepts bearer authentication for protected routes', async () => {
    const res = await buildApp().request('/api/protected', {
      headers: { Authorization: `Bearer ${PASSWORD}` },
    })

    expect(res.status).toBe(200)
  })

  it('does not exempt unauthenticated image uploads', async () => {
    const res = await buildApp().request('/api/images', { method: 'POST' })

    expect(res.status).toBe(401)
  })
})
