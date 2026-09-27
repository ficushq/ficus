import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LEGACY_ENTITY_REFERENCE_SCHEME } from '@ficus/shared'
import { MarkdownContent } from './MarkdownContent'

const url = 'https://github.com/example/project/pull/42'

describe('compact Action Center PR links', () => {
  test('shortens a bare PR URL without changing its destination', () => {
    const html = renderToStaticMarkup(<MarkdownContent compactPullRequestLinks>{`Review ${url}`}</MarkdownContent>)
    expect(html).toContain(`href="${url}"`)
    expect(html).toContain(`title="${url}"`)
    expect(html).toContain('>PR #42</a>')
  })

  test('preserves authored labels, other URLs, and ordinary markdown elsewhere', () => {
    const named = renderToStaticMarkup(
      <MarkdownContent compactPullRequestLinks>{`[Review the changes](${url})`}</MarkdownContent>
    )
    expect(named).toContain('>Review the changes</a>')
    const other = 'https://example.com/pull/42'
    expect(renderToStaticMarkup(<MarkdownContent compactPullRequestLinks>{other}</MarkdownContent>)).toContain(
      `>${other}</a>`
    )
    expect(renderToStaticMarkup(<MarkdownContent>{url}</MarkdownContent>)).toContain(`>${url}</a>`)
  })
})

const entityId = 'fa27abb6-4c92-4cc6-aff9-a8da616346c1'
test('renders explicit work stream and agent references as in-place actions', () => {
  for (const kind of ['ws', 'agent']) {
    expect(
      renderToStaticMarkup(<MarkdownContent>{`[Short](ficus:${kind}:${entityId.slice(0, 8)})`}</MarkdownContent>)
    ).toContain('<button')
    const html = renderToStaticMarkup(<MarkdownContent>{`[Open item](ficus:${kind}:${entityId})`}</MarkdownContent>)
    expect(html).toContain('<button')
    expect(html).toContain('Open item</button>')
    expect(html).not.toContain('href="ficus:')
  }
})

test('stored references written before the rename still render as in-place actions', () => {
  for (const kind of ['ws', 'agent']) {
    const html = renderToStaticMarkup(
      <MarkdownContent>{`[Open item](${LEGACY_ENTITY_REFERENCE_SCHEME}:${kind}:${entityId})`}</MarkdownContent>
    )
    expect(html).toContain('Open item</button>')
  }
})

test('does not activate malformed references or references in code and retains URL sanitization', () => {
  for (const content of ['[Bad](ficus:ws:not-an-id)', '[Bad](javascript:alert)', `[Bad](ficus:ws:${entityId}/extra)`]) {
    const html = renderToStaticMarkup(<MarkdownContent>{content}</MarkdownContent>)
    expect(html).not.toContain('<button')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="ficus:')
  }
  expect(
    renderToStaticMarkup(<MarkdownContent>{`\`[Example](ficus:ws:${entityId})\``}</MarkdownContent>)
  ).not.toContain('<button')
})

test('user-bubble markdown inherits the on-accent ink instead of fixed inverted prose colours', () => {
  const html = renderToStaticMarkup(
    <MarkdownContent variant="human">{`Hi **there** [docs](https://example.com) \`code\``}</MarkdownContent>
  )
  expect(html).toContain('prose-on-accent')
  expect(html).not.toContain('prose-invert')
  expect(html).not.toContain('syntax-human')
  // Assistant markdown keeps its page prose colours.
  expect(renderToStaticMarkup(<MarkdownContent>{'Hi'}</MarkdownContent>)).toContain('dark:prose-invert')
})
