import { createHash, randomBytes } from 'crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import { db } from '../../db'
import { deviceAuthorizations, users } from '../../db/schema'
import { createDeviceToken } from './device-tokens'
import type { PairedUser } from './pairing'

export const DEVICE_AUTH_TTL_MS = 5 * 60_000
export const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')

export type DeviceTokenPollResult =
  | { status: 'pending'; interval: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'invalid' }
  | { status: 'authorized'; token: string; deviceId: string; user: PairedUser }

export type DeviceAuthorizationPlatform = 'cli' | 'desktop'
const DEFAULT_NAMES: Record<DeviceAuthorizationPlatform, string> = { cli: 'Ficus CLI', desktop: 'Ficus Desktop' }

export async function createDeviceAuthorization(input: { name: string; platform?: DeviceAuthorizationPlatform }) {
  const platform = input.platform ?? 'cli'
  const now = new Date()
  await db.delete(deviceAuthorizations).where(lt(deviceAuthorizations.expiresAt, now))
  const deviceCode = secret()
  const verificationCode = secret()
  const expiresAt = new Date(now.getTime() + DEVICE_AUTH_TTL_MS)
  await db.insert(deviceAuthorizations).values({
    deviceCodeHash: hash(deviceCode),
    verificationCodeHash: hash(verificationCode),
    name: input.name.trim().slice(0, 200) || DEFAULT_NAMES[platform],
    platform,
    expiresAt,
  })
  return { deviceCode, verificationCode, expiresAt, platform }
}

export async function inspectDeviceAuthorization(verificationCode: string) {
  const [grant] = await db
    .select({
      name: deviceAuthorizations.name,
      platform: deviceAuthorizations.platform,
      expiresAt: deviceAuthorizations.expiresAt,
    })
    .from(deviceAuthorizations)
    .where(
      and(
        eq(deviceAuthorizations.verificationCodeHash, hash(verificationCode)),
        gt(deviceAuthorizations.expiresAt, new Date()),
        isNull(deviceAuthorizations.approvedAt),
        isNull(deviceAuthorizations.consumedAt)
      )
    )
    .limit(1)
  return grant ?? null
}

export async function approveDeviceAuthorization(verificationCode: string, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1)
  if (!user) return false
  const approved = await db
    .update(deviceAuthorizations)
    .set({ userId, approvedAt: new Date() })
    .where(
      and(
        eq(deviceAuthorizations.verificationCodeHash, hash(verificationCode)),
        gt(deviceAuthorizations.expiresAt, new Date()),
        isNull(deviceAuthorizations.approvedAt),
        isNull(deviceAuthorizations.consumedAt)
      )
    )
    .returning({ id: deviceAuthorizations.id })
  return approved.length === 1
}

export async function exchangeDeviceAuthorization(deviceCode: string): Promise<DeviceTokenPollResult> {
  const now = new Date()
  const [grant] = await db
    .select()
    .from(deviceAuthorizations)
    .where(
      and(
        eq(deviceAuthorizations.deviceCodeHash, hash(deviceCode)),
        gt(deviceAuthorizations.expiresAt, now),
        isNull(deviceAuthorizations.consumedAt)
      )
    )
    .limit(1)
  if (!grant) return { status: 'invalid' }
  if (grant.lastPolledAt && now.getTime() - grant.lastPolledAt.getTime() < DEVICE_AUTH_POLL_INTERVAL_SECONDS * 1000) {
    return { status: 'slow_down', interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS }
  }
  if (!grant.approvedAt || !grant.userId) {
    await db.update(deviceAuthorizations).set({ lastPolledAt: now }).where(eq(deviceAuthorizations.id, grant.id))
    return { status: 'pending', interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS }
  }

  return db.transaction(async (tx) => {
    const consumed = await tx
      .update(deviceAuthorizations)
      .set({ consumedAt: now, lastPolledAt: now })
      .where(and(eq(deviceAuthorizations.id, grant.id), isNull(deviceAuthorizations.consumedAt)))
      .returning({ userId: deviceAuthorizations.userId })
    if (consumed.length !== 1 || !consumed[0].userId) return { status: 'invalid' as const }

    const [user] = await tx.select().from(users).where(eq(users.id, consumed[0].userId)).limit(1)
    if (!user || user.disabledAt) throw new Error('Approved user is unavailable')
    // Mint through the shared helper (inside this transaction) so device-auth tokens are
    // byte-for-byte the same shape as pairing-minted ones and share their revoke/resolve path.
    const { token, id: deviceId } = await createDeviceToken(
      { userId: user.id, name: grant.name, platform: grant.platform },
      tx
    )
    return {
      status: 'authorized' as const,
      token,
      deviceId,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        disabledAt: user.disabledAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    }
  })
}
