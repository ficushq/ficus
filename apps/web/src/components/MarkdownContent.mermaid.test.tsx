import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from './MarkdownContent'

const html = (markdown: string) => renderToStaticMarkup(<MarkdownContent>{markdown}</MarkdownContent>)

/** How many fences render as Mermaid diagrams (before Mermaid loads they show their source). */
const diagrams = (markdown: string) => html(markdown).match(/data-mermaid="/g)?.length ?? 0

describe('Mermaid fences in Markdown', () => {
  test('a complete fence becomes a diagram that shows its source until Mermaid has drawn it', () => {
    const output = html('Flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n')
    expect(output).toContain('data-mermaid="loading"')
    expect(output).toContain('class="language-mermaid"')
    expect(output).not.toContain('data-fence-unclosed')
    for (const complete of [
      '~~~mermaid\nflowchart TD\n~~~',
      '> ```mermaid\n> flowchart TD\n> ```\n',
      '- item\n\n  ```mermaid\n  flowchart TD\n  ```\n',
      '```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\n```mermaid\nstateDiagram-v2\n  [*] --> Done\n```',
    ]) {
      expect(diagrams(complete)).toBe(complete.match(/(```|~~~)mermaid/g)!.length)
    }
  })

  test('a fence that is still streaming stays a plain code block', () => {
    for (const streaming of [
      'Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B',
      '```mermaid',
      // A partial closing fence, a shorter fence and the other fence character do not close it.
      '```mermaid\nflowchart TD\n``',
      '````mermaid\nflowchart TD\n```',
      '```mermaid\nflowchart TD\n~~~',
    ]) {
      const output = html(streaming)
      expect(diagrams(streaming)).toBe(0)
      expect(output).not.toContain('data-fence-unclosed')
      expect(output).toContain('class="language-mermaid"')
    }
  })

  test('other languages keep the unchanged syntax-highlighted block', () => {
    const python = '```python\nprint("hi")\n```'
    expect(diagrams(python)).toBe(0)
    expect(html(python)).toContain('class="language-python"')
    expect(diagrams('```ts\nconst a = 1')).toBe(0)
    expect(diagrams('Inline `mermaid` code')).toBe(0)
  })
})
