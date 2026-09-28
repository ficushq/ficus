import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { queryKeys } from '../queryKeys'
import type { Agent, Squad } from '@ficus/shared'

import { SquadManagerChatPage } from './SquadManagerChatPage'

let capturedProps: Record<string, unknown> | null = null
const ThreadsStub = (props: Record<string, unknown>) => {
  capturedProps = props
  return <div data-testid="agent-threads">threads</div>
}

const now = new Date('2026-01-01T00:00:00Z')
const squad = { id: 'squad-1', name: 'Ficus', managerAgentId: 'manager-1' } as Squad
const manager = {
  id: 'manager-1',
  squadId: 'squad-1',
  agentTypeId: 'manager',
  status: 'idle',
  metadata: { name: 'Manager Alpha' },
  createdAt: now,
  updatedAt: now,
} as Agent

function seededClient(agents: Agent[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.detail(squad.id), squad)
  queryClient.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), { agents, recentlyTerminated: [] })
  return queryClient
}

function renderPage(agents: Agent[]) {
  capturedProps = null
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/squads/${squad.id}/manager`]}>
      <QueryClientProvider client={seededClient(agents)}>
        <Routes>
          <Route path="/squads/:squadId/manager" element={<SquadManagerChatPage threadsComponent={ThreadsStub} />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SquadManagerChatPage', () => {
  test('renders the agent panel locked to the manager in page mode', () => {
    const html = renderPage([manager])
    expect(html).toContain('data-testid="agent-threads"')
    expect(capturedProps).toMatchObject({ layout: 'page', lockedAgentId: 'manager-1', squadId: 'squad-1' })
  })

  test('shows the no-manager message when there is no manager agent', () => {
    const html = renderPage([])
    expect(html).toContain('No manager agent found')
  })
})
