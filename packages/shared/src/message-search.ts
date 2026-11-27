import { z } from 'zod'

/** Longest query accepted by one-conversation message search. */
export const MESSAGE_SEARCH_MAX_QUERY_LENGTH = 200
/** Largest page of results one-conversation message search returns. */
export const MESSAGE_SEARCH_MAX_LIMIT = 50

/**
 * What one-conversation message search looks at:
 * - `text`: the visible message text (what a person wrote, the agent's reply text). The default,
 *   and what the chat view uses, because it collapses tool calls.
 * - `tools`: tool calls (tool name and arguments) and tool results.
 * - `all`: both.
 */
export const MESSAGE_SEARCH_SCOPES = ['text', 'tools', 'all'] as const
export type MessageSearchScope = (typeof MESSAGE_SEARCH_SCOPES)[number]
export const messageSearchScopeSchema = z.enum(MESSAGE_SEARCH_SCOPES)

const timestampSchema = z
  .string()
  .max(100)
  .refine((value) => !Number.isNaN(new Date(value).valueOf()), 'Expected an ISO timestamp')

/**
 * Query for `GET /api/agents/:id/messages/search`: a case-insensitive, literal substring
 * search over one conversation, newest first.
 */
export const messageSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(MESSAGE_SEARCH_MAX_QUERY_LENGTH),
  limit: z.coerce.number().int().min(1).max(MESSAGE_SEARCH_MAX_LIMIT).default(20),
  /** Opaque cursor from the previous page's `nextCursor`; bound to the agent, query and filters. */
  cursor: z.string().max(1000).optional(),
  /** Where to look; defaults to the visible message text. */
  in: messageSearchScopeSchema.default('text'),
  /** Only messages with this role. */
  role: z.enum(['human', 'assistant']).optional(),
  /** Only messages created before this timestamp. */
  before: timestampSchema.optional(),
  /** Only messages created after this timestamp. */
  after: timestampSchema.optional(),
})
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>
export type MessageSearchQueryInput = z.input<typeof messageSearchQuerySchema>

/** A short excerpt of a matching message with the matched ranges. */
export interface MessageSearchSnippet {
  text: string
  /** True when text was cut at the start or end of the message. */
  truncatedStart: boolean
  truncatedEnd: boolean
  /** Half-open [start, end) character ranges in `text` that match the query. */
  highlights: Array<[number, number]>
}

/** Where the snippet's match is: the message text, or one tool call's name, arguments or result. */
export type MessageSearchMatch =
  { field: 'text' } | { field: 'tool_name' | 'tool_args' | 'tool_result'; toolName: string; toolCallId: string }

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
  /** Where the snippet comes from. Always `text` for a `text` search. */
  match: MessageSearchMatch
  snippet: MessageSearchSnippet
  /**
   * How many messages in this conversation are newer than this one, whatever the
   * search filters. A chat view uses it to load enough history to reach the
   * message; the CLI uses it to fetch the messages around a hit.
   */
  newerCount: number
}

export interface MessageSearchResponse {
  results: MessageSearchResult[]
  nextCursor: string | null
}
