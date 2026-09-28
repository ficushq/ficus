import { afterEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { Agent, Squad, WorkStream } from '@ficus/shared'
import { queryKeys } from '../queryKeys'

import { SquadDetailPage } from './SquadDetailPage'

function AgentThreadsFixture() {
  const location = useLocation()
  const selectedAgent = new URLSearchParams(location.search).get('agent')
  return (
    <div
      data-squad-agent-panel
      data-selected-agent={selectedAgent ?? ''}
      tabIndex={-1}
      aria-label="Agent conversations"
    >
      Agent chat body
    </div>
  )
}

const dependencies = {
  useWebSocket: () => ({ subscribe: mock(() => mock(() => undefined)) }),
  SandboxStatusIndicator: () => <span data-test-slot="sandbox">Sandbox fixture</span>,
  SquadAgentThreads: AgentThreadsFixture,
  homeTabDependencies: {
    WorkStreamList: () => <div>Work stream fixture</div>,
    SquadAgentThreads: AgentThreadsFixture,
  },
}

const now = new Date('2026-01-01T00:00:00Z')

const squad: Squad = {
  id: 'squad-1',
  name: 'Ficus Routing Squad',
  purpose: 'Route agent deep links by device',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  createdAt: now,
  updatedAt: now,
}

function workStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Active work from active query',
    description: '',
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
    completionMode: 'pr-merge',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const managerAgent = {
  id: 'manager-1',
  agentTypeId: 'manager',
  status: 'idle',
  metadata: { name: 'Pearl' },
  createdAt: now,
} as Agent

const engineerAgent = {
  id: 'engineer-1',
  agentTypeId: 'engineer',
  status: 'idle',
  metadata: { name: 'Ada' },
  createdAt: now,
} as Agent

let activeDom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

async function installViewport(width: number) {
  let desktop = width >= 768
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  return (activeDom = await acquireDomHarness({
    url: 'http://localhost/',
    windowOptions: { innerWidth: width, innerHeight: 800 },
    configureWindow(window) {
      const mediaQuery = {
        get matches() {
          return desktop
        },
        media: '(min-width: 768px)',
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
          listeners.delete(listener),
        addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        dispatchEvent: () => false,
      }
      window.matchMedia = (() => mediaQuery) as typeof window.matchMedia
      ;(window as typeof window & { setViewportWidth: (width: number) => void }).setViewportWidth = (nextWidth) => {
        desktop = nextWidth >= 768
        window.innerWidth = nextWidth
        listeners.forEach((listener) => listener({ matches: desktop, media: mediaQuery.media } as MediaQueryListEvent))
      }
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    },
  }))
}

afterEach(async () => {
  // Preserve the suite's existing scheduler-drain window while this test still owns its DOM globals.
  if (activeDom) await new Promise((resolve) => setTimeout(resolve, 30))
  for (const queryClient of queryClients) {
    await queryClient.cancelQueries()
    queryClient.clear()
  }
  queryClients.clear()
  await activeDom?.cleanup()
  activeDom = undefined
})

const queryClients = new Set<QueryClient>()

function newQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } },
  })
  queryClients.add(queryClient)
  // useSquadSlugs reads the squad list to derive id<->slug maps.
  queryClient.setQueryData(queryKeys.squads.list(), [squad])
  queryClient.setQueryData(queryKeys.squads.detail(squad.id), squad)
  queryClient.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), {
    agents: [managerAgent, engineerAgent],
    recentlyTerminated: [],
  })
  queryClient.setQueryData(queryKeys.squads.agents(squad.id), [managerAgent, engineerAgent])
  queryClient.setQueryData(queryKeys.squads.workStreams(squad.id), [
    workStream({ id: 'done-ws', title: 'Done work should not feed Home', status: 'done' }),
  ])
  queryClient.setQueryData(queryKeys.squads.activeWorkStreams(squad.id), [
    workStream({ id: 'manager-ws', assigneeAgentId: managerAgent.id, agentIds: [managerAgent.id] }),
    workStream({ id: 'engineer-ws', assigneeAgentId: engineerAgent.id, agentIds: [engineerAgent.id] }),
  ])
  // Pre-seed the queries SquadAgentThreads fires so they resolve synchronously from cache.
  queryClient.setQueryData(queryKeys.agentTypes.list(), [])
  queryClient.setQueryData(queryKeys.agents.children(managerAgent.id), [])
  queryClient.setQueryData(queryKeys.agents.children(engineerAgent.id), [])
  return queryClient
}

function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

function lastTab(locations: string[]): string | null {
  // Tabs live in the path (/squads/<slug>/<tab>); the query fallback only
  // sees pre-redirect legacy entries.
  const [pathname, search] = locations.at(-1)!.split('?')
  const pathTab = pathname.match(/^\/squads\/[^/]+\/([^/]+)$/)?.[1]
  return pathTab ?? searchParams(search ?? '').get('tab')
}

function activateLinkWithEnter(
  window: Awaited<ReturnType<typeof acquireDomHarness>>['window'],
  link: HTMLAnchorElement
) {
  link.focus()
  const keydown = new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  if (link.dispatchEvent(keydown)) link.click()
  link.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
}

async function renderSquadDetail(
  width: number,
  initialSearch: string,
  pageDependencies: typeof dependencies = dependencies
) {
  const dom = await installViewport(width)
  const { window } = dom
  const locations: string[] = []

  function LocationRecorder() {
    const location = useLocation()
    const navigate = useNavigate()
    locations.push(`${location.pathname}${location.search}`)
    return (
      <div hidden>
        <button data-testid="history-back" onClick={() => navigate(-1)} />
        <button data-testid="history-forward" onClick={() => navigate(1)} />
      </div>
    )
  }

  const { root } = dom.createRoot()

  await dom.act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/squads/${squad.id}${initialSearch}`]}>
        <QueryClientProvider client={newQueryClient()}>
          <LocationRecorder />
          <Routes>
            <Route path="/squads/:squadId/:tab?" element={<SquadDetailPage dependencies={pageDependencies} />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    )
  })
  // Flush async react-query cache resolutions and routing effects. Each act() drains a microtask/macrotask layer.
  await dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  return { dom, window, locations, root, cleanup: () => dom.cleanup() }
}

async function renderAtPath(initialPath: string, width = 1280) {
  const dom = await installViewport(width)
  const { window } = dom
  const locations: string[] = []

  function LocationRecorder() {
    const location = useLocation()
    locations.push(`${location.pathname}${location.search}`)
    return null
  }

  const { root } = dom.createRoot()

  await dom.act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <QueryClientProvider client={newQueryClient()}>
          <LocationRecorder />
          <Routes>
            <Route path="/squads/:squadId/:tab?" element={<SquadDetailPage dependencies={dependencies} />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    )
  })
  await dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  return { dom, window, locations, root, cleanup: () => dom.cleanup() }
}

describe('SquadDetailPage slug resolution', () => {
  test('resolves a slug param to the squad', async () => {
    // 'Ficus Routing Squad' slugifies to 'ficus-routing-squad'.
    const { dom, window, cleanup } = await renderAtPath('/squads/ficus-routing-squad')
    expect(window.document.body.textContent).toContain('Ficus Routing Squad')
  })

  test('normalizes a UUID URL to the slug', async () => {
    const { dom, locations, cleanup } = await renderAtPath('/squads/squad-1')
    expect(locations.at(-1)).toBe('/squads/ficus-routing-squad')
  })
})

describe('SquadDetailPage ?agent= dedicated Chats routing', () => {
  test('opens Chats on repeated desktop assignee-pill activation', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(1280, '', {
      ...dependencies,
      homeTabDependencies: {
        SquadAgentThreads: AgentThreadsFixture,
      },
    })

    const assigneePill = Array.from(window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'manager'
    ) as HTMLAnchorElement
    expect(assigneePill).toBeDefined()

    await dom.act(async () => assigneePill.click())
    await dom.act(async () => activateLinkWithEnter(window, assigneePill))

    const finalSearch = searchParams(locations.at(-1)!.split('?')[1] ?? '')
    expect(finalSearch.get('agent')).toBe('manager-1')
    expect(finalSearch.has('tab')).toBe(false)
    expect(window.document.body.textContent).toContain('Agent chat body')
    expect(locations.filter((location) => location.includes('tab=agents'))).toHaveLength(0)
    expect(locations.filter((location) => location.includes('agent=manager-1'))).toHaveLength(1)
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe('Agent conversations')
    const homeTab = Array.from(window.document.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === 'Chats'
    )
    expect(homeTab?.getAttribute('aria-selected')).toBe('true')
  })

  test('selects a different desktop agent in Chats and supports back/forward', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(1280, '', {
      ...dependencies,
      homeTabDependencies: { SquadAgentThreads: AgentThreadsFixture },
    })
    const pills = Array.from(window.document.querySelectorAll('a'))
    const managerPill = pills.find((link) => link.textContent === 'manager') as HTMLAnchorElement
    const engineerPill = pills.find((link) => link.textContent === 'engineer') as HTMLAnchorElement

    await dom.act(async () => managerPill.click())
    await dom.act(async () =>
      (
        Array.from(window.document.querySelectorAll('[role="tab"]')).find(
          (tab) => tab.textContent === 'Home'
        ) as HTMLButtonElement
      ).click()
    )
    const nextEngineerPill = Array.from(window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'engineer'
    ) as HTMLAnchorElement
    await dom.act(async () => nextEngineerPill.click())
    expect(window.document.querySelector('[data-squad-agent-panel]')?.getAttribute('data-selected-agent')).toBe(
      'engineer-1'
    )
    expect(lastTab(locations)).toBe('agents')

    await dom.act(async () =>
      (window.document.querySelector('[data-testid="history-back"]') as HTMLButtonElement).click()
    )
    expect(lastTab(locations)).toBe('home')
    await dom.act(async () =>
      (window.document.querySelector('[data-testid="history-forward"]') as HTMLButtonElement).click()
    )
    expect(window.document.querySelector('[data-squad-agent-panel]')?.getAttribute('data-selected-agent')).toBe(
      'engineer-1'
    )
    expect(window.document.querySelectorAll('[data-squad-agent-panel]')).toHaveLength(1)
  })

  test('handles rapid desktop double activation without duplicate history', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(1280, '', {
      ...dependencies,
      homeTabDependencies: { SquadAgentThreads: AgentThreadsFixture },
    })
    const pill = Array.from(window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'manager'
    ) as HTMLAnchorElement
    await dom.act(async () => {
      pill.click()
      pill.click()
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 1)))
    expect(locations.filter((location) => location.includes('agent=manager-1'))).toHaveLength(1)
    expect(lastTab(locations)).toBe('agents')
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe('Agent conversations')
    await dom.act(async () =>
      (window.document.querySelector('[data-testid="history-back"]') as HTMLButtonElement).click()
    )
    expect(window.document.querySelector('[data-squad-agent-panel]')).toBeNull()
  })

  test('activates the Chats destination at the tablet boundary', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(768, '', {
      ...dependencies,
      homeTabDependencies: { SquadAgentThreads: AgentThreadsFixture },
    })
    const pill = Array.from(window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'manager'
    ) as HTMLAnchorElement
    await dom.act(async () => activateLinkWithEnter(window, pill))
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 1)))
    expect(lastTab(locations)).toBe('agents')
    expect(window.document.querySelectorAll('[data-squad-agent-panel]')).toHaveLength(1)
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe('Agent conversations')
  })

  test('enters Home from another tab before activating an assignee pill', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(1280, '?tab=work', {
      ...dependencies,
      homeTabDependencies: { SquadAgentThreads: AgentThreadsFixture },
    })
    const homeTab = Array.from(window.document.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === 'Home'
    ) as HTMLButtonElement
    await dom.act(async () => homeTab.click())
    const pill = Array.from(window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'manager'
    ) as HTMLAnchorElement
    await dom.act(async () => pill.click())
    expect(lastTab(locations)).toBe('agents')
    expect(window.document.querySelector('[data-squad-agent-panel]')?.getAttribute('data-selected-agent')).toBe(
      'manager-1'
    )
  })

  test('routes mobile assignee-pill activation to the visible Agents panel', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(375, '', {
      ...dependencies,
      homeTabDependencies: {
        SquadAgentThreads: AgentThreadsFixture,
      },
    })

    const assigneePill = Array.from(window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'manager'
    ) as HTMLAnchorElement
    expect(assigneePill.getAttribute('href')).toContain('agent=manager-1')
    expect(assigneePill.getAttribute('href')).not.toContain('tab=')

    await dom.act(async () => assigneePill.click())

    expect(lastTab(locations)).toBe('agents')
    expect(window.document.body.textContent).toContain('Agent chat body')
  })

  test('restores the selected desktop agent on refresh after pill navigation', async () => {
    const first = await renderSquadDetail(1280, '', {
      ...dependencies,
      homeTabDependencies: { SquadAgentThreads: AgentThreadsFixture },
    })
    const pill = Array.from(first.window.document.querySelectorAll('a')).find(
      (link) => link.textContent === 'engineer'
    ) as HTMLAnchorElement
    await first.dom.act(async () => pill.click())
    const refreshPath = first.locations.at(-1)!
    for (const queryClient of queryClients) {
      await queryClient.cancelQueries()
      queryClient.clear()
    }
    queryClients.clear()
    await first.cleanup()
    activeDom = undefined

    const refreshed = await renderAtPath(refreshPath, 1280)
    expect(refreshed.locations.at(-1)).toContain('agent=engineer-1')
    expect(refreshed.locations.at(-1)).not.toContain('tab=agents')
    expect(refreshed.window.document.querySelectorAll('[data-squad-agent-panel]')).toHaveLength(1)
  })

  test('normalizes legacy desktop agent links to Chats', async () => {
    // Desktop arrives on the (hidden) Agents tab via an existing ?tab=agents&agent= link.
    const { dom, window, locations, cleanup } = await renderSquadDetail(1280, '?tab=agents&agent=manager-1')

    const finalSearch = searchParams(locations.at(-1)!.split('?')[1] ?? '')
    expect(finalSearch.get('agent')).toBe('manager-1')
    // Home is the default tab, so the `tab` param is cleared on desktop.
    expect(finalSearch.has('tab')).toBe(false)
    // The Home tab's embedded agent panel renders.
    expect(window.document.body.textContent).toContain('Agent chat body')
  })

  test('routes a mobile deep link to the Agents tab so the agent panel is reachable', async () => {
    // Mobile arrives with only ?agent= (no tab) — default Home has no agent panel on mobile.
    const { dom, window, locations, cleanup } = await renderSquadDetail(375, '?agent=manager-1')

    const finalSearch = searchParams(locations.at(-1)!.split('?')[1] ?? '')
    expect(finalSearch.get('agent')).toBe('manager-1')
    expect(lastTab(locations)).toBe('agents')
    // The Agents tab renders the agent panel.
    expect(window.document.body.textContent).toContain('Agent chat body')
  })

  test('reconciles the selected agent to the visible panel across breakpoint changes in both directions', async () => {
    const { dom, window, locations, cleanup } = await renderSquadDetail(375, '?agent=manager-1')
    expect(lastTab(locations)).toBe('agents')

    await dom.act(async () => {
      ;(window as Window & { setViewportWidth(width: number): void }).setViewportWidth(768)
    })
    expect(lastTab(locations)).toBe('agents')
    expect(window.document.querySelectorAll('[data-squad-agent-panel]')).toHaveLength(1)

    await dom.act(async () => {
      ;(window as Window & { setViewportWidth(width: number): void }).setViewportWidth(767)
    })
    expect(lastTab(locations)).toBe('agents')
    expect(window.document.querySelectorAll('[data-squad-agent-panel]')).toHaveLength(1)
  })

  test('does not fight a manual tab change after an agent deep link has landed', async () => {
    // Mobile deep link routes to Agents, then the user switches to the Home tab manually.
    const { dom, window, locations, cleanup } = await renderSquadDetail(375, '?agent=manager-1')

    // After deep-link routing the tab is Agents.
    expect(lastTab(locations)).toBe('agents')

    // User clicks the Home tab.
    const homeTabButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Home'
    ) as HTMLButtonElement
    await dom.act(async () => {
      homeTabButton.click()
    })
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    // An explicit Home path preserves the user's choice on refresh too.
    expect(lastTab(locations)).toBe('home')
  })
})

describe('SquadDetailPage path-based tabs', () => {
  test('legacy ?tab= deep links redirect to the tab subpath', async () => {
    const { locations, cleanup } = await renderSquadDetail(1280, '?tab=work')
    expect(locations.at(-1)).toBe('/squads/ficus-routing-squad/work')
  })

  test('an explicit tab subpath survives refresh with an agent param present', async () => {
    // THE bug (2026-08-27): refreshing /squads/x?agent=y&tab=<x> landed on
    // home/agents because the ?agent= routing effect stomped the query-param
    // tab. With path tabs the explicit segment always wins — on desktop the
    // effect would previously have flipped this to Home.
    const { locations, cleanup } = await renderAtPath('/squads/squad-1/agents?agent=manager-1', 1280)
    expect(lastTab(locations)).toBe('agents')
    const finalSearch = searchParams(locations.at(-1)!.split('?')[1] ?? '')
    expect(finalSearch.get('agent')).toBe('manager-1')
  })
})
