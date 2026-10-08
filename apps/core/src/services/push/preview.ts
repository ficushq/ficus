import { decodeHTML } from 'entities'
import { marked, type Token, type Tokens } from 'marked'

/** OS alerts have no Markdown renderer. Walk parsed tokens, never strip punctuation from prose. */
export function pushPlainText(markdown: string): string {
  const walk = (tokens: Token[]): string => tokens.map(render).join('')
  const render = (token: Token): string => {
    let text: string
    switch (token.type) {
      case 'checkbox':
      case 'def':
        return ''
      case 'space':
        return token.raw
      case 'br':
        return '\n'
      case 'hr':
        text = ''
        break
      case 'code':
      case 'codespan':
        // Code is literal: preserve punctuation and entity spellings inside it.
        text = token.text
        break
      case 'list':
        text = token.items.map((item: Tokens.ListItem) => render(item)).join('')
        break
      case 'table':
        text = [token.header, ...token.rows]
          .map((row: Tokens.TableCell[]) => row.map((cell) => walk(cell.tokens)).join('\t'))
          .join('\n')
        break
      default:
        // Includes nested formatting, link labels, image alt text and resolved reference links.
        text =
          'tokens' in token && token.tokens ? walk(token.tokens) : decodeHTML('text' in token ? token.text : token.raw)
    }
    // Block delimiters can consume newlines. Keep their spacing without duplicating
    // newlines already included by child tokens (notably quotes and nested lists).
    const suffix = token.raw.match(/\n+$/)?.[0] ?? ''
    const existing = text.match(/\n+$/)?.[0] ?? ''
    return text + suffix.slice(existing.length)
  }
  return walk(marked.lexer(markdown, { gfm: true }))
}

function previewText(markdown: string, max: number): string {
  // Relay limits count UTF-16 units. Respect them without leaving half an emoji.
  return pushPlainText(markdown)
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, '')
}

/** Shared outbound presentation for web, native/relay and desktop pushes; never mutates the rich event. */
export function pushPreview(event: {
  title: string
  body: string
  pushSource?: { title?: string; body?: string; subtitle?: string }
  subtitle?: string
}) {
  const subtitle = event.pushSource?.subtitle ?? event.subtitle
  return {
    title: previewText(event.pushSource?.title ?? event.title, 200),
    body: previewText(event.pushSource?.body ?? event.body, 500),
    ...(subtitle ? { subtitle: previewText(subtitle, 80) } : {}),
  }
}
