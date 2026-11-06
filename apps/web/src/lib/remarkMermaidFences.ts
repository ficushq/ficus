import { visit } from 'unist-util-visit'

/** The hast property set on the `code` element of a Mermaid fence that has no closing fence yet. */
const UNCLOSED_FENCE_PROPERTY = 'dataFenceUnclosed'
/** The same marker as react-markdown passes it to the `code` component. */
export const UNCLOSED_FENCE_ATTRIBUTE = 'data-fence-unclosed'

/**
 * Marks Mermaid fences whose closing fence has not arrived yet.
 *
 * Markdown closes an unterminated fence at the end of the document, so while a message streams the
 * partial diagram source still parses as a complete code block. The renderer keeps such a block as
 * code and draws the diagram only once the closing fence exists, so half-written diagrams never
 * flash a parse error.
 */
export function remarkMermaidFences() {
  return (tree: any, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '')
    visit(tree, 'code', (node: any) => {
      if (node.lang !== 'mermaid') return
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (typeof start !== 'number' || typeof end !== 'number') return
      if (hasClosingFence(source.slice(start, end))) return
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, [UNCLOSED_FENCE_PROPERTY]: 'true' },
      }
    })
  }
}

/** Container markers (block quote `>` and list indentation) may precede both fences. */
const FENCE_LINE = /^[\s>]*(`{3,}|~{3,})(.*)$/

function hasClosingFence(raw: string): boolean {
  const lines = raw.replace(/\n+$/, '').split('\n')
  if (lines.length < 2) return false
  const opening = FENCE_LINE.exec(lines[0]!)?.[1]
  const closing = FENCE_LINE.exec(lines[lines.length - 1]!)
  if (!opening || !closing) return false
  const [, fence, rest] = closing
  return fence![0] === opening[0] && fence!.length >= opening.length && rest!.trim() === ''
}
