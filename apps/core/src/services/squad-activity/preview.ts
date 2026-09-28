import { decodeHTML } from 'entities'
import { marked, type Token } from 'marked'
import { parseEntityReference, type ActivityPreviewSpan } from '@ficus/shared'

// Bound parser work and wire size independently of visible text. An oversized
// destination degrades to its authored label, never to a partial URL.
const MAX_SOURCE = 65_536
const MAX_DESTINATION = 8_192
const MAX_DEPTH = 64
const MAX_TOKENS = 8_192

function safeHref(href: string): string | undefined {
  if (href.length > MAX_DESTINATION) return
  if (parseEntityReference(href)) return href
  try {
    const url = new URL(href)
    if (url.protocol === 'https:' || url.protocol === 'http:') return href
  } catch {
    /* Not an absolute URL. */
  }
}

/** Parse original Markdown, flatten blocks, then limit Unicode visible points. */
export function activityPreview(
  value: string,
  max = 160,
  prefix = ''
): {
  summary: string
  preview: ActivityPreviewSpan[]
} {
  max = Number.isFinite(max) ? Math.max(1, Math.min(512, Math.floor(max))) : 160
  const spans: ActivityPreviewSpan[] = []
  const add = (text: string, style: Omit<ActivityPreviewSpan, 'text'> = {}) => {
    text = (style.code ? text : decodeHTML(text)).replace(/\s+/g, ' ')
    if (!spans.length) text = text.trimStart()
    if (spans.at(-1)?.text.endsWith(' ')) text = text.replace(/^ /, '')
    if (!text) return
    const last = spans.at(-1)
    if (
      last &&
      last.bold === style.bold &&
      last.italic === style.italic &&
      last.code === style.code &&
      last.href === style.href
    )
      last.text += text
    else spans.push({ text, ...style })
  }
  let visited = 0
  const walk = (tokens: Token[] = [], style: Omit<ActivityPreviewSpan, 'text'> = {}, depth = 0) => {
    if (depth > MAX_DEPTH) throw new RangeError('Activity preview nesting limit')
    for (const token of tokens) {
      if (++visited > MAX_TOKENS) throw new RangeError('Activity preview token limit')
      switch (token.type) {
        case 'html':
          break
        case 'space':
        case 'br':
        case 'hr':
          add(' ')
          break
        case 'strong':
          walk(token.tokens, { ...style, bold: true }, depth + 1)
          break
        case 'em':
          walk(token.tokens, { ...style, italic: true }, depth + 1)
          break
        case 'codespan':
        case 'code':
          add(token.text, { ...style, code: true })
          break
        case 'link': {
          const href = value.length <= MAX_SOURCE ? safeHref(decodeHTML(token.href)) : undefined
          walk(token.tokens, { ...style, ...(href ? { href } : {}) }, depth + 1)
          break
        }
        case 'image':
          add(token.text, style)
          break
        case 'list':
          for (const item of token.items) {
            walk(item.tokens, style, depth + 1)
            add(' ')
          }
          break
        case 'table':
          for (const row of [token.header, ...token.rows])
            for (const cell of row) {
              walk(cell.tokens, style, depth + 1)
              add(' ')
            }
          break
        default:
          if ('tokens' in token && token.tokens) walk(token.tokens as Token[], style, depth + 1)
          else if ('text' in token) add(token.text as string, style)
      }
      if (['paragraph', 'heading', 'blockquote', 'code', 'list', 'table'].includes(token.type)) add(' ')
    }
  }
  if (prefix) add(`${prefix} `)
  const bounded = value.slice(0, MAX_SOURCE)
  // Never lex an incomplete source boundary into a fabricated partial URL.
  const source = value.length > MAX_SOURCE ? bounded.slice(0, Math.max(0, bounded.lastIndexOf('\n'))) : bounded
  try {
    walk(marked.lexer(source, { gfm: true }))
  } catch {
    // The lexer may reject adversarial nesting even below MAX_SOURCE. Discard
    // partial rich output: only literal original-source text survives, with no
    // URLs or markup interpretation. This is not a stored-summary fallback.
    spans.length = 0
    spans.push({ text: `${prefix ? `${prefix} ` : ''}${bounded}`.replace(/\s+/g, ' ').trim() })
  }
  while (spans.length && !spans.at(-1)!.text.trimEnd()) spans.pop()
  if (spans.length) spans.at(-1)!.text = spans.at(-1)!.text.trimEnd()
  const length = spans.reduce((sum, span) => sum + [...span.text].length, 0)
  const clipped = length > max || value.length > MAX_SOURCE
  let remaining = Math.max(0, Math.min(512, max) - (clipped ? 1 : 0))
  const preview: ActivityPreviewSpan[] = []
  let destinationBudget = 32_768
  for (const span of spans) {
    if (!remaining) break
    const points = [...span.text]
    const { href, ...style } = span
    const destination = href && href.length <= destinationBudget ? href : undefined
    if (destination) destinationBudget -= destination.length
    preview.push({ ...style, text: points.slice(0, remaining).join(''), ...(destination ? { href: destination } : {}) })
    remaining -= Math.min(points.length, remaining)
  }
  if (clipped) {
    while (preview.length && !preview.at(-1)!.text.trimEnd()) preview.pop()
    if (preview.length) preview.at(-1)!.text = preview.at(-1)!.text.trimEnd()
    preview.push({ text: '…' })
  }
  return { summary: preview.map((span) => span.text).join(''), preview }
}
