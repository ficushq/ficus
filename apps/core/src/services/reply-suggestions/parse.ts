/**
 * Validation for the reply-suggestion model's answer. The answer is untrusted text: it is parsed as
 * JSON, and only short, plain, single-line strings survive. Anything malformed yields no chips.
 */

export const MAX_REPLY_SUGGESTIONS = 4
/** Fewer than this many usable replies is not worth a row of chips. */
export const MIN_REPLY_SUGGESTIONS = 2
/** Longest reply kept, in characters; longer ones are dropped rather than cut mid-sentence. */
export const MAX_REPLY_CHARS = 40

// Control, zero-width and bidirectional-override characters never belong in a chip.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
const URL_LIKE = /:\/\/|\bwww\./i
const WRAPPING_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g

/** The JSON value in a model answer: the whole text, a fenced block, or the outermost array. */
function extractJson(raw: string): unknown {
  const text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  for (const candidate of [text, fenced, outermost(text, '[', ']'), outermost(text, '{', '}')]) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return undefined
}

function outermost(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined
}

/** One reply as plain single-line text, or null when it cannot be a chip. */
export function cleanReply(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().replace(WRAPPING_QUOTES, '').trim()
  if (!text || URL_LIKE.test(text)) return null
  if ([...text].length > MAX_REPLY_CHARS) return null
  return text
}

/**
 * The replies in a model answer: a JSON array of strings, or `{ "replies": [...] }`. Invalid items
 * are dropped, duplicates removed, and at most {@link MAX_REPLY_SUGGESTIONS} kept; fewer than
 * {@link MIN_REPLY_SUGGESTIONS} usable replies means none.
 */
export function parseReplySuggestions(raw: string): string[] {
  const parsed = extractJson(raw)
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { replies?: unknown }).replies)
      ? (parsed as { replies: unknown[] }).replies
      : []
  const seen = new Set<string>()
  const replies: string[] = []
  for (const item of list) {
    const reply = cleanReply(item)
    if (!reply) continue
    const key = reply.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    replies.push(reply)
    if (replies.length === MAX_REPLY_SUGGESTIONS) break
  }
  return replies.length >= MIN_REPLY_SUGGESTIONS ? replies : []
}
