import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { liveActivityTokens } from '../../db/schema'

/**
 * Registry for Live Activity APNs tokens.
 *
 * Two kinds, and the difference matters at fan-out time:
 *  - `start`  — the app's push-to-start token (iOS 17.2+). One per install, no activityId. Used to
 *               CREATE an activity on a device where none is running.
 *  - `update` — one specific activity's token, carrying its activityId. Used to update or end that
 *               activity.
 *
 * These are not device tokens and cannot be sent through the normal alert path: they need the
 * `<bundleId>.push-type.liveactivity` topic and the `liveactivity` push type (see Task 7's
 * apns.ts), which is why they live in their own table rather than in apns_devices.
 *
 * Rows are expected to CHURN: iOS ends an activity after roughly 8 hours, and on dismissal or
 * reboot, and the update token dies with it. An APNs 410 for one of these is routine cleanup, not
 * an incident — call deleteLiveActivityToken and move on.
 */

export type LiveActivityTokenKind = 'start' | 'update'

export interface RegisterLiveActivityTokenInput {
  userId: string
  apnsToken: string
  kind: LiveActivityTokenKind
  /** Required in practice for `update` tokens; always null for `start`. */
  activityId?: string | null
  environment?: string
}

/**
 * Upsert by token. The token is the identity — the same device re-registering after an activity
 * restart must not accumulate rows, and a token can legitimately move to a different activityId,
 * so every mutable column is refreshed on conflict.
 */
export async function registerLiveActivityToken(input: RegisterLiveActivityTokenInput) {
  const values = {
    userId: input.userId,
    apnsToken: input.apnsToken,
    kind: input.kind,
    // A start token is not bound to an activity; normalize undefined → null so the column never
    // holds a stale id from a previous registration of the same token.
    activityId: input.kind === 'start' ? null : (input.activityId ?? null),
    environment: input.environment === 'sandbox' ? 'sandbox' : 'production',
  }
  const [row] = await db
    .insert(liveActivityTokens)
    .values(values)
    .onConflictDoUpdate({
      target: liveActivityTokens.apnsToken,
      set: { ...values, lastUsedAt: new Date() },
    })
    .returning({
      id: liveActivityTokens.id,
      kind: liveActivityTokens.kind,
      activityId: liveActivityTokens.activityId,
    })
  return row
}

/**
 * Remove a token. Returns whether a row was actually deleted so a caller can tell "cleaned up" from
 * "already gone" — the 410 path races with the app unregistering the same token.
 */
export async function deleteLiveActivityToken(apnsToken: string): Promise<boolean> {
  const deleted = await db
    .delete(liveActivityTokens)
    .where(eq(liveActivityTokens.apnsToken, apnsToken))
    .returning({ id: liveActivityTokens.id })
  return deleted.length > 0
}

/** Scoped variant for the unregister route: a user may only delete their own token. */
export async function deleteLiveActivityTokenForUser(apnsToken: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(liveActivityTokens)
    .where(and(eq(liveActivityTokens.apnsToken, apnsToken), eq(liveActivityTokens.userId, userId)))
    .returning({ id: liveActivityTokens.id })
  return deleted.length > 0
}

/** Fan-out lookup. Empty `userIds` returns nothing rather than every row. */
export async function listLiveActivityTokens(userIds: string[], kind?: LiveActivityTokenKind) {
  if (userIds.length === 0) return []
  const where = kind
    ? and(inArray(liveActivityTokens.userId, userIds), eq(liveActivityTokens.kind, kind))
    : inArray(liveActivityTokens.userId, userIds)
  return db
    .select({
      id: liveActivityTokens.id,
      userId: liveActivityTokens.userId,
      apnsToken: liveActivityTokens.apnsToken,
      kind: liveActivityTokens.kind,
      activityId: liveActivityTokens.activityId,
      environment: liveActivityTokens.environment,
    })
    .from(liveActivityTokens)
    .where(where)
}

/** Only installations using Live Activities need background snapshot recomputation. */
export async function listLiveActivityUserIds(): Promise<string[]> {
  const rows = await db.selectDistinct({ userId: liveActivityTokens.userId }).from(liveActivityTokens)
  return rows.map((row) => row.userId)
}
