// Real Feed component and theme styles, with synthetic data and a pending receipt for disabled-state checks.
// `?theme=<built-in id>&appearance=dark` picks the theme; `?settled` adds the "since your last visit" line.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import type { WorkStream } from '@ficus/shared'
import { AccountFeedVisit } from '../../src/components/FeedVisitSummary'
import { ReactQueryHooksProvider } from '../../src/reactQueryHooks'
import { applyResolvedTheme } from '../../src/theme/apply'
import { BUILT_IN_THEMES, FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
applyResolvedTheme(
  document.documentElement,
  BUILT_IN_THEMES.find((theme) => theme.id === params.get('theme')) ?? FICUS_THEME,
  params.get('appearance') === 'dark' ? 'dark' : 'light'
)
const data = {
  pages: [
    {
      items: [
        {
          id: 'example',
          title: 'Completed update',
          squadId: 'example-squad',
          completedAt: '2026-10-29T12:00:00Z',
        } as unknown as WorkStream,
      ],
      totalCount: 1,
    },
  ],
}
const since = new Date(Date.now() - 26 * 3_600_000).toISOString()
const countedThrough = new Date().toISOString()
const hooks = {
  useInfiniteQuery: (() => ({ isSuccess: true, isFetchedAfterMount: true, data, hasNextPage: false })) as never,
  // The last-visit read and the settled counts; without `?settled` the account has no recorded visit.
  useQuery: ((query: { queryKey: unknown[] }) =>
    query.queryKey[1] === 'feed-visit'
      ? {
          isSuccess: true,
          data: { lastVisitedAt: params.has('settled') ? since : null, observedAt: new Date().toISOString() },
        }
      : {
          isSuccess: true,
          data: { since, clamped: false, through: countedThrough, counts: { questions: 4, reviews: 2 } },
        }) as never,
}
const useActivity = (() => ({ ownerId: 'example-user', activity: { conversations: [] } })) as never
const acknowledge = () => new Promise<{ seen: true }>(() => {})

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ReactQueryHooksProvider hooks={hooks}>
      <main className="min-h-full bg-page p-4 text-primary">
        <AccountFeedVisit
          userId="example-user"
          useActivity={useActivity}
          acknowledge={acknowledge}
          acknowledgeVisit={async (visitedAt) => ({ lastVisitedAt: visitedAt })}
        />
      </main>
    </ReactQueryHooksProvider>
  </MemoryRouter>
)
