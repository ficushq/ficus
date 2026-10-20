import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { authRouter } from './auth'
import { identityMiddleware } from '../middleware/identity'
import { csrfProtection } from '../middleware/csrf'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { db } from '../db'
import { passkeyEnrollmentCodes, sessions, userCredentials, users } from '../db/schema'
import { cleanupTestRbac, createTestCredential, createTestSession, createTestUser } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import * as webauthn from '../services/auth/webauthn'
import { passkeyCodeIssueLimiter, passkeyCodeRedeemLimiter } from '../services/auth/device-auth-rate-limit'
import { issuePasskeyEnrollmentCode, PASSKEY_ENROLLMENT_CODE_TTL_MS } from '../services/auth/passkey-enrollment'
import { resolveTokenContext } from '../services/auth/resolve-token'

// One claim under test: a passkey enrollment code lets its own user register ONE
// more passkey, once, within 15 minutes, at an allowed address of this server —
// and nothing else. It never removes passkeys or sessions.

const PRIMARY = 'https://pub.example.com'
const LOCAL = 'http://localhost:61896'
const OLD = 'https://old.example.com'

function buildApp() {
  const app = new Hono()
  app.use('*', jsonBodyErrorMiddleware)
  app.onError(jsonBodyErrorHandler)
  app.use('/api/*', csrfProtection)
  app.route('/api/auth', authRouter)
  app.use('/api/*', identityMiddleware)
  app.get('/api/protected', (c) => c.json({ ok: true }))
  return app
}

const app = buildApp()
const prefix = `pk-enroll-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const ENV_KEYS = [
  'FICUS_WEB_ORIGIN',
  'WEBAUTHN_ORIGIN',
  'APP_URL',
  'PUBLIC_URL',
  'FICUS_LOCAL_APP_URL',
  'APP_BASE_PATH',
]
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const spies: { mockRestore(): void }[] = []

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.FICUS_WEB_ORIGIN = `${PRIMARY},${LOCAL}`
  passkeyCodeIssueLimiter.reset()
  passkeyCodeRedeemLimiter.reset()
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

function cookieHeaders(token: string, origin?: string): Record<string, string> {
  return { Cookie: `ficus_session=${token}`, [CSRF_HEADER]: '1', ...(origin ? { Origin: origin } : {}) }
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Stub the step-up assertion: verified for `userId`, or a PasskeyAuthenticationError when null. */
function stubStepUp(userId: string | null) {
  const spy = spyOn(webauthn, 'verifyAuthResponse').mockImplementation(async () => {
    if (!userId) throw new webauthn.PasskeyAuthenticationError('Passkey verification failed')
    return { verification: { verified: true }, userId } as Awaited<ReturnType<typeof webauthn.verifyAuthResponse>>
  })
  spies.push(spy)
  return spy
}

/** Stub a successful registration ceremony; returns the new credential id. */
function stubRegistration(result: 'ok' | 'fail' | 'timeout' = 'ok') {
  const credentialId = `enrolled-${randomUUID()}`
  const spy = spyOn(webauthn, 'verifyRegResponse').mockImplementation(async () => {
    if (result === 'timeout') throw new Error('Challenge expired or not found')
    if (result === 'fail') return { verified: false } as Awaited<ReturnType<typeof webauthn.verifyRegResponse>>
    return {
      verified: true,
      registrationInfo: { credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0 } },
    } as Awaited<ReturnType<typeof webauthn.verifyRegResponse>>
  })
  spies.push(spy)
  return { spy, credentialId }
}

const codeRows = (userId: string) =>
  db.select().from(passkeyEnrollmentCodes).where(eq(passkeyEnrollmentCodes.userId, userId))

async function userWithPasskey(): Promise<TestUser & { credentialRowId: string }> {
  const user = await createTestUser({ prefix })
  const credentialRowId = await createTestCredential({ userId: user.id })
  return { ...user, credentialRowId }
}

describe('POST /api/auth/me/passkey-codes/options', () => {
  it('401 without a session', async () => {
    const res = await post('/api/auth/me/passkey-codes/options', {}, { [CSRF_HEADER]: '1', Origin: PRIMARY })
    expect(res.status).toBe(401)
  })

  it('returns authentication options for the caller’s own passkeys', async () => {
    const user = await userWithPasskey()
    const res = await post('/api/auth/me/passkey-codes/options', {}, cookieHeaders(user.token, PRIMARY))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.challengeKey).toStartWith('auth:')
    expect(body.options.rpId).toBe('pub.example.com')
    expect(body.options.allowCredentials).toHaveLength(1)
  })

  it('from an address that left the allowlist, uses the origin the session was minted at', async () => {
    const user = await userWithPasskey()
    const token = await createTestSession(user.id, { signInOrigin: OLD })
    const res = await post('/api/auth/me/passkey-codes/options', {}, cookieHeaders(token, OLD))
    expect((await res.json()).options.rpId).toBe('old.example.com')
  })
})

describe('POST /api/auth/me/passkey-codes', () => {
  const stepUpBody = { challengeKey: 'auth:test', response: { id: 'assertion' } }

  it('401 without a session, and nothing is issued', async () => {
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, { [CSRF_HEADER]: '1', Origin: PRIMARY })
    expect(res.status).toBe(401)
  })

  it('403 for a cookie session without the CSRF header', async () => {
    const user = await userWithPasskey()
    const verify = stubStepUp(user.id)
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, { Cookie: `ficus_session=${user.token}` })
    expect(res.status).toBe(403)
    expect(verify).not.toHaveBeenCalled()
    expect(await codeRows(user.id)).toHaveLength(0)
  })

  it('400 without a step-up assertion', async () => {
    const user = await userWithPasskey()
    const res = await post('/api/auth/me/passkey-codes', {}, cookieHeaders(user.token, PRIMARY))
    expect(res.status).toBe(400)
    expect(await codeRows(user.id)).toHaveLength(0)
  })

  it('401 when the assertion fails, and nothing is issued', async () => {
    const user = await userWithPasskey()
    stubStepUp(null)
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))
    expect(res.status).toBe(401)
    expect(await codeRows(user.id)).toHaveLength(0)
  })

  it('401 when the assertion is another account’s passkey', async () => {
    const user = await userWithPasskey()
    const other = await userWithPasskey()
    stubStepUp(other.id)
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))
    expect(res.status).toBe(401)
    expect(await codeRows(user.id)).toHaveLength(0)
    expect(await codeRows(other.id)).toHaveLength(0)
  })

  it('issues a code once the assertion verifies: hashed row, a link for every allowed origin, primary first', async () => {
    const user = await userWithPasskey()
    stubStepUp(user.id)
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, LOCAL))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    const expiresIn = new Date(body.expiresAt).getTime() - Date.now()
    expect(expiresIn).toBeGreaterThan(PASSKEY_ENROLLMENT_CODE_TTL_MS - 60_000)
    expect(expiresIn).toBeLessThanOrEqual(PASSKEY_ENROLLMENT_CODE_TTL_MS)
    expect(body.links[0]).toEqual({ origin: PRIMARY, url: `${PRIMARY}/add-passkey#code=${body.code}` })
    expect(body.links.map((l: { origin: string }) => l.origin)).toContain(LOCAL)
    const [row] = await codeRows(user.id)
    expect(row.codeHash).not.toContain(body.code.replace(/-/g, ''))
    expect(row.issuedOrigin).toBe(LOCAL)
  })

  it('links carry APP_BASE_PATH', async () => {
    process.env.APP_BASE_PATH = '/ficus'
    const user = await userWithPasskey()
    stubStepUp(user.id)
    const body = await (await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))).json()
    expect(body.links[0].url).toBe(`${PRIMARY}/ficus/add-passkey#code=${body.code}`)
  })

  it('passes the session’s sign-in origin into the step-up ceremony', async () => {
    const user = await userWithPasskey()
    const token = await createTestSession(user.id, { signInOrigin: OLD })
    const verify = stubStepUp(user.id)
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(token, OLD))
    expect(res.status).toBe(200)
    expect(verify).toHaveBeenCalledWith('auth:test', { id: 'assertion' }, OLD, { stepUp: { sessionOrigin: OLD } })
    expect((await codeRows(user.id))[0].issuedOrigin).toBe(OLD)
  })

  it('429 after five attempts in the window, failed ones included', async () => {
    const user = await userWithPasskey()
    stubStepUp(null)
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))).status).toBe(
        401
      )
    }
    const res = await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('900')
  })

  it('issuing again retires the previous code', async () => {
    const user = await userWithPasskey()
    stubStepUp(user.id)
    const first = await (
      await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))
    ).json()
    await post('/api/auth/me/passkey-codes', stepUpBody, cookieHeaders(user.token, PRIMARY))
    const res = await post('/api/auth/add-passkey/options', { code: first.code }, { [CSRF_HEADER]: '1', Origin: LOCAL })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/auth/add-passkey/{options,verify}', () => {
  const redeemHeaders = (origin: string = LOCAL) => ({ [CSRF_HEADER]: '1', Origin: origin })

  it('403 when Origin is missing or not an allowed address, before the code is looked at', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    const reg = stubRegistration()
    for (const path of ['/api/auth/add-passkey/options', '/api/auth/add-passkey/verify']) {
      for (const headers of [{ [CSRF_HEADER]: '1' }, redeemHeaders('https://evil.example'), redeemHeaders('null')]) {
        const res = await post(path, { code, response: {} }, headers)
        expect(res.status).toBe(403)
      }
    }
    expect(reg.spy).not.toHaveBeenCalled()
    const [row] = await codeRows(user.id)
    expect(row.usedAt).toBeNull()
    expect(row.attempts).toBe(0)
  })

  it('403 without the CSRF header, even with no cookie', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    const res = await post('/api/auth/add-passkey/options', { code }, { Origin: LOCAL })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Missing CSRF token' })
  })

  it('401 with the same body for unknown, malformed, expired, retired and used codes', async () => {
    const user = await userWithPasskey()
    const expired = await issuePasskeyEnrollmentCode(user.id, {
      now: new Date(Date.now() - PASSKEY_ENROLLMENT_CODE_TTL_MS - 1000),
    })
    const retired = await issuePasskeyEnrollmentCode(user.id)
    const used = await issuePasskeyEnrollmentCode(user.id)
    stubRegistration()
    expect(
      (await post('/api/auth/add-passkey/verify', { code: used.code, response: {} }, redeemHeaders())).status
    ).toBe(200)
    for (const code of ['ZZZZ-ZZZZ-ZZZZ-ZZZZ', 'nonsense', undefined, expired.code, retired.code, used.code]) {
      const res = await post('/api/auth/add-passkey/options', { code }, redeemHeaders())
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'This code is invalid, expired or already used.' })
    }
  })

  it('options is non-consuming and names the account and origin', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    for (let i = 0; i < 2; i++) {
      const res = await post('/api/auth/add-passkey/options', { code: code.toLowerCase() }, redeemHeaders())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.email).toBe(user.email)
      expect(body.origin).toBe(LOCAL)
      expect(body.options.rp.id).toBe('localhost')
      // The existing passkey is excluded so the same authenticator isn't registered twice.
      expect(body.options.excludeCredentials).toHaveLength(1)
    }
    expect((await codeRows(user.id))[0].usedAt).toBeNull()
  })

  it('success adds exactly one passkey, keeps every other passkey and session, and signs in at this origin', async () => {
    const user = await userWithPasskey()
    const otherSession = await createTestSession(user.id, { signInOrigin: PRIMARY })
    const { code } = await issuePasskeyEnrollmentCode(user.id, { issuedOrigin: PRIMARY })
    const { spy, credentialId } = stubRegistration()

    const res = await post(
      '/api/auth/add-passkey/verify',
      { code, response: { id: 'new' }, credentialName: 'Laptop at new address' },
      { ...redeemHeaders(), 'User-Agent': 'test-agent' }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toContain('ficus_session=')
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.user.id).toBe(user.id)
    // The ceremony was verified against this (allowlisted) origin.
    expect(spy.mock.calls[0][2]).toBe(LOCAL)

    const creds = await db.select().from(userCredentials).where(eq(userCredentials.userId, user.id))
    expect(creds).toHaveLength(2)
    expect(creds.map((c) => c.id)).toContain(user.credentialRowId)
    expect(creds.find((c) => c.credentialId === credentialId)?.displayName).toBe('Laptop at new address')

    // Every earlier session still resolves; the new one is recorded at the redeeming origin.
    expect((await resolveTokenContext(user.token))?.identity).toEqual({ type: 'user', userId: user.id })
    expect((await resolveTokenContext(otherSession))?.identity).toEqual({ type: 'user', userId: user.id })
    expect((await resolveTokenContext(body.token))?.signInOrigin).toBe(LOCAL)
    const all = await db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(all).toHaveLength(3)

    // Audit: the row records where and what it registered.
    const [row] = await codeRows(user.id)
    expect(row.usedAt).not.toBeNull()
    expect(row.redeemedOrigin).toBe(LOCAL)
    expect(row.redeemedCredentialId).toBe(credentialId)
    expect(row.issuedOrigin).toBe(PRIMARY)

    // The new session works.
    const me = await app.request('/api/protected', { headers: { Authorization: `Bearer ${body.token}` } })
    expect(me.status).toBe(200)
  })

  it('never changes the account name or other account fields', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    stubRegistration()
    await post('/api/auth/add-passkey/verify', { code, response: {}, displayName: 'Hijacked' }, redeemHeaders())
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row.displayName).toBe(user.displayName)
  })

  it('is bound to its user: an email or userId in the body is ignored', async () => {
    const user = await userWithPasskey()
    const victim = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    stubRegistration()
    const res = await post(
      '/api/auth/add-passkey/verify',
      { code, response: {}, email: victim.email, userId: victim.id },
      redeemHeaders()
    )
    expect((await res.json()).user.id).toBe(user.id)
    const victimCreds = await db.select().from(userCredentials).where(eq(userCredentials.userId, victim.id))
    expect(victimCreds).toHaveLength(1)
  })

  it('a failed ceremony leaves the code usable and is counted', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    stubRegistration('fail')
    const res = await post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders())
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    for (const spy of spies.splice(0)) spy.mockRestore()

    stubRegistration('timeout')
    const timedOut = await post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders())
    expect(await timedOut.json()).toEqual({ error: 'The passkey prompt timed out. Try again.' })

    const [row] = await codeRows(user.id)
    expect(row.usedAt).toBeNull()
    expect(row.attempts).toBe(2)
    expect((await post('/api/auth/add-passkey/options', { code }, redeemHeaders())).status).toBe(200)
  })

  it('a second redemption of the same code is refused and adds nothing', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    stubRegistration()
    expect((await post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders())).status).toBe(200)
    const again = await post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders(PRIMARY))
    expect(again.status).toBe(401)
    const creds = await db.select().from(userCredentials).where(eq(userCredentials.userId, user.id))
    expect(creds).toHaveLength(2)
  })

  it('concurrent redemptions: exactly one wins', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    stubRegistration()
    const results = await Promise.all([
      post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders()),
      post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders(PRIMARY)),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 401])
    const creds = await db.select().from(userCredentials).where(eq(userCredentials.userId, user.id))
    expect(creds).toHaveLength(2)
  })

  it('the code is not a credential: it authenticates no API call', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    for (const headers of [{ Authorization: `Bearer ${code}` }, { Cookie: `ficus_session=${code}` }]) {
      expect((await app.request('/api/protected', { headers })).status).toBe(401)
    }
  })

  it('a disabled user’s code is refused', async () => {
    const user = await userWithPasskey()
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    stubRegistration()
    expect((await post('/api/auth/add-passkey/verify', { code, response: {} }, redeemHeaders())).status).toBe(401)
  })

  it('429 per client address after 20 calls in a minute', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await post('/api/auth/add-passkey/options', { code: 'nonsense' }, redeemHeaders())).status).toBe(401)
    }
    const res = await post('/api/auth/add-passkey/options', { code: 'nonsense' }, redeemHeaders())
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
  })
})
