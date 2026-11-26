import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test } from 'bun:test'
import type { ActivitySettledSummary } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ReactQueryHooksProvider } from '../reactQueryHooks'
import { AccountFeedVisit } from './FeedVisitSummary'
import { settledActivityHref, settledLineParts, settledPeriodLabel } from '../lib/settledActivity'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const since = '2026-11-25T09:00:00.000Z'
const summary = (counts: Partial<ActivitySettledSummary['counts']>): ActivitySettledSummary => ({
  since,
  clamped: false,
  counts: { questions: 0, reviews: 0, completed: 0, ...counts },
})

describe('settled line text', () => {
  test('leaves out zero counts and is empty when every count is zero', () => {
    expect(settledLineParts(summary({}))).toEqual([])
    expect(settledLineParts(null)).toEqual([])
    expect(settledLineParts(summary({ questions: 4, completed: 1 })).map((part) => part.label)).toEqual([
      '4 questions settled by managers',
      '1 stream completed',
    ])
    expect(settledLineParts(summary({ reviews: 1 }))[0]?.label).toBe('1 review done by agents')
  })

  test('names the period in plain words', () => {
    const now = new Date(2026, 10, 26, 15, 0)
    expect(settledPeriodLabel(new Date(2026, 10, 26, 8, 0).toISOString(), now)).toBe('Since earlier today')
    expect(settledPeriodLabel(new Date(2026, 10, 25, 23, 0).toISOString(), now)).toBe('Since yesterday')
    expect(settledPeriodLabel(new Date(2026, 10, 23, 12, 0).toISOString(), now)).toMatch(/^Since [A-Z][a-z]+day$/)
    expect(settledPeriodLabel(new Date(2026, 9, 27, 12, 0).toISOString(), now)).toMatch(/^Since Oct 27$/)
  })

  test('each count opens Activity filtered to its rows in the same squads', () => {
    expect(settledActivityHref('reviews', since, ['s2', 's1'])).toBe(
      `/activity?settled=reviews&since=${encodeURIComponent(since)}&squad=s1&squad=s2`
    )
  })
})

async function renderVisit(options: {
  lastVisitedAt: string | null
  settled?: ActivitySettledSummary
  squadIds?: string[]
}) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  const recorded: string[] = []
  const settledRequests: unknown[][] = []
  const hooks = {
    useQuery: ((query: { queryKey: unknown[]; enabled?: boolean }) => {
      if (query.queryKey[1] === 'feed-visit')
        return {
          isSuccess: true,
          data: { lastVisitedAt: options.lastVisitedAt, observedAt: '2026-11-26T12:00:00.000Z' },
        }
      if (query.enabled === false) return { isSuccess: false, data: undefined }
      settledRequests.push(query.queryKey)
      return { isSuccess: !!options.settled, data: options.settled }
    }) as never,
    useInfiniteQuery: (() => ({
      isSuccess: true,
      isFetchedAfterMount: true,
      data: { pages: [{ items: [], totalCount: 0 }] },
      hasNextPage: false,
    })) as never,
  }
  await dom.act(async () =>
    root.render(
      <MemoryRouter>
        <ReactQueryHooksProvider hooks={hooks}>
          <AccountFeedVisit
            userId="u1"
            squadIds={options.squadIds ?? []}
            acknowledge={async () => ({ seen: true as const })}
            acknowledgeVisit={async (visitedAt) => {
              recorded.push(visitedAt)
              return { lastVisitedAt: visitedAt }
            }}
            useActivity={(() => ({ ownerId: 'u1', activity: { conversations: [] } })) as never}
          />
        </ReactQueryHooksProvider>
      </MemoryRouter>
    )
  )
  return { document: dom.window.document, recorded, settledRequests }
}

describe('Feed Updates with the settled line', () => {
  test('shows the line on its own and records the visit after the counts load', async () => {
    const { document, recorded, settledRequests } = await renderVisit({
      lastVisitedAt: since,
      settled: summary({ questions: 4, reviews: 2, completed: 2 }),
      squadIds: ['s1'],
    })
    const line = document.querySelector('[data-testid="feed-settled-line"]')
    expect(document.querySelector('[data-testid="feed-visit-summary"]')).not.toBeNull()
    expect(line?.textContent).toMatch(
      /: 4 questions settled by managers, 2 reviews done by agents, 2 streams completed$/
    )
    const links = [...line!.querySelectorAll('a')].map((link) => link.getAttribute('href'))
    expect(links).toEqual([
      settledActivityHref('questions', since, ['s1']),
      settledActivityHref('reviews', since, ['s1']),
      settledActivityHref('completed', since, ['s1']),
    ])
    expect(settledRequests[0]).toEqual(['activity', 'settled', 'u1', since, ['s1']])
    expect(recorded).toEqual(['2026-11-26T12:00:00.000Z'])
  })

  test('is absent when every count is zero', async () => {
    const { document, recorded } = await renderVisit({ lastVisitedAt: since, settled: summary({}) })
    expect(document.querySelector('[data-testid="feed-settled-line"]')).toBeNull()
    expect(document.querySelector('[data-testid="feed-visit-summary"]')).toBeNull()
    expect(recorded).toHaveLength(1)
  })

  test('without a recorded visit there is no period: no counts are asked for, and this visit is recorded', async () => {
    const { document, recorded, settledRequests } = await renderVisit({ lastVisitedAt: null })
    expect(document.querySelector('[data-testid="feed-settled-line"]')).toBeNull()
    expect(settledRequests).toEqual([])
    expect(recorded).toEqual(['2026-11-26T12:00:00.000Z'])
  })

  test('keeps the older start when the counts fail to load', async () => {
    const { recorded } = await renderVisit({ lastVisitedAt: since, settled: undefined })
    expect(recorded).toEqual([])
  })
})
