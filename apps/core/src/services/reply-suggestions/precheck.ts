/**
 * A cheap, model-free check that an agent's message probably ends by asking the human something,
 * so the reply-suggestion model is only asked when chips are plausible.
 *
 * Real questions sit in the last one or two paragraphs (often followed by a trailing status line),
 * and only about half end exactly in "?". The text is cleaned first so a "?" that is not a question
 * does not count: URLs and query strings (`?ws=42`), code, block quotes, headings and bold
 * heading-style questions ("**Is it needed?** Yes, because…").
 */

/** Phrases that ask the human for a decision without a question mark. */
const ASKING_PHRASES =
  /\b(?:want me to|should i|shall i|let me know|your call|which (?:one )?do you prefer|which would you prefer|would you like|do you want)\b/i

/** How many trailing paragraphs are searched. */
const TAIL_PARAGRAPHS = 2

/** Remove text whose "?" or wording is not a question to the human. */
export function stripNonQuestionText(text: string): string {
  let value = text.replace(/\r\n?/g, '\n')
  // Fenced code, including an unterminated fence at the end.
  value = value.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n')
  // Inline code.
  value = value.replace(/`[^`\n]*`/g, ' ')
  // Markdown links keep their label; the target goes.
  value = value.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
  // Bare URLs, then anything still carrying a query string (/x?ws=42, ?ws=42).
  value = value.replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, ' ')
  value = value.replace(/\S*\?[\w.-]+=\S*/g, ' ')

  const lines = value.split('\n')
  const lastContent = findLastIndex(lines, (line) => line.trim() !== '')
  const kept = lines.map((line, index) => {
    // Block quotes and headings.
    if (/^\s*>/.test(line) || /^\s{0,3}#{1,6}\s/.test(line)) return ''
    // A line that is only bold text reads as a heading, unless it is the message's last line.
    if (index !== lastContent && /^\s*(?:\*\*|__)[^*_\n]+(?:\*\*|__)\s*:?\s*$/.test(line)) return ''
    // A bold question leading a line that goes on is a heading too: "**Is it needed?** Yes, …".
    return line.replace(/^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(\*\*|__)[^*_\n]*\?\s*\2(?=\s*\S)/, '$1')
  })
  return kept.join('\n')
}

/** The last paragraphs of cleaned text, where a question to the human would be. */
export function questionTail(text: string, paragraphs = TAIL_PARAGRAPHS): string {
  return stripNonQuestionText(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(-paragraphs)
    .join('\n\n')
}

/** Whether an agent's message plausibly ends by asking the human something. */
export function likelyAsksHuman(text: string): boolean {
  const tail = questionTail(text)
  return tail.includes('?') || ASKING_PHRASES.test(tail)
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index
  return -1
}
