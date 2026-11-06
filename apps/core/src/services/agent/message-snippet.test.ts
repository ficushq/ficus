import { describe, expect, it } from 'bun:test'
import { buildMessageSnippet } from './message-snippet'

const marked = (snippet: ReturnType<typeof buildMessageSnippet>) =>
  snippet.highlights.map(([start, end]) => snippet.text.slice(start, end))

describe('buildMessageSnippet', () => {
  it('returns a short message whole with every case-insensitive match marked', () => {
    const snippet = buildMessageSnippet('Deploy the API, then deploy the web.', 'DEPLOY')
    expect(snippet.text).toBe('Deploy the API, then deploy the web.')
    expect(snippet.truncatedStart).toBe(false)
    expect(snippet.truncatedEnd).toBe(false)
    expect(marked(snippet)).toEqual(['Deploy', 'deploy'])
  })

  it('cuts a long message around the first match on word boundaries', () => {
    const before = 'alpha '.repeat(40)
    const after = ' omega'.repeat(40)
    const snippet = buildMessageSnippet(`${before}needle${after}`, 'needle', 20)
    expect(snippet.truncatedStart).toBe(true)
    expect(snippet.truncatedEnd).toBe(true)
    expect(snippet.text.startsWith('alpha')).toBe(true)
    expect(snippet.text.endsWith('omega')).toBe(true)
    expect(snippet.text.length).toBeLessThanOrEqual(20 + 'needle'.length + 20)
    expect(marked(snippet)).toEqual(['needle'])
  })

  it('flattens line breaks without shifting highlight offsets', () => {
    const snippet = buildMessageSnippet('first line\nsecond\tMatch here\r\nmatch', 'match')
    expect(snippet.text).toBe('first line second Match here  match')
    expect(marked(snippet)).toEqual(['Match', 'match'])
  })

  it('treats regular-expression characters in the query literally', () => {
    const snippet = buildMessageSnippet('cost is $5.00 (approx.) or 5x00', '5.00 (')
    expect(marked(snippet)).toEqual(['5.00 ('])
  })

  it('never splits a surrogate pair at a cut', () => {
    const snippet = buildMessageSnippet(`${'🌿'.repeat(30)}needle${'🌿'.repeat(30)}`, 'needle', 5)
    expect(snippet.text).not.toMatch(/^[\udc00-\udfff]/)
    expect(snippet.text).not.toMatch(/[\ud800-\udbff]$/)
    expect(marked(snippet)).toEqual(['needle'])
  })

  it('falls back to the start of the message with no marks when JavaScript finds no match', () => {
    const snippet = buildMessageSnippet('x'.repeat(300), 'missing', 10)
    expect(snippet.text).toBe('x'.repeat(10))
    expect(snippet.highlights).toEqual([])
    expect(snippet.truncatedEnd).toBe(true)
  })
})
