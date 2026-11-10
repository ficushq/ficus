import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { queryKeys } from '../queryKeys'
import type { Squad } from '@ficus/shared'

import { SquadConsultantChatPage } from './SquadConsultantChatPage'

// Server rendering runs no effects, so a spy records the props the threads panel
// receives instead of assigning them to a variable during render.
const ThreadsStub = mock((_props: Record<string, unknown>) => <div data-testid="agent-threads">threads</div>)
const capturedProps = (): Record<string, unknown> | null => ThreadsStub.mock.calls.at(-1)?.[0] ?? null

const squad = { id: 'squad-1', name: 'Ficus' } as Squad

function renderPage() {
  ThreadsStub.mockClear()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.detail(squad.id), squad)
  queryClient.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), { agents: [], recentlyTerminated: [] })
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/squads/${squad.id}/consultant`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route
            path="/squads/:squadId/consultant"
            element={<SquadConsultantChatPage threadsComponent={ThreadsStub} />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SquadConsultantChatPage', () => {
  test('renders the agent panel in consultant page mode with default-compose', () => {
    const html = renderPage()
    expect(html).toContain('data-testid="agent-threads"')
    expect(capturedProps()).toMatchObject({
      layout: 'page',
      agentTypeFilter: 'consultant',
      defaultCompose: true,
      squadId: 'squad-1',
    })
  })

  test('passes a back link via headerLeading', () => {
    renderPage()
    expect(capturedProps()?.headerLeading).toBeTruthy()
  })
})
