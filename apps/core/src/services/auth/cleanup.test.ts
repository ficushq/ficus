import { afterEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { emailVerifications, passkeyEnrollmentCodes, sessions, users, webauthnChallenges } from '../../db/schema'
import { cleanupExpiredAuthData } from './cleanup'
import { AuthCleanupScheduler, DEFAULT_AUTH_CLEANUP_INTERVAL_MS } from './cleanup-scheduler'

const insertedUserIds: string[] = []
const insertedSessionIds: string[] = []
const insertedChallengeKeys: string[] = []
const insertedVerificationIds: string[] = []

afterEach(async () => {
  if (insertedSessionIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.id, insertedSessionIds.splice(0)))
  }
  if (insertedChallengeKeys.length > 0) {
    await db.delete(webauthnChallenges).where(inArray(webauthnChallenges.challengeKey, insertedChallengeKeys.splice(0)))
  }
  if (insertedVerificationIds.length > 0) {
    await db.delete(emailVerifications).where(inArray(emailVerifications.id, insertedVerificationIds.splice(0)))
  }
  if (insertedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, insertedUserIds.splice(0)))
  }
})

describe('cleanupExpiredAuthData', () => {
  test('keeps passkey enrollment codes as audit records for 30 days past expiry', async () => {
    const now = new Date('2026-06-18T07:00:00.000Z')
    const day = 24 * 60 * 60 * 1000
    const [user] = await db
      .insert(users)
      .values({ email: `cleanup-${randomUUID()}@test.local`, displayName: 'Cleanup Test User' })
      .returning({ id: users.id })
    insertedUserIds.push(user.id)
    const rows = await db
      .insert(passkeyEnrollmentCodes)
      .values([
        { userId: user.id, codeHash: `old-${randomUUID()}`, expiresAt: new Date(now.getTime() - 31 * day) },
        {
          userId: user.id,
          codeHash: `recent-${randomUUID()}`,
          expiresAt: new Date(now.getTime() - day),
          usedAt: new Date(now.getTime() - day - 60_000),
        },
      ])
      .returning({ id: passkeyEnrollmentCodes.id, codeHash: passkeyEnrollmentCodes.codeHash })

    await cleanupExpiredAuthData(now)

    const remaining = await db
      .select({ codeHash: passkeyEnrollmentCodes.codeHash })
      .from(passkeyEnrollmentCodes)
      .where(
        inArray(
          passkeyEnrollmentCodes.id,
          rows.map((row) => row.id)
        )
      )
    expect(remaining.map((row) => row.codeHash)).toEqual([rows[1].codeHash])
  })

  test('deletes expired sessions, WebAuthn challenges, and email verifications only', async () => {
    const now = new Date('2026-06-18T07:00:00.000Z')
    const expiredAt = new Date(now.getTime() - 1)
    const futureAt = new Date(now.getTime() + 60_000)

    const [user] = await db
      .insert(users)
      .values({ email: `cleanup-${randomUUID()}@test.local`, displayName: 'Cleanup Test User' })
      .returning({ id: users.id })
    insertedUserIds.push(user.id)

    const insertedSessions = await db
      .insert(sessions)
      .values([
        { userId: user.id, tokenHash: `expired-session-${randomUUID()}`, expiresAt: expiredAt },
        { userId: user.id, tokenHash: `active-session-${randomUUID()}`, expiresAt: futureAt },
      ])
      .returning({ id: sessions.id })
    insertedSessionIds.push(...insertedSessions.map((row) => row.id))

    const expiredChallengeKey = `expired-challenge-${randomUUID()}`
    const activeChallengeKey = `active-challenge-${randomUUID()}`
    insertedChallengeKeys.push(expiredChallengeKey, activeChallengeKey)
    await db.insert(webauthnChallenges).values([
      { challengeKey: expiredChallengeKey, challenge: 'expired', expiresAt: expiredAt },
      { challengeKey: activeChallengeKey, challenge: 'active', expiresAt: futureAt },
    ])

    const insertedVerifications = await db
      .insert(emailVerifications)
      .values([
        { email: `expired-${randomUUID()}@test.local`, code: '111111', expiresAt: expiredAt },
        { email: `active-${randomUUID()}@test.local`, code: '222222', expiresAt: futureAt },
      ])
      .returning({ id: emailVerifications.id })
    insertedVerificationIds.push(...insertedVerifications.map((row) => row.id))

    await cleanupExpiredAuthData(now)

    const remainingSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        inArray(
          sessions.id,
          insertedSessions.map((row) => row.id)
        )
      )
    expect(remainingSessions.map((row) => row.id)).toEqual([insertedSessions[1].id])

    const remainingChallenges = await db
      .select({ challengeKey: webauthnChallenges.challengeKey })
      .from(webauthnChallenges)
      .where(inArray(webauthnChallenges.challengeKey, [expiredChallengeKey, activeChallengeKey]))
    expect(remainingChallenges.map((row) => row.challengeKey)).toEqual([activeChallengeKey])

    const remainingVerifications = await db
      .select({ id: emailVerifications.id })
      .from(emailVerifications)
      .where(
        inArray(
          emailVerifications.id,
          insertedVerifications.map((row) => row.id)
        )
      )
    expect(remainingVerifications.map((row) => row.id)).toEqual([insertedVerifications[1].id])
  })
})

describe('AuthCleanupScheduler', () => {
  test('runs an immediate cleanup and schedules future sweeps at the default interval', async () => {
    const calls: Date[] = []
    const intervals: number[] = []
    const handles: unknown[] = []
    let intervalCallback: (() => void) | undefined
    const scheduler = new AuthCleanupScheduler({
      cleanup: (now) => {
        calls.push(now)
        return Promise.resolve()
      },
      now: () => new Date('2026-06-18T08:00:00.000Z'),
      setIntervalFn: (callback, intervalMs) => {
        intervals.push(intervalMs)
        intervalCallback = callback
        return 123
      },
      clearIntervalFn: (handle) => handles.push(handle),
    })

    scheduler.start()
    await Promise.resolve()
    if (!intervalCallback) throw new Error('interval callback was not scheduled')
    intervalCallback()
    await Promise.resolve()

    expect(intervals).toEqual([DEFAULT_AUTH_CLEANUP_INTERVAL_MS])
    expect(calls).toEqual([new Date('2026-06-18T08:00:00.000Z'), new Date('2026-06-18T08:00:00.000Z')])

    scheduler.stop()
    expect(handles).toEqual([123])
  })

  test('does not run overlapping cleanup sweeps', async () => {
    let intervalCallback: (() => void) | undefined
    let releaseCleanup: (() => void) | undefined
    let calls = 0
    const scheduler = new AuthCleanupScheduler({
      cleanup: () => {
        calls += 1
        return new Promise<void>((resolve) => {
          releaseCleanup = resolve
        })
      },
      setIntervalFn: (callback) => {
        intervalCallback = callback
        return 1
      },
      clearIntervalFn: () => {},
    })

    scheduler.start()
    if (!intervalCallback) throw new Error('interval callback was not scheduled')
    intervalCallback()
    expect(calls).toBe(1)

    if (!releaseCleanup) throw new Error('cleanup promise was not created')
    releaseCleanup()
    await Promise.resolve()
    intervalCallback()
    expect(calls).toBe(2)
  })
})
