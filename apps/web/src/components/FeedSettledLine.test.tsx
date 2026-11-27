import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { ACTIVITY_SETTLED_MARGIN_MS, type ActivitySettledSummary } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ReactQueryHooksProvider } from '../reactQueryHooks'
import { AccountFeedVisit } from './FeedVisitSummary'
import { settledActivityHref, settledLineParts, settledPeriodLabel } from '../lib/settledActivity'
import {
  FEED_VISIT_HIDDEN_KEY,
  FEED_VISIT_IDLE_MS,
  FEED_VISIT_MAX_MS,
  readSessionFeedVisit,
} from '../hooks/useSettledSinceLastVisit'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const since = '2026-11-25T09:00:00.000Z'
const summary = (counts: Partial<ActivitySettledSummary['counts']>): ActivitySettledSummary => ({
  since,
  clamped: false,
  through: '2026-11-26T12:00:00.000Z',
  counts: { questions: 0, reviews: 0, ...counts },
})

describe('settled line text', () => {
  test('leaves out zero counts and is empty when every count is zero', () => {
    expect(settledLineParts(summary({}))).toEqual([])
    expect(settledLineParts(null)).toEqual([])
    expect(settledLineParts(summary({ questions: 4, reviews: 2 })).map((part) => part.label)).toEqual([
      '4 questions settled by agents',
      '2 reviews done by agents',
    ])
    expect(settledLineParts(summary({ questions: 1 }))[0]?.label).toBe('1 question settled by agents')
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

const HOUR = 3_600_000
const T0 = Date.parse(since)
const iso = (ms: number) => new Date(ms).toISOString()
/** Where counts taken at `ms` end, and so where the visit that showed them records its end. */
const endAt = (ms: number) => iso(ms - ACTIVITY_SETTLED_MARGIN_MS)

/**
 * The Feed with a fake account behind it: its Feed watermark, and the questions settled without a
 * person by time. Like the real cache, the visit read is taken once per key and the counts once per
 * key until `refetchCounts`; the counts run from `since` up to the time they were taken (`through`).
 */
async function renderVisit(options: {
  lastVisitedAt: string | null
  settledAt?: number[]
  reviews?: number
  failCounts?: boolean
  squadIds?: string[]
  now?: number
}) {
  setSystemTime(new Date(options.now ?? T0 + 3 * HOUR))
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  dom.window.sessionStorage.clear()
  const { root } = dom.createRoot()
  const account = { watermark: options.lastVisitedAt, settledAt: [...(options.settledAt ?? [])] }
  const recorded: string[] = []
  const settledRequests: unknown[][] = []
  const visitReads: unknown[][] = []
  const cache = new Map<string, unknown>()
  let holdVisitReads = false
  const hooks = {
    useQuery: ((query: { queryKey: unknown[]; enabled?: boolean }) => {
      if (query.enabled === false) return { isSuccess: false, data: undefined }
      const key = JSON.stringify(query.queryKey)
      if (!cache.has(key)) {
        if (query.queryKey[1] === 'feed-visit') {
          if (holdVisitReads) return { isSuccess: false, data: undefined }
          visitReads.push(query.queryKey)
          cache.set(key, { lastVisitedAt: account.watermark, observedAt: iso(Date.now()) })
        } else {
          settledRequests.push(query.queryKey)
          const from = Date.parse(query.queryKey[3] as string)
          const through = Date.now() - ACTIVITY_SETTLED_MARGIN_MS
          const questions = account.settledAt.filter((at) => at >= from && at < through).length
          cache.set(
            key,
            options.failCounts
              ? undefined
              : {
                  since: query.queryKey[3],
                  clamped: false,
                  through: iso(through),
                  counts: { questions, reviews: options.reviews ?? 0 },
                }
          )
        }
      }
      const data = cache.get(key)
      return { isSuccess: data !== undefined, data }
    }) as never,
    useInfiniteQuery: (() => ({
      isSuccess: true,
      isFetchedAfterMount: true,
      data: { pages: [{ items: [], totalCount: 0 }] },
      hasNextPage: false,
    })) as never,
  }
  let mount = 0
  const render = async ({ remount = true } = {}) => {
    if (remount) mount++
    await dom!.act(async () =>
      root.render(
        <MemoryRouter>
          <ReactQueryHooksProvider hooks={hooks}>
            <AccountFeedVisit
              key={mount}
              userId="u1"
              squadIds={options.squadIds ?? []}
              acknowledge={async () => ({ seen: true as const })}
              acknowledgeVisit={async (visitedAt) => {
                recorded.push(visitedAt)
                if (!account.watermark || Date.parse(visitedAt) > Date.parse(account.watermark))
                  account.watermark = visitedAt
                return { lastVisitedAt: account.watermark }
              }}
              useActivity={(() => ({ ownerId: 'u1', activity: { conversations: [] } })) as never}
            />
          </ReactQueryHooksProvider>
        </MemoryRouter>
      )
    )
  }
  await render()
  const document = dom!.window.document
  return {
    document,
    recorded,
    settledRequests,
    visitReads,
    render,
    line: () => document.querySelector('[data-testid="feed-settled-line"]')?.textContent ?? null,
    settle: (at: number) => account.settledAt.push(at),
    advance: (ms: number) => setSystemTime(new Date(Date.now() + ms)),
    /** The counts load again, as on window focus once they are a minute old. */
    refetchCounts: async () => {
      for (const key of cache.keys()) if (key.includes('"settled"')) cache.delete(key)
      await render({ remount: false })
    },
    visibility: async (value: 'hidden' | 'visible') =>
      dom!.act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value })
        document.dispatchEvent(new dom!.window.Event('visibilitychange'))
      }),
    /** The account read for a new visit stays in flight until released. */
    holdVisitReads: (value: boolean) => {
      holdVisitReads = value
    },
    focus: async () => dom!.act(async () => void dom!.window.dispatchEvent(new dom!.window.Event('focus'))),
  }
}

describe('Feed Updates with the settled line', () => {
  afterEach(() => setSystemTime())

  test('shows the line on its own and records the end of its counts', async () => {
    const { document, recorded, settledRequests, line } = await renderVisit({
      lastVisitedAt: since,
      settledAt: [1, 2, 3, 4].map((n) => T0 + n * 60_000),
      reviews: 2,
      squadIds: ['s1'],
    })
    expect(document.querySelector('[data-testid="feed-visit-summary"]')).not.toBeNull()
    expect(line()).toMatch(/: 4 questions settled by agents, 2 reviews done by agents$/)
    const links = [...document.querySelector('[data-testid="feed-settled-line"]')!.querySelectorAll('a')].map((link) =>
      link.getAttribute('href')
    )
    expect(links).toEqual([
      settledActivityHref('questions', since, ['s1']),
      settledActivityHref('reviews', since, ['s1']),
    ])
    expect(settledRequests[0]).toEqual(['activity', 'settled', 'u1', since, ['s1']])
    expect(recorded).toEqual([endAt(T0 + 3 * HOUR)])
  })

  test('is absent when every count is zero', async () => {
    const { document, recorded, line } = await renderVisit({ lastVisitedAt: since })
    expect(line()).toBeNull()
    expect(document.querySelector('[data-testid="feed-visit-summary"]')).toBeNull()
    expect(recorded).toHaveLength(1)
  })

  test('without a recorded visit there is no period: no counts are asked for, and this visit is recorded', async () => {
    const { line, recorded, settledRequests } = await renderVisit({ lastVisitedAt: null })
    expect(line()).toBeNull()
    expect(settledRequests).toEqual([])
    // The visit's start, less the margin counts keep, so a row still being written is not skipped.
    expect(recorded).toEqual([endAt(T0 + 3 * HOUR)])
  })

  test('coming back from Activity keeps the period: the visit lasts for the tab session', async () => {
    const { line, recorded, visitReads, render } = await renderVisit({
      lastVisitedAt: since,
      settledAt: [T0 + HOUR],
    })
    await render()
    expect(line()).toContain('1 question settled')
    // One account read for the whole tab visit, not one per Feed mount, and one record of the same end.
    expect(visitReads).toHaveLength(1)
    expect(recorded).toEqual([endAt(T0 + 3 * HOUR)])
    expect(readSessionFeedVisit('u1')).toEqual({
      lastVisitedAt: since,
      observedAt: iso(T0 + 3 * HOUR),
      startedAt: T0 + 3 * HOUR,
      recordedThrough: endAt(T0 + 3 * HOUR),
    })
  })

  test('a tab away for longer than the idle timeout starts a new visit', async () => {
    await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR] })
    const now = Date.now()
    dom!.window.sessionStorage.setItem(FEED_VISIT_HIDDEN_KEY, String(now - FEED_VISIT_IDLE_MS + 60_000))
    expect(readSessionFeedVisit('u1', now)).not.toBeNull()
    dom!.window.sessionStorage.setItem(FEED_VISIT_HIDDEN_KEY, String(now - FEED_VISIT_IDLE_MS - 60_000))
    expect(readSessionFeedVisit('u1', now)).toBeNull()
    expect(readSessionFeedVisit('u1', now)).toBeNull()
  })

  test('a visit lasts at most FEED_VISIT_MAX_MS, even in a tab that never leaves the screen', async () => {
    const { visitReads, render } = await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR] })
    const startedAt = Date.now()
    expect(FEED_VISIT_MAX_MS).toBe(8 * HOUR)
    expect(readSessionFeedVisit('u1', startedAt + FEED_VISIT_MAX_MS - 60_000)).not.toBeNull()
    await render()
    expect(visitReads).toHaveLength(1)
    setSystemTime(new Date(startedAt + FEED_VISIT_MAX_MS + 60_000))
    // Opening the Feed again after that is a new visit.
    await render()
    expect(visitReads).toHaveLength(2)
    // A clock moved far back does not keep a visit alive either.
    const restarted = readSessionFeedVisit('u1')!.startedAt
    expect(readSessionFeedVisit('u1', restarted - FEED_VISIT_MAX_MS - 60_000)).toBeNull()
  })

  test('work settled during a visit is counted once: in that visit’s latest counts or in the next visit', async () => {
    const view = await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR], now: T0 + 2 * HOUR })
    expect(view.line()).toMatch(/: 1 question settled by agents$/)
    expect(view.recorded).toEqual([endAt(T0 + 2 * HOUR)])

    // Settled while the Feed is open: the counts load again later in the same visit and include it.
    view.settle(T0 + 2.5 * HOUR)
    view.advance(HOUR)
    await view.refetchCounts()
    expect(view.line()).toMatch(/: 2 questions settled by agents$/)
    expect(view.recorded).toEqual([endAt(T0 + 2 * HOUR), endAt(T0 + 3 * HOUR)])

    // Settled seconds before those counts (its row may still have been being written), and after
    // them; then the visit ends (the tab is away past the idle timeout).
    view.settle(T0 + 3 * HOUR - 5_000)
    view.settle(T0 + 3.25 * HOUR)
    await view.visibility('hidden')
    view.advance(FEED_VISIT_IDLE_MS + 60_000)
    await view.visibility('visible')
    // The next visit starts where the last counts ended: only the work not shown yet, nothing twice.
    expect(view.settledRequests.at(-1)?.[3]).toBe(endAt(T0 + 3 * HOUR))
    expect(view.line()).toMatch(/: 2 questions settled by agents$/)
  })

  test('a Feed that stays mounted starts the new visit when the person comes back', async () => {
    const view = await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR] })
    view.settle(T0 + 3.5 * HOUR)

    // Away for less than the idle timeout: the same visit, so the same period.
    await view.visibility('hidden')
    view.advance(FEED_VISIT_IDLE_MS - 60_000)
    await view.visibility('visible')
    expect(view.visitReads).toHaveLength(1)
    expect(view.line()).toMatch(/: 1 question settled by agents$/)

    // Away for longer: a new visit is read and its line shown without remounting the Feed.
    await view.visibility('hidden')
    view.advance(FEED_VISIT_IDLE_MS + 60_000)
    await view.visibility('visible')
    expect(view.visitReads).toHaveLength(2)
    expect(view.settledRequests.at(-1)?.[3]).toBe(endAt(T0 + 3 * HOUR))
    expect(view.line()).toMatch(/: 1 question settled by agents$/)
    expect(readSessionFeedVisit('u1')?.lastVisitedAt).toBe(endAt(T0 + 3 * HOUR))
  })

  test('a window that never leaves the screen starts a new visit at its maximum age, when it regains focus', async () => {
    const view = await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR] })
    view.advance(FEED_VISIT_MAX_MS - 60_000)
    await view.focus()
    expect(view.visitReads).toHaveLength(1)
    view.settle(Date.now())
    view.advance(3 * 60_000)
    await view.focus()
    expect(view.visitReads).toHaveLength(2)
    expect(view.settledRequests.at(-1)?.[3]).toBe(endAt(T0 + 3 * HOUR))
    expect(view.line()).toMatch(/: 1 question settled by agents$/)
  })

  test('the previous line stays on screen until the new visit has its counts', async () => {
    const view = await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR] })
    view.settle(T0 + 3.25 * HOUR)
    view.holdVisitReads(true)
    await view.visibility('hidden')
    view.advance(FEED_VISIT_IDLE_MS + 60_000)
    await view.visibility('visible')
    // The new visit is still reading the account: the old line holds its place.
    expect(view.line()).toMatch(/: 1 question settled by agents$/)
    expect(view.document.querySelector('[data-testid="feed-visit-summary"]')).not.toBeNull()
    view.holdVisitReads(false)
    await view.render({ remount: false })
    expect(view.settledRequests.at(-1)?.[3]).toBe(endAt(T0 + 3 * HOUR))
    expect(view.line()).toMatch(/: 1 question settled by agents$/)
  })

  test('the period label follows the day on screen', async () => {
    const view = await renderVisit({
      lastVisitedAt: new Date(2026, 10, 26, 8, 0).toISOString(),
      settledAt: [new Date(2026, 10, 26, 9, 0).getTime()],
      now: new Date(2026, 10, 26, 20, 0).getTime(),
    })
    expect(view.line()).toMatch(/^Since earlier today: /)
    // Past midnight, 4.5 hours into the visit: the same visit, now named from the next day.
    setSystemTime(new Date(2026, 10, 27, 0, 30))
    await view.focus()
    expect(view.visitReads).toHaveLength(1)
    expect(view.line()).toMatch(/^Since yesterday: /)
  })

  test('keeps the older start when the counts fail to load', async () => {
    const { recorded } = await renderVisit({ lastVisitedAt: since, settledAt: [T0 + HOUR], failCounts: true })
    expect(recorded).toEqual([])
  })
})
