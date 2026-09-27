import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { pairingCodes, users } from '../../db/schema'
import { cleanupTestRbac, createTestUser } from '../../test-utils'
import { claimPairingCode } from '../auth/pairing'
import { DemoReviewerAccess, DEMO_REVIEWER_EMAIL, isDemoReviewerAccessEnabled } from './access'

const prefix = `demo-access-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SECRET = 'reviewer-secret-that-is-long-enough'

function access(overrides: Partial<ConstructorParameters<typeof DemoReviewerAccess>[0]> = {}) {
  const now = 0
  return new DemoReviewerAccess({
    enabled: () => true,
    secret: () => SECRET,
    now: () => now,
    ...overrides,
  })
}

const request = (secret: string, address = '203.0.113.7') => ({
  secret,
  clientAddress: address,
  requestUrl: 'https://demo.example.com/api/auth/demo/pair',
  originHeader: 'https://demo.example.com',
})

describe('isDemoReviewerAccessEnabled', () => {
  it('is off unless the flag is explicitly on', () => {
    expect(isDemoReviewerAccessEnabled({})).toBe(false)
    expect(isDemoReviewerAccessEnabled({ FICUS_DEMO_REVIEWER_ACCESS: '' })).toBe(false)
    expect(isDemoReviewerAccessEnabled({ FICUS_DEMO_REVIEWER_ACCESS: '0' })).toBe(false)
    expect(isDemoReviewerAccessEnabled({ FICUS_DEMO_REVIEWER_ACCESS: 'false' })).toBe(false)
    expect(isDemoReviewerAccessEnabled({ FICUS_DEMO_REVIEWER_ACCESS: '1' })).toBe(true)
    expect(isDemoReviewerAccessEnabled({ FICUS_DEMO_REVIEWER_ACCESS: 'true' })).toBe(true)
    expect(isDemoReviewerAccessEnabled({ FICUS_DEMO_REVIEWER_ACCESS: 'YES' })).toBe(true)
  })
})

describe('DemoReviewerAccess.pair', () => {
  beforeAll(async () => {
    await db.delete(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
  })
  afterAll(async () => {
    await db.delete(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
    await cleanupTestRbac(prefix)
  })
  beforeEach(async () => {
    await db.delete(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
  })

  it('is indistinguishable from absent while the flag is off, whatever the secret', async () => {
    const result = await access({ enabled: () => false }).pair(request(SECRET))
    expect(result).toEqual({ status: 'disabled' })
  })

  it('rejects a wrong, empty, or unconfigured secret without touching the database', async () => {
    expect(await access().pair(request('wrong'))).toEqual({ status: 'invalid_secret' })
    expect(await access().pair(request(''))).toEqual({ status: 'invalid_secret' })
    expect(await access({ secret: () => undefined }).pair(request(SECRET))).toEqual({ status: 'invalid_secret' })
    // A secret too short to be a credential never matches, even when it is what is stored.
    expect(await access({ secret: () => 'short' }).pair(request('short'))).toEqual({ status: 'invalid_secret' })
  })

  it('reports an unseeded or disabled demo account rather than pairing a stranger', async () => {
    expect(await access().pair(request(SECRET))).toEqual({ status: 'not_seeded' })
    await createTestUser({ email: DEMO_REVIEWER_EMAIL, prefix })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, DEMO_REVIEWER_EMAIL))
    expect(await access().pair(request(SECRET))).toEqual({ status: 'not_seeded' })
  })

  it('mints an ordinary single-use pairing code bound to the demo account', async () => {
    const demo = await createTestUser({ email: DEMO_REVIEWER_EMAIL, prefix })
    const result = await access().pair(request(SECRET))
    if (result.status !== 'ok') throw new Error(`unexpected ${result.status}`)
    expect(result.serverUrl).toBe('https://demo.example.com')
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const claimed = await claimPairingCode({ code: result.code, name: 'Reviewer iPhone', platform: 'ios' })
    expect(claimed?.user.id).toBe(demo.id)
    expect(claimed?.token.startsWith('ficus_dev_')).toBe(true)
    // Single use: the same code cannot pair a second device.
    expect(await claimPairingCode({ code: result.code, name: 'Again', platform: 'ios' })).toBeNull()
    // A second reviewer gets their own code.
    const again = await access().pair(request(SECRET, '198.51.100.9'))
    expect(again.status).toBe('ok')
    await db.delete(pairingCodes).where(eq(pairingCodes.userId, demo.id))
  })

  it('rate limits per client address, including guesses at the secret', async () => {
    await createTestUser({ email: DEMO_REVIEWER_EMAIL, prefix })
    const limited = access({ limit: { max: 3, windowMs: 60_000 } })
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await limited.pair(request('wrong', '192.0.2.1'))).status).toBe('invalid_secret')
    }
    expect(await limited.pair(request(SECRET, '192.0.2.1'))).toEqual({ status: 'rate_limited', retryAfterSeconds: 60 })
    // Another address is unaffected.
    expect((await limited.pair(request(SECRET, '192.0.2.2'))).status).toBe('ok')
  })
})
