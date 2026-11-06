import type { MessageSearchSnippet } from '@ficus/shared'

/** Characters kept on each side of the first match in a snippet. */
const SNIPPET_CONTEXT = 80
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** Build a short, single-line excerpt around the first match with every match in it marked. */
export function buildMessageSnippet(content: string, query: string, context = SNIPPET_CONTEXT): MessageSearchSnippet {
  const pattern = new RegExp(escapeRegExp(query), 'giu')
  const first = pattern.exec(content)
  // Postgres and JavaScript case folding can differ for a few characters; show the start then.
  const matchStart = first?.index ?? 0
  const matchEnd = first ? matchStart + first[0].length : 0

  let start = Math.max(0, matchStart - context)
  let end = Math.min(content.length, matchEnd + context)
  // Prefer word boundaries within the context window, and never split a surrogate pair.
  if (start > 0) {
    const space = content.slice(start, matchStart).search(/\s/)
    if (space >= 0) start += space + 1
    if (isLowSurrogate(content.charCodeAt(start))) start += 1
  }
  if (end < content.length) {
    const tail = content.slice(matchEnd, end)
    const lastSpace = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'), tail.lastIndexOf('\t'))
    if (lastSpace > 0) end = matchEnd + lastSpace
    if (isLowSurrogate(content.charCodeAt(end))) end -= 1
  }

  // Whitespace becomes plain spaces one for one, so highlight offsets stay exact.
  const text = content.slice(start, end).replace(/\s/g, ' ')
  const highlights: Array<[number, number]> = []
  if (first) {
    const inSnippet = new RegExp(escapeRegExp(query), 'giu')
    const original = content.slice(start, end)
    for (let match = inSnippet.exec(original); match; match = inSnippet.exec(original)) {
      if (match[0].length === 0) break
      highlights.push([match.index, match.index + match[0].length])
    }
  }
  return { text, truncatedStart: start > 0, truncatedEnd: end < content.length, highlights }
}
