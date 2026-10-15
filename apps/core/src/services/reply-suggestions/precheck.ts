/**
 * A cheap, model-free check that an agent's message probably ends by asking the human something,
 * so the reply-suggestion model is only asked when chips are plausible. It is a real filter: plain
 * status updates, recaps and answers must not pass, because every pass costs a model call.
 *
 * Real questions sit in the last few paragraphs (often followed by a trailing status line or an
 * options list), and only about half end exactly in "?". The text is cleaned first so a "?" that is
 * not a question does not count: URLs and query strings (`?ws=42`), code, block quotes, headings and
 * bold heading-style questions ("**Is it needed?** Yes, because…").
 */

/**
 * Wordings that ask the human for a decision or offer them something without a question mark.
 * Each one is narrow on purpose (see precheck.test.ts for what must and must not match):
 * - "if you want/like" offers, but not "if you want to see/check…" pointers to information;
 * - "or I can" (an alternative offered), not any "I can" ("I can see the logs");
 * - "happy to …" offers, not the "happy to help" sign-off;
 * - "if that works / sounds good" only at the end of a sentence or with "for you", not
 *   "if that works, I'll merge";
 * - "Want to …" only where a sentence starts, not "I want to note".
 */
const ASKING_PHRASES = new RegExp(
  [
    String.raw`\b(?:want me to|should (?:i|we)|shall (?:i|we)|let me know|your call|up to you|say the word)\b`,
    String.raw`\b(?:which (?:one )?do you prefer|which would you prefer|would you like|do you want)\b`,
    String.raw`(?:^|[.!;:]\s+)want to\b`,
    String.raw`\bif you(?:['’]d| would)? (?:want|like|prefer)\b(?! to (?:see|read|check|look|view|know|dig)\b)`,
    String.raw`\bor i can\b(?!['’]t|not)`,
    String.raw`\bhappy to (?!help\b)`,
    String.raw`\b(?:once|when|after|as soon as) you(?:['’]ve)? confirm`,
    String.raw`\bif that (?:works|sounds good) for you\b`,
    String.raw`\bif that (?:works|sounds good)(?=\s*(?:[.!;)]|$))`,
  ].join('|'),
  'im'
)

/** How many trailing paragraphs are searched, not counting a trailing options list. */
const TAIL_PARAGRAPHS = 3

/** A line that is only bold text ("**Plan**", "**Want me to start it?**"). */
const BOLD_ONLY_LINE = /^\s*(?:\*\*|__)([^*_\n]+)(?:\*\*|__)\s*:?\s*$/

/**
 * A line that starts an option or list item: "- x", "1. x", "1) x", "A) x", "A. x", "**A.** x",
 * "**A. Name**: x", "**Option B**".
 */
const OPTION_LINE =
  /^\s*(?:[-*+•]\s+|\d{1,2}[.)]\s+|[A-Za-z][.)]\s+|(?:\*\*|__)(?:option\s+)?(?:[A-Za-z]|\d{1,2})(?:[.):]|\s*(?:\*\*|__)))/i

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
    const bold = BOLD_ONLY_LINE.exec(line)
    if (bold) {
      // A bold question is kept unless it heads text on the next line, which reads as a heading
      // answered in place ("**Why did it fail?**\nThe token expired…").
      if (bold[1].trim().endsWith('?')) return lines[index + 1]?.trim() ? '' : line
      // Other bold-only lines read as headings, unless it is the message's last line.
      return index === lastContent ? line : ''
    }
    // A bold question leading a line that goes on is a heading too: "**Is it needed?** Yes, …".
    return line.replace(/^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(\*\*|__)[^*_\n]*\?\s*\2(?=\s*\S)/, '$1')
  })
  return kept.join('\n')
}

/**
 * The end of the cleaned text, where a question to the human would be: the last `paragraphs`
 * paragraphs, plus any options list after them ("Which do you prefer?" followed by "**A.** …" and
 * "**B.** …" paragraphs), so a list does not push the question out of view.
 */
export function questionTail(text: string, paragraphs = TAIL_PARAGRAPHS): string {
  const all = stripNonQuestionText(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  let start = all.length
  while (start > 0 && isOptionParagraph(all[start - 1])) start--
  return all.slice(Math.max(0, start - paragraphs)).join('\n\n')
}

/** Whether an agent's message plausibly ends by asking the human something. */
export function likelyAsksHuman(text: string): boolean {
  const tail = questionTail(text)
  return tail.includes('?') || ASKING_PHRASES.test(tail)
}

/** A paragraph that is only option or list items (indented lines continue an item). */
function isOptionParagraph(paragraph: string): boolean {
  const [first, ...rest] = paragraph.split('\n')
  return OPTION_LINE.test(first) && rest.every((line) => OPTION_LINE.test(line) || /^\s+\S/.test(line))
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index
  return -1
}
