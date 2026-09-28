import { createHash, randomBytes } from 'crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { deviceTokens, users } from '../../db/schema'
import { publishDeviceTokenRevocation } from './device-token-events'

/** Per-device tokens carry this prefix so resolveToken can route them without a DB hit for other kinds. */
export const DEVICE_TOKEN_PREFIX = 'ficus_dev_'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface DeviceTokenSummary {
  id: string
  name: string
  platform: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

/** A transaction handle, so a caller minting inside a transaction shares its atomicity. */
export type DeviceTokenTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Mint a new device token for a user (returned raw exactly once). This is the ONLY place
 * that decides the prefix, the secret length and the at-rest hash — a caller that needs to
 * mint inside a transaction passes `tx` instead of re-implementing any of it, so the mint
 * path and the resolve/revoke paths cannot drift apart.
 */
export async function createDeviceToken(
  input: {
    userId: string
    name: string
    platform: string
  },
  tx?: DeviceTokenTx
): Promise<{ token: string; id: string }> {
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const [record] = await (tx ?? db)
    .insert(deviceTokens)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      name: input.name,
      platform: input.platform,
    })
    .returning({ id: deviceTokens.id })
  return { token, id: record.id }
}

/** List a user's active (non-revoked) paired devices, newest first. */
export async function listDeviceTokens(userId: string): Promise<DeviceTokenSummary[]> {
  return db
    .select({
      id: deviceTokens.id,
      name: deviceTokens.name,
      platform: deviceTokens.platform,
      createdAt: deviceTokens.createdAt,
      lastUsedAt: deviceTokens.lastUsedAt,
      revokedAt: deviceTokens.revokedAt,
    })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
    .orderBy(desc(deviceTokens.createdAt))
}

interface RevokeDeviceTokenDependencies {
  publishRevocation: typeof publishDeviceTokenRevocation
}

/**
 * Revoke one of the user's own devices. Returns true if a row was revoked.
 *
 * Resolution includes the durable guarded update, synchronous same-process
 * connection termination, and the settled best-effort peer dispatch attempt.
 * It intentionally excludes worker reader cancellation and client SSE EOF;
 * those stream-owned completion barriers must not extend revoke latency.
 */
export async function revokeDeviceToken(
  userId: string,
  id: string,
  dependencies: Partial<RevokeDeviceTokenDependencies> = {}
): Promise<boolean> {
  const res = await db
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.id, id), eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
    .returning({ id: deviceTokens.id })
  if (!res[0]) return false
  await (dependencies.publishRevocation ?? publishDeviceTokenRevocation)(res[0].id)
  return true
}

/** Resolve a raw device token to its durable ID and owner (null if invalid/revoked or user disabled). */
export async function resolveDeviceToken(token: string): Promise<{ id: string; userId: string } | null> {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null
  const [row] = await db
    .update(deviceTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(deviceTokens.tokenHash, hashToken(token)), isNull(deviceTokens.revokedAt)))
    .returning({ id: deviceTokens.id, userId: deviceTokens.userId })
  if (!row) return null

  const [user] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, row.userId)).limit(1)
  if (!user || user.disabledAt) return null

  return row
}

/** Return the distinct IDs that still belong to enabled users and have not been revoked. */
export async function findActiveDeviceTokenIds(ids: string[]): Promise<Set<string>> {
  const distinctIds = [...new Set(ids)]
  if (distinctIds.length === 0) return new Set()

  const rows = await db
    .select({ id: deviceTokens.id })
    .from(deviceTokens)
    .innerJoin(users, and(eq(users.id, deviceTokens.userId), isNull(users.disabledAt)))
    .where(and(inArray(deviceTokens.id, distinctIds), isNull(deviceTokens.revokedAt)))

  return new Set(rows.map((row) => row.id))
}
