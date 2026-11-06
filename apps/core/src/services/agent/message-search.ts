import { and, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm'
import type { MessageSearchQuery, MessageSearchResponse } from '@ficus/shared'
import { db, messages } from '../../db'
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor'
import { buildMessageSnippet } from './message-snippet'

/**
 * Search one agent conversation's full message history.
 *
 * Matches a case-insensitive substring of the message text (`messages.content`):
 * what a person wrote and the visible text of the agent's reply. Thinking, tool
 * calls and tool output live in `metadata.content` and are deliberately not
 * searched: the chat view collapses them, so a hit there would jump to a
 * message whose visible text does not contain the query.
 *
 * The caller must already have authorized reading this agent's messages; this
 * function only ever reads rows of `agentId`.
 */

/** Cursor scope marker so a search cursor is never valid for message listing, and vice versa. */
const CURSOR_ROLE = 'message-search'

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&')

export async function searchAgentMessages(agentId: string, input: MessageSearchQuery): Promise<MessageSearchResponse> {
  const query = input.q
  const cursorContext = { agentId, role: CURSOR_ROLE, search: query }
  const conditions: SQL[] = [eq(messages.agentId, agentId), ilike(messages.content, `%${escapeLike(query)}%`)]
  if (input.cursor) {
    const keyset = decodeMessageCursor(input.cursor, cursorContext)
    conditions.push(
      or(
        lt(messages.createdAt, keyset.createdAt),
        and(eq(messages.createdAt, keyset.createdAt), lt(messages.enqueueOrder, keyset.enqueueOrder))
      )!
    )
  }

  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
      enqueueOrder: messages.enqueueOrder,
      // Same ordering as message listing (created_at, then enqueue order), so the
      // count is exactly how many listed messages precede this one, newest first. Outer columns are
      // written qualified by hand: Drizzle renders single-table columns unqualified, which would bind
      // them to the inner alias.
      newerCount: sql<number>`(
        SELECT count(*)::int FROM messages newer
        WHERE newer.agent_id = messages.agent_id
          AND (newer.created_at > messages.created_at
            OR (newer.created_at = messages.created_at AND newer.enqueue_order > messages.enqueue_order))
      )`,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.enqueueOrder))
    .limit(input.limit + 1)

  const hasMore = rows.length > input.limit
  const page = hasMore ? rows.slice(0, input.limit) : rows
  const last = page.at(-1)

  return {
    results: page.map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>
      const sender = metadata.sender as { userId?: unknown; name?: unknown } | undefined
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        role: row.role,
        sender:
          sender && typeof sender.userId === 'string' && typeof sender.name === 'string'
            ? { userId: sender.userId, name: sender.name }
            : null,
        source: typeof metadata.source === 'string' ? metadata.source : null,
        isSystem: metadata.isSystem === true,
        snippet: buildMessageSnippet(row.content, query),
        newerCount: Number(row.newerCount),
      }
    }),
    nextCursor:
      hasMore && last?.enqueueOrder != null
        ? encodeMessageCursor({ createdAt: last.createdAt, enqueueOrder: last.enqueueOrder }, cursorContext)
        : null,
  }
}
