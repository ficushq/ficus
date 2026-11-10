import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from './MarkdownContent'

function rootClasses(html: string): string[] {
  return /^<div class="([^"]*)"/.exec(html)![1]!.split(' ')
}

test('prose-sm is the default size, and a caller size modifier replaces it instead of competing', () => {
  expect(rootClasses(renderToStaticMarkup(<MarkdownContent>text</MarkdownContent>))).toContain('prose-sm')
  // Both modifiers on one element compile to equal-specificity rules whose order Tailwind decides,
  // which changed between Tailwind 3 and 4; the caller's size must be the only one.
  const document = rootClasses(
    renderToStaticMarkup(
      <MarkdownContent variant="document" className="prose-base text-primary">
        text
      </MarkdownContent>
    )
  )
  expect(document).toContain('prose-base')
  expect(document).not.toContain('prose-sm')
})
