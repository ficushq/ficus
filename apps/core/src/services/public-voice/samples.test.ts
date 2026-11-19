import { describe, expect, test } from 'bun:test'
import type { CollectedActivity, RawActivityItem } from './github-activity'
import { DerivationError } from './github-activity'
import { cleanSampleText, isToolAuthored, MAX_SAMPLES, MIN_SAMPLES, prepareSamples, summarizeSamples } from './samples'

const prose = (n: number) => `I looked into this and the cause is the retry loop number ${n}; the fix is to cap it.`

function item(over: Partial<RawActivityItem> & Pick<RawActivityItem, 'surface'>): RawActivityItem {
  return { text: prose(1), repository: 'acme/api', isPrivate: false, createdAt: '2026-01-10T10:00:00Z', ...over }
}

function many(
  surface: RawActivityItem['surface'],
  count: number,
  over: Partial<RawActivityItem> = {}
): RawActivityItem[] {
  return Array.from({ length: count }, (_, i) =>
    item({ surface, text: prose(i), createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, ...over })
  )
}

function collected(items: RawActivityItem[], over: Partial<CollectedActivity> = {}): CollectedActivity {
  return {
    items,
    pagingCapped: false,
    requests: 2,
    droppedByFilter: { date: 0, repository: 0 },
    unavailableRepositories: [],
    commitRepositoriesNotSampled: [],
    ...over,
  }
}

describe('cleanSampleText', () => {
  test('strips fenced code, quoted lines, HTML comments, checklists and trailers', () => {
    const text = [
      '> you said this',
      'My answer.',
      '```ts',
      'const secret = 1',
      '```',
      '<!-- template hint -->',
      '- [ ] tests added',
      '- [x] docs',
      'Co-authored-by: Someone <someone@example.com>',
    ].join('\n')
    expect(cleanSampleText(text)).toBe('My answer.')
  })

  test('redacts emails and URLs and collapses whitespace', () => {
    expect(cleanSampleText('Mail me at a.b@example.com   or see https://example.com/x?y=1 \n\n\n\nThanks')).toBe(
      'Mail me at <email> or see <url>\n\nThanks'
    )
  })
})

describe('secrets and titles', () => {
  test('redacts credential-shaped strings', () => {
    const text = [
      'token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'pat github_pat_11ABCDEFG0123456789_abcdefghijk',
      'key AKIAABCDEFGHIJKLMNOP',
      'auth Bearer eyJhbGciOiJIUzI1NiJ9.payload',
      'hash 0123456789abcdef0123456789abcdef',
      'blob dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlzIGxvbmc9PQ',
    ].join('\n')
    const cleaned = cleanSampleText(text)
    expect(cleaned).not.toMatch(/ghp_|github_pat_|AKIA|eyJ|0123456789abcdef|dGhpcyBp/)
    expect(cleaned.match(/<secret>/g)).toHaveLength(6)
    expect(cleanSampleText('An ordinary sentence about a refactor.')).toBe('An ordinary sentence about a refactor.')
    // Valid base64 does not necessarily contain a digit.
    expect(cleanSampleText('YWJj'.repeat(12))).toBe('<secret>')
  })

  test('cleans titles and commit headlines like bodies', () => {
    const items = [
      ...many('issue-comments', 15),
      item({ surface: 'pull-requests', title: 'Fix login for a@b.io, see https://x.dev/1', text: prose(1) }),
    ]
    const { samples } = prepareSamples(collected(items), {})
    const pr = samples.find((s) => s.surface === 'pull-requests')!
    expect(pr.text.startsWith('Fix login for <email>, see <url>')).toBe(true)
  })
})

describe('isToolAuthored', () => {
  test('flags assistant co-author trailers and generation markers', () => {
    expect(isToolAuthored({ text: 'Fix.\n\nCo-authored-by: Claude <noreply@anthropic.com>' })).toBe(true)
    expect(isToolAuthored({ text: 'Summary\n\n🤖 Generated with a tool' })).toBe(true)
    expect(isToolAuthored({ text: 'This pull request was created by an assistant.' })).toBe(true)
    expect(isToolAuthored({ text: 'Fix.\n\nCo-authored-by: Jane Doe <jane@example.com>' })).toBe(false)
    expect(isToolAuthored({ text: 'Plain human text.' })).toBe(false)
  })
})

describe('prepareSamples', () => {
  test('drops tool-authored and bot items with counts, and keeps metadata', () => {
    const items = [
      ...many('issue-comments', 16),
      item({
        surface: 'commits',
        title: 'fix: retry',
        text: 'Body.\n\nCo-authored-by: Claude <noreply@anthropic.com>',
      }),
      item({ surface: 'issue-comments', text: 'Bumps lodash from 4.17.20 to 4.17.21.' }),
      item({ surface: 'pull-requests', title: 'Add retry', text: '## Summary\n\n## Test plan\n', isPrivate: true }),
    ]
    const { samples, summary } = prepareSamples(collected(items, { droppedByFilter: { date: 3, repository: 1 } }), {})
    expect(summary.counts.droppedAsToolAuthored).toBe(1)
    expect(summary.counts.droppedAsTemplate).toBe(2)
    expect(summary.counts.droppedByFilter).toEqual({ date: 3, repository: 1 })
    expect(summary.counts.collected).toBe(items.length + 4)
    expect(summary.counts.kept).toBe(16)
    expect(samples[0]).toMatchObject({ surface: 'issue-comments', repository: 'acme/api', isPrivate: false })
    expect(samples[0]!.createdAt).toMatch(/^2026-01/)
    expect(summary.toolAuthoredIsHeuristic).toBe(true)
  })

  test('keeps tool-authored items when the filter is off', () => {
    const items = [
      ...many('issue-comments', 15),
      item({ surface: 'issue-comments', text: `${prose(99)}\n\n🤖 Generated with X` }),
    ]
    expect(prepareSamples(collected(items), { excludeToolAuthored: false }).summary.counts.kept).toBe(16)
  })

  test('interleaves surfaces newest first and respects per-surface and total caps', () => {
    const items = [
      ...many('pull-requests', 50, { title: 'A title' }),
      ...many('issue-comments', 60),
      ...many('reviews', 50),
      ...many('commits', 50, { title: 'fix: thing' }),
    ]
    const { samples, summary } = prepareSamples(collected(items), {})
    expect(samples.length).toBe(MAX_SAMPLES)
    expect(samples.slice(0, 4).map((s) => s.surface)).toEqual(['pull-requests', 'issue-comments', 'reviews', 'commits'])
    expect(samples.filter((s) => s.surface === 'pull-requests').length).toBeLessThanOrEqual(30)
    expect(samples[0]!.text.startsWith('A title\n\n')).toBe(true)
    // Only the 40 newest comments are kept, so the oldest kept is later than the oldest collected.
    expect(summary.dateRange['issue-comments']!.newest).toBe('2026-01-28')
    expect(summary.dateRange['issue-comments']!.oldest > '2026-01-01').toBe(true)
  })

  test('reports public and private repositories separately', () => {
    const items = [
      ...many('issue-comments', 10),
      ...many('reviews', 10, { repository: 'acme/secret', isPrivate: true }),
    ]
    const { summary } = prepareSamples(collected(items), {})
    expect(summary.publicRepositories).toEqual(['acme/api'])
    expect(summary.privateRepositories).toEqual(['acme/secret'])
    expect(summary.unavailableRepositories).toEqual([])
  })

  test('too few samples is an error with the counts', () => {
    try {
      prepareSamples(collected(many('issue-comments', MIN_SAMPLES - 1)), {})
      throw new Error('expected an error')
    } catch (error) {
      expect(error).toBeInstanceOf(DerivationError)
      expect((error as DerivationError).code).toBe('derivation_too_few_samples')
      expect((error as DerivationError).details.counts).toMatchObject({ kept: MIN_SAMPLES - 1 })
    }
  })
})

test('partial snapshots reconcile every sample and budget exclusion without requiring minimum', () => {
  const snapshot = summarizeSamples(collected(many('issue-comments', 45)), {})
  expect(snapshot.summary.breakdown!.totals).toMatchObject({ seen: 45, kept: 40, dropped: { surface_limit: 5 } })
  expect(summarizeSamples(collected([]), {}).samples).toEqual([])
  const totals = snapshot.summary.breakdown!.totals
  expect(totals.seen).toBe(totals.kept + Object.values(totals.dropped).reduce((a,b) => a+b, 0))
})
