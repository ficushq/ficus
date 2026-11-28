// Synthetic routes for the keyboard layout check. Render the real settings navigation,
// squad page, activity picker, and workspace terminal without a backend.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActivityWorkStreamCard } from '@ficus/shared'
import { SettingsNavigation } from '../../src/components/settings/SettingsNavigation'
import { SECTION_GROUPS } from '../../src/components/settings/settingsSections'
import { ActivityWorkPicker } from '../../src/components/squads/ActivityWorkPicker'
import { SquadDetailPage } from '../../src/components/SquadDetailPage'
import { useVisualViewportShell } from '../../src/hooks/useVisualViewportShell'
import { WebSocketContext } from '../../src/hooks/useWebSocket'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { queryKeys } from '../../src/queryKeys'
import { queries } from '../../src/queryOptions'
import { AppHeader, MobileBottomNav } from '../../src/components/AppNav'
import { InboxPopupProvider } from '../../src/components/InboxPopupProvider'
import { ThemeProvider } from '../../src/providers/ThemeProvider'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
const squadId = '00000000-0000-4000-8000-000000000001'
const squad = {
  id: squadId,
  name: 'Product Engineering',
  purpose: 'Build a product customers love. Ship thoughtful improvements to onboarding, payments, and the API.',
  status: 'active',
  globalCollaborationEnabled: false,
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
client.setQueryData(queryKeys.squads.list(), [squad])
client.setQueryData(queryKeys.squads.detail(squadId), squad)
client.setQueryData(queryKeys.squads.agents(squadId), [])
client.setQueryData(queryKeys.squads.agentsWithRecent(squadId), { agents: [] })
client.setQueryData(queryKeys.squads.activeWorkStreams(squadId), [])
client.setQueryData(queries.sandbox.status(squadId).queryKey, { runtime: 'host', status: 'running' })
client.setQueryData(queries.terminal.sessions(`squad_${squadId}`).queryKey, [
  { sessionId: 'shell-one', lastActivity: 0 },
  { sessionId: 'shell-two', lastActivity: 0 },
])

const cards: ActivityWorkStreamCard[] = Array.from({ length: 20 }, (_, i) => ({
  id: `stream-${i + 1}`,
  number: 100 + i,
  squadId,
  title: `Release check ${i + 1}`,
  status: 'active',
  step: null,
  waits: [],
  needsYou: false,
  pullRequest: null,
  ci: null,
  deliveryLabel: null,
  workingAgentIds: [],
  lastEventAt: new Date().toISOString(),
}))

const useEmptyPendingActions = () => ({ data: [] })

export function Fixture() {
  const shell = useRef<HTMLDivElement>(null)
  useVisualViewportShell(shell)
  const [section, selectSection] = useState('account')
  const [stream, selectStream] = useState<string | null>(null)
  return (
    <div
      ref={shell}
      data-testid="app-shell"
      className="ficus-app-shell h-full max-h-full flex flex-col overflow-hidden bg-page text-primary"
    >
      <AppHeader usePendingActions={useEmptyPendingActions} />
      <div className="relative grow min-h-0 flex flex-col overflow-hidden">
        <main
          data-testid="app-scroll-container"
          className="ficus-app-main grow min-h-0 flex flex-col overflow-y-auto p-4"
        >
          <Routes>
            <Route
              path="/settings"
              element={
                <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
                  <SettingsNavigation
                    groups={SECTION_GROUPS}
                    activeSection={section}
                    onSectionChange={selectSection}
                    showOnboardingLink
                  />
                  <h1 className="text-lg font-semibold">Settings</h1>
                </div>
              }
            />
            <Route
              path="/activity"
              element={
                <>
                  <h1 className="mb-24 text-lg font-semibold">Activity</h1>
                  <div className="self-start">
                    <ActivityWorkPicker
                      cards={cards}
                      total={cards.length}
                      selectedId={stream}
                      onSelect={selectStream}
                      moreHref="/work"
                    />
                  </div>
                </>
              }
            />
            <Route
              path="/squads/:squadId/:tab"
              element={<SquadDetailPage dependencies={{ SandboxStatusIndicator: () => null }} />}
            />
          </Routes>
        </main>
      </div>
      <MobileBottomNav usePendingActions={useEmptyPendingActions} />
    </div>
  )
}

const view = params.get('view')
const path =
  view === 'workspace' || view === 'squad'
    ? `/squads/${squadId}/${view === 'squad' ? 'settings' : view}`
    : `/${view ?? 'settings'}`
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[path]}>
    <QueryClientProvider client={client}>
      <WebSocketContext.Provider value={{ subscribe: () => () => {}, isConnected: false }}>
        <PermissionsProvider
          usePermissions={() => ({
            permissions: [],
            can: (permission) => permission === 'squads:update' || permission === 'agents:private-access',
            isLoading: false,
            isError: false,
          })}
        >
          <ThemeProvider>
            <InboxPopupProvider>
              <Fixture />
            </InboxPopupProvider>
          </ThemeProvider>
        </PermissionsProvider>
      </WebSocketContext.Provider>
    </QueryClientProvider>
  </MemoryRouter>
)
