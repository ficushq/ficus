import { describe, expect, test } from 'bun:test'
import { parseInboxPushPresentation } from './inbox-push'

describe('parseInboxPushPresentation', () => {
  test('accepts a complete presentation and trims text', () => {
    expect(
      parseInboxPushPresentation({
        title: ' Completed: #197 · Validate deletion ',
        body: 'Next steps: ship it',
        subtitle: 'Platform',
        collapseKey: 'ws:abc',
        threadKey: 'squad:def',
        interruptionLevel: 'passive',
      })
    ).toEqual({
      title: 'Completed: #197 · Validate deletion',
      body: 'Next steps: ship it',
      subtitle: 'Platform',
      collapseKey: 'ws:abc',
      threadKey: 'squad:def',
      interruptionLevel: 'passive',
    })
  })

  test('retains optional original Markdown for rendering before preview limits', () => {
    const source = { title: '[Title](ficus:ws:454)', body: `[PR](https://example.com/${'x'.repeat(600)})` }
    expect(parseInboxPushPresentation({ title: 'Clipped', body: 'Clipped', source })?.source).toEqual(source)
    expect(parseInboxPushPresentation({ title: 'T', body: 'B', source: { url: '/other' } })).toBeUndefined()
  })

  test('requires a non-empty title and body and rejects unknown or oversized fields', () => {
    expect(parseInboxPushPresentation({ title: '', body: 'x' })).toBeUndefined()
    expect(parseInboxPushPresentation({ title: 'T', body: '  ' })).toBeUndefined()
    expect(parseInboxPushPresentation({ title: 'T', body: 'B', extra: 1 })).toBeUndefined()
    expect(parseInboxPushPresentation({ title: 'T'.repeat(121), body: 'B' })).toBeUndefined()
    expect(parseInboxPushPresentation({ title: 'T', body: 'B', interruptionLevel: 'loud' })).toBeUndefined()
    expect(parseInboxPushPresentation(null)).toBeUndefined()
    expect(parseInboxPushPresentation('title')).toBeUndefined()
  })
})
