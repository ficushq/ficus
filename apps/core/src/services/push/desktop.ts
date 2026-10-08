import { pushPreview } from './preview'
import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { PushCategory } from '@ficus/shared'
import type { NotificationEvent } from '../../channels/provider'
import { db, desktopNotifications } from '../../db'
import { deviceTokens } from '../../db/schema'
import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'

/** Managed desktop homes get every alert; everyone else only gets one once they've paired a Ficus Desktop device. */
async function desktopRecipients(userIds: string[]): Promise<string[]> {
  const unique = [...new Set(userIds)]
  if (!unique.length || process.env.FICUS_DESKTOP_MANAGED === '1') return unique
  const rows = await db
    .selectDistinct({ userId: deviceTokens.userId })
    .from(deviceTokens)
    .where(
      and(inArray(deviceTokens.userId, unique), eq(deviceTokens.platform, 'desktop'), isNull(deviceTokens.revokedAt))
    )
  return rows.map((row) => row.userId)
}

/** OS alerts are a bounded view of durable work/inbox state; reading never acknowledges the underlying work.
 *  Queued for Desktop-managed homes and for users who have paired a Ficus Desktop device. */
export async function enqueueDesktopNotifications(
  userIds: string[],
  event: NotificationEvent,
  eventType: string,
  category: PushCategory
): Promise<void> {
  const recipients = await desktopRecipients(userIds)
  if (!recipients.length) return
  const eventKey = createHash('sha256')
    .update(
      JSON.stringify([
        eventType,
        event.messageId ?? event.questionId ?? event.timestamp.toISOString(),
        event.title,
        event.body,
      ])
    )
    .digest('hex')
  const preview = pushPreview(event)
  await db
    .insert(desktopNotifications)
    .values(
      recipients.map((userId) => ({
        userId,
        eventKey,
        eventType,
        category,
        title: preview.title,
        body: preview.body,
        url: event.url ?? '/inbox',
      }))
    )
    .onConflictDoNothing()
  await db.delete(desktopNotifications).where(lt(desktopNotifications.createdAt, sql`now() - interval '7 days'`))
}

export async function listDesktopNotifications(userId: string) {
  const preferences = await UserNotificationPreferences.get(userId)
  if (!preferences.pushEnabled) return []
  const rows = await db
    .select()
    .from(desktopNotifications)
    .where(
      and(eq(desktopNotifications.userId, userId), gt(desktopNotifications.createdAt, sql`now() - interval '7 days'`))
    )
    .orderBy(desc(desktopNotifications.createdAt), desc(desktopNotifications.id))
    .limit(100)
  return rows
    .filter(
      (row) => !preferences.mutedEvents.includes(row.eventType) && !preferences.mutedEvents.includes(row.category)
    )
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      url: row.url,
      title: preferences.showPreviews ? row.title : 'Ficus update',
      body: preferences.showPreviews ? row.body : 'Open Ficus to see your update.',
    }))
}
