import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Agent, Squad, WorkStream, SquadActivityItem } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { WebSocketContext } from '../hooks/useWebSocket'

let permissions = new Set<string>()

import { SquadDetailPage } from './SquadDetailPage'
import { SquadAgentThreads } from './squads/SquadAgentThreads'
import { activityAccessSignature } from './squads/squadActivityView'

const dependencies = {
  useWebSocket: () => ({ isConnected: true, subscribe: mock(() => mock(() => undefined)) }),
  SandboxStatusIndicator: () => <span data-test-slot="sandbox">Sandbox fixture</span>,
  SquadAgentThreads: () => <div>Agent threads fixture</div>,
  homeTabDependencies: {
    SquadAgentThreads: () => <div>Agent threads fixture</div>,
  },
}

const now = new Date('2026-01-01T00:00:00Z')

const squad: Squad = {
  id: 'squad-1',
  name: 'Ficus Mobile Header Squad',
  purpose: 'Build mobile layouts',
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
    title: 'Active squad work',
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

function renderSquadDetail(
  options: {
    loading?: boolean
    entry?: string
    activeAgents?: Agent[]
    recentAgents?: Agent[]
    activityItems?: SquadActivityItem[]
    SandboxStatusIndicator?: () => React.ReactNode
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(queryKeys.auth.permissions(squad.id), {
    permissions: [...permissions],
    identity: { type: 'user', userId: 'user-1' },
  })
  if (!options.loading) queryClient.setQueryData(queryKeys.squads.detail(squad.id), squad)
  if (!options.loading)
    queryClient.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), {
      agents: options.activeAgents ?? [],
      recentlyTerminated: options.recentAgents ?? [],
    })
  queryClient.setQueryData(
    queryKeys.squads.activityInfinite(
      squad.id,
      { verbose: false, agentIds: [], kinds: [] },
      // Compute the signature with the SAME helper the component uses — a
      // hand-rolled string here silently cache-misses when the format moves.
      activityAccessSignature({ type: 'user', userId: 'user-1' }, squad.id, true, (permission) =>
        permissions.has(permission)
      )
    ),
    {
      pages: [{ items: options.activityItems ?? [], hasMore: false, nextCursor: null }],
      pageParams: [null],
    }
  )
  queryClient.setQueryData(queryKeys.squads.workStreams(squad.id), [
    workStream({ id: 'done-ws', title: 'Done work should not feed Home', status: 'done' }),
  ])
  if (!options.loading)
    queryClient.setQueryData(queryKeys.squads.activeWorkStreams(squad.id), [
      workStream({
        id: 'active-ws',
        title: 'Active work from active query',
        status: 'active',
        derivedState: 'in_progress',
      }),
    ])

  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[options.entry ?? `/squads/${squad.id}`]}>
      <QueryClientProvider client={queryClient}>
        <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => undefined }}>
          <Routes>
            <Route
              path="/squads/:squadId/:tab?"
              element={
                <SquadDetailPage
                  dependencies={{
                    ...dependencies,
                    ...(options.SandboxStatusIndicator
                      ? { SandboxStatusIndicator: options.SandboxStatusIndicator }
                      : {}),
                  }}
                />
              }
            />
          </Routes>
        </WebSocketContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SquadDetailPage', () => {
  beforeEach(() => {
    permissions = new Set<string>()
  })

  // The sandbox indicator renders nothing on the host runtime, and a stat-pill
  // wrapper around it would leave a padded, background-filled empty box in the
  // header — so the indicator owns its own pill chrome and the header adds none.
  test('leaves no empty stat pill when the sandbox indicator renders nothing', () => {
    const html = renderSquadDetail({ SandboxStatusIndicator: () => null })

    expect(html).not.toContain('<span class="px-2 py-0.5 rounded-md bg-surface-secondary"></span>')
  })
  test('renders the mobile back link in its own row above the title and actions row', () => {
    const html = renderSquadDetail()

    expect(html).toContain('data-testid="mobile-squad-header-back-row"')
    expect(html).toContain('data-testid="mobile-squad-header-title-row"')
    expect(html.indexOf('data-testid="mobile-squad-header-back-row"')).toBeLessThan(
      html.indexOf('data-testid="mobile-squad-header-title-row"')
    )
  })

  test('uses active work stream data for the header and Home work list', () => {
    const html = renderSquadDetail()

    expect(html).toContain('1 active work stream')
    expect(html).toContain('Active work from active query')
    expect(html).not.toContain('Done work should not feed Home')
  })

  test('hides squad delete actions unless squads:delete is allowed', () => {
    expect(renderSquadDetail()).not.toContain('Archive')

    permissions.add('squads:delete')

    expect(renderSquadDetail()).toContain('Archive')
  })

  test('shows four primary destinations and keeps secondary tools in More', () => {
    const html = renderSquadDetail()
    const tabsHtml = html.match(/<nav[^>]*aria-label="Squad sections"[^>]*>(?<tabs>.*?)<\/nav>/)?.groups?.tabs
    const tabLabels = Array.from(tabsHtml?.matchAll(/<button[^>]*>(?<label>[^<]+)<\/button>/g) ?? []).map(
      (match) => match.groups!.label
    )

    expect(tabLabels).toEqual(['Home', 'Chats', 'Work', 'Activity'])
    expect(html).toContain('More squad tools')
  })

  test('renders historical agents in Activity while keeping the query inactive on Home', () => {
    const historical = {
      id: '00000000-0000-4000-8000-000000000099',
      agentTypeId: 'reviewer',
      squadId: squad.id,
      parentAgentId: null,
      status: 'idle',
      persist: false,
      modelOverride: null,
      metadata: { name: 'Historical Reviewer' },
      context: {},
      questionData: null,
      sessionUsage: null,
      terminatedAt: now,
      lastMessageAt: null,
      lastHumanMessageAt: null,
      lastMessagePreview: null,
      createdAt: now,
      updatedAt: now,
      amtpHandle: null,
      identityPublicKey: null,
      inboundOpen: false,
    } satisfies Agent

    expect(renderSquadDetail()).not.toContain('Loading activity')
    permissions.add('agents:read')
    // The agent pill filter is gone (2026-08-27): historical agents surface in
    // Activity through row labels resolved from the recentlyTerminated set.
    const historicalRow: SquadActivityItem = {
      id: '80:hist-row',
      at: '2026-08-27T10:00:00.000Z',
      agentId: historical.id,
      agentTypeId: 'reviewer',
      kind: 'message',
      preview: [{ text: 'Reviewed the auth changes' }],
      summary: 'Reviewed the auth changes',
      ref: { type: 'agent', agentId: historical.id, view: 'chat' },
    }
    expect(
      renderSquadDetail({
        entry: `/squads/${squad.id}/activity`,
        recentAgents: [historical],
        activityItems: [historicalRow],
      })
    ).toContain(
      // Label contract (2026-08-27 v2): the visible label is the Title-Cased
      // type only; the historical agent's purpose survives as the tooltip,
      // which still requires resolving the agent outside the live roster.
      'title="Historical Reviewer"'
    )
  })
})

test('cold squad Home keeps real navigation and static sections with local placeholders', () => {
  const html = renderSquadDetail({ loading: true })
  for (const label of [
    'Home',
    'Chats',
    'Work',
    'Activity',
    'More',
    'Start with a conversation',
    'New chat',
    'Recent chats',
    'Squad coordinator',
  ])
    expect(html).toContain(label)
  expect(html).toContain('Loading recent chats')
  expect(html).toContain('Loading squad coordinator')
  expect(html).not.toContain('Your conversations will appear here')
  expect(html).not.toContain('No active work streams')
})

test('cold squad Work keeps filters instead of a generic page skeleton or premature empty state', () => {
  const html = renderSquadDetail({ loading: true, entry: `/squads/${squad.id}/work` })
  expect(html).toContain('Work stream filters')
  expect(html).toContain('Loading active work streams')
  expect(html).not.toContain('No work streams yet')
})

test('cold squad Activity keeps its filter toolbar and presence strip', () => {
  const html = renderSquadDetail({ loading: true, entry: `/squads/${squad.id}/activity` })
  expect(html).toContain('Activity kind filters')
  expect(html).toContain('activity-presence')
  expect(html).toContain('waiting on you')
})

test('a cold slug route keeps placeholders until canonical queries settle without requesting the slug', async () => {
  const { acquireDomHarness } = await import('../test/domHarness')
  const requests: string[] = []
  const pending = new Map<string, (response: Response) => void>()
  const dom = await acquireDomHarness({
    url: 'http://localhost/squads/ficus',
    configureWindow: (window) => {
      window.fetch = ((input: string) => {
        const path = new URL(input).pathname + new URL(input).search
        requests.push(path)
        return new Promise<Response>((resolve) => pending.set(path, resolve))
      }) as typeof window.fetch
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const canonical = { ...squad, id: '11111111-1111-1111-1111-111111111111', name: 'Ficus' }
  const { root, container } = dom.createRoot()
  const flush = () =>
    dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  try {
    await dom.act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/squads/ficus']}>
          <QueryClientProvider client={client}>
            <Routes>
              <Route path="/squads/:squadId/:tab?" element={<SquadDetailPage dependencies={dependencies} />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    const newChat = [...container.querySelectorAll('a')].find((link) => link.textContent?.includes('New chat'))!
    expect(newChat.getAttribute('href')).toBe('/squads/ficus/agents?newConsultant=1')
    expect(container.textContent).not.toContain('No active work streams')
    expect(requests.some((path) => path.includes('/squads/ficus'))).toBe(false)
    await dom.act(async () => pending.get('/api/squads')!(new Response(JSON.stringify([canonical]))))
    await flush()
    expect(container.textContent).not.toContain('No active work streams')
    expect(container.contains(newChat)).toBe(true)
    await dom.act(async () => client.setQueryData(queryKeys.squads.detail(canonical.id), canonical))
    await flush()
    expect(container.textContent).not.toContain('No active work streams')
    await dom.act(async () => client.setQueryData(queryKeys.squads.activeWorkStreams(canonical.id), []))
    await flush()
    expect(container.textContent).toContain('No active work streams')
    await dom.act(async () =>
      client.setQueryData(queryKeys.squads.agentsWithRecent(canonical.id), { agents: [], recentlyTerminated: [] })
    )
    await flush()
    expect(container.textContent).toContain('No active work streams')
    expect(container.contains(newChat)).toBe(true)
    expect(requests.some((path) => path.includes('/squads/ficus'))).toBe(false)
    expect(requests.filter((path) => path === `/api/squads/${canonical.id}?includeRelationships=true`)).toHaveLength(1)
  } finally {
    client.clear()
    await dom.cleanup()
  }
})

test('Home New chat opens the Chats composer instead of selecting an existing conversation', async () => {
  const { acquireDomHarness } = await import('../test/domHarness')
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/ficus' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const canonical = { ...squad, name: 'Ficus' }
  const consultant = {
    id: 'consultant-1',
    agentTypeId: 'consultant',
    status: 'idle',
    metadata: { name: 'Existing consultant' },
    createdAt: now,
  } as Agent
  client.setQueryData(queryKeys.squads.list(), [canonical])
  client.setQueryData(queryKeys.squads.detail(squad.id), canonical)
  client.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), { agents: [consultant], recentlyTerminated: [] })
  client.setQueryData(queryKeys.squads.activeWorkStreams(squad.id), [])
  client.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['agents:read', 'agents:run'] })
  const Threads = (props: React.ComponentProps<typeof SquadAgentThreads>) => (
    <SquadAgentThreads
      {...props}
      dependencies={{
        Chat: () => <div data-testid="consultant-chat-composer" />,
        AgentConversation: () => <div data-testid="existing-conversation" />,
      }}
    />
  )
  const { root, container } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/squads/ficus']}>
          <QueryClientProvider client={client}>
            <Routes>
              <Route
                path="/squads/:squadId/:tab?"
                element={<SquadDetailPage dependencies={{ ...dependencies, SquadAgentThreads: Threads }} />}
              />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    expect(container.querySelector('[data-active-tab="home"]')).not.toBeNull()
    const newChat = [...container.querySelectorAll('a')].find((link) => link.textContent?.includes('New chat'))!
    await dom.act(async () => newChat.click())
    expect(container.querySelector('[data-active-tab="agents"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="consultant-chat-composer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="existing-conversation"]')).toBeNull()
    expect(
      container.querySelector('[title="Existing consultant · consultant · consultant-1"]')?.getAttribute('aria-pressed')
    ).toBe('false')
  } finally {
    await dom.cleanup()
    client.clear()
  }
})
