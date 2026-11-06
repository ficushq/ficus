import { z } from 'zod'

/** Longest query accepted by one-conversation message search. */
export const MESSAGE_SEARCH_MAX_QUERY_LENGTH = 200
/** Largest page of results one-conversation message search returns. */
export const MESSAGE_SEARCH_MAX_LIMIT = 50

/**
 * Query for `GET /api/agents/:id/messages/search`: a case-insensitive substring
 * search over one conversation's visible message text, newest first.
 */
export const messageSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(MESSAGE_SEARCH_MAX_QUERY_LENGTH),
  limit: z.coerce.number().int().min(1).max(MESSAGE_SEARCH_MAX_LIMIT).default(20),
  /** Opaque cursor from the previous page's `nextCursor`; bound to the agent and query. */
  cursor: z.string().max(1000).optional(),
})
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>

/** A short excerpt of a matching message with the matched ranges. */
export interface MessageSearchSnippet {
  text: string
  /** True when text was cut at the start or end of the message. */
  truncatedStart: boolean
  truncatedEnd: boolean
  /** Half-open [start, end) character ranges in `text` that match the query. */
  highlights: Array<[number, number]>
}

export interface MessageSearchResult {
  /** Message id: the value chat views carry in data-message-id. */
  id: string
  createdAt: string
  role: 'human' | 'assistant'
  /** The person who sent a chat message, when recorded. */
  sender: { userId: string; name: string } | null
  /** Where a non-chat human row came from (inbox, monitor), when recorded. */
  source: string | null
  isSystem: boolean
  snippet: MessageSearchSnippet
  /**
   * How many messages in this conversation are newer than this one. A chat view
   * uses it to load enough history to reach the message.
   */
  newerCount: number
}

export interface MessageSearchResponse {
  results: MessageSearchResult[]
  nextCursor: string | null
}
