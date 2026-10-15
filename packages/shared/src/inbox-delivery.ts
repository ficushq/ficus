/**
 * Helpers for the agent-facing inbox delivery prompt (services/inbox/inboxDelivery.ts
 * formatInboxMessages): "You have N unread message(s) …", one `### Message <id>`
 * section per message (with **From:** / **Sent at:** / **Subject:** lines, then
 * the body), sections separated by `---`, and usually a trailing "**Mark one or
 * more messages as read …**" footer (left out for Assistant agents). Both apps render that delivery as cards showing
 * each message's SUBJECT and BODY, not the framing — and the persisted
 * `inboxMessageSummaries` only carry a short preview, so the full bodies must
 * be recovered from the prompt itself.
 */

const FOOTER_RE = /\n+\*\*Mark one or more messages as read/
const HEADER_RE = /^\s*You have \d+ unread message\(s\)[^\n]*\n+/
const SECTION_SEPARATOR_RE = /\n+---\n+/
const SUBJECT_LINE_RE = /\*\*Subject:\*\*[^\n]*\n+/

const MESSAGE_SECTION_RE = /^### Message /m

/** Whether `content` is an inbox delivery prompt (has at least one message section). */
export function hasInboxFraming(content: string): boolean {
  return MESSAGE_SECTION_RE.test(content)
}

/**
 * The body of each message section, in delivery order (index-aligned with
 * `metadata.inboxMessageSummaries` for a summaries-bearing delivery). Empty
 * sections are dropped. Content WITHOUT the framing yields `[]` — callers that
 * render per-message cards fall back to the summary preview, because an
 * unframed content is not a body they can attribute to a message.
 */
export function extractInboxBodies(content: string): string[] {
  if (!hasInboxFraming(content)) return []
  let text = content
  const footer = text.search(FOOTER_RE)
  if (footer !== -1) text = text.slice(0, footer)
  text = text.replace(HEADER_RE, '')
  return text
    .split(SECTION_SEPARATOR_RE)
    .map((section) => (section.split(SUBJECT_LINE_RE).pop() ?? section).trim())
    .filter(Boolean)
}

/** All message bodies joined with `---` separators (single-body deliveries are just the body). */
export function extractInboxBody(content: string): string {
  const joined = extractInboxBodies(content).join('\n\n---\n\n').trim()
  return joined || content.trim()
}
