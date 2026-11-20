/**
 * Validation for the summary model's answer. The answer is untrusted text: only one plain line of
 * at most WORK_STREAM_SUMMARY_MAX_CHARS characters survives. Anything else is discarded whole (never
 * cut down), and the stream keeps its previous summary.
 */
import { WORK_STREAM_SUMMARY_MAX_CHARS } from '@ficus/shared'

// Control, zero-width and bidirectional-override characters (newlines are checked separately).
/* eslint-disable no-control-regex */
const INVISIBLE =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
/* eslint-enable no-control-regex */
const URL_LIKE = /:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|io|dev|app)\/\S/i
/** Markdown that would render as something other than plain text. */
const MARKDOWN = /`|\*\*|__|\[[^\]]*\]\(|^\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+\.\s)|<\/?[a-z][^>]*>/i
const WRAPPING_QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g
const LABEL_PREFIX = /^(?:summary|status|now)\s*:\s*/i

/** The summary line in a model answer, or null when the answer is not one usable line. */
export function parseStreamSummary(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || /[\r\n]/.test(trimmed)) return null
  const text = trimmed.replace(LABEL_PREFIX, '').replace(WRAPPING_QUOTES, '').replace(/\s+/g, ' ').trim()
  if (!text || INVISIBLE.test(text) || URL_LIKE.test(text) || MARKDOWN.test(text)) return null
  if ([...text].length > WORK_STREAM_SUMMARY_MAX_CHARS) return null
  // A bare "none" or an apology is not a status line.
  if (/^(?:none|n\/a|no (?:new )?(?:activity|update)s?\.?)$/i.test(text)) return null
  return text
}
