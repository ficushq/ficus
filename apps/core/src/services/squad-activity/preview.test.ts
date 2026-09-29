import { describe, expect, test } from 'bun:test'
import { activityPreview } from './preview'

describe('source activity previews', () => {
  test('parses before clipping and keeps hidden targets out of the budget', () => {
    const href = `https://example.com/${'x'.repeat(1000)}`
    expect(activityPreview(`[**hello**](${href}) world`, 4)).toEqual({
      summary: 'hel…',
      preview: [{ text: 'hel', bold: true, href }, { text: '…' }],
    })
  })
  test('preserves labels and explicit Ficus references but not bare numbers', () => {
    expect(activityPreview('[#241](ficus:ws:241) [Ada](ficus:agent:deadbeef) #242').preview).toEqual([
      { text: '#241', href: 'ficus:ws:241' },
      { text: ' ' },
      { text: 'Ada', href: 'ficus:agent:deadbeef' },
      { text: ' #242' },
    ])
  })
  test('formats inline content and keeps code literal', () => {
    expect(activityPreview('**bold** *italic* `[x](ficus:ws:1)` https://example.com').preview).toEqual([
      { text: 'bold', bold: true },
      { text: ' ' },
      { text: 'italic', italic: true },
      { text: ' ' },
      { text: '[x](ficus:ws:1)', code: true },
      { text: ' ' },
      { text: 'https://example.com', href: 'https://example.com' },
    ])
  })
  test('flattens blocks, images and HTML without embedding them', () => {
    expect(activityPreview('# Heading\n\n- item\n- ![alt](https://image.test)\n\n<b>safe</b>').summary).toBe(
      'Heading item alt safe'
    )
  })
  test('unsafe and unknown schemes have labels but no destinations', () => {
    expect(activityPreview('[bad](javascript:alert) [file](file:///secret) [mail](mailto:a@b.com)').preview).toEqual([
      { text: 'bad file mail' },
    ])
  })
  test('malformed Markdown stays readable and Unicode clipping does not split surrogate pairs', () => {
    expect(activityPreview('[broken](https://example.com').summary).toBe('[broken](https://example.com')
    expect(activityPreview('😀😀😀', 3).summary).toBe('😀😀😀')
    expect(activityPreview('😀😀😀😀', 3).summary).toBe('😀😀…')
  })
  test('structural prefix is literal', () => {
    expect(activityPreview('**title**', 512, '[#241 created]').preview).toEqual([
      { text: '[#241 created] ' },
      { text: 'title', bold: true },
    ])
  })
})

test('chat extraction materializes previews from original source', async () => {
  const { extractChatExecution } = await import('./extractors')
  const [row] = extractChatExecution({
    squadId: 's',
    executionId: 'e',
    agentId: 'a',
    agentTypeId: 'engineer',
    messages: [{ id: 'm', role: 'assistant', content: '[#241](ficus:ws:241)', createdAt: new Date() }],
  })
  expect(row!.preview).toEqual([{ text: '#241', href: 'ficus:ws:241' }])
  expect(row!.summary).toBe('#241')
})

test('decodes authored entities and escapes without exposing markup', () => {
  expect(activityPreview('[A &amp; B](https://example.com?a=1&amp;b=2) \\*plain\\*').preview).toEqual([
    { text: 'A & B', href: 'https://example.com?a=1&b=2' },
    { text: ' *plain*' },
  ])
})

test('clips before, at and after link labels and bounds oversized inputs', () => {
  const source = 'x [label](https://example.com/long-target) z'
  expect(activityPreview(source, 2)).toEqual({ summary: 'x…', preview: [{ text: 'x' }, { text: '…' }] })
  expect(activityPreview(source, 7).preview).toEqual([
    { text: 'x ' },
    { text: 'labe', href: 'https://example.com/long-target' },
    { text: '…' },
  ])
  expect(activityPreview(source, 9).preview).toEqual([
    { text: 'x ' },
    { text: 'label', href: 'https://example.com/long-target' },
    { text: ' z' },
  ])
  const oversize = activityPreview(`https://example.com/${'x'.repeat(100_000)}`)
  expect(oversize.preview.every((span) => !span.href)).toBe(true)
  expect([...oversize.summary].length).toBeLessThanOrEqual(160)
  expect(activityPreview('x'.repeat(600), 1000).summary.endsWith('…')).toBe(true)
})

test('validates Ficus references using the shared client grammar', () => {
  for (const href of ['ficus:ws:241', 'ficus:ws:deadbeef', 'ficus:agent:deadbeef-1234-1234-1234-123456789abc'])
    expect(activityPreview(`[label](${href})`).preview).toEqual([{ text: 'label', href }])
  // tau: is the pre-rename scheme; migration 0196 rewrote stored links, so nothing reads it (Task 36c).
  for (const href of ['ficus:ws:abc-def', 'ficus:agent:xyz', 'ficus:other:241', 'tau:ws:241']) // ficus-negative-test
    expect(activityPreview(`[label](${href})`).preview).toEqual([{ text: 'label' }])
})

test('bounds repeated hidden destinations without cutting or fabricating them', () => {
  const href = `https://example.com/${'x'.repeat(8000)}`
  const { preview, summary } = activityPreview(`[${'**b** *i* '.repeat(40)}](${href})`, 512)
  expect(summary).toContain('b i')
  expect(preview.reduce((size, span) => size + (span.href?.length ?? 0), 0)).toBeLessThanOrEqual(32_768)
  expect(preview.filter((span) => span.href).every((span) => span.href === href)).toBe(true)
})

test('inbox Markdown is parsed before adding its literal system prefix', async () => {
  const { extractInboxMessage } = await import('./extractors')
  const [row] = extractInboxMessage({
    id: 'i',
    createdAt: new Date(),
    recipientType: 'agent',
    recipientId: 'a',
    recipientSquadId: 's',
    recipientAgentTypeId: 'engineer',
    senderType: 'agent',
    senderId: 'b',
    content: '# [#241](ficus:ws:241)\n\n- **ready**',
    metadata: null,
    workStream: null,
  })
  expect(row!.summary).toBe('Sent message to Engineer: #241 ready')
  expect(row!.preview).toContainEqual({ text: '#241', href: 'ficus:ws:241' })
})

test('an input safety cutoff never turns a partial multiline destination into a URL', () => {
  const result = activityPreview(`[label](https://example.com/part\n${'x'.repeat(70_000)})`)
  expect(result.preview.every((span) => !span.href)).toBe(true)
})

test('deep blockquote parser rejection remains bounded literal source text', () => {
  const source = '>'.repeat(12_000) + 'hello'
  const result = activityPreview(source, 160, '[#241 created]')
  expect(result.summary).toBe(`[#241 created] ${'>'.repeat(144)}…`)
  expect([...result.summary]).toHaveLength(160)
  expect(result.preview.every((span) => !span.href && !span.bold && !span.italic && !span.code)).toBe(true)
})

test('token traversal depth is bounded even when the lexer accepts nested blocks', () => {
  const source = '> '.repeat(100) + '[label](https://example.com)'
  const result = activityPreview(source, 512, '[#241 created]')
  expect(result.summary).toBe(`[#241 created] ${source}`)
  expect(result.preview.every((span) => !span.href)).toBe(true)
  expect(activityPreview('[label](https://example.com)').preview).toEqual([
    { text: 'label', href: 'https://example.com' },
  ])
})

test('parser rejection does not prevent chat extraction', async () => {
  const { extractChatExecution } = await import('./extractors')
  const [row] = extractChatExecution({
    squadId: 's',
    executionId: 'e',
    agentId: 'a',
    agentTypeId: 'engineer',
    messages: [{ id: 'm', role: 'assistant', content: '>'.repeat(12_000) + 'hello', createdAt: new Date() }],
  })
  expect(row!.summary).toBe(`${'>'.repeat(159)}…`)
  expect(row!.preview.every((span) => !span.href)).toBe(true)
})

test('token traversal budget discards partial rich output rather than emitting partial links', () => {
  const source = '[first](https://example.com) ' + '*a* '.repeat(4500)
  const result = activityPreview(source, 160)
  expect(result.summary.startsWith('[first](https://example.com) *a*')).toBe(true)
  expect([...result.summary]).toHaveLength(160)
  expect(result.preview.every((span) => !span.href && !span.italic)).toBe(true)
})
