import type { RenderItem } from '@ficus/client-core'

export interface ReplySuggestionSet {
  /** The agent message the replies answer. */
  messageId: string
  replies: string[]
}

/** Defensive bounds on what the server saved; it already validates the model's answer. */
const MAX_REPLIES = 4
const MAX_REPLY_CHARS = 80

/**
 * The replies offered for a conversation: those saved on the latest agent message, only while it is
 * the last thing in the transcript. Anything after it (the user's message, a queued send, a new
 * turn, the working indicator, a system notice) means no chips.
 */
export function latestReplySuggestions(items: readonly RenderItem[]): ReplySuggestionSet | null {
  const last = items.at(-1)
  if (!last || last.kind !== 'persisted' || last.message.role !== 'assistant') return null
  const rows = last.mergedFrom?.length ? last.mergedFrom : [last.message]
  for (let index = rows.length - 1; index >= 0; index--) {
    const saved: unknown = rows[index].metadata?.replySuggestions
    if (!Array.isArray(saved)) continue
    const usable = saved
      .filter((reply): reply is string => typeof reply === 'string')
      .map((reply) => reply.trim())
      .filter((reply) => reply.length > 0 && reply.length <= MAX_REPLY_CHARS)
    const replies = [...new Set(usable)].slice(0, MAX_REPLIES)
    return replies.length > 0 ? { messageId: rows[index].id, replies } : null
  }
  return null
}
