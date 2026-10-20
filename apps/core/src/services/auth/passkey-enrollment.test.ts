import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { passkeyEnrollmentCodes, users } from '../../db/schema'
import { cleanupTestRbac, createTestUser } from '../../test-utils'
import type { TestUser } from '../../test-utils/rbac'
import {
  CODE_LENGTH,
  PASSKEY_ENROLLMENT_CODE_TTL_MS,
  consumePasskeyEnrollmentCode,
  formatEnrollmentCode,
  issuePasskeyEnrollmentCode,
  normalizeEnrollmentCode,
  peekPasskeyEnrollmentCode,
  recordPasskeyEnrollmentFailure,
} from './passkey-enrollment'

const prefix = `pk-enroll-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const outcome = { redeemedOrigin: 'https://b.example', credentialId: 'cred-1' }

describe('enrollment code format', () => {
  it('normalizes separators, case and look-alikes', () => {
    expect(normalizeEnrollmentCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS')
    expect(normalizeEnrollmentCode(' 0OIL abcd efgh jkmn ')).toBe('0011ABCDEFGHJKMN')
  })

  it('rejects anything but 16 alphabet characters', () => {
    expect(normalizeEnrollmentCode('ABCDEFGHJKMNPQR')).toBeNull()
    expect(normalizeEnrollmentCode('ABCDEFGHJKMNPQRST')).toBeNull()
    expect(normalizeEnrollmentCode('ABCDEFGHJKMNPQRU')).toBeNull() // U is not Crockford base32
    expect(normalizeEnrollmentCode(42)).toBeNull()
    expect(normalizeEnrollmentCode(undefined)).toBeNull()
    expect(normalizeEnrollmentCode('A'.repeat(65))).toBeNull()
  })

  it('formats as four dashed groups', () => {
    expect(formatEnrollmentCode('ABCDEFGHJKMNPQRS')).toBe('ABCD-EFGH-JKMN-PQRS')
    expect(CODE_LENGTH).toBe(16)
  })
})

describe('issue / peek / consume', () => {
  let user: TestUser

  beforeEach(async () => {
    user = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  const rows = () => db.select().from(passkeyEnrollmentCodes).where(eq(passkeyEnrollmentCodes.userId, user.id))

  it('stores only a hash and returns the dashed code once', async () => {
    const { code, expiresAt } = await issuePasskeyEnrollmentCode(user.id, { issuedOrigin: 'https://a.example' })
    const [row] = await rows()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, ''))
    expect(row.issuedOrigin).toBe('https://a.example')
    expect(expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(PASSKEY_ENROLLMENT_CODE_TTL_MS + 5_000)
  })

  it('codes are random', async () => {
    const a = await issuePasskeyEnrollmentCode(user.id)
    const b = await issuePasskeyEnrollmentCode(user.id)
    expect(a.code).not.toBe(b.code)
  })

  it('peek does not consume; consume is single-use and records the outcome', async () => {
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    expect(await peekPasskeyEnrollmentCode(code.toLowerCase())).toEqual({ userId: user.id })
    expect(await peekPasskeyEnrollmentCode(code)).toEqual({ userId: user.id })
    expect(await consumePasskeyEnrollmentCode(code, outcome)).toEqual({ userId: user.id })
    expect(await consumePasskeyEnrollmentCode(code, { ...outcome, credentialId: 'cred-2' })).toBeNull()
    expect(await peekPasskeyEnrollmentCode(code)).toBeNull()
    const [row] = await rows()
    expect(row.usedAt).not.toBeNull()
    expect(row.redeemedOrigin).toBe('https://b.example')
    expect(row.redeemedCredentialId).toBe('cred-1')
  })

  it('exactly one of two parallel consumes wins', async () => {
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    const results = await Promise.all([
      consumePasskeyEnrollmentCode(code, outcome),
      consumePasskeyEnrollmentCode(code, { ...outcome, credentialId: 'cred-2' }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('expires', async () => {
    const { code } = await issuePasskeyEnrollmentCode(user.id, {
      now: new Date(Date.now() - PASSKEY_ENROLLMENT_CODE_TTL_MS - 1000),
    })
    expect(await peekPasskeyEnrollmentCode(code)).toBeNull()
    expect(await consumePasskeyEnrollmentCode(code, outcome)).toBeNull()
  })

  it('issuing again retires the earlier live code but leaves used ones alone', async () => {
    const used = await issuePasskeyEnrollmentCode(user.id)
    await consumePasskeyEnrollmentCode(used.code, outcome)
    const first = await issuePasskeyEnrollmentCode(user.id)
    const second = await issuePasskeyEnrollmentCode(user.id)
    expect(await peekPasskeyEnrollmentCode(first.code)).toBeNull()
    expect(await peekPasskeyEnrollmentCode(second.code)).toEqual({ userId: user.id })
    const all = await rows()
    expect(all).toHaveLength(3)
    expect(all.filter((r) => r.revokedAt)).toHaveLength(1)
    const usedRow = all.find((r) => r.usedAt)!
    expect(usedRow.revokedAt).toBeNull()
  })

  it('a code belongs to its user only', async () => {
    const other = await createTestUser({ prefix })
    const mine = await issuePasskeyEnrollmentCode(user.id)
    await issuePasskeyEnrollmentCode(other.id)
    // Issuing for someone else does not retire this user's code.
    expect(await peekPasskeyEnrollmentCode(mine.code)).toEqual({ userId: user.id })
  })

  it('a disabled user’s code is dead', async () => {
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    expect(await peekPasskeyEnrollmentCode(code)).toBeNull()
    expect(await consumePasskeyEnrollmentCode(code, outcome)).toBeNull()
  })

  it('records failures against a known code only', async () => {
    const { code } = await issuePasskeyEnrollmentCode(user.id)
    await recordPasskeyEnrollmentFailure(code)
    await recordPasskeyEnrollmentFailure('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
    await recordPasskeyEnrollmentFailure('nonsense')
    const [row] = await rows()
    expect(row.attempts).toBe(1)
    // A failure does not spend the code.
    expect(await peekPasskeyEnrollmentCode(code)).toEqual({ userId: user.id })
  })
})
