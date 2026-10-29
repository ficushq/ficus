// Real Feed layout, Updates, mobile dock and screenshot overlay; synthetic data only.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PendingAction } from '@ficus/shared'
import { AccountFeedVisit } from '../../src/components/FeedVisitSummary'
import { FeedPage } from '../../src/components/FeedPage'
import { MobileBottomNav } from '../../src/components/AppNav'
import { ScreenshotFiling } from '../../src/components/ScreenshotFiling'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import '../../src/index.css'

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
Object.assign(window, { refreshFeed: () => client.invalidateQueries({ queryKey: ['squads'] }) })
const actions = [
  { id: 'pending-action', type: 'workstream-review', priority: 1, data: { squadId: 'synthetic' } },
] as PendingAction[]
const pending = () => ({ data: actions, isLoading: false, isError: false, error: null, refetch: async () => {} })
const activity = (() => ({
  ownerId: 'synthetic',
  activity: {
    conversations: [
      {
        id: 'chat',
        title: 'Assistant pointer',
        unreadUpdates: 1,
        latestUpdate: { createdAt: '2026-10-28T12:00:00.000Z', preview: 'Still unread' },
      },
    ],
  },
})) as never
if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark')
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={client}>
      <PermissionsProvider
        usePermissions={() => ({
          permissions: ['*'],
          identity: { type: 'user', userId: 'synthetic' },
          can: () => true,
          isLoading: false,
          isError: false,
        })}
      >
        <div style={{ height: '100dvh' }} className="overflow-hidden flex flex-col bg-page text-primary">
          <header className="ficus-glass shrink-0 border-b border-panel-border px-4 py-3">Ficus · Feed preview</header>
          <main
            data-testid="app-scroll-container"
            className="grow min-h-0 overflow-y-auto overscroll-contain max-w-7xl w-full mx-auto p-4 md:pt-6 md:px-6"
          >
            <FeedPage
              dependencies={{
                FeedVisitSummary: (props) => <AccountFeedVisit userId="synthetic" useActivity={activity} {...props} />,
                usePendingActions: pending,
                useSquadFilters: () => [],
                ActionCenterContent: () => (
                  <button className="ficus-button ficus-button-secondary">Review pending action</button>
                ),
                WorkStreamListAll: () => (
                  <div className="space-y-4">
                    {Array.from({ length: 35 }, (_, i) => (
                      <div key={i} className="rounded border border-th-border p-4">
                        Active work {i + 1}
                      </div>
                    ))}
                  </div>
                ),
              }}
            />
          </main>
          <MobileBottomNav usePendingActions={pending} />
          <ScreenshotFiling />
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
