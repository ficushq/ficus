import { createHash, randomUUID } from 'crypto'
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db } from '../../db'
import { users, wsTickets } from '../../db/schema'
import { findActiveDeviceTokenIds } from './device-tokens'
import type { AuthContext } from './resolve-token'

const WS_TICKET_TTL_MS = 60_000

function hashTicket(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Mint a single-use, short-lived ticket for a user session (used as the WS URL token). */
export async function createWsTicket(userId: string, deviceTokenId: string | null = null): Promise<string> {
  const raw = `ficus_wst_${randomUUID()}${randomUUID().replace(/-/g, '')}`
  await db.insert(wsTickets).values({
    tokenHash: hashTicket(raw),
    userId,
    deviceTokenId,
    expiresAt: new Date(Date.now() + WS_TICKET_TTL_MS),
  })
  return raw
}

/**
 * Atomically consume a ticket: only the request that flips used_at from NULL on
 * an unexpired ticket wins, so a ticket resolves at most once. Returns the
 * minting user's identity, or null if the ticket is unknown/expired/already used.
 */
export async function consumeWsTicket(raw: string): Promise<AuthContext | null> {
  const consumed = await db
    .update(wsTickets)
    .set({ usedAt: new Date() })
    .where(and(eq(wsTickets.tokenHash, hashTicket(raw)), isNull(wsTickets.usedAt), gt(wsTickets.expiresAt, new Date())))
    .returning({ userId: wsTickets.userId, deviceTokenId: wsTickets.deviceTokenId })
  if (consumed.length === 0) return null

  const [{ userId, deviceTokenId }] = consumed
  const [user] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId)).limit(1)
  if (!user || user.disabledAt) return null
  if (deviceTokenId && !(await findActiveDeviceTokenIds([deviceTokenId])).has(deviceTokenId)) return null

  return {
    identity: { type: 'user', userId },
    deviceTokenId,
  }
}

/** Delete expired or already-used tickets. */
export async function pruneWsTickets(): Promise<void> {
  await db.delete(wsTickets).where(or(lt(wsTickets.expiresAt, new Date()), isNotNull(wsTickets.usedAt)))
}
