import { and, desc, eq, gt, ilike, lt, or, sql, type SQL } from 'drizzle-orm'
import type {
  MessageSearchMatch,
  MessageSearchQuery,
  MessageSearchResponse,
  MessageSearchScope,
  MessageSearchSnippet,
} from '@ficus/shared'
import { db, messages } from '../../db'
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor'
import { buildMessageSnippet, containsQuery } from './message-snippet'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('message-search')

/**
 * Search one agent conversation's full message history. This is the only message-search
 * implementation for a conversation: the chat view's history search, `ficus agent search`
 * and the `search` filter of message listing (`ficus agent messages --search`) all use it.
 *
 * A match is a case-insensitive, literal substring: `%`, `_` and `\` in the query match
 * themselves. The scope decides where it looks:
 * - `text` (the default) is the visible message text, `messages.content`: what a person
 *   wrote and the visible text of the agent's reply. The chat view uses it because it
 *   collapses tool calls, so a hit there would jump to a message whose visible text does
 *   not contain the query.
 * - `tools` is every tool call's name, arguments and result, stored as `tool_use` blocks in
 *   `metadata.content`. Thinking is never searched.
 * - `all` is both.
 *
 * Tool matching is not indexed. It is a jsonpath filter over this agent's rows, found
 * through the agent's (agent_id, created_at) index; "Conversation history search" in
 * docs/wiki/agents-and-executions.md has the measurements behind that choice.
 *
 * The caller must already have authorized reading this agent's messages; this
 * function only ever reads rows of `agentId`.
 */

/** Cursor scope marker so a search cursor is never valid for message listing, and vice versa. */
const CURSOR_ROLE = 'message-search'

/** Escape LIKE wildcards so `%`, `_` and `\` match themselves (Postgres' default escape is `\`). */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&')

/**
 * Tool arguments are stored as JSON text, so a quote, backslash or newline in an argument is
 * escaped there. Arguments also match the query in that escaped form, so `-m "fix"` finds
 * `{"command":"git commit -m \\"fix\\""}`. Null when escaping changes nothing.
 */
export function jsonEscapedQuery(query: string): string | null {
  const escaped = JSON.stringify(query).slice(1, -1)
  return escaped === query ? null : escaped
}

/**
 * A jsonpath that is true when any tool call's name, arguments or result contains the query.
 * `like_regex ... flag "q"` takes the pattern literally and `"i"` ignores case. Each pattern
 * becomes a jsonpath string literal through JSON string escaping, whose escapes jsonpath
 * accepts, and the whole path is sent as a bound parameter.
 */
export function toolCallJsonPath(query: string): string {
  const contains = (field: string, pattern: string) => `@.${field} like_regex ${JSON.stringify(pattern)} flag "iq"`
  const escaped = jsonEscapedQuery(query)
  const checks = [
    contains('toolName', query),
    contains('args', query),
    ...(escaped ? [contains('args', escaped)] : []),
    contains('result', query),
  ]
  return `$.content[*] ? (@.type == "tool_use").toolCall ? (${checks.join(' || ')})`
}

/**
 * Log how long a conversation search took, without the query text. Tool search is not indexed, so these
 * lines are what tells us when long histories make it slow enough to need the trigram index.
 */
export function logMessageSearch(entry: {
  agentId: string
  via: 'search' | 'list'
  scope: MessageSearchScope
  durationMs: number
  results: number
}): void {
  log.info(
    `Searched agent ${entry.agentId} via ${entry.via} (in=${entry.scope}): ${entry.results} result(s) in ${Math.round(entry.durationMs)} ms`
  )
}

/** The SQL condition for "this message matches the query in this scope". */
export function messageSearchCondition(query: string, scope: MessageSearchScope = 'text'): SQL {
  const text = ilike(messages.content, `%${escapeLike(query)}%`)
  if (scope === 'text') return text
  const tools = sql`${messages.metadata} @? ${toolCallJsonPath(query)}::jsonpath`
  return scope === 'tools' ? tools : or(text, tools)!
}

interface ToolCallLike {
  toolCallId?: unknown
  toolName?: unknown
  args?: unknown
  result?: unknown
}

const TOOL_FIELDS = [
  ['tool_name', 'toolName'],
  ['tool_args', 'args'],
  ['tool_result', 'result'],
] as const

/** Find where a matching row matched, preferring visible text, then tool calls in order. */
export function locateMessageMatch(
  row: { content: string; metadata: unknown },
  query: string,
  scope: MessageSearchScope
): { match: MessageSearchMatch; snippet: MessageSearchSnippet } {
  if (scope !== 'tools' && containsQuery(row.content, query))
    return { match: { field: 'text' }, snippet: buildMessageSnippet(row.content, query) }
  if (scope !== 'text') {
    const metadata = (row.metadata ?? {}) as { content?: unknown }
    const blocks = Array.isArray(metadata.content) ? metadata.content : []
    for (const block of blocks as Array<{ type?: unknown; id?: unknown; toolCall?: ToolCallLike } | null>) {
      if (block?.type !== 'tool_use' || !block.toolCall || typeof block.toolCall !== 'object') continue
      const call = block.toolCall
      const toolName = typeof call.toolName === 'string' ? call.toolName : ''
      const toolCallId =
        typeof call.toolCallId === 'string' ? call.toolCallId : typeof block.id === 'string' ? block.id : ''
      for (const [field, key] of TOOL_FIELDS) {
        const value = call[key]
        if (typeof value !== 'string') continue
        const escaped = key === 'args' ? jsonEscapedQuery(query) : null
        const pattern = containsQuery(value, query) ? query : escaped && containsQuery(value, escaped) ? escaped : null
        if (pattern) return { match: { field, toolName, toolCallId }, snippet: buildMessageSnippet(value, pattern) }
      }
    }
  }
  // Postgres and JavaScript case folding can differ for a few characters; show the text then.
  return { match: { field: 'text' }, snippet: buildMessageSnippet(row.content, query) }
}

export async function searchAgentMessages(agentId: string, input: MessageSearchQuery): Promise<MessageSearchResponse> {
  const startedAt = performance.now()
  const query = input.q
  const scope = input.in ?? 'text'
  const cursorContext = {
    agentId,
    role: input.role ? `${CURSOR_ROLE}:${input.role}` : CURSOR_ROLE,
    search: query,
    before: input.before,
    after: input.after,
    scope,
  }
  const conditions: SQL[] = [eq(messages.agentId, agentId), messageSearchCondition(query, scope)]
  if (input.role) conditions.push(eq(messages.role, input.role))
  if (input.before) conditions.push(lt(messages.createdAt, new Date(input.before)))
  if (input.after) conditions.push(gt(messages.createdAt, new Date(input.after)))
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
  logMessageSearch({ agentId, via: 'search', scope, durationMs: performance.now() - startedAt, results: page.length })

  return {
    results: page.map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>
      const sender = metadata.sender as { userId?: unknown; name?: unknown } | undefined
      const { match, snippet } = locateMessageMatch(row, query, scope)
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
        match,
        snippet,
        newerCount: Number(row.newerCount),
      }
    }),
    nextCursor:
      hasMore && last?.enqueueOrder != null
        ? encodeMessageCursor({ createdAt: last.createdAt, enqueueOrder: last.enqueueOrder }, cursorContext)
        : null,
  }
}
