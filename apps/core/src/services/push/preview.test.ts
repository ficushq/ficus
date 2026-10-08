import { describe, expect, test } from 'bun:test'
import { pushPlainText, pushPreview } from './preview'

describe('push plain text', () => {
  test.each([
    ['', ''],
    ['  Hello, 世界 👋!\n\nKeep  spaces.\n', '  Hello, 世界 👋!\n\nKeep  spaces.\n'],
    ['**bold** *italic* __strong__ _em_ ~~deleted~~', 'bold italic strong em deleted'],
    ['1. First\n2. Second\n   - Nested\n\n> Quote\n> continued', 'First\nSecond\nNested\n\nQuote\ncontinued'],
    ['- [x] Done\n- [ ] Pending', 'Done\nPending'],
    ['Heading\n=======\n\n---\n\nTail', 'Heading\n\n\n\nTail'],
    ['a  \nb\\\nc', 'a\nb\nc'],
    ['\\*literal\\* &amp; &#x1F44B; `&amp;`', '*literal* & 👋 &amp;'],
    [
      '[**PR** `#1591`](https://example.com/a_(b)) and <https://example.com/path>',
      'PR #1591 and https://example.com/path',
    ],
    ['![**Build** _passed_](https://example.com/status.png)', 'Build passed'],
    ['    const x = "*literal*";\n    x++;', 'const x = "*literal*";\nx++;'],
    ['| Name | Status |\n| --- | --- |\n| **Build** | passed |', 'Name\tStatus\nBuild\tpassed'],
    ['[unresolved][missing] and unmatched **', '[unresolved][missing] and unmatched **'],
  ])('preserves visible content: %s', (source, expected) => {
    expect(pushPlainText(source)).toBe(expected)
  })

  test('clips visible Unicode text, not link destinations or surrogate halves', () => {
    const destination = `https://example.com/${'x'.repeat(600)}`
    const event = Object.freeze({
      title: `[${'a'.repeat(199)}👋extra](${destination})`,
      body: 'old clipped body',
      pushSource: { body: `[PR #1591](${destination}) merged.` },
      subtitle: `**${'a'.repeat(79)}👋extra**`,
    })
    expect(pushPreview(event)).toEqual({ title: 'a'.repeat(199), body: 'PR #1591 merged.', subtitle: 'a'.repeat(79) })
    expect(pushPreview({ title: '👋'.repeat(200), body: '👋'.repeat(500) })).toEqual({
      title: '👋'.repeat(100),
      body: '👋'.repeat(250),
    })
    expect(event.body).toBe('old clipped body')
  })
})
