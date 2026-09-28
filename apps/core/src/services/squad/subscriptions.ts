import { and, eq } from 'drizzle-orm'
import { WATCH_ATTENTION, parseAttention, type Attention } from '@ficus/shared'
import { db } from '../../db'
import { squadSubscriptions } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'

/**
 * Squad-level attention rows. A row carries the user's `decisions` and `progress` levels for the
 * whole squad; a per-work-stream row overrides it (see services/attention/resolver.ts). No row at
 * all means DEFAULT_ATTENTION — visible everywhere the user has permission, notifying nowhere.
 */

/**
 * Create or update the caller's squad attention row.
 *
 * With `attention`, the row is upserted to exactly those levels. Without it, a NEW row is created
 * at WATCH_ATTENTION and an EXISTING row is left alone — a plain `ficus squad watch` must never
 * silently reset levels the user configured.
 */
export async function subscribeToSquad(squadId: string, userId: string, attention?: Attention): Promise<void> {
  const insert = db.insert(squadSubscriptions).values({ squadId, userId, attention: attention ?? WATCH_ATTENTION })
  if (attention) {
    await insert.onConflictDoUpdate({
      target: [squadSubscriptions.squadId, squadSubscriptions.userId],
      set: { attention },
    })
  } else {
    await insert.onConflictDoNothing()
  }
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function unsubscribeFromSquad(squadId: string, userId: string): Promise<void> {
  await db
    .delete(squadSubscriptions)
    .where(and(eq(squadSubscriptions.squadId, squadId), eq(squadSubscriptions.userId, userId)))
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function isSubscribedToSquad(squadId: string, userId: string): Promise<boolean> {
  return (await getSquadAttention(squadId, userId)) !== null
}

/** This user's stored levels for this squad, or null when there is no row. */
export async function getSquadAttention(squadId: string, userId: string): Promise<Attention | null> {
  const [row] = await db
    .select({ attention: squadSubscriptions.attention })
    .from(squadSubscriptions)
    .where(and(eq(squadSubscriptions.squadId, squadId), eq(squadSubscriptions.userId, userId)))
    .limit(1)
  return row ? parseAttention(row.attention) : null
}

export async function listSquadSubscriberIds(squadId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: squadSubscriptions.userId })
    .from(squadSubscriptions)
    .where(eq(squadSubscriptions.squadId, squadId))
  return rows.map((r) => r.userId)
}

/** Every squad row this user has, as a batch loader for one-request attention resolution. */
export async function listUserSquadAttention(userId: string): Promise<Map<string, Attention>> {
  const rows = await db
    .select({ squadId: squadSubscriptions.squadId, attention: squadSubscriptions.attention })
    .from(squadSubscriptions)
    .where(eq(squadSubscriptions.userId, userId))
  return new Map(rows.map((row) => [row.squadId, parseAttention(row.attention)]))
}

export async function countSquadSubscribers(squadId: string): Promise<number> {
  return (await listSquadSubscriberIds(squadId)).length
}
