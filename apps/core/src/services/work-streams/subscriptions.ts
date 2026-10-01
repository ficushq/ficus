import { and, eq, inArray } from 'drizzle-orm'
import { WATCH_ATTENTION, parseAttention, type Attention } from '@ficus/shared'
import { db } from '../../db'
import { workStreamSubscriptions, workStreams } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'

/**
 * Per-work-stream attention rows. A row overrides the squad row for this one stream, so a user can
 * follow a single stream inside a muted squad, or mute one noisy stream inside a watched squad.
 */

/**
 * Create or update the caller's attention row for this stream.
 *
 * With `attention`, the row is upserted to exactly those levels. Without it, a NEW row is created
 * at WATCH_ATTENTION and an EXISTING row is left alone (the requester auto-subscribe on stream
 * creation and a plain `ficus workstream watch` both take this path).
 */
export async function subscribeToWorkStream(
  workStreamId: string,
  userId: string,
  attention?: Attention
): Promise<void> {
  const insert = db
    .insert(workStreamSubscriptions)
    .values({ workStreamId, userId, attention: attention ?? WATCH_ATTENTION })
  if (attention) {
    await insert.onConflictDoUpdate({
      target: [workStreamSubscriptions.workStreamId, workStreamSubscriptions.userId],
      set: { attention },
    })
  } else {
    await insert.onConflictDoNothing()
  }
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function unsubscribeFromWorkStream(workStreamId: string, userId: string): Promise<void> {
  await db
    .delete(workStreamSubscriptions)
    .where(and(eq(workStreamSubscriptions.workStreamId, workStreamId), eq(workStreamSubscriptions.userId, userId)))
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function isSubscribedToWorkStream(workStreamId: string, userId: string): Promise<boolean> {
  return (await getWorkStreamAttention(workStreamId, userId)) !== null
}

/** This user's stored levels for this stream, or null when the stream inherits from the squad. */
export async function getWorkStreamAttention(workStreamId: string, userId: string): Promise<Attention | null> {
  const [row] = await db
    .select({ attention: workStreamSubscriptions.attention })
    .from(workStreamSubscriptions)
    .where(and(eq(workStreamSubscriptions.workStreamId, workStreamId), eq(workStreamSubscriptions.userId, userId)))
    .limit(1)
  return row ? parseAttention(row.attention) : null
}

export async function listWorkStreamSubscriberIds(workStreamId: string, executor: typeof db = db): Promise<string[]> {
  const rows = await executor
    .select({ userId: workStreamSubscriptions.userId })
    .from(workStreamSubscriptions)
    .where(eq(workStreamSubscriptions.workStreamId, workStreamId))
  return rows.map((r) => r.userId)
}

/** Every stream row this user has, as a batch loader for one-request attention resolution. */
export async function listUserWorkStreamAttention(userId: string): Promise<Map<string, Attention>> {
  const rows = await db
    .select({ workStreamId: workStreamSubscriptions.workStreamId, attention: workStreamSubscriptions.attention })
    .from(workStreamSubscriptions)
    .where(eq(workStreamSubscriptions.userId, userId))
  return new Map(rows.map((row) => [row.workStreamId, parseAttention(row.attention)]))
}

export async function countWorkStreamSubscribers(workStreamId: string): Promise<number> {
  return (await listWorkStreamSubscriberIds(workStreamId)).length
}

/** Recompute audience for a squad-scoped resource change, not permission to push.
 * Snapshot loading still checks each user's effective interest and current RBAC.
 */
export async function listSquadWorkStreamSubscriberIds(squadId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: workStreamSubscriptions.userId })
    .from(workStreamSubscriptions)
    .innerJoin(workStreams, eq(workStreams.id, workStreamSubscriptions.workStreamId))
    .where(and(eq(workStreams.squadId, squadId), inArray(workStreams.status, ['active', 'queued'])))
  return rows.map((row) => row.userId)
}
