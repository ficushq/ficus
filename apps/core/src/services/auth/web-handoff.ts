import { createHash, randomUUID } from 'crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { users, webHandoffs } from '../../db/schema'
import { findActiveDeviceTokenIds } from './device-tokens'
import { WEB_HANDOFF_PREFIX } from './token-prefixes'

/**
 * Web handoffs let a paired device sign its embedded web view in (Ficus
 * Mobile's Farm tab) without the device token ever leaving the app:
 *
 * 1. The app, authenticated by its device token, mints a code
 *    (`POST /api/auth/web-handoff`).
 * 2. It gives the code to the page by postMessage or injected script, never in
 *    a URL, where it could be logged.
 * 3. The page trades it for an ordinary browser session cookie
 *    (`POST /api/auth/web-handoff/exchange`). That session carries the device's
 *    id, so it ends when the device is unpaired.
 *
 * A code lasts a minute and works once.
 */
export const WEB_HANDOFF_TTL_MS = 60_000

function hashCode(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export async function createWebHandoff(
  userId: string,
  deviceTokenId: string,
  now: Date = new Date()
): Promise<{ code: string; expiresAt: Date }> {
  const code = `${WEB_HANDOFF_PREFIX}${randomUUID()}${randomUUID().replace(/-/g, '')}`
  const expiresAt = new Date(now.getTime() + WEB_HANDOFF_TTL_MS)
  await db.insert(webHandoffs).values({ tokenHash: hashCode(code), userId, deviceTokenId, expiresAt })
  return { code, expiresAt }
}

/**
 * Atomically use a code: only the request that flips `used_at` from NULL on an
 * unexpired code wins. Returns who minted it, or null when the code is
 * unknown, expired, already used, or its user or device is no longer active.
 */
export async function consumeWebHandoff(
  code: string,
  now: Date = new Date()
): Promise<{ userId: string; deviceTokenId: string } | null> {
  if (!code.startsWith(WEB_HANDOFF_PREFIX)) return null
  const [consumed] = await db
    .update(webHandoffs)
    .set({ usedAt: now })
    .where(and(eq(webHandoffs.tokenHash, hashCode(code)), isNull(webHandoffs.usedAt), gt(webHandoffs.expiresAt, now)))
    .returning({ userId: webHandoffs.userId, deviceTokenId: webHandoffs.deviceTokenId })
  if (!consumed) return null

  const [user] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, consumed.userId))
  if (!user || user.disabledAt) return null
  if (!(await findActiveDeviceTokenIds([consumed.deviceTokenId])).has(consumed.deviceTokenId)) return null
  return consumed
}
