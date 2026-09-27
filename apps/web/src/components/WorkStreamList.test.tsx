import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { queryKeys } from '../queryKeys'
import type { Agent, Squad, WorkStream, WorkStreamMetrics, WorkStreamWait } from '@ficus/shared'
import { acquireDomHarness, withDomOwnership } from '../test/domHarness'

const { WorkStreamList } = await import('./WorkStreamList')
const { WorkStreamDetailModal, WORKSTREAM_RESPONSE_CONTROL_CLASS } = await import('./WorkStreamDetailModal')
const { WorkStreamList: SquadWorkStreamList } = await import('./squads/WorkStreamList')

const now = new Date('2026-01-01T00:00:00Z')

const squad: Squad = {
  id: 'squad-1',
  name: 'Tau',
  purpose: 'Build Tau',
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
  // Default the derived state from the (possibly overridden) status when the caller doesn't supply
  // one explicitly: 'active' -> 'in_progress' (the common case), otherwise mirror the stored status
  // (queued/done/canceled all read the same as their derived state).
  const status = overrides.status ?? 'active'
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Ship active section reuse',
    description: 'Reuse WorkStreamList sections.',
    status,
    derivedState: status === 'active' ? 'in_progress' : status,
    assigneeAgentId: null,
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

function workStreamWait(overrides: Partial<WorkStreamWait> = {}): WorkStreamWait {
  return {
    id: 'wait-1',
    workStreamId: 'ws-1',
    type: 'review',
    referenceId: null,
    message: null,
    createdBy: 'agent',
    createdByAgentId: null,
    openedAt: now.toISOString(),
    closedAt: null,
    resolution: null,
    resolutionNote: null,
    ...overrides,
  }
}

const engineer: Agent = {
  id: 'agent-1',
  squadId: squad.id,
  agentTypeId: 'engineer',
  status: 'idle',
  persist: false,
  metadata: { name: 'Pearl' },
  context: null,
  questionData: null,
  sessionUsage: null,
  createdAt: now,
  updatedAt: now,
  lastMessageAt: null,
  terminatedAt: null,
}

function createTestQueryClient(agents: Agent[] = [], metrics?: WorkStreamMetrics, cachedAgents: Agent[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  queryClient.setQueryData(
    queryKeys.agentTypes.list(),
    agents.map((agent) => ({
      id: agent.agentTypeId,
      name: agent.agentTypeId.charAt(0).toUpperCase() + agent.agentTypeId.slice(1),
    }))
  )
  for (const agent of cachedAgents) {
    queryClient.setQueryData(queryKeys.agents.detail(agent.id), agent)
  }
  if (metrics) queryClient.setQueryData(queryKeys.squads.workStreamMetrics('ws-1'), metrics)
  return queryClient
}

async function renderClient(element: React.ReactNode) {
  const dom = await acquireDomHarness({ url: 'http://localhost/work-streams' })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(element))
    await dom.act(async () => Bun.sleep(10))
    return dom.window.document.body.innerHTML
  } finally {
    await dom.cleanup()
  }
}

function renderWorkStreamList(
  workStreams: WorkStream[],
  props: Partial<Parameters<typeof WorkStreamList>[0]> = {},
  initialEntry = '/',
  agents: Agent[] = []
) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={createTestQueryClient(agents)}>
        <WorkStreamList
          workStreams={workStreams}
          squadMap={new Map([[squad.id, squad]])}
          agentMap={new Map(agents.map((agent) => [agent.id, agent]))}
          showSquadFilter={false}
          hideFilters
          {...props}
        />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('WorkStreamList', () => {
  test.each([
    ['Tau', '/squads/squad-1'],
    ['Engineer', '/squads/squad-1/agents?agent=agent-1'],
  ])('feed metadata links open %s without opening the work stream', async (label, destination) => {
    const dom = await acquireDomHarness({ url: 'http://localhost/feed' })
    const rendered = dom.createRoot()
    const client = createTestQueryClient([engineer])
    function CurrentRoute() {
      const location = useLocation()
      return (
        <output data-testid="current-route">
          {location.pathname}
          {location.search}
        </output>
      )
    }
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter initialEntries={['/feed']}>
            <QueryClientProvider client={client}>
              <WorkStreamList
                workStreams={[workStream({ assigneeAgentId: engineer.id })]}
                squadMap={new Map([[squad.id, squad]])}
                agentMap={new Map([[engineer.id, engineer]])}
                feedLayout
                hideFilters
              />
              <CurrentRoute />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const row = rendered.container.querySelector('[data-testid="feed-work-row"]')!
      const link = [...row.querySelectorAll('a')].find((element) => element.textContent === label)!
      expect(link).toBeTruthy()
      expect(link.getAttribute('href')).toBe(destination)
      expect(link.closest('button')).toBeNull()
      // The row's pseudo-element covers its surface; links must sit above it.
      expect(link.className).toContain('relative z-10')
      // Mobile widens every anchor to a 24px touch target; the text must stay centered in that box
      // so it lines up with the separators and elapsed time beside it.
      expect(link.className).toContain('inline-flex items-center')
      expect(link.className).toContain('hover:underline')
      expect(link.className).toContain('focus-visible:ring-2')
      link.focus()
      expect(dom.window.document.activeElement).toBe(link)
      await dom.act(async () => link.click())
      expect(rendered.container.querySelector('[data-testid="current-route"]')!.textContent).toBe(destination)
      expect(rendered.container.querySelector('[role="dialog"]')).toBeNull()
    } finally {
      await dom.cleanup()
      client.clear()
    }
  })

  test('renders agent runtime instead of wall-clock since createdAt', () => {
    const oldCreated = new Date(now.getTime() - 60 * 60 * 1000)
    const ws = workStream({
      id: 'rt-1',
      status: 'active',
      derivedState: 'in_progress',
      createdAt: oldCreated,
      updatedAt: oldCreated,
      runtime: { totalMs: 12_000, activeCount: 0, computedAt: oldCreated.toISOString() },
    })
    const html = renderWorkStreamList([ws])
    expect(html).toContain('>12s</span>')
    expect(html).not.toContain('1h')
  })

  test('renders active work streams in the server canonical order without re-sorting', () => {
    // The fixture is pre-sorted to mirror the server contract (GET /workstreams);
    // the component must render that order as-is.
    const html = renderWorkStreamList([
      workStream({ id: 'review', title: 'Order Review', derivedState: 'in_review' }),
      workStream({ id: 'wait', title: 'Order Wait', derivedState: 'blocked' }),
      workStream({ id: 'progress', title: 'Order Progress', derivedState: 'in_progress' }),
      workStream({ id: 'idle', title: 'Order Idle', derivedState: 'idle', effectivePriority: 'low' }),
      workStream({ id: 'queue-1', title: 'Order Queue One', status: 'queued', queuePosition: 1 }),
      workStream({ id: 'queue-2', title: 'Order Queue Two', status: 'queued', queuePosition: 2 }),
    ])

    const indices = [
      'Order Review',
      'Order Wait',
      'Order Progress',
      'Order Idle',
      'Order Queue One',
      'Order Queue Two',
    ].map((title) => html.indexOf(title))
    expect(indices.every((index) => index >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test('renders active and done sections by default with done collapsed', () => {
    const html = renderWorkStreamList([
      workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' }),
      workStream({ id: 'done-ws', title: 'Done work', status: 'done' }),
    ])

    expect(html).toContain('>Active</span>')
    expect(html).toContain('>Done</span>')
    expect(html).toContain('Active work')
    expect(html).not.toContain('Done work')
    expect(html).toContain('<button')
  })

  test('renders persistent squad Home quick links below Done when enabled', () => {
    const html = renderWorkStreamList(
      [
        workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' }),
        workStream({ id: 'done-ws', title: 'Done work', status: 'done' }),
      ],
      {
        showManagerChatMenu: true,
        showSquadFilter: true,
        squads: [squad],
      }
    )

    expect(html).toContain('aria-label="Squad quick links"')
    expect(html).not.toContain('<details')
    expect(html).toContain('Squads')
    expect(html).toContain('href="/squads/squad-1"')
    expect(html).not.toContain('Manager chat')
    expect(html.indexOf('>Done</span>')).toBeLessThan(html.indexOf('aria-label="Squad quick links"'))
  })

  test('preloads squad filters and quick links with their real structure', () => {
    const html = renderWorkStreamList([], {
      isLoading: true,
      showManagerChatMenu: true,
      showSquadFilter: true,
      hideFilters: false,
      squadsLoading: true,
      squads: [],
    })

    expect(html).toContain('All squads')
    expect(html).toContain('aria-label="Loading squad quick links"')
    expect(html).not.toContain('Open squad home')
    expect(html.indexOf('>Done</span>')).toBeLessThan(html.indexOf('aria-label="Loading squad quick links"'))
  })

  test('shows real quick links as soon as squads resolve while work streams are still loading', () => {
    const html = renderWorkStreamList([], {
      isLoading: true,
      showManagerChatMenu: true,
      showSquadFilter: true,
      squadsLoading: false,
      squads: [squad],
    })

    expect(html).not.toContain('aria-label="Loading squad quick links"')
    expect(html).toContain('href="/squads/squad-1"')
    expect(html).toContain('>Tau</span>')
  })

  test('orders squad quick links by squad custom order', () => {
    const alphaSquad: Squad = { ...squad, id: 'alpha-squad', name: 'Alpha', order: 2 }
    const betaSquad: Squad = { ...squad, id: 'beta-squad', name: 'Beta', order: 1 }

    const html = renderWorkStreamList(
      [workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' })],
      {
        showManagerChatMenu: true,
        showSquadFilter: true,
        squads: [alphaSquad, betaSquad],
      }
    )

    expect(html.indexOf('href="/squads/beta-squad"')).toBeLessThan(html.indexOf('href="/squads/alpha-squad"'))
  })

  test('hides squads from quick links when hidden in quick-link settings', async () => {
    const withLocalStorageFixture = async (body: () => void | Promise<void>) =>
      withDomOwnership(async () => {
        const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
        const localStorageFixture = {
          getItem: () => JSON.stringify(['hidden-squad']),
          setItem: mock(() => undefined),
        }
        const installedDescriptor: PropertyDescriptor = {
          configurable: true,
          enumerable: previousDescriptor?.enumerable ?? false,
          writable: true,
          value: localStorageFixture,
        }
        Object.defineProperty(globalThis, 'localStorage', installedDescriptor)
        expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toEqual(installedDescriptor)

        try {
          await body()
        } finally {
          if (previousDescriptor) Object.defineProperty(globalThis, 'localStorage', previousDescriptor)
          else Reflect.deleteProperty(globalThis, 'localStorage')
          expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toEqual(previousDescriptor)
        }
      })

    const hiddenSquad: Squad = { ...squad, id: 'hidden-squad', name: 'Hidden Squad', order: 1 }
    const visibleSquad: Squad = { ...squad, id: 'visible-squad', name: 'Visible Squad', order: 2 }

    await withLocalStorageFixture(() => {
      const html = renderWorkStreamList(
        [workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' })],
        {
          showManagerChatMenu: true,
          showSquadFilter: true,
          squads: [visibleSquad, hiddenSquad],
        }
      )

      expect(html).toContain('Visible Squad')
      expect(html).not.toContain('href="/squads/hidden-squad"')
      expect(html).not.toContain('Show Hidden Squad')
      expect(html).not.toContain('Hidden from quick links')
      expect(html).toContain('Customize squad quick links')
    })

    const sentinel = new Error('fixture assertion failed')
    await expect(
      withLocalStorageFixture(() => {
        throw sentinel
      })
    ).rejects.toBe(sentinel)
  })

  test('customizing shows every squad in place and persists hide/unhide choices', async () => {
    const storageKey = 'feed-manager-chat-hidden-squad-ids'
    const dom = await acquireDomHarness({ url: 'http://localhost/feed' })
    const rendered = dom.createRoot()
    const client = createTestQueryClient()
    const beta = { ...squad, id: 'beta', name: 'Beta', order: 1 }
    const squads = [squad, beta]
    const render = (status: Agent['status'] = 'active') => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <WorkStreamList
            workStreams={[]}
            squadMap={new Map(squads.map((item) => [item.id, item]))}
            agentMap={new Map([[engineer.id, { ...engineer, status }]])}
            squads={squads}
            showManagerChatMenu
            hideFilters
          />
        </QueryClientProvider>
      </MemoryRouter>
    )
    const section = () => rendered.container.querySelector('[aria-label="Squad quick links"]')!
    const links = () => [...section().querySelectorAll('a')].map((link) => link.getAttribute('href'))
    const click = async (label: string) => {
      const button = section().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      expect(button).not.toBeNull()
      await dom.act(async () => button!.click())
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify([beta.id]))
      await dom.act(async () => rendered.root.render(render()))
      expect(links()).toEqual(['/squads/squad-1'])
      expect(section().querySelector('[aria-label="Tau: Agents working"]')).not.toBeNull()
      expect(section().querySelector('.tabular-nums')).toBeNull()
      expect(section().querySelectorAll('button')).toHaveLength(1)
      expect(section().textContent).not.toContain('Hidden from quick links')

      await click('Customize squad quick links')
      expect(links()).toEqual(['/squads/squad-1', '/squads/beta'])
      expect(section().querySelector('[aria-label="Beta: No active agents"]')).not.toBeNull()
      await click('Hide Tau from quick links')
      expect(links()).toEqual(['/squads/squad-1', '/squads/beta'])
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(['beta', 'squad-1'])
      await click('Finish customizing squad quick links')
      expect(links()).toEqual([])
      expect(section().textContent).toContain('Choose Customize')

      await click('Customize squad quick links')
      await click('Unhide Beta in quick links')
      await click('Finish customizing squad quick links')
      expect(links()).toEqual(['/squads/beta'])
      expect(section().querySelectorAll('button')).toHaveLength(1)

      await dom.act(async () => rendered.root.render(null))
      await dom.act(async () => rendered.root.render(render()))
      expect(links()).toEqual(['/squads/beta'])
      await click('Customize squad quick links')
      await click('Unhide Tau in quick links')
      expect(localStorage.getItem(storageKey)).toBeNull()
      await click('Finish customizing squad quick links')
      expect(links()).toEqual(['/squads/squad-1', '/squads/beta'])
      await dom.act(async () => rendered.root.render(render('idle')))
      expect(section().querySelector('[aria-label="Tau: Agents working"]')).toBeNull()
      expect(section().querySelector('[aria-label="Tau: No active agents"]')).not.toBeNull()
    } finally {
      client.clear()
      await dom.cleanup()
    }
  })

  test('can render only the active section as a collapsible section', () => {
    const html = renderWorkStreamList(
      [
        workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' }),
        workStream({ id: 'done-ws', title: 'Done work', status: 'done' }),
      ],
      { activeOnly: true, activeCollapsible: true }
    )

    expect(html).toContain('>Active</span>')
    expect(html).toContain('<button')
    expect(html).toContain('Active work')
    expect(html).not.toContain('>Done</span>')
    expect(html).not.toContain('Done work')
  })

  test('renders externally paged done streams with total count and sentinel', () => {
    const html = renderWorkStreamList(
      [workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' })],
      {
        doneStreams: [workStream({ id: 'done-ws', title: 'Paged done work', status: 'done' })],
        doneTotalCount: 42,
        hasMoreDone: true,
        onLoadMoreDone: () => undefined,
      },
      '/?collapsed=0'
    )

    expect(html).toContain('>Done</span>')
    expect(html).toContain('>42</span>')
    expect(html).toContain('Paged done work')
    expect(html).toContain('data-testid="done-load-more-sentinel"')
    expect(html).toContain('Scroll to load more')
  })

  test('active-only mode does not open hidden done work streams from the URL', () => {
    const html = renderWorkStreamList(
      [
        workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' }),
        workStream({ id: 'done-ws', title: 'Done work', status: 'done' }),
      ],
      { activeOnly: true, activeCollapsible: true },
      '/?ws=done-ws'
    )

    expect(html).toContain('Active work')
    expect(html).not.toContain('Done work')
  })

  test('default mode can open a deep-linked work stream hidden by status filters', async () => {
    const streams = [
      workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' }),
      workStream({ id: 'done-ws', title: 'Done work', status: 'done' }),
    ]
    const html = await renderClient(
      <MemoryRouter initialEntries={['/?status=done&ws=active-ws&collapsed=0']}>
        <QueryClientProvider client={createTestQueryClient()}>
          <WorkStreamList
            workStreams={streams}
            squadMap={new Map([[squad.id, squad]])}
            agentMap={new Map()}
            showSquadFilter={false}
            hideFilters
          />
        </QueryClientProvider>
      </MemoryRouter>
    )

    expect(html).toContain('Active work')
    expect(html).toContain('Done work')
  })

  test('active-only mode ignores URL status filters from other list views', () => {
    const html = renderWorkStreamList(
      [workStream({ id: 'active-ws', title: 'Active work', status: 'active', derivedState: 'in_progress' })],
      { activeOnly: true, activeCollapsible: true },
      '/?status=done'
    )

    expect(html).toContain('Active work')
    expect(html).toContain('>Active</span>')
    expect(html).not.toContain('No active work streams')
  })

  test('toggles multiple status and squad filters, with All clearing each group', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/feed' })
    const rendered = dom.createRoot()
    const secondSquad = { ...squad, id: 'squad-2', name: 'Beta' }
    const progress = workStream({ id: 'progress', title: 'Progress Alpha', squadId: squad.id })
    const waiting = workStream({
      id: 'waiting',
      title: 'Waiting Beta',
      squadId: secondSquad.id,
      derivedState: 'blocked',
    })

    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={createTestQueryClient()}>
              <WorkStreamList
                workStreams={[progress, waiting]}
                squadMap={
                  new Map([
                    [squad.id, squad],
                    [secondSquad.id, secondSquad],
                  ])
                }
                agentMap={new Map()}
                squads={[squad, secondSquad]}
              />
            </QueryClientProvider>
          </MemoryRouter>
        )
      })
      const button = (label: string) =>
        [...dom.window.document.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
      const pageText = () => dom.window.document.body.textContent ?? ''

      expect(button('All').getAttribute('aria-pressed')).toBe('true')
      expect(button('All squads').getAttribute('aria-pressed')).toBe('true')

      await dom.act(async () => button('In Progress').click())
      expect(button('All').getAttribute('aria-pressed')).toBe('false')
      expect(pageText()).toContain('Progress Alpha')
      expect(pageText()).not.toContain('Waiting Beta')

      await dom.act(async () => button('Waiting').click())
      expect(button('In Progress').getAttribute('aria-pressed')).toBe('true')
      expect(button('Waiting').getAttribute('aria-pressed')).toBe('true')
      expect(pageText()).toContain('Progress Alpha')
      expect(pageText()).toContain('Waiting Beta')

      await dom.act(async () => button('All').click())
      expect(button('All').getAttribute('aria-pressed')).toBe('true')
      expect(button('In Progress').getAttribute('aria-pressed')).toBe('false')
      expect(button('Waiting').getAttribute('aria-pressed')).toBe('false')

      await dom.act(async () => button('Tau').click())
      expect(button('All squads').getAttribute('aria-pressed')).toBe('false')
      expect(pageText()).toContain('Progress Alpha')
      expect(pageText()).not.toContain('Waiting Beta')

      await dom.act(async () => button('Beta').click())
      expect(button('Tau').getAttribute('aria-pressed')).toBe('true')
      expect(button('Beta').getAttribute('aria-pressed')).toBe('true')
      expect(pageText()).toContain('Progress Alpha')
      expect(pageText()).toContain('Waiting Beta')

      await dom.act(async () => button('All squads').click())
      expect(button('All squads').getAttribute('aria-pressed')).toBe('true')
      expect(button('Tau').getAttribute('aria-pressed')).toBe('false')
      expect(button('Beta').getAttribute('aria-pressed')).toBe('false')
    } finally {
      await dom.cleanup()
    }
  })

  test('header filter popup controls Active and Done without a separate filter row', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/feed' })
    const rendered = dom.createRoot()
    const header = dom.window.document.createElement('header')
    dom.window.document.body.append(header)
    const secondSquad = { ...squad, id: 'squad-2', name: 'Beta' }
    const queryClient = createTestQueryClient()
    const active = [
      workStream({ id: 'active-tau', title: 'Active Tau' }),
      workStream({ id: 'active-beta', title: 'Active Beta', squadId: secondSquad.id }),
    ]
    const done = [
      workStream({ id: 'done-tau', title: 'Done Tau', status: 'done' }),
      workStream({ id: 'done-beta', title: 'Done Beta', status: 'done', squadId: secondSquad.id }),
    ]

    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter initialEntries={['/feed?collapsed=0']}>
            <QueryClientProvider client={queryClient}>
              <WorkStreamList
                filterContainer={header as unknown as HTMLElement}
                workStreams={active}
                doneStreams={done}
                squadMap={new Map([squad, secondSquad].map((value) => [value.id, value]))}
                agentMap={new Map()}
                squads={[squad, secondSquad]}
              />
            </QueryClientProvider>
          </MemoryRouter>
        )
      })
      const trigger = header.querySelector('button')!
      const panel = () => header.querySelector('[aria-label="Feed filters"]')
      const button = (label: string) =>
        [...panel()!.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
      const pageText = () => dom.window.document.body.textContent ?? ''

      expect(trigger.textContent).toBe('Filters')
      expect(dom.window.document.querySelector('[aria-label="Work stream filters"]')).toBeNull()
      await dom.act(async () => trigger.click())
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(dom.window.document.activeElement).toBe(button('All'))
      expect(header.contains(dom.window.document.querySelector('[aria-label="Work stream filters"]'))).toBe(true)

      await dom.act(async () => button('Tau').click())
      expect(pageText()).toContain('Active Tau')
      expect(pageText()).toContain('Done Tau')
      expect(pageText()).not.toContain('Active Beta')
      expect(pageText()).not.toContain('Done Beta')
      expect(trigger.textContent).toBe('Filters1')

      await dom.act(async () => button('Done').click())
      expect(pageText()).not.toContain('Active Tau')
      expect(pageText()).toContain('Done Tau')
      expect(trigger.textContent).toBe('Filters2')
      await dom.act(async () =>
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      )
      expect(panel()).toBeNull()
      expect(dom.window.document.activeElement).toBe(trigger)
      expect(pageText()).toContain('Done Tau')

      await dom.act(async () => trigger.click())
      expect(button('Done').getAttribute('aria-pressed')).toBe('true')
      await dom.act(async () => button('All').click())
      await dom.act(async () => button('All squads').click())
      expect(trigger.textContent).toBe('Filters')
      for (const item of [...active, ...done]) expect(pageText()).toContain(item.title)
      await dom.act(async () =>
        dom.window.document.body.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true }))
      )
      expect(panel()).toBeNull()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await dom.cleanup()
      queryClient.clear()
    }
  })

  test('renders assigned agent metadata in a stacked mobile row and linked desktop pill', () => {
    const html = renderWorkStreamList([workStream({ assigneeAgentId: engineer.id })], {}, '/', [engineer])

    expect(html).toContain('>Engineer</a>')
    expect(html).toContain('href="/squads/squad-1/agents?agent=agent-1"')
    expect(html).toContain('bg-badge-accent-1-surface')
    expect(html).toContain('data-testid="work-stream-mobile-metadata"')
    expect(html).toContain('>Engineer</span>')
    expect(html).toContain('>In Progress</span>')
    expect(html).not.toContain('Pearl')
  })

  test('renders independent accessible activity dots for active and idle assignees', () => {
    const reviewer: Agent = {
      ...engineer,
      id: 'agent-2',
      agentTypeId: 'reviewer',
      status: 'active',
      metadata: { name: 'Gust' },
    }
    const html = renderWorkStreamList(
      [
        workStream({ id: 'idle-ws', assigneeAgentId: engineer.id }),
        workStream({ id: 'active-ws', assigneeAgentId: reviewer.id }),
      ],
      {},
      '/',
      [engineer, reviewer]
    )

    expect(html).toContain('agent=agent-1')
    expect(html).toContain('agent=agent-2')
    expect(html.match(/aria-label="Agent activity: Idle"/g)).toHaveLength(1)
    expect(html.match(/aria-label="Agent activity: Working"/g)).toHaveLength(1)
    expect(html).toContain('bg-status-neutral-solid')
    expect(html).toContain('bg-status-progress-solid')
  })

  test('renders squad badge as a link to the squad detail page', () => {
    const html = renderWorkStreamList([workStream({ id: 'squad-badge-ws', title: 'Squad badge work' })], {
      showSquadFilter: true,
      squads: [squad],
    })

    expect(html).toContain('href="/squads/squad-1"')
    expect(html).toContain('title="Open Tau squad"')
    expect(html).toContain('>Tau</a>')
  })

  test('does not render an assigned agent pill for unassigned work streams', () => {
    const html = renderWorkStreamList([workStream()], {}, '/', [engineer])

    expect(html).not.toContain('>Engineer</a>')
    expect(html).not.toContain('tab=agents')
  })

  test('renders the queued status badge and queue position for a queued stream', () => {
    const html = renderWorkStreamList([
      workStream({ id: 'queued-ws', title: 'Queued work', status: 'queued', queuePosition: 2 }),
    ])

    expect(html).toContain('Queued work')
    expect(html).toContain('>Queued</span>')
    expect(html).toContain('#2')
    expect(html).toContain('title="Queued (2)"')
  })

  test('renders a priority badge immediately left of the assignee pill', () => {
    const html = renderWorkStreamList(
      [workStream({ id: 'high-ws', title: 'High priority work', priority: 'high', assigneeAgentId: engineer.id })],
      {},
      '/',
      [engineer]
    )

    expect(html).toContain('High priority work')
    expect(html).toContain('>high</span>')
    expect(html.indexOf('>high</span>')).toBeLessThan(html.indexOf('>Engineer</a>'))
  })

  test('renders a boosted priority badge when effective priority differs from stored priority', () => {
    const html = renderWorkStreamList([
      workStream({
        id: 'boosted-ws',
        title: 'Boosted work',
        priority: 'low',
        effectivePriority: 'high',
        effectivePriorityVia: 'Ship it',
      }),
    ])

    expect(html).toContain('Boosted work')
    const boostedBadge = html.match(/<span[^>]*title="low \(effective high via Ship it\)"[^>]*>/)?.[0]
    expect(boostedBadge).toContain('bg-status-external-wait-badge-surface')
    expect(boostedBadge).not.toContain('opacity-60')
    expect(boostedBadge).not.toContain('bg-status-neutral-badge-surface')
    expect(html).toContain('>↑ high</span>')
  })

  test('renders a muted priority badge for a normal-priority stream', () => {
    const html = renderWorkStreamList([workStream({ id: 'normal-ws', title: 'Normal work', priority: 'normal' })])

    expect(html).toContain('Normal work')
    expect(html).toContain('title="normal priority"')
    expect(html).toContain('>normal</span>')
  })

  test('renders the status badge from derivedState, not stored status', () => {
    // Stored status is 'active' (admitted, holds a slot) but the derived display state is 'in_review'
    // — the badge must read the derived state. Deleting the `ws.derivedState ?? ws.status` fallback
    // and reading `ws.status` directly would render an "Active" (blue) badge instead.
    const html = renderWorkStreamList([
      workStream({ id: 'review-ws', title: 'Awaiting review', status: 'active', derivedState: 'in_review' }),
    ])

    const badge = html.match(/<span[^>]*title="In Review"[^>]*>In Review<\/span>/)?.[0]
    expect(badge).toBeDefined()
    expect(badge).toContain('bg-status-review-badge-surface')
    expect(badge).not.toContain('bg-status-progress-badge-surface')
    expect(html).not.toContain('title="Active"')
  })

  test('renders raw active fallback as explicit progress rather than placeholder styling', () => {
    const html = renderWorkStreamList([
      workStream({ id: 'raw-active', title: 'Raw active work', status: 'active', derivedState: undefined }),
    ])

    expect(html).toContain('title="Active"')
    expect(html).toContain('bg-status-progress-badge-surface')
    expect(html).toContain('text-status-progress-fg')
    expect(html).toContain('>●</span>')
    expect(html).not.toContain('title="Active">○')
    expect(html).not.toContain('bg-placeholder')
  })

  test('shows a plain queued badge with queue position when there are no open waits', () => {
    const html = renderWorkStreamList([
      workStream({ id: 'plain-queued-ws', title: 'Freshly queued', status: 'queued', queuePosition: 1 }),
    ])

    expect(html).toContain('Freshly queued')
    expect(html).toContain('#1 in queue')
    expect(html).toContain('>Queued</span>')
    expect(html).not.toContain('parked')
  })

  test('shows separate consistently capitalized status and Parked pills with a scheduling explanation', () => {
    const html = renderWorkStreamList([
      workStream({
        id: 'parked-ws',
        title: 'Parked while in review',
        status: 'queued',
        queuePosition: 4,
        openWaits: [workStreamWait({ id: 'wait-1', workStreamId: 'parked-ws', type: 'review' })],
      }),
    ])

    expect(html).toContain('Parked while in review')
    expect(html).toContain('#4 in queue')
    expect(html).toContain('>In Review</span>')
    expect(html).toContain('>Parked</span>')
    expect(html).not.toContain('in review — parked')
    expect(html).toContain('This work stream has released its squad concurrency slot.')
    expect(html).toContain('once its blockers or pause are cleared and capacity is available.')
  })

  test('parked rows use shared wait precedence rather than the order of open waits', () => {
    const html = renderWorkStreamList([
      workStream({
        status: 'queued',
        openWaits: [workStreamWait({ type: 'manual' }), workStreamWait({ id: 'review', type: 'review' })],
      }),
    ])
    expect(html).toContain('>In Review</span>')
    expect(html).toContain('>Parked</span>')
    expect(html).not.toContain('>Blocked</span>')
  })

  test('parked pause remains Paused instead of being replaced by a wait label', () => {
    const html = renderWorkStreamList([
      workStream({
        status: 'queued',
        pause: {
          id: 'pause',
          reason: 'Waiting for approval',
          pausedAt: now.toISOString(),
          parkAt: now.toISOString(),
          agentIds: [],
        },
        openWaits: [workStreamWait({ type: 'manual' })],
      }),
    ])
    expect(html).toContain('>Paused</span>')
    expect(html).toContain('>Parked</span>')
    expect(html).not.toContain('>Blocked</span>')
  })

  test.each([
    ['manual', 'Blocked'],
    ['question', 'Waiting on Answer'],
    ['dependency', 'Waiting on Dependency'],
  ] as const)('uses the same %s label before and after parking', (type, label) => {
    for (const status of ['active', 'queued'] as const) {
      const html = renderWorkStreamList([workStream({ status, openWaits: [workStreamWait({ type })] })])
      expect(html).toContain(`>${label}</span>`)
      expect(html.includes('>Parked</span>')).toBe(status === 'queued')
    }
  })
})

function renderWorkStreamDetailModal(
  workStreamValue: WorkStream,
  agents: Agent[] = [],
  metrics?: WorkStreamMetrics,
  cachedAgents: Agent[] = [],
  workStreams: WorkStream[] = []
) {
  return renderClient(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient(agents, metrics, cachedAgents)}>
        <WorkStreamDetailModal
          workStream={workStreamValue}
          squadMap={new Map([[squad.id, squad]])}
          agentMap={new Map(agents.map((agent) => [agent.id, agent]))}
          workStreamMap={new Map(workStreams.map((stream) => [stream.id, stream]))}
          onSelectWorkStream={() => undefined}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

// Canonical tracked-resource metadata shapes used by the inline PR link tests.
const trackedDeliveryPullRequest = (number: number, overrides: Record<string, unknown> = {}) => ({
  integration: 'github',
  repository: 'example/product',
  kind: 'pull_request',
  number,
  delivery: true,
  ...overrides,
})

describe('WorkStreamList inline pull request links', () => {
  test('feed rows link every tracked delivery pull request in order', () => {
    const html = renderWorkStreamList(
      [workStream({ metadata: { tracked: [trackedDeliveryPullRequest(31), trackedDeliveryPullRequest(32)] } })],
      { feedLayout: true, hideFilters: true }
    )
    expect(html.indexOf('href="https://github.com/example/product/pull/31"')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('href="https://github.com/example/product/pull/32"')).toBeGreaterThanOrEqual(0)
    // Primary-first order: the first delivery PR renders before the second.
    expect(html.indexOf('pull/31')).toBeLessThan(html.indexOf('pull/32'))
    expect(html).toContain('aria-label="Open PR #31"')
    expect(html).toContain('aria-label="Open PR #32"')
  })

  test('standard rows badge every delivery pull request, codeHost-bound first', () => {
    const html = renderWorkStreamList([
      workStream({
        metadata: {
          codeHost: { integration: 'github', repository: 'example/product', changeRequest: { number: 5 } },
          tracked: [trackedDeliveryPullRequest(6)],
        },
      }),
    ])
    expect(html.indexOf('href="https://github.com/example/product/pull/5"')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('href="https://github.com/example/product/pull/6"')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('pull/5"')).toBeLessThan(html.indexOf('pull/6"'))
    expect(html).toContain('title="Open PR #5"')
    expect(html).toContain('title="Open PR #6"')
  })

  test('standard rows link tracked delivery pull requests without a codeHost change request', () => {
    const html = renderWorkStreamList([
      workStream({
        metadata: {
          codeHost: { integration: 'github', repository: 'example/product' },
          tracked: [trackedDeliveryPullRequest(9)],
        },
      }),
    ])
    expect(html).toContain('href="https://github.com/example/product/pull/9"')
  })

  test('tracked issues and non-delivery pull requests render no PR link', () => {
    const html = renderWorkStreamList(
      [
        workStream({
          metadata: {
            tracked: [
              { integration: 'github', repository: 'example/product', kind: 'issue', number: 11 },
              { integration: 'github', repository: 'example/product', kind: 'pull_request', number: 12 },
            ],
          },
        }),
      ],
      { feedLayout: true, hideFilters: true }
    )
    expect(html).not.toContain('pull/11')
    expect(html).not.toContain('issues/11')
    expect(html).not.toContain('pull/12')
  })

  test('legacy metadata.github alone renders no PR link', () => {
    const standard = renderWorkStreamList([
      workStream({ metadata: { github: { repo: 'example/product', pr: { number: 123 } } } }),
    ])
    expect(standard).not.toContain('pull/123')
    const feed = renderWorkStreamList(
      [workStream({ metadata: { github: { repo: 'example/product', pr: { number: 123 } } } })],
      { feedLayout: true, hideFilters: true }
    )
    expect(feed).not.toContain('pull/123')
    expect(feed).not.toContain('aria-label="Open PR #123"')
  })
})

describe('squad WorkStreamList canonical ordering', () => {
  // Pre-sorted to mirror the server contract (GET /workstreams); the
  // component must render that order as-is.
  const ordered = [
    workStream({ id: 'review-home', title: 'Squad Review', derivedState: 'in_review' }),
    workStream({ id: 'wait-home', title: 'Squad Wait', derivedState: 'blocked' }),
    workStream({ id: 'progress-home', title: 'Squad Progress', derivedState: 'in_progress' }),
    workStream({ id: 'idle-home', title: 'Squad Idle', derivedState: 'idle' }),
    workStream({ id: 'queue-1-home', title: 'Squad Queue One', status: 'queued', queuePosition: 1 }),
    workStream({ id: 'queue-2-home', title: 'Squad Queue Two', status: 'queued', queuePosition: 2 }),
  ]

  test('renders the compact squad home list in the server canonical order', async () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.squads.agents(squad.id), [])
    const html = await renderClient(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SquadWorkStreamList workStreams={ordered} squadId={squad.id} squad={squad} activeOnly compact />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const indices = [
      'Squad Review',
      'Squad Wait',
      'Squad Progress',
      'Squad Idle',
      'Squad Queue One',
      'Squad Queue Two',
    ].map((title) => html.indexOf(title))
    expect(indices.every((index) => index >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test('keeps canonical queue order inside the squad Work kanban column', async () => {
    const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}/work` })
    dom.window.localStorage.setItem(`ficus.wsView.${squad.id}`, 'kanban')
    const rendered = dom.createRoot()
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.squads.agents(squad.id), [])
    try {
      await dom.act(async () =>
        rendered.root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <SquadWorkStreamList workStreams={ordered} squadId={squad.id} squad={squad} />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      const html = dom.window.document.body.innerHTML
      expect(html.indexOf('Squad Queue One')).toBeLessThan(html.indexOf('Squad Queue Two'))
    } finally {
      await dom.cleanup()
    }
  })
})

describe('squad WorkStreamList dependency navigation', () => {
  for (const { status, title } of [
    { status: 'done', title: 'Completed dependency' },
    { status: 'canceled', title: 'Canceled dependency' },
  ] as const) {
    test(`hydrates and opens a ${status} dependency absent from the active list`, async () => {
      const parent = workStream({
        id: `active-parent-${status}`,
        title: 'Active parent',
        dependsOn: [`${status}-dependency`],
      })
      const terminalDependency = workStream({ id: `${status}-dependency`, title, status })
      const queryClient = createTestQueryClient()
      queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
      queryClient.setQueryData(queryKeys.squads.agents(squad.id), [])
      queryClient.setQueryData(queryKeys.squads.list(), [squad])
      queryClient.setQueryDefaults(queryKeys.workflows.all, { queryFn: async () => null, staleTime: Infinity })
      queryClient.setQueryData(queryKeys.workflows.run(parent.id), null)
      queryClient.setQueryData(queryKeys.workflows.run(terminalDependency.id), null)
      queryClient.setQueryData(queryKeys.squads.workStreamMetrics(parent.id), null)
      queryClient.setQueryData(queryKeys.squads.workStreamMetrics(terminalDependency.id), null)
      queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: [] })
      queryClient.setQueryData(queryKeys.workStreamSubscription.detail(parent.id), { subscribed: false, count: 0 })
      const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}?ws=${parent.id}` })
      const rendered = dom.createRoot()
      const originalFetch = globalThis.fetch
      const fetchCalls: string[] = []
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = String(input)
        fetchCalls.push(url)
        if (url.endsWith(`/api/workstreams/${parent.id}`)) {
          return new dom.window.Response(JSON.stringify(parent), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as unknown as Response
        }
        if (url.endsWith(`/api/workstreams/${terminalDependency.id}`)) {
          return new dom.window.Response(JSON.stringify(terminalDependency), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as unknown as Response
        }
        return new dom.window.Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response
      }) as unknown as typeof fetch
      try {
        await dom.act(async () =>
          rendered.root.render(
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={[`/squads/${squad.id}?ws=${parent.id}`]}>
                <SquadWorkStreamList workStreams={[parent]} squadId={squad.id} squad={squad} activeOnly compact />
              </MemoryRouter>
            </QueryClientProvider>
          )
        )
        await dom.act(async () => Bun.sleep(20))
        expect(fetchCalls.filter((url) => url.endsWith(`/api/workstreams/${terminalDependency.id}`))).toHaveLength(1)
        const dependencyButton = dom.window.document.querySelector<HTMLButtonElement>(
          `[aria-label="Open dependency ${title}"]`
        )
        expect(dependencyButton).not.toBeNull()
        await dom.act(async () => dependencyButton!.click())
        await dom.act(async () => Bun.sleep(10))
        const modalTitles = [...dom.window.document.querySelectorAll('h3')].map((heading) => heading.textContent)
        expect(modalTitles).toContain(title)
        expect(modalTitles).not.toContain('Active parent')
      } finally {
        globalThis.fetch = originalFetch
        await dom.cleanup()
      }
    }, 10_000)
  }
})

describe('WorkStreamDetailModal', async () => {
  test('detail status agrees with the list for a parked blocked stream', async () => {
    const html = await renderWorkStreamDetailModal(
      workStream({
        status: 'queued',
        openWaits: [workStreamWait({ type: 'manual' })],
      })
    )
    expect(html).toContain('>Blocked</span>')
    expect(html).toContain('>Parked</span>')
    expect(html).toContain('once its blockers or pause are cleared and capacity is available.')
  })

  test('shows an exact queue position in queued status and omits it otherwise', async () => {
    const queuedHtml = await renderWorkStreamDetailModal(workStream({ status: 'queued', queuePosition: 3 }))
    const pendingHtml = await renderWorkStreamDetailModal(
      workStream({ status: 'active', derivedState: 'in_progress', queuePosition: 3 })
    )

    expect(queuedHtml).toContain('Queued — position 3')
    expect(pendingHtml).not.toContain('position 3')
  })

  test('shows the stored and boosted effective priority', async () => {
    const html = await renderWorkStreamDetailModal(
      workStream({
        priority: 'low',
        effectivePriority: 'critical',
        effectivePriorityVia: 'Urgent dependent',
      })
    )

    expect(html).toContain('>Priority</label>')
    expect(html).toContain('low')
    expect(html).toContain('effective critical via Urgent dependent')
  })

  test('keeps the ID prefix and unknown status when a dependency cannot be resolved', async () => {
    const html = await renderWorkStreamDetailModal(workStream({ dependsOn: ['missing-dependency-record'] }))

    expect(html).toContain('aria-label="Open dependency missing-"')
    expect(html).toContain('aria-label="Unknown status"')
    expect(html).toContain('>missing-</button>')
  })

  test('renders dependencies from their selected display state', async () => {
    const blocker = workStream({
      id: 'blocker-id',
      title: 'Blocking stream',
      status: 'active',
      derivedState: 'blocked',
    })
    const html = await renderWorkStreamDetailModal(
      workStream({ dependsOn: [blocker.id] }),
      [],
      undefined,
      [],
      [blocker]
    )

    expect(html).toContain('aria-label="Open dependency Blocking stream"')
    expect(html).toContain('aria-label="Blocked status"')
    expect(html).toContain('bg-status-danger-solid')
    expect(html).not.toContain('aria-label="Active status"')
    expect(html).toContain('>Blocking stream</button>')
  })

  test('headline elapsed shows agent runtime, not wall-clock', async () => {
    const oldCreated = new Date(now.getTime() - 60 * 60 * 1000)
    const ws = workStream({
      status: 'active',
      derivedState: 'in_progress',
      createdAt: oldCreated,
      updatedAt: oldCreated,
      runtime: { totalMs: 45_000, activeCount: 0, computedAt: oldCreated.toISOString() },
    })
    const html = await renderWorkStreamDetailModal(ws)
    expect(html).toContain('>Runtime</label>')
    expect(html).toContain('>45s</p>')
    expect(html).not.toContain('>1h<')
  })

  test('headline elapsed reads "Runtime" even for done work streams', async () => {
    const ws = workStream({
      status: 'done',
      runtime: { totalMs: 3_000, activeCount: 0, computedAt: now.toISOString() },
    })
    const html = await renderWorkStreamDetailModal(ws)
    expect(html).toContain('>Runtime</label>')
    expect(html).toContain('>3s</p>')
  })

  test('links assigned terminated agents resolved from agent detail cache', async () => {
    const terminatedEngineer: Agent = {
      ...engineer,
      id: 'terminated-agent-1',
      status: 'terminated',
      terminatedAt: now,
      metadata: { name: 'Cypress' },
    }

    const html = await renderWorkStreamDetailModal(
      workStream({ status: 'done', agentIds: [terminatedEngineer.id], assigneeAgentId: terminatedEngineer.id }),
      [],
      undefined,
      [terminatedEngineer]
    )

    expect(html).toContain('Cypress')
    expect(html).toContain('href="/squads/squad-1?agent=terminated-agent-1"')
    expect(html).not.toContain('>terminat</span>')
  })

  test('renders next steps from metadata in the detail modal', async () => {
    const html = await renderWorkStreamDetailModal(
      workStream({ metadata: { nextSteps: 'Open a follow-up work stream for rollout docs.' } })
    )

    expect(html).toContain('Next Steps')
    expect(html).toContain('Open a follow-up work stream for rollout docs.')
    expect(html).not.toContain('nextSteps')
  })

  test('renders completion mode, branch, and base branch in the detail metadata section', async () => {
    const html = await renderWorkStreamDetailModal(
      workStream({ completionMode: 'review-approval', branch: 'feat/x', baseBranch: 'feature/base' })
    )

    expect(html).toContain('Completion')
    expect(html).toContain('review-approval')
    expect(html).toContain('Branch')
    expect(html).toContain('feat/x')
    expect(html).toContain('Base Branch')
    expect(html).toContain('feature/base')
  })

  test('renders pr-auto-merge completion mode with a readable label', async () => {
    const html = await renderWorkStreamDetailModal(workStream({ completionMode: 'pr-auto-merge' }))

    expect(html).toContain('Completion')
    expect(html).toContain('PR (auto-merge)')
  })

  test('renders completion mode badge even when branch and base branch are unset', async () => {
    const html = await renderWorkStreamDetailModal(workStream())

    expect(html).toContain('Completion')
    expect(html).toContain('pr-merge')
    expect(html).not.toContain('Base Branch')
  })

  test('shows cache token categories when they contribute to the token total', async () => {
    const html = await renderWorkStreamDetailModal(workStream(), [], {
      tokens: { input: 18, output: 5700, cacheRead: 364082, cacheWrite: 0, total: 369800 },
      cost: 1.23,
      executions: { total: 2, completed: 2, failed: 0 },
      duration: { totalMs: 0, firstStartedAt: null, lastEndedAt: null },
      byAgent: {},
    })

    expect(html).toContain('Tokens:')
    expect(html).toContain('369.8K')
    expect(html).toContain('in: 18')
    expect(html).toContain('out: 5.7K')
    expect(html).toContain('cache read: 364.1K')
  })

  test('response controls use theme-aware readable input styles', async () => {
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('text-primary')
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('placeholder:text-placeholder')
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('caret-accent')
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('bg-surface')
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('border-th-border')
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('focus:ring-accent')
    expect(WORKSTREAM_RESPONSE_CONTROL_CLASS).toContain('focus:border-accent')
  })

  test('renders open waits with opened timestamps and a review round, plus closed review history', async () => {
    const openedAt = new Date('2026-01-05T09:30:00Z')
    const closedAt = new Date('2026-01-03T09:30:00Z')
    const html = await renderWorkStreamDetailModal(
      workStream({
        status: 'active',
        derivedState: 'in_review',
        reviewRounds: 1,
        openWaits: [
          workStreamWait({
            id: 'wait-open',
            type: 'review',
            message: 'Please check the diff',
            openedAt: openedAt.toISOString(),
          }),
        ],
        waitHistory: [
          workStreamWait({
            id: 'wait-closed',
            type: 'review',
            message: 'First pass',
            openedAt: closedAt.toISOString(),
            closedAt: closedAt.toISOString(),
            resolution: 'sent_back',
            resolutionNote: 'Needs more tests',
          }),
        ],
      })
    )

    // The respond panel is the single home for the review wait: message once,
    // round + timestamp carried by the panel header, and no redundant Open
    // Waits section when the panel consumed the only wait.
    expect(html.split('Please check the diff').length - 1).toBe(1)
    expect(html).not.toContain('Open Waits')
    expect(html).toContain(openedAt.toLocaleString())
    expect(html).toContain('Round 2')
    expect(html).toContain('Wait history')
    expect(html).toContain('Sent back')
    expect(html).toContain('Needs more tests')
    expect(html).toContain(closedAt.toLocaleString())
  })

  test('shows review and question waits once in their dedicated sections', async () => {
    const html = await renderWorkStreamDetailModal(
      workStream({
        status: 'active',
        derivedState: 'in_review',
        openWaits: [
          workStreamWait({
            id: 'wait-review',
            type: 'review',
            message: 'Panel-owned review message',
            openedAt: new Date('2026-01-05T09:30:00Z').toISOString(),
          }),
          workStreamWait({
            id: 'wait-question',
            type: 'question',
            message: 'Which region should we deploy to?',
            openedAt: new Date('2026-01-05T10:30:00Z').toISOString(),
          }),
        ],
      })
    )

    expect(html.split('Panel-owned review message').length - 1).toBe(1)
    expect(html).not.toContain('Open Waits')
    expect(html).toContain('Pending Questions')
    expect(html.split('Which region should we deploy to?').length - 1).toBe(1)
  })

  test('omits the review history section when no review round has closed yet', async () => {
    const html = await renderWorkStreamDetailModal(
      workStream({
        status: 'active',
        derivedState: 'in_review',
        reviewRounds: 0,
        openWaits: [workStreamWait({ id: 'wait-open', type: 'review', message: 'First look' })],
      })
    )

    // Panel consumed the only wait: message once, no redundant list.
    expect(html.split('First look').length - 1).toBe(1)
    expect(html).not.toContain('Open Waits')
    expect(html).not.toContain('Wait history')
  })

  test('surfaces a closed MANUAL wait in the audit history with its resolution note', async () => {
    // The gap this feature closes: a resolved manual wait used to be invisible
    // in the UI. It must now appear in the wait-history audit trail.
    const closedAt = new Date('2026-02-01T12:00:00Z')
    const html = await renderWorkStreamDetailModal(
      workStream({
        status: 'active',
        openWaits: [],
        waitHistory: [
          workStreamWait({
            id: 'wait-manual-closed',
            type: 'manual',
            message: 'need a decision',
            openedAt: closedAt.toISOString(),
            closedAt: closedAt.toISOString(),
            resolution: 'cleared',
            resolutionNote: 'use the compliant alternative',
          }),
        ],
      })
    )

    expect(html).toContain('Wait history')
    expect(html).toContain('Manual')
    expect(html).toContain('Cleared')
    expect(html).toContain('use the compliant alternative')
  })
})

describe('WorkStreamDetailModal respond flows', () => {
  function renderRespondModal(workStreamValue: WorkStream) {
    // staleTime: Infinity so the seeded caches below aren't immediately refetched on mount — a
    // refetch would hit the blanket fetch mock installed for the respond-mutation assertion and
    // clobber e.g. the squads list with its generic `{}` response.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } },
    })
    queryClient.setQueryData(queryKeys.workflows.run(workStreamValue.id), null)
    queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['workstreams:update'] })
    queryClient.setQueryData(queryKeys.squads.list(), [squad])
    queryClient.setQueryData(queryKeys.squads.workStreamMetrics(workStreamValue.id), null)
    queryClient.setQueryData(queryKeys.workStreamSubscription.detail(workStreamValue.id), {
      subscribed: false,
      count: 0,
    })
    return { queryClient }
  }

  async function withMockedFetch<T>(
    dom: Awaited<ReturnType<typeof acquireDomHarness>>,
    stream: WorkStream,
    run: (fetchCalls: Array<{ url: string; method?: string; body?: string }>) => Promise<T>
  ): Promise<T> {
    const fetchCalls: Array<{ url: string; method?: string; body?: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
      return new dom.window.Response(
        JSON.stringify(String(input).endsWith(`/api/workstreams/${stream.id}`) ? stream : {}),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      ) as unknown as Response
    }) as unknown as typeof fetch
    try {
      return await run(fetchCalls)
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  test('a completing review wait requires explicit approval confirmation before responding', async () => {
    const ws = workStream({
      status: 'active',
      derivedState: 'in_review',
      openWaits: [
        workStreamWait({
          id: 'wait-review',
          type: 'review',
          message: 'Please review',
          completesOnApproval: true,
        }),
      ],
    })
    const { queryClient } = renderRespondModal(ws)
    const dom = await acquireDomHarness({ url: 'http://localhost/work-streams/ws-1' })
    const rendered = dom.createRoot()
    try {
      await withMockedFetch(dom, ws, async (fetchCalls) => {
        await dom.act(async () =>
          rendered.root.render(
            <MemoryRouter>
              <QueryClientProvider client={queryClient}>
                <WorkStreamDetailModal
                  workStream={ws}
                  squadMap={new Map([[squad.id, squad]])}
                  agentMap={new Map()}
                  onClose={() => undefined}
                />
              </QueryClientProvider>
            </MemoryRouter>
          )
        )
        await dom.act(async () => Bun.sleep(10))

        expect(dom.window.document.body.textContent).toContain('Please review')
        const buttons = [...dom.window.document.querySelectorAll('button')]
        const approveButton = buttons.find((button) => button.textContent === 'Approve and complete')
        expect(approveButton).toBeDefined()

        await dom.act(async () => approveButton!.click())
        expect(
          fetchCalls.filter((call) => call.url.includes('/workstreams/ws-1/waits/wait-review/resolve'))
        ).toHaveLength(0)

        const firstDialog = dom.window.document.querySelector(
          '[role="dialog"][aria-label="Approve and complete work stream?"]'
        )
        expect(firstDialog?.textContent).toContain(
          'Approving completes this work stream even if its pull request has not merged'
        )
        const cancelButton = [...(firstDialog?.querySelectorAll('button') ?? [])].find(
          (button) => button.textContent === 'Cancel'
        )
        await dom.act(async () => cancelButton?.click())
        expect(
          fetchCalls.filter((call) => call.url.includes('/workstreams/ws-1/waits/wait-review/resolve'))
        ).toHaveLength(0)

        await dom.act(async () => approveButton!.click())
        const secondDialog = dom.window.document.querySelector(
          '[role="dialog"][aria-label="Approve and complete work stream?"]'
        )
        const confirmButton = [...(secondDialog?.querySelectorAll('button') ?? [])].find(
          (button) => button.textContent === 'Approve and complete'
        )
        await dom.act(async () => {
          confirmButton?.click()
          confirmButton?.click()
        })
        await dom.act(async () => Bun.sleep(10))

        const resolveCalls = fetchCalls.filter((call) =>
          call.url.includes('/workstreams/ws-1/waits/wait-review/resolve')
        )
        expect(resolveCalls).toHaveLength(1)
        expect(resolveCalls[0]!.method).toBe('POST')
        expect(JSON.parse(resolveCalls[0]!.body!)).toEqual({ resolution: 'approved' })
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('a manual wait shows a free-text respond box wired to the typed wait resolve endpoint', async () => {
    const ws = workStream({
      status: 'active',
      derivedState: 'blocked',
      openWaits: [workStreamWait({ id: 'wait-manual', type: 'manual', message: 'Need SSH access to prod' })],
    })
    const { queryClient } = renderRespondModal(ws)
    const fetchCalls: Array<{ url: string; body?: string }> = []
    const dom = await acquireDomHarness({
      url: 'http://localhost/work-streams/ws-1',
      configureWindow(window) {
        Object.assign(window, {
          SyntaxError,
          fetch: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ url: String(input), body: init?.body as string | undefined })
            return new window.Response(JSON.stringify(String(input).endsWith(`/api/workstreams/${ws.id}`) ? ws : {}), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }),
        })
      },
    })
    const { window } = dom
    const { root } = dom.createRoot()
    try {
      await dom.act(async () =>
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <WorkStreamDetailModal
                workStream={ws}
                squadMap={new Map([[squad.id, squad]])}
                agentMap={new Map()}
                onClose={() => undefined}
              />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(document.body.textContent).toContain('Need SSH access to prod')
      const respondButton = [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'Respond'
      )
      expect(respondButton).toBeDefined()
      await dom.act(async () => respondButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
      const input = document.body.querySelector<HTMLInputElement>('input[type="text"]')
      expect(input).not.toBeNull()
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      expect(nativeSetter).toBeDefined()
      await dom.act(async () => {
        nativeSetter!.call(input, 'Ship it')
        input!.dispatchEvent(
          new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Ship it' })
        )
      })
      const submitButton = [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'Submit'
      )
      expect(submitButton).toBeDefined()
      await dom.act(async () => submitButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
      const resolveCall = fetchCalls.find((call) => call.url.includes('/workstreams/ws-1/waits/wait-manual/resolve'))
      expect(resolveCall).toBeDefined()
      expect(JSON.parse(resolveCall!.body!)).toEqual({ resolution: 'cleared', note: 'Ship it' })
    } finally {
      await queryClient.cancelQueries()
      queryClient.clear()
      await dom.act(async () => root.unmount())
      await dom.cleanup()
    }
  })
})
