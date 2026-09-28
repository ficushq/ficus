import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { AssistantEntry } from '@ficus/shared'
import { assistantConversations, assistantEntries, assistantUpdates, db, inbox } from '../../db'
import { ownedConversation } from './read'

export type MarkProcessedResult =
  | { ok: true }
  | { ok: false; reason: 'lease' | 'updates' | 'response'; message: string }

/**
 * Record that Realtime presented (or deliberately interrupted) these updates. Requires the current
 * consumer lease, every update to belong to the conversation, and a durable final entry that names
 * exactly these update IDs — so a crash before the response was saved leaves them unprocessed and
 * replayed later. Idempotent; never touches `seen_at`.
 */
export async function markAssistantUpdatesProcessed(
  conversationId: string,
  input: { consumerId: string; messageIds: string[]; responseEntryId: string }
): Promise<MarkProcessedResult> {
  const ids = [...new Set(input.messageIds)]
  return db.transaction(async (tx) => {
    const [lease] = await tx
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          eq(assistantConversations.inboxConsumerId, input.consumerId),
          sql`${assistantConversations.inboxConsumerExpiresAt} > now()`
        )
      )
      .for('update')
    if (!lease) return { ok: false, reason: 'lease', message: 'Inbox receiver unavailable' }
    const owned = await tx
      .select({ id: assistantUpdates.messageId })
      .from(assistantUpdates)
      .where(and(eq(assistantUpdates.conversationId, conversationId), inArray(assistantUpdates.messageId, ids)))
    if (owned.length !== ids.length)
      return { ok: false, reason: 'updates', message: 'Every update must belong to this conversation' }
    const [saved] = await tx
      .select({ entry: assistantEntries.entry })
      .from(assistantEntries)
      .where(
        and(eq(assistantEntries.conversationId, conversationId), eq(assistantEntries.clientId, input.responseEntryId))
      )
    const entry = saved?.entry as AssistantEntry | undefined
    const covered = new Set(entry?.assistantUpdateIds ?? [])
    if (!entry || !entry.final || !ids.every((id) => covered.has(id)))
      return {
        ok: false,
        reason: 'response',
        message: 'A saved final response referencing these updates is required before acknowledgment',
      }
    await tx
      .update(assistantUpdates)
      .set({ processedAt: sql`coalesce(${assistantUpdates.processedAt}, now())` })
      .where(and(eq(assistantUpdates.conversationId, conversationId), inArray(assistantUpdates.messageId, ids)))
    // Keep the legacy read marker in step for inbox listings; it no longer drives consumption.
    await tx
      .update(inbox)
      .set({ readAt: sql`coalesce(${inbox.readAt}, now())` })
      .where(inArray(inbox.id, ids))
    return { ok: true }
  })
}

export type MarkSeenResult = { ok: true } | { ok: false; reason: 'not-found' | 'invalid-ids' }

/**
 * Record human acknowledgment. Idempotent, owner-scoped, and independent of Realtime processing:
 * seeing an update never marks it processed and processing never marks it seen. A batch with any
 * ID outside the conversation is rejected whole so a client cannot probe other mailboxes.
 */
export async function markAssistantUpdatesSeen(
  ownerUserId: string,
  conversationId: string,
  selection: { messageIds: string[] } | { throughSequence: number }
): Promise<MarkSeenResult> {
  const conversation = await ownedConversation(ownerUserId, conversationId)
  if (!conversation) return { ok: false, reason: 'not-found' }
  return db.transaction(async (tx) => {
    if ('messageIds' in selection) {
      const ids = [...new Set(selection.messageIds)]
      const owned = await tx
        .select({ id: assistantUpdates.messageId })
        .from(assistantUpdates)
        .where(and(eq(assistantUpdates.conversationId, conversationId), inArray(assistantUpdates.messageId, ids)))
      if (owned.length !== ids.length) return { ok: false, reason: 'invalid-ids' }
      await tx
        .update(assistantUpdates)
        .set({ seenAt: sql`now()` })
        .where(
          and(
            eq(assistantUpdates.conversationId, conversationId),
            inArray(assistantUpdates.messageId, ids),
            isNull(assistantUpdates.seenAt)
          )
        )
    } else {
      // Only the displayed snapshot is acknowledged; later sequences stay unread.
      await tx
        .update(assistantUpdates)
        .set({ seenAt: sql`now()` })
        .where(
          and(
            eq(assistantUpdates.conversationId, conversationId),
            lte(assistantUpdates.sequence, selection.throughSequence),
            isNull(assistantUpdates.seenAt)
          )
        )
    }
    return { ok: true }
  })
}
