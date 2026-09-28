import { and, eq } from 'drizzle-orm'
import { db, pushSubscriptions } from '../../db'
import type { PushSubscription } from '@ficus/shared'

export interface RegisterPushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
  userId: string
}

export interface PushSubscriptionWithKeys extends PushSubscription {
  userId: string
  p256dh: string
  auth: string
}

export async function registerPushSubscription(input: RegisterPushSubscriptionInput): Promise<PushSubscription> {
  const [sub] = await db
    .insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      userId: input.userId,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        userId: input.userId,
      },
    })
    .returning()

  return mapSubscription(sub)
}

export async function getPushSubscription(id: string): Promise<PushSubscription | null> {
  const [sub] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id))

  return sub ? mapSubscription(sub) : null
}

export async function getAllPushSubscriptions(): Promise<PushSubscription[]> {
  const subs = await db.select().from(pushSubscriptions)
  return subs.map(mapSubscription)
}

export async function getPushSubscriptionsByUser(userId: string): Promise<PushSubscription[]> {
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
  return subs.map(mapSubscription)
}

export async function getAllPushSubscriptionsWithKeys(): Promise<PushSubscriptionWithKeys[]> {
  const subs = await db.select().from(pushSubscriptions)
  return subs.map(mapSubscriptionWithKeys)
}

/** Like getAllPushSubscriptionsWithKeys, but scoped to a single user's devices. */
export async function getPushSubscriptionsByUserWithKeys(userId: string): Promise<PushSubscriptionWithKeys[]> {
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
  return subs.map(mapSubscriptionWithKeys)
}

function mapSubscriptionWithKeys(s: typeof pushSubscriptions.$inferSelect): PushSubscriptionWithKeys {
  return {
    id: s.id,
    endpoint: s.endpoint,
    userId: s.userId,
    p256dh: s.p256dh,
    auth: s.auth,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
  }
}

export async function deletePushSubscriptionIfUnchanged(snapshot: PushSubscriptionWithKeys): Promise<boolean> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.id, snapshot.id),
        eq(pushSubscriptions.userId, snapshot.userId),
        eq(pushSubscriptions.p256dh, snapshot.p256dh),
        eq(pushSubscriptions.auth, snapshot.auth)
      )
    )
    .returning({ id: pushSubscriptions.id })
  return deleted.length > 0
}

export async function deletePushSubscriptionForUser(id: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
    .returning({ id: pushSubscriptions.id })
  return deleted.length > 0
}

function mapSubscription(row: typeof pushSubscriptions.$inferSelect): PushSubscription {
  return {
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  }
}
