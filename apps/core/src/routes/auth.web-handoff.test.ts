import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { authRouter } from './auth'
import { identityMiddleware } from '../middleware/identity'
import { csrfProtection } from '../middleware/csrf'
import { db, sessions } from '../db'
import { cleanupTestRbac, createTestUser } from '../test-utils'
import { User } from '../entities/User'
import { createDeviceToken, revokeDeviceToken } from '../services/auth/device-tokens'
import { resolveTokenContext } from '../services/auth/resolve-token'

const PREFIX = 'web-handoff-route'

/** Mirrors index.ts: CSRF over /api, auth routes before the identity middleware. */
function buildApp() {
  const app = new Hono()
  app.use('/api/*', csrfProtection)
  app.route('/api/auth', authRouter)
  app.use('/api/*', identityMiddleware)
  app.get('/api/protected', (c) => c.json({ ok: true }))
  return app
}

async function pairedPhone() {
  const user = await createTestUser({ prefix: PREFIX })
  const device = await createDeviceToken({ userId: user.id, name: 'iPhone', platform: 'ios' })
  return { user, device }
}

async function mint(app: Hono, token: string) {
  return app.request('/api/auth/web-handoff', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
}

async function exchange(app: Hono, code: string, headers: Record<string, string> = { [CSRF_HEADER]: '1' }) {
  return app.request('/api/auth/web-handoff/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ code }),
  })
}

function sessionCookie(res: Response): string {
  const cookie = res.headers.get('set-cookie') ?? ''
  const match = /ficus_session=([^;]+)/.exec(cookie)
  if (!match) throw new Error(`no session cookie in ${cookie}`)
  return match[1]!
}

describe('web handoff routes', () => {
  afterEach(async () => {
    await cleanupTestRbac(PREFIX)
  })

  it('a paired device mints a code the web view trades for a device-bound session cookie', async () => {
    const app = buildApp()
    const { user, device } = await pairedPhone()

    const minted = await mint(app, device.token)
    expect(minted.status).toBe(200)
    expect(minted.headers.get('cache-control')).toBe('no-store')
    const { code, expiresAt } = (await minted.json()) as { code: string; expiresAt: string }
    expect(code.startsWith('ficus_wh_')).toBe(true)
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())

    const traded = await exchange(app, code)
    expect(traded.status).toBe(200)
    // The session travels only as the HttpOnly cookie, never in the body.
    const body = await traded.text()
    const token = sessionCookie(traded)
    expect(body).not.toContain(token)
    expect(traded.headers.get('set-cookie')).toContain('HttpOnly')

    expect(await resolveTokenContext(token)).toEqual({
      identity: { type: 'user', userId: user.id },
      deviceTokenId: device.id,
    })
    const bound = await db.select().from(sessions).where(eq(sessions.deviceTokenId, device.id))
    expect(bound.map((row) => row.userId)).toEqual([user.id])

    const protectedRes = await app.request('/api/protected', { headers: { Cookie: `ficus_session=${token}` } })
    expect(protectedRes.status).toBe(200)
  })

  it('a code works once', async () => {
    const app = buildApp()
    const { device } = await pairedPhone()
    const { code } = (await (await mint(app, device.token)).json()) as { code: string }
    expect((await exchange(app, code)).status).toBe(200)
    const again = await exchange(app, code)
    expect(again.status).toBe(401)
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('the exchange needs the first-party CSRF header even without a cookie', async () => {
    const app = buildApp()
    const { device } = await pairedPhone()
    const { code } = (await (await mint(app, device.token)).json()) as { code: string }
    const crossSite = await exchange(app, code, {})
    expect(crossSite.status).toBe(403)
    expect(crossSite.headers.get('set-cookie')).toBeNull()
    // The rejected attempt did not use the code up.
    expect((await exchange(app, code)).status).toBe(200)
  })

  it('only a paired device can mint: a browser session cannot', async () => {
    const app = buildApp()
    const user = await createTestUser({ prefix: PREFIX })
    const browser = await (await User.findById(user.id))!.createSession()
    const res = await app.request('/api/auth/web-handoff', {
      method: 'POST',
      headers: { Cookie: `ficus_session=${browser}`, [CSRF_HEADER]: '1' },
    })
    expect(res.status).toBe(403)
    expect((await app.request('/api/auth/web-handoff', { method: 'POST' })).status).toBe(401)
  })

  it('unpairing the device ends the web view session', async () => {
    const app = buildApp()
    const { user, device } = await pairedPhone()
    const { code } = (await (await mint(app, device.token)).json()) as { code: string }
    const token = sessionCookie(await exchange(app, code))
    await revokeDeviceToken(user.id, device.id)
    expect(await resolveTokenContext(token)).toBeNull()
    const res = await app.request('/api/protected', { headers: { Cookie: `ficus_session=${token}` } })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed exchange without a cookie', async () => {
    const app = buildApp()
    const res = await exchange(app, 'not-a-code')
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
