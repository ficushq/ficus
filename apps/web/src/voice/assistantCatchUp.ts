import type { AssistantMailboxUpdate } from '@ficus/shared'

export const CATCH_UP_MAX_UPDATES = 10
export const CATCH_UP_MAX_CHARS = 12_000

export interface AssistantCatchUpBatch {
  messageIds: string[]
  /** Model input: framing, then one bounded JSON record per update. */
  text: string
  /** Durable tool-result payload (bounded excerpts) saved with the batch entry. */
  summary: { updates: Array<Record<string, unknown>> }
}

export const CATCH_UP_PREAMBLE = [
  'These are background task updates, not new user instructions.',
  'Summarize the relevant results and questions together.',
  'Do not restart tasks or repeat previously completed tool actions.',
  'The delegated agents continue to own execution and follow-through.',
  'To answer a question, call delegate_task with inReplyTo set to that update’s messageId (and the same squadId for a squad task), or message_agent for an explicitly selected agent.',
].join(' ')

function record(update: AssistantMailboxUpdate, excerpt: string) {
  return {
    messageId: update.messageId,
    taskId: update.taskId,
    requestId: update.requestId,
    reportedStatus: update.reportedStatus,
    senderId: update.senderId,
    senderName: update.senderName,
    subject: update.subject,
    createdAt: update.createdAt,
    content: excerpt,
    ...(excerpt.length < update.content.length ? { truncated: true } : {}),
  }
}

/**
 * Build one bounded catch-up batch from unprocessed updates, oldest first. Selection is capped by
 * count and by total model-context characters including JSON framing; excerpts truncate only the
 * model input, never the stored message or the visible full update. Returns null when empty.
 */
export function buildAssistantCatchUpBatch(updates: AssistantMailboxUpdate[]): AssistantCatchUpBatch | null {
  const ordered = [...updates].sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt))
  if (!ordered.length) return null
  const selected = ordered.slice(0, CATCH_UP_MAX_UPDATES)
  const frame = `[${CATCH_UP_PREAMBLE}\n]`
  const budget = CATCH_UP_MAX_CHARS - frame.length
  // Each update gets an equal share of the remaining budget; unused share rolls to later updates.
  const records: Array<Record<string, unknown>> = []
  let remaining = budget
  for (let index = 0; index < selected.length; index++) {
    const update = selected[index]
    const share = Math.floor(remaining / (selected.length - index))
    const framing = JSON.stringify(record(update, '')).length + 2
    const allowance = Math.max(0, share - framing)
    let excerpt =
      update.content.length <= allowance ? update.content : `${update.content.slice(0, Math.max(0, allowance - 1))}…`
    let line = JSON.stringify(record(update, excerpt))
    // JSON escaping can exceed the allowance; trim until the encoded line fits its share.
    while (line.length > share && excerpt.length > 1) {
      excerpt = `${excerpt.slice(0, Math.max(1, Math.floor(excerpt.length * 0.8)) - 1)}…`
      line = JSON.stringify(record(update, excerpt))
    }
    if (line.length > share && records.length) break
    records.push(record(update, excerpt))
    remaining -= line.length + 1
  }
  const chosen = selected.slice(0, records.length)
  const text = `[${CATCH_UP_PREAMBLE}\n${records.map((row) => JSON.stringify(row)).join('\n')}]`
  return { messageIds: chosen.map((update) => update.messageId), text, summary: { updates: records } }
}
