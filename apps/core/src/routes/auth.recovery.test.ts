import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { eq, like } from 'drizzle-orm'
import { authRouter } from './auth'
import { identityMiddleware } from '../middleware/identity'
import {
  INVALID_JSON_BODY_MESSAGE,
  jsonBodyErrorHandler,
  jsonBodyErrorMiddleware,
} from '../middleware/json-body-errors'
import { db } from '../db'
import { emailVerifications, sessions, userCredentials, users } from '../db/schema'
import { createTestCredential, createTestUser, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { sesSendMock } from '../test-utils/ses-mock'
import {
  consumeVerificationToken,
  issueEmailChallenge,
  peekVerificationToken,
  PASSKEY_RECOVERY_TTL_MS,
} from '../services/auth/email'
import { replaceCredentialsAfterRecovery } from '../services/auth/passkey-recovery'

// Everything here is about ONE claim: a deep-link token authorises registering a
// passkey for exactly one address, exactly once, for a bounded time — and NOTHING
// else. It is not a session and not an API credential.

function buildApp() {
  const app = new Hono()
  app.use('*', jsonBodyErrorMiddleware)
  app.onError(jsonBodyErrorHandler)
  app.route('/api/auth', authRouter)
  app.use('/api/*', identityMiddleware)
  app.get('/api/protected', (c) => c.json({ ok: true }))
  return app
}

const app = buildApp()
const prefix = `recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const priorFrom = process.env.SES_FROM_ADDRESS

let subject: TestUser

beforeAll(async () => {
  subject = await createTestUser({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
  await db.delete(emailVerifications).where(like(emailVerifications.email, `${prefix}%`))
})

beforeEach(() => {
  sesSendMock.mockClear()
  process.env.SES_FROM_ADDRESS = 'noreply@test.local'
})

afterEach(async () => {
  if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
  else process.env.SES_FROM_ADDRESS = priorFrom
  await db.delete(emailVerifications).where(like(emailVerifications.email, `${prefix}%`))
})

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function postRaw(path: string, body: string, contentType?: string) {
  return app.request(path, {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : undefined,
    body,
  })
}

// ── Token semantics ──────────────────────────────────────────────────────────

describe('deep-link token', () => {
  it('is single-use: the second consume of the same token loses', async () => {
    const { token } = await issueEmailChallenge(`${prefix}-single@test.local`)
    expect(await consumeVerificationToken(token)).toMatchObject({ purpose: 'register' })
    expect(await consumeVerificationToken(token)).toBeNull()
  })

  it('is single-use under concurrency — exactly one of two parallel consumes wins', async () => {
    const { token } = await issueEmailChallenge(`${prefix}-race@test.local`)
    const [a, b] = await Promise.all([consumeVerificationToken(token), consumeVerificationToken(token)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('expires', async () => {
    const { token } = await issueEmailChallenge(`${prefix}-expired@test.local`, { ttlMs: -1000 })
    expect(await peekVerificationToken(token)).toBeNull()
    expect(await consumeVerificationToken(token)).toBeNull()
  })

  it('rejects an unknown or empty token', async () => {
    expect(await peekVerificationToken('not-a-real-token')).toBeNull()
    expect(await consumeVerificationToken('')).toBeNull()
  })

  it('is stored only as a hash — the raw value never lands in the row', async () => {
    const email = `${prefix}-hash@test.local`
    const { token } = await issueEmailChallenge(email)
    const [row] = await db.select().from(emailVerifications).where(eq(emailVerifications.email, email))
    expect(row.tokenHash).not.toBe(token)
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a recovery code is NOT redeemable through the ordinary code path', async () => {
    const { verifyEmailCode } = await import('../services/auth/email')
    const email = `${prefix}-purpose@test.local`
    const { code } = await issueEmailChallenge(email, { purpose: 'recovery' })
    // The row exists and the code is right, but purpose 'recovery' is token-only:
    // redeeming it here would add a passkey without revoking the lost one.
    expect(await verifyEmailCode(email, code)).toBe(false)
  })
})

// ── The token is not a credential ────────────────────────────────────────────

describe('a token grants no access by itself', () => {
  it('does not authenticate an API call as a bearer token', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    const res = await app.request('/api/protected', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('does not authenticate an API call as a session cookie', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    const res = await app.request('/api/protected', { headers: { Cookie: `ficus_session=${token}` } })
    expect(res.status).toBe(401)
  })

  it('opening the ceremony sets no session cookie', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    const res = await post('/api/auth/register/token/options', { token })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

// ── /register/token/options ──────────────────────────────────────────────────

describe('POST /api/auth/register/token/options', () => {
  it('returns WebAuthn options plus the address the token belongs to', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    const res = await post('/api/auth/register/token/options', { token })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.email).toBe(subject.email)
    expect(body.purpose).toBe('register')
    expect(body.options.challenge).toBeTruthy()
  })

  it('does NOT consume the token — an abandoned ceremony leaves the invite usable', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    await post('/api/auth/register/token/options', { token })
    expect(await peekVerificationToken(token)).not.toBeNull()
  })

  it('401s on an unknown, expired or already-spent token, with the same message', async () => {
    const live = await issueEmailChallenge(subject.email)
    await consumeVerificationToken(live.token)
    const expired = await issueEmailChallenge(subject.email, { ttlMs: -1000 })

    const messages: string[] = []
    for (const token of ['made-up-token', live.token, expired.token]) {
      const res = await post('/api/auth/register/token/options', { token })
      expect(res.status).toBe(401)
      messages.push((await res.json()).error)
    }
    expect(new Set(messages).size).toBe(1)
  })

  it('400s when no token is supplied', async () => {
    expect((await post('/api/auth/register/token/options', {})).status).toBe(400)
  })

  it('resolves a mixed-case address — verification rows are lowercased, user rows are not', async () => {
    const mixed = await createTestUser({ prefix: `${prefix}-Mixed`, email: `${prefix}-MiXeD@Test.Local` })
    try {
      const { token } = await issueEmailChallenge(mixed.email)
      const res = await post('/api/auth/register/token/options', { token })
      expect(res.status).toBe(200)
      expect((await res.json()).email).toBe(mixed.email)
    } finally {
      await cleanupTestRbac(`${prefix}-Mixed`)
    }
  })

  it('fails closed for a token whose user was deleted or disabled', async () => {
    const doomed = await createTestUser({ prefix: `${prefix}-gone` })
    const { token } = await issueEmailChallenge(doomed.email)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, doomed.id))
    expect((await post('/api/auth/register/token/options', { token })).status).toBe(401)
    await cleanupTestRbac(`${prefix}-gone`)
  })
})

// ── /register/token/verify ───────────────────────────────────────────────────

describe('POST /api/auth/register/token/verify', () => {
  it('a failed WebAuthn ceremony 401s and does NOT burn the token', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    await post('/api/auth/register/token/options', { token })
    const res = await post('/api/auth/register/token/verify', { token, response: { id: 'bogus' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    // Still redeemable — a fumbled ceremony must not cost the invitee their invite.
    expect(await peekVerificationToken(token)).not.toBeNull()
  })

  it('a retry on a used-up or expired challenge says the prompt timed out, and keeps the invite', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    await post('/api/auth/register/token/options', { token })
    const first = await post('/api/auth/register/token/verify', { token, response: { id: 'bogus' } })
    expect(first.status).toBe(401)
    expect(((await first.json()) as { error: string }).error).toBe('Verification failed')
    // The first attempt spent the challenge; asking again without fresh options is a timed-out prompt.
    const retry = await post('/api/auth/register/token/verify', { token, response: { id: 'bogus' } })
    expect(retry.status).toBe(401)
    expect(((await retry.json()) as { error: string }).error).toBe('The passkey prompt timed out. Try again.')
    expect(await peekVerificationToken(token)).not.toBeNull()
  })

  it('a spent token cannot be replayed even with a response in hand', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    await consumeVerificationToken(token)
    const res = await post('/api/auth/register/token/verify', { token, response: { id: 'anything' } })
    expect(res.status).toBe(401)
  })

  it('400s without a response body', async () => {
    const { token } = await issueEmailChallenge(subject.email)
    expect((await post('/api/auth/register/token/verify', { token })).status).toBe(400)
  })
})

// ── Recovery request ─────────────────────────────────────────────────────────

describe('POST /api/auth/login/options optional object body', () => {
  it('accepts zero bytes and a valid email object', async () => {
    for (const init of [
      { method: 'POST' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: subject.email }),
      },
    ]) {
      const response = await app.request('/api/auth/login/options', init)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        options: expect.any(Object),
        challengeKey: expect.any(String),
      })
    }
  })
})

describe('POST /api/auth/recover/passkey', () => {
  it('rejects non-object roots without sending recovery mail', async () => {
    for (const [root, raw] of [
      ['null', 'null'],
      ['array', '["recovery-secret-marker"]'],
      ['string', '"recovery-secret-marker"'],
      ['number', '42'],
      ['boolean', 'true'],
    ] as const) {
      const response = await postRaw('/api/auth/recover/passkey', raw, 'application/json')
      const responseText = await response.text()
      expect({ root, status: response.status }).toEqual({ root, status: 400 })
      expect(JSON.parse(responseText)).toEqual({ error: INVALID_JSON_BODY_MESSAGE })
      expect(responseText).not.toContain('recovery-secret-marker')
    }
    expect(sesSendMock).not.toHaveBeenCalled()
  })
  it('answers identically for a registered and an unregistered address', async () => {
    const known = await post('/api/auth/recover/passkey', { email: subject.email })
    const unknown = await post('/api/auth/recover/passkey', { email: `${prefix}-nobody@test.local` })
    expect(known.status).toBe(unknown.status)
    expect(await known.json()).toEqual(await unknown.json())
  })

  it('mails a link ONLY for the registered address', async () => {
    await post('/api/auth/recover/passkey', { email: `${prefix}-nobody2@test.local` })
    expect(sesSendMock).not.toHaveBeenCalled()
    await post('/api/auth/recover/passkey', { email: subject.email })
    expect(sesSendMock).toHaveBeenCalledTimes(1)
  })

  it('the mail carries a single-use registration link and no typeable code', async () => {
    await post('/api/auth/recover/passkey', { email: subject.email })
    const command = sesSendMock.mock.calls[0]?.[0] as {
      input: { Message: { Body: { Text: { Data: string } } } }
    }
    const text = command.input.Message.Body.Text.Data
    expect(text).toMatch(/\/register\?token=[\w-]{20,}/)
    expect(text).not.toMatch(/\b\d{6}\b/)
    expect(text).toContain('removes every passkey currently on the account')
  })

  it('issues a recovery-purpose challenge with the short recovery TTL', async () => {
    const before = Date.now()
    await post('/api/auth/recover/passkey', { email: subject.email })
    const [row] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.email, subject.email.toLowerCase()))
    expect(row.purpose).toBe('recovery')
    // Comfortably shorter than the 7-day invite TTL.
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(before + PASSKEY_RECOVERY_TTL_MS + 5_000)
  })

  it('fails closed for a disabled account, and looks like an unknown address', async () => {
    const banned = await createTestUser({ prefix: `${prefix}-banned` })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, banned.id))
    const res = await post('/api/auth/recover/passkey', { email: banned.email })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sesSendMock).not.toHaveBeenCalled()
    await cleanupTestRbac(`${prefix}-banned`)
  })

  it('rate-limits to 3 per 15 minutes per address — silently, so it leaks nothing', async () => {
    const target = await createTestUser({ prefix: `${prefix}-rl` })
    try {
      for (let i = 0; i < 3; i++) {
        const res = await post('/api/auth/recover/passkey', { email: target.email })
        expect(res.status).toBe(200)
      }
      expect(sesSendMock).toHaveBeenCalledTimes(3)

      const fourth = await post('/api/auth/recover/passkey', { email: target.email })
      // Same 200 { ok: true } as everything else — a 429 would confirm the
      // address is registered.
      expect(fourth.status).toBe(200)
      expect(await fourth.json()).toEqual({ ok: true })
      expect(sesSendMock).toHaveBeenCalledTimes(3)
    } finally {
      await db.delete(emailVerifications).where(like(emailVerifications.email, `${prefix}-rl%`))
      await cleanupTestRbac(`${prefix}-rl`)
    }
  })

  it('shrugs off a malformed body without leaking a different shape', async () => {
    for (const body of [{}, { email: 'not-an-email' }, { email: '' }]) {
      const res = await post('/api/auth/recover/passkey', body)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
  })
})

// ── Recovery replaces credentials ────────────────────────────────────────────

describe('recovery replaces every prior passkey', () => {
  it('deletes the old credentials and all sessions, keeping only the new one', async () => {
    const owner = await createTestUser({ prefix: `${prefix}-replace` })
    try {
      await createTestCredential({ userId: owner.id, displayName: 'lost phone' })
      await createTestCredential({ userId: owner.id, displayName: 'old laptop' })
      const [fresh] = await db
        .insert(userCredentials)
        .values({
          userId: owner.id,
          credentialId: `new-cred-${randomUUID()}`,
          publicKey: 'pk',
          counter: 0,
        })
        .returning()

      const result = await replaceCredentialsAfterRecovery(owner.id, fresh.credentialId)
      expect(result.removedCredentials).toBe(2)
      // createTestUser opens a session; recovery must revoke it.
      expect(result.removedSessions).toBeGreaterThanOrEqual(1)

      const left = await db.select().from(userCredentials).where(eq(userCredentials.userId, owner.id))
      expect(left.map((c) => c.credentialId)).toEqual([fresh.credentialId])
      const openSessions = await db.select().from(sessions).where(eq(sessions.userId, owner.id))
      expect(openSessions).toHaveLength(0)
    } finally {
      await cleanupTestRbac(`${prefix}-replace`)
    }
  })

  it('never removes the credential just registered', async () => {
    const owner = await createTestUser({ prefix: `${prefix}-keep` })
    try {
      const only = await db
        .insert(userCredentials)
        .values({ userId: owner.id, credentialId: `solo-${randomUUID()}`, publicKey: 'pk', counter: 0 })
        .returning()
      await replaceCredentialsAfterRecovery(owner.id, only[0].credentialId)
      const left = await db.select().from(userCredentials).where(eq(userCredentials.userId, owner.id))
      expect(left).toHaveLength(1)
    } finally {
      await cleanupTestRbac(`${prefix}-keep`)
    }
  })
})
