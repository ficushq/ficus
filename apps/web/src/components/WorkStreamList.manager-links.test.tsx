import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Agent, Squad, WorkStream } from '@ficus/shared'
import { WorkStreamList } from './WorkStreamList'

function squad(overrides: Partial<Squad> = {}): Squad {
  return {
    id: 'squad-1',
    name: 'Ficus',
    purpose: 'Coordinate work',
    status: 'active',
    squadPresetId: null,
    defaultAgents: [],
    managerAgentId: 'manager-1',
    context: null,
    isAnonymous: false,
    globalCollaborationEnabled: false,
    order: 0,
    metadata: {},
    sandboxStatus: { state: 'none' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function workStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: 'squad-1',
    title: 'Ship responsive links',
    description: null,
    status: 'active',
    derivedState: 'in_progress',
    assigneeAgentId: null,
    ownerAgentId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function renderList(squads: Squad[] = [squad()]) {
  const queryClient = new QueryClient()

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkStreamList
          workStreams={[workStream()]}
          squadMap={new Map(squads.map((item) => [item.id, item]))}
          agentMap={new Map<string, Agent>()}
          squads={squads}
          showManagerChatMenu
          hideFilters
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('WorkStreamList squad quick links', () => {
  test('uses one squad Home link for every screen size without destination hints', () => {
    const html = renderList()
    const section = html.slice(html.indexOf('<section aria-label="Squad quick links"'))

    expect(section.match(/href="\/squads\/squad-1"/g)).toHaveLength(1)
    expect(section).not.toContain('/manager')
    expect(section).not.toContain('md:hidden')
    expect(section).not.toContain('md:flex')
    expect(section).not.toContain('Manager chat')
    expect(section).not.toContain('Squad home')
    expect(section).not.toContain('Open squad home')
    expect(section).toContain('Coordinate work')
    expect(section).toContain('Customize squad quick links')
    expect(section).not.toContain('Hide Ficus from quick links')
  })

  test('keeps squad quick links visible without a disclosure control', () => {
    const html = renderList()

    expect(html).toContain('aria-label="Squad quick links"')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('<summary')
  })
})
