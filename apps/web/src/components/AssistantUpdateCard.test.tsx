import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantUpdateCard } from './AssistantUpdateCard'

const update = (content: string) => ({
  reportedStatus: 'completed' as const,
  senderName: 'Drift',
  createdAt: '2026-09-29T04:57:58.000Z',
  subject: null,
  content,
  seenAt: '2026-09-29T04:58:00.000Z',
})

describe('AssistantUpdateCard', () => {
  test('shows a short report whole, with no toggle', () => {
    const html = renderToStaticMarkup(
      <AssistantUpdateCard update={update('Audit **done**.')} taskLabel="Check access" />
    )
    expect(html).toContain('<strong>done</strong>')
    expect(html).not.toContain('Show more')
  })

  test('collapses a long report to a few lines behind Show more', () => {
    const html = renderToStaticMarkup(
      <AssistantUpdateCard update={update(`${'finding '.repeat(80)}THE_TAIL_SHOULD_BE_HIDDEN`)} />
    )
    expect(html).toContain('Show more')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('THE_TAIL_SHOULD_BE_HIDDEN')
  })
})
