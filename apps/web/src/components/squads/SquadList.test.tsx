import { describe, expect, test } from 'bun:test'
import type { AgentStatus } from '@ficus/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { queries } from '../../queryOptions'
import { hasWorkingAgent, SquadList } from './SquadList'

function agents(...statuses: AgentStatus[]) {
  return statuses.map((status, index) => ({ id: String(index), status }))
}

describe('hasWorkingAgent', () => {
  test('only exact active agents claim activity in progress', () => {
    expect(hasWorkingAgent(agents('active'))).toBe(true)
    expect(hasWorkingAgent(agents('idle'))).toBe(false)
    expect(hasWorkingAgent(agents('waiting-input'))).toBe(false)
    expect(hasWorkingAgent(agents('compacting'))).toBe(false)
    expect(hasWorkingAgent(agents('resetting'))).toBe(false)
    expect(hasWorkingAgent(agents('idle', 'active'))).toBe(true)
  })
})

describe('squad cards', () => {
  test('show the active agent count alone, and pin the counts to the card bottom', () => {
    const client = new QueryClient()
    const squad = { id: 'sq', name: 'Chlea', purpose: 'Short', status: 'active', isAnonymous: false, avatarUrl: null }
    const agent = (id: string, status: AgentStatus) => ({ id, squadId: 'sq', agentTypeId: 'engineer', status })
    client.setQueryData(queries.squads.list('active').queryKey, [squad] as never)
    client.setQueryData(queries.agents.list().queryKey, [
      agent('a', 'active'),
      agent('b', 'idle'),
      agent('c', 'idle'),
    ] as never)
    client.setQueryData(queries.squads.activeWorkStreams().queryKey, [] as never)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SquadList />
        </MemoryRouter>
      </QueryClientProvider>
    )
    expect(html).toContain('1 active agent<')
    expect(html).not.toMatch(/\d+\/\d+ active agents?/)
    expect(html).toContain('mt-auto flex items-center gap-3 text-xs text-muted')
  })
})
