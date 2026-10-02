import { waitFor } from '@testing-library/dom'
import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { GlobalSquadActivityItem, NormalizedSquadActivityFilters, Squad } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { acquireDomHarness } from '../test/domHarness'
import { ActivityPage } from './ActivityPage'
import { WebSocketContext } from '../hooks/useWebSocket'

/** A socket that records subscriptions, so a test can push a squad's activity event. */
const listeners = new Map<string, (message: { event: string; data: unknown }) => void>()
const socket = {
  isConnected: true,
  subscribe: (topic: string, callback: (message: { event: string; data: unknown }) => void) => {
    listeners.set(topic, callback)
    return () => listeners.delete(topic)
  },
} as never

const squadAId = '00000000-0000-4000-8000-00000000000a'
const squadBId = '00000000-0000-4000-8000-00000000000b'
const agentId = '00000000-0000-4000-8000-000000000002'
const filters: NormalizedSquadActivityFilters = { verbose: false, agentIds: [], kinds: [] }
const longSquadName = 'Squad With An Exceptionally Long Name That Must Ellipsize Independently'

function squad(id: string, name: string, createdAt: string): Squad {
  return {
    id,
    name,
    purpose: 'test',
    status: 'active',
    squadPresetId: null,
    defaultAgents: [],
    managerAgentId: null,
    context: null,
    typeContext: null,
    isAnonymous: false,
    globalCollaborationEnabled: false,
    order: 0,
    metadata: {},
    maxConcurrentWorkStreams: null,
    blockedGraceMinutes: null,
    sandboxStatus: 'none',
    avatarImageId: null,
    machineId: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    archivedAt: null,
  } as Squad
}

const workItem: GlobalSquadActivityItem = {
  id: '30:00000000-0000-4000-8000-000000000030',
  at: '2026-08-27T12:00:00.000Z',
  agentId: null,
  agentTypeId: null,
  kind: 'workstream',
  preview: [{ text: '[ws-abcd created] Cross-squad work' }],
  summary: '[ws-abcd created] Cross-squad work',
  ref: { type: 'workstream', workStreamId: '00000000-0000-4000-8000-000000000010' },
  squadId: squadAId,
}
const messageItem: GlobalSquadActivityItem = {
  id: '20:00000000-0000-4000-8000-000000000020',
  at: '2026-08-27T11:59:00.000Z',
  agentId,
  agentTypeId: 'engineer',
  kind: 'message',
  preview: [{ text: 'Implementation ready' }],
  summary: 'Implementation ready',
  ref: { type: 'agent', agentId, view: 'inbox', messageId: '00000000-0000-4000-8000-000000000020' },
  squadId: squadBId,
}
// A tracked GitHub issue: the row opens the code host, while the work-stream
// chip stays in-app and resolves the row's OWN squad slug.
const issueItem: GlobalSquadActivityItem = {
  id: '71:00000000-0000-4000-8000-000000000071',
  at: '2026-08-27T11:58:00.000Z',
  agentId: null,
  agentTypeId: null,
  kind: 'issue',
  preview: [{ text: 'Flaky login' }],
  summary: 'Flaky login',
  ref: {
    type: 'issue',
    url: 'https://example.test/issues/12',
    workStreamId: '00000000-0000-4000-8000-000000000010',
    workStreamNumber: 12,
  },
  squadId: squadAId,
}

function seedClient(
  items: GlobalSquadActivityItem[],
  hasMore = false,
  squadNames: Record<string, { name: string }> = {
    [squadAId]: { name: 'Squad Alpha' },
    [squadBId]: { name: 'Squad Bravo' },
  }
) {
  // staleTime: Infinity — the DOM-harness tests fire a mount-time background refetch through a
  // generic mock fetch that doesn't understand every query on the page (squads.list, agents.detail);
  // seeded cache data must survive untouched for the assertions below.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.activity.globalInfinite(filters), {
    pages: [
      {
        items,
        hasMore,
        nextCursor: hasMore ? 'next' : null,
        squads: squadNames,
      },
    ],
    pageParams: [null],
  })
  client.setQueryData(queryKeys.activity.presence(), {
    workingAgentIds: [agentId],
    workingCount: 1,
    needsYouCount: 2,
    streamCount: 3,
  })
  client.setQueryData(queryKeys.squads.list(), [
    squad(squadAId, 'Squad Alpha', '2026-01-01T00:00:00Z'),
    squad(squadBId, 'Squad Bravo', '2026-01-02T00:00:00Z'),
  ])
  return client
}

function staticRender(
  items: GlobalSquadActivityItem[],
  hasMore = false,
  squadNames?: Record<string, { name: string }>
) {
  const client = seedClient(items, hasMore, squadNames)
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <WebSocketContext.Provider value={socket}>
          <ActivityPage />
        </WebSocketContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('ActivityPage rendering', () => {
  test('renders empty state with no rows', () => {
    expect(staticRender([])).toContain('No activity matches these filters')
  })

  test('renders rows with a squad-name chip, and the shared filter toolbar', () => {
    const html = staticRender([workItem, messageItem], true)
    expect(html).toContain('Cross-squad work')
    expect(html).toContain('Implementation ready')
    expect(html).toContain('Squad Alpha')
    expect(html).toContain('Squad Bravo')
    // Shared filter toolbar (same FILTER_GROUPS as the per-squad tab).
    expect(html).toContain('>All<')
    expect(html).toContain('>Messages<')
    expect(html).toContain('>Work<')
    expect(html).toContain('>Subagents<')
    expect(html).toContain('>GitHub<')
    expect(html).toContain('data-testid="activity-presence"')
    expect(html).toContain('1 working')
    expect(html).toContain('2 waiting on you')
    expect(html).toContain('3 active streams')
    expect(html).toContain('title="Working now"')
  })

  test('row hrefs route into the OWNING squad, not a fixed one', () => {
    const html = staticRender([workItem, messageItem])
    expect(html).toContain('/squads/squad-alpha/work?ws=00000000-0000-4000-8000-000000000010')
    expect(html).toContain('/squads/squad-bravo?agent=00000000-0000-4000-8000-000000000002&amp;view=inbox')
  })

  test('keeps a long squad name in an accessible column separate from the agent on mobile and desktop', () => {
    const html = staticRender([messageItem], false, {
      [squadAId]: { name: 'Squad Alpha' },
      [squadBId]: { name: longSquadName },
    })
    const squadColumn = html.indexOf('data-activity-column="squad"')
    const agentColumn = html.indexOf('data-activity-column="agent"')
    const summaryColumn = html.indexOf('data-activity-column="summary"')

    expect(html).toContain('data-activity-layout="global"')
    expect(html).toContain('data-activity-mobile-header="global"')
    expect(html).toContain('grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto]')
    expect(html).toContain('col-start-3 row-start-1')
    expect(html).toContain('col-start-1 row-start-1 justify-self-start text-left lg:col-start-3')
    expect(html).toContain('col-start-2 row-start-1 min-w-0 max-w-full self-start justify-self-end')
    expect(html).toContain('lg:col-start-2 lg:justify-self-start lg:text-left')
    expect(html).toContain('lg:grid-cols-[4rem_minmax(5rem,8rem)_8rem_minmax(0,1fr)]')
    expect(html).not.toContain('md:grid-cols-[4rem_minmax(5rem,8rem)_8rem_minmax(0,1fr)]')
    expect(squadColumn).toBeGreaterThan(-1)
    expect(agentColumn).toBeGreaterThan(squadColumn)
    expect(summaryColumn).toBeGreaterThan(agentColumn)
    expect(html).toContain(`aria-label="Open activity for ${longSquadName}"`)
    expect(html).toContain(`title="${longSquadName}"`)
    expect(html).toContain(`>${longSquadName}</span>`)
  })

  test('the squad chip hugs the top-left of its cell instead of stretching to a multi-line row', () => {
    const html = staticRender([messageItem])
    const squadColumn = html.indexOf('data-activity-column="squad"')
    const chip = html.slice(html.lastIndexOf('<button', squadColumn), squadColumn)
    expect(chip).toContain('self-start')
    expect(chip).toContain('justify-self-start')
  })

  test('renders an issue row as an external code-host link with an in-app work-stream chip', () => {
    const html = staticRender([issueItem])
    expect(html).toContain('href="https://example.test/issues/12"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('Flaky login')
    expect(html).toContain('aria-label="Open work stream #12"')
    expect(html).toContain('#12</button>')
  })
})

describe('ActivityPage kind filtering', () => {
  test('keeps current rows visible and pulses the filters until the server-filtered rows arrive', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = seedClient([workItem])
    const originalFetch = globalThis.fetch
    let finishActivityRequest: (() => void) | undefined
    globalThis.fetch = mock(async (input) => {
      if (String(input).includes('/activity?')) {
        return new Promise<Response>((resolve) => {
          finishActivityRequest = () =>
            resolve(
              new dom.window.Response(
                JSON.stringify({
                  items: [messageItem],
                  hasMore: false,
                  nextCursor: null,
                  squads: { [squadBId]: { name: 'Squad Bravo' } },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              ) as unknown as Response
            )
        })
      }
      return new dom.window.Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch

    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <ActivityPage />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
      })
      const filters = dom.window.document.querySelector('[aria-label="Activity kind filters"]')!
      const button = (label: string) =>
        [...filters.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!

      expect(button('All').getAttribute('aria-pressed')).toBe('true')
      await dom.act(async () => {
        button('Messages').click()
        await Bun.sleep(0)
      })

      expect(finishActivityRequest).toBeDefined()
      expect(filters.getAttribute('aria-busy')).toBe('true')
      expect(filters.className).toContain('animate-pulse')
      expect(dom.window.document.body.textContent).toContain('Cross-squad work')
      expect(button('All').getAttribute('aria-pressed')).toBe('false')
      expect(button('Messages').getAttribute('aria-pressed')).toBe('true')

      await dom.act(async () => {
        finishActivityRequest?.()
      })
      await dom.act(async () => {
        await waitFor(() => expect(filters.getAttribute('aria-busy')).toBe('false'))
      })
      expect(filters.getAttribute('aria-busy')).toBe('false')
      expect(filters.className).not.toContain('animate-pulse')
      expect(dom.window.document.body.textContent).not.toContain('Cross-squad work')
      expect(dom.window.document.body.textContent).toContain('Implementation ready')

      await dom.act(async () => button('All').click())
      expect(button('All').getAttribute('aria-pressed')).toBe('true')
      expect(button('Messages').getAttribute('aria-pressed')).toBe('false')
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('ActivityPage squad chip', () => {
  test("clicking the chip navigates to that squad's Activity tab and does NOT open the row modal", async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = seedClient([workItem])
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new dom.window.Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    function Harness() {
      const location = useLocation()
      return (
        <>
          <span data-testid="current-path">{location.pathname}</span>
          <ActivityPage
            dependencies={{
              WorkStreamViewModalComponent: (() => <p>workstream-modal-opened</p>) as never,
            }}
          />
        </>
      )
    }
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter initialEntries={['/activity']}>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <Harness />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const chip = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Squad Alpha')!
      expect(chip).toBeDefined()
      await dom.act(async () => {
        chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      expect(dom.window.document.querySelector('[data-testid="current-path"]')?.textContent).toBe(
        '/squads/squad-alpha/activity'
      )
      expect(dom.window.document.body.textContent).not.toContain('workstream-modal-opened')
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('ActivityPage issue rows', () => {
  test('the work-stream chip navigates in-app instead of following the code-host link', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = seedClient([issueItem])
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new dom.window.Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    function Harness() {
      const location = useLocation()
      return (
        <>
          <span data-testid="current-path">
            {location.pathname}
            {location.search}
          </span>
          <ActivityPage />
        </>
      )
    }
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter initialEntries={['/activity']}>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <Harness />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const row = [...dom.window.document.querySelectorAll('a')].find(
        (candidate) => candidate.getAttribute('href') === 'https://example.test/issues/12'
      )
      expect(row).toBeDefined()
      expect(row!.getAttribute('target')).toBe('_blank')
      expect(row!.getAttribute('rel')).toBe('noopener noreferrer')
      const chip = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Open work stream #12"]')!
      expect(chip).toBeDefined()
      await dom.act(async () => {
        chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      expect(dom.window.document.querySelector('[data-testid="current-path"]')?.textContent).toBe(
        '/squads/squad-alpha/work?ws=12'
      )
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('ActivityPage in-place modals', () => {
  test('a plain click routes each row to its OWN squad (not a fixed one); agent rows fetch the agent then open AgentViewModal', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = seedClient([workItem, messageItem])
    client.setQueryData(queryKeys.agents.detail(agentId), {
      id: agentId,
      agentTypeId: 'engineer',
      squadId: squadBId,
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new dom.window.Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <ActivityPage
                  dependencies={{
                    WorkStreamViewModalComponent: (({
                      workStreamId,
                      squadId,
                    }: {
                      workStreamId: string
                      squadId: string
                    }) => (
                      <p>
                        workstream-modal:{workStreamId}:{squadId}
                      </p>
                    )) as never,
                    AgentConversationComponent: ((props: { agentId: string; focusInboxMessageId?: string }) => (
                      <p>
                        conversation-stub:{props.agentId}:{props.focusInboxMessageId}
                      </p>
                    )) as never,
                    AgentViewModalComponent: ((props: { agent: { id: string }; squadId: string }) => (
                      <p>
                        agent-view-modal:{props.agent.id}:{props.squadId}
                      </p>
                    )) as never,
                  }}
                />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const wsRow = [...dom.window.document.querySelectorAll('a')].find((a) =>
        a.getAttribute('aria-label')?.includes('Cross-squad work')
      )!
      expect(wsRow).toBeDefined()
      await dom.act(async () => {
        wsRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      expect(dom.window.document.body.textContent).toContain(
        `workstream-modal:00000000-0000-4000-8000-000000000010:${squadAId}`
      )

      const agentRow = [...dom.window.document.querySelectorAll('a')].find((a) =>
        a.getAttribute('aria-label')?.includes('Implementation ready')
      )!
      expect(agentRow).toBeDefined()
      await dom.act(async () => {
        agentRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      // The agent was prewarmed in cache above, so it resolves straight to AgentViewModal (no
      // conversation-stub flash) — scoped to squad B, the row's OWN squad.
      expect(dom.window.document.body.textContent).toContain(`agent-view-modal:${agentId}:${squadBId}`)
      expect(dom.window.document.body.textContent).not.toContain('conversation-stub')
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  test('an agent row falls back to the plain conversation modal while the agent record is still loading', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const client = seedClient([messageItem])
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new Promise(() => {
          /* never resolves — keeps queries.agents.detail perpetually loading */
        })
    ) as unknown as typeof fetch
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <ActivityPage
                  dependencies={{
                    AgentConversationComponent: ((props: { agentId: string; focusInboxMessageId?: string }) => (
                      <p>
                        conversation-stub:{props.agentId}:{props.focusInboxMessageId}
                      </p>
                    )) as never,
                    AgentViewModalComponent: (() => <p>agent-view-modal</p>) as never,
                  }}
                />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
        await Bun.sleep(20)
      })
      const agentRow = [...dom.window.document.querySelectorAll('a')].find((a) =>
        a.getAttribute('aria-label')?.includes('Implementation ready')
      )!
      await dom.act(async () => {
        agentRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await Bun.sleep(10)
      })
      expect(dom.window.document.body.textContent).toContain(
        `conversation-stub:${agentId}:${messageItem.ref.type === 'agent' ? messageItem.ref.messageId : ''}`
      )
      expect(dom.window.document.body.textContent).not.toContain('agent-view-modal')
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

for (const reference of ['abc12345-1234-1234-1234-123456789abc', 'abc12345']) {
  test(`inline agent ${reference} retains global filters and scroll without opening the source`, async () => {
    await import('./EntityReferenceModal')
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const target = { id: 'abc12345-1234-1234-1234-123456789abc', squadId: squadAId, agentTypeId: 'reviewer' }
    const item = { ...messageItem, preview: [{ text: 'Review agent', href: `ficus:agent:${reference}` }] }
    const client = seedClient([item])
    client.setQueryData(queryKeys.activity.globalInfinite({ ...filters, kinds: ['message', 'subagent'] }), {
      pages: [{ items: [item], hasMore: false, nextCursor: null, squads: { [squadBId]: { name: 'Bravo' } } }],
      pageParams: [null],
    })
    client.setQueryData(queryKeys.agents.detail(reference), target)
    client.setQueryData(queryKeys.agents.detail(target.id), target)
    function LocationProbe() {
      return <p data-location>{useLocation().pathname}</p>
    }
    const opened: string[] = []
    try {
      const view = dom.createRoot()
      await dom.act(() =>
        view.root.render(
          <MemoryRouter initialEntries={['/activity']}>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <LocationProbe />
                <ActivityPage
                  dependencies={{
                    AgentViewModalComponent: (({
                      agent,
                      squadId,
                      onClose,
                    }: {
                      agent: { id: string }
                      squadId: string
                      onClose: () => void
                    }) => {
                      opened.push(`${agent.id}:${squadId}`)
                      return <button onClick={onClose}>Close referenced agent</button>
                    }) as never,
                  }}
                />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const messages = [...view.container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Messages'
      )!
      await dom.act(() => messages.click())
      const scroller = view.container.querySelector<HTMLElement>('.overflow-y-auto')!
      scroller.scrollTop = 400
      await dom.act(async () => {
        ;[...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Review agent')!.click()
      })
      await dom.act(async () => {
        await waitFor(() => expect(view.container.textContent).toContain('Close referenced agent'))
      })
      expect(view.container.querySelector('[data-location]')?.textContent).toBe('/activity')
      expect(opened).toContain(`${target.id}:${squadAId}`)
      expect(opened.every((value) => value.startsWith(target.id))).toBe(true)
      expect(messages.getAttribute('aria-pressed')).toBe('true')
      expect(view.container.querySelector('.overflow-y-auto')).toBe(scroller)
      expect(scroller.scrollTop).toBe(400)
      await dom.act(() =>
        [...view.container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Close referenced agent')!
          .click()
      )
      expect(view.container.querySelector('[data-location]')?.textContent).toBe('/activity')
      expect(messages.getAttribute('aria-pressed')).toBe('true')
      expect(scroller.scrollTop).toBe(400)
    } finally {
      client.clear()
      await dom.cleanup()
    }
  })
}

describe('ActivityPage live updates', () => {
  test("a squad's activity change refreshes the feed moments later", async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/activity' })
    const client = seedClient([], false)
    client.setQueryData(queryKeys.squads.list(), [{ id: 'sq-1', name: 'Chlea', status: 'active' }] as never)
    const rendered = dom.createRoot()
    try {
      await dom.act(async () => {
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <WebSocketContext.Provider value={socket}>
                <ActivityPage />
              </WebSocketContext.Provider>
            </QueryClientProvider>
          </MemoryRouter>
        )
      })
      expect(listeners.has('squadActivity:sq-1')).toBe(true)
      const feed = () => client.getQueryCache().findAll({ queryKey: queryKeys.activity.all })
      expect(feed().some((query) => query.state.isInvalidated)).toBe(false)

      listeners.get('squadActivity:sq-1')!({ event: 'squadActivity.projected', data: {} })
      await dom.act(async () => {
        await Bun.sleep(450)
      })
      expect(feed().some((query) => query.state.isInvalidated)).toBe(true)
    } finally {
      await dom.act(async () => rendered.root.unmount())
      await dom.cleanup()
      client.clear()
    }
  })
})
