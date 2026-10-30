// Real Feed component and theme styles, with synthetic data and a pending receipt for disabled-state checks.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { WorkStream } from '@ficus/shared'
import { AccountFeedVisit } from '../../src/components/FeedVisitSummary'
import { ReactQueryHooksProvider } from '../../src/reactQueryHooks'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME, IRIS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
applyResolvedTheme(
  document.documentElement,
  params.get('theme') === 'iris' ? IRIS_THEME : FICUS_THEME,
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
        } as WorkStream,
      ],
      totalCount: 1,
    },
  ],
}
const hooks = {
  useInfiniteQuery: (() => ({ isSuccess: true, isFetchedAfterMount: true, data, hasNextPage: false })) as never,
}
const useActivity = (() => ({ ownerId: 'example-user', activity: { conversations: [] } })) as never
const acknowledge = () => new Promise<{ seen: true }>(() => {})

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ReactQueryHooksProvider hooks={hooks}>
      <main className="min-h-full bg-page p-4 text-primary">
        <AccountFeedVisit userId="example-user" useActivity={useActivity} acknowledge={acknowledge} />
      </main>
    </ReactQueryHooksProvider>
  </MemoryRouter>
)
