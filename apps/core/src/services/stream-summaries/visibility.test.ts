import { describe, expect, test } from 'bun:test'
import { parseStreamSummary } from './parse'
import { presentWorkStreamSummary } from './visibility'

const metadata = (step: string | null = 'Implement', text = 'Adding the peek card to Feed rows') => ({
  git: { branch: 'work/1' },
  streamSummary: { text, generatedAt: '2026-11-20T12:00:00.000Z', step, through: '2026-11-20T11:59:00.000Z' },
})

describe('presentWorkStreamSummary', () => {
  test('shows the summary for the step it was generated for, without its cursor', () => {
    expect(presentWorkStreamSummary(metadata(), { status: 'active', step: 'Implement' }, true)).toEqual({
      text: 'Adding the peek card to Feed rows',
      generatedAt: '2026-11-20T12:00:00.000Z',
      step: 'Implement',
    })
  })

  test('hides a summary generated for an older step', () => {
    expect(presentWorkStreamSummary(metadata('Plan'), { status: 'active', step: 'Implement' }, true)).toBeUndefined()
    expect(presentWorkStreamSummary(metadata(null), { status: 'active', step: 'Implement' }, true)).toBeUndefined()
  })

  test('hides summaries while the switch is off and for streams that are not active', () => {
    expect(presentWorkStreamSummary(metadata(), { status: 'active', step: 'Implement' }, false)).toBeUndefined()
    expect(presentWorkStreamSummary(metadata(), { status: 'done', step: 'Implement' }, true)).toBeUndefined()
    expect(presentWorkStreamSummary(metadata(), { status: 'queued', step: 'Implement' }, true)).toBeUndefined()
  })

  test('ignores a malformed stored value', () => {
    expect(
      presentWorkStreamSummary(metadata('Implement', 'x'.repeat(200)), { status: 'active', step: 'Implement' }, true)
    ).toBeUndefined()
    expect(
      presentWorkStreamSummary({ streamSummary: 'text' }, { status: 'active', step: 'Implement' }, true)
    ).toBeUndefined()
  })
})

describe('parseStreamSummary', () => {
  test('keeps one plain line, trimming quotes and a label', () => {
    expect(parseStreamSummary('  "Fixing the flaky export test"  ')).toBe('Fixing the flaky export test')
    expect(parseStreamSummary('Summary: Reviewing the cache change')).toBe('Reviewing the cache change')
    expect(parseStreamSummary('Fixing #1354 in apps/web')).toBe('Fixing #1354 in apps/web')
  })

  test('discards anything that is not one plain line within the limit', () => {
    for (const raw of [
      '',
      'none',
      'First line\nSecond line',
      'Opened https://github.com/ficushq/ficus/pull/1',
      'Read [the doc](docs/wiki/x.md)',
      '`code` change',
      '# Heading',
      '- bullet item',
      '<b>bold</b>',
      'Hidden\u202echaracter',
      'x'.repeat(121),
    ])
      expect(parseStreamSummary(raw)).toBeNull()
    expect(parseStreamSummary('x'.repeat(120))).toBe('x'.repeat(120))
  })
})
