import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentProps, ReactNode } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { Chat } from './Chat'

let mockAgentStatus: 'idle' | 'active' = 'idle'
let mockExecutionStatus: 'queued' | 'waiting-sandbox' | 'running' | 'stopping' | undefined
let mockAgentTypeId = 'manager'
let mockAgentTypeModel: string | null = 'anthropic:claude-sonnet-4-5'
let mockSquadId: string | null = null
let mockScopeType = 'system-manager'
let mockSelectedSubagents: Array<{ id: string; status: string }> = []
let mockAgentIds = ['agent-1']
let mockAgentScopeTypes: Record<string, string> = {}

const agent = {
  id: 'agent-1',
  agentTypeId: mockAgentTypeId,
  squadId: mockSquadId,
  status: 'idle',
  metadata: { name: 'Agent Alpha' },
  context: { scope: { type: mockScopeType } },
  createdAt: '2026-05-05T00:00:00.000Z',
  lastMessageAt: '2026-05-05T00:00:00.000Z',
  modelOverride: null,
  configuredModel: 'anthropic:claude-sonnet-4-5:high',
  sessionUsage: {
    context: { percent: 42, contextWindow: 100000 },
    stats: { tokens: { total: 1234 }, cost: 0.56 },
  },
}

const currentQueryClient: { getQueryData?: (key: readonly unknown[]) => unknown } | null = null

import { ReactQueryHooksProvider } from '../reactQueryHooks'

const reactQueryOverrides = {
  useQueryClient: () => currentQueryClient,
  useInfiniteQuery: () => ({ data: undefined, isLoading: false, isFetchingNextPage: false, hasNextPage: false }),
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    const key = options.queryKey ?? []
    const cachedData = currentQueryClient?.getQueryData?.(key)
    if (cachedData !== undefined) return { data: cachedData, isLoading: false }
    if (key[0] === 'auth' && key[1] === 'permissions') return { data: undefined, isLoading: true, isError: false }
    if (key[0] === 'agents' && key[1] === 'list')
      return {
        data: mockAgentIds.map((id, index) => ({
          ...agent,
          id,
          metadata: { name: index === 0 ? 'Agent Alpha' : `Agent ${index + 1}` },
          agentTypeId: mockAgentTypeId,
          squadId: mockSquadId,
          status: mockAgentStatus,
          context: { scope: { type: mockAgentScopeTypes[id] ?? mockScopeType } },
        })),
        isLoading: false,
      }
    if (key[0] === 'agents' && key[1] === 'detail')
      return {
        data: {
          ...agent,
          agentTypeId: mockAgentTypeId,
          squadId: mockSquadId,
          status: mockAgentStatus,
          context: { scope: { type: mockScopeType } },
        },
        isLoading: false,
      }
    if (key[0] === 'agents' && key[1] === 'children') return { data: mockSelectedSubagents, isLoading: false }
    if (key[0] === 'agents' && key[1] === 'activeExecution') {
      return { data: mockExecutionStatus ? { id: 'exec-1', status: mockExecutionStatus, active: true } : null }
    }
    if (key[0] === 'agentTypes' && key[1] === 'detail') {
      return {
        data: {
          id: mockAgentTypeId,
          name: mockAgentTypeId,
          model: mockAgentTypeModel,
          tier: null,
          resolvedChain: mockAgentTypeModel,
          provenance: 'type override',
        },
        isLoading: false,
      }
    }
    if (key[0] === 'inbox') return { data: { count: 0 } }
    if (key[0] === 'agentQuestions') return { data: [], isLoading: false }
    return { data: undefined, isLoading: false }
  },
  useQueryClient: () => ({
    getQueryData: (key: readonly unknown[]) => currentQueryClient?.getQueryData?.(key),
    invalidateQueries: mock(() => undefined),
  }),
  useQueries: ({ queries }: { queries?: Array<{ queryKey?: readonly unknown[] }> }) =>
    (queries ?? []).map((options) => {
      const cachedData = currentQueryClient?.getQueryData?.(options.queryKey ?? [])
      return { data: cachedData, isLoading: false }
    }),
  useMutation: () => ({ mutate: mock(() => undefined), isPending: false }),
  queryOptions: (options: unknown) => options,
}

const queryClients = new Set<QueryClient>()

function withReactQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClients.add(client)
  return (
    <QueryClientProvider client={client}>
      <ReactQueryHooksProvider hooks={reactQueryOverrides}>{children}</ReactQueryHooksProvider>
    </QueryClientProvider>
  )
}

let capturedAgentChatProps: Record<string, unknown> = {}

beforeEach(() => {
  mockAgentIds = ['agent-1']
  mockAgentScopeTypes = {}
  capturedAgentChatProps = {}
})

afterEach(async () => {
  for (const queryClient of queryClients) {
    await queryClient.cancelQueries()
    queryClient.clear()
  }
  queryClients.clear()
})

const TestAgentChat = (props: Record<string, unknown>) => {
  capturedAgentChatProps = props
  return <div data-testid="agent-chat">{props.header as React.ReactNode}</div>
}
// Substitute at AgentChat, not at Chat: the header controls these tests assert on
// (Compact/Reset/Stop) are built by Chat itself, so stubbing Chat would delete the
// code under test rather than isolate it.
const testChatDependencies = {
  AgentChatComponent: TestAgentChat as never,
  useNotificationSoundHook: () => ({ playSound: () => undefined }),
  useTextToSpeechHook: () => ({
    enabled: false,
    speak: async () => undefined,
    stop: () => undefined,
    toggle: () => undefined,
    isPlaying: false,
    isSynthesizing: false,
    playingMessageId: null,
  }),
}
const TestChat = (props: ComponentProps<typeof Chat>) => <Chat {...props} dependencies={testChatDependencies} />
const TestSubagentsInlinePanel = ({ parentAgentId }: { parentAgentId: string }) => (
  <div data-testid="subagents-panel" data-parent={parentAgentId} />
)
const TestAgentWorkStreamsPanel = () => <div>Agent work streams</div>
const chatPageDependencies = {
  ChatComponent: TestChat,
  SubagentsInlinePanelComponent: TestSubagentsInlinePanel,
  AgentWorkStreamsPanelComponent: TestAgentWorkStreamsPanel,
}

const { ChatPage } = await import('./ChatPage')

function configureViewport(width: number) {
  return (window: Awaited<ReturnType<typeof acquireDomHarness>>['window']) => {
    window.innerWidth = width
    window.matchMedia = ((query: string) => ({
      matches: query === '(min-width: 768px)' ? width >= 768 : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
}

const route = (router: ReturnType<typeof createMemoryRouter>) =>
  `${router.state.location.pathname}${router.state.location.search}`

type Navigation = { key: string; route: string; action: string }

async function renderChatRoute(entry: string, width: number) {
  const dom = await acquireDomHarness({
    url: `https://ficus.test${entry}`,
    windowOptions: { innerWidth: width },
    configureWindow: configureViewport(width),
  })

  const router = createMemoryRouter(
    [
      { path: '/before', element: <div>Before</div> },
      { path: '/chat', element: withReactQuery(<ChatPage dependencies={chatPageDependencies} />) },
      { path: '/chat/:agentId', element: withReactQuery(<ChatPage dependencies={chatPageDependencies} />) },
    ],
    { initialEntries: ['/before', entry], initialIndex: 1 }
  )
  const navigations: Navigation[] = []
  let lastLocationKey = router.state.location.key
  const unsubscribe = router.subscribe((state) => {
    if (state.location.key === lastLocationKey) return
    lastLocationKey = state.location.key
    navigations.push({
      key: state.location.key,
      route: `${state.location.pathname}${state.location.search}`,
      action: state.historyAction,
    })
  })
  const rendered = dom.createRoot()
  let renderRevision = 0
  const renderRouter = () =>
    dom.act(async () => rendered.root.render(<RouterProvider key={renderRevision++} router={router} />))
  await renderRouter()

  return {
    dom,
    router,
    rendered,
    navigations,
    rerender: renderRouter,
    async cleanup() {
      unsubscribe()
      for (const queryClient of queryClients) {
        await queryClient.cancelQueries()
        queryClient.clear()
      }
      queryClients.clear()
      await dom.cleanup()
      router.dispose()
    },
  }
}

function renderChatPage(scope = 'system-manager', extraQuery = '') {
  return renderToStaticMarkup(
    withReactQuery(
      <MemoryRouter initialEntries={[`/chat/agent-1?scope=${scope}${extraQuery}`]}>
        <Routes>
          <Route path="/chat/:agentId" element={<ChatPage dependencies={chatPageDependencies} />} />
        </Routes>
      </MemoryRouter>
    )
  )
}

function renderChatIndexPage(query = '') {
  return renderToStaticMarkup(
    withReactQuery(
      <MemoryRouter initialEntries={[`/chat${query}`]}>
        <Routes>
          <Route path="/chat" element={<ChatPage dependencies={chatPageDependencies} />} />
        </Routes>
      </MemoryRouter>
    )
  )
}

describe('ChatPage scope filter', () => {
  test('defaults to All when no scope query param is present', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatIndexPage()

    expect(html).toMatch(/class="[^"]*bg-accent text-on-accent[^"]*">All<\/button>/)
    expect(html).not.toMatch(/class="[^"]*bg-accent text-on-accent[^"]*">System<\/button>/)
  })

  test('respects an explicit System scope query param', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatIndexPage('?scope=system-manager')

    expect(html).toMatch(/class="[^"]*bg-accent text-on-accent[^"]*">System<\/button>/)
  })
})

describe('ChatPage Subagents tab', () => {
  test('shows active child count from the existing children query', () => {
    mockSelectedSubagents = [
      { id: 'sa-1', status: 'active' },
      { id: 'sa-2', status: 'active' },
      { id: 'sa-3', status: 'idle' },
    ]

    const html = renderChatPage()

    expect(html).toContain('aria-label="Subagents, 2 active subagents"')
    mockSelectedSubagents = []
  })

  test('keeps the Subagents tab unadorned when all children are idle', () => {
    mockSelectedSubagents = [{ id: 'sa-1', status: 'idle' }]

    const html = renderChatPage()

    expect(html).toContain('Subagents')
    expect(html).not.toContain('aria-label="Subagents, 1 active subagent"')
    mockSelectedSubagents = []
  })
})

describe('ChatPage mobile auto-routing', () => {
  test('does not auto-navigate into the first agent on mobile when no agent is selected', async () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const fixture = await renderChatRoute('/chat', 375)
    try {
      expect(route(fixture.router)).toBe('/chat')
      expect(fixture.navigations).toEqual([])
      expect(fixture.rendered.container.textContent).toContain('Chats')
      expect(fixture.rendered.container.textContent).toContain('Agent Alpha')
    } finally {
      await fixture.cleanup()
    }
  })

  test('still auto-navigates into the first agent on desktop when no agent is selected', async () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'
    mockAgentIds = ['agent-1', 'agent-2']

    const fixture = await renderChatRoute('/chat', 1280)
    try {
      expect(route(fixture.router)).toBe('/chat/agent-1?scope=all')
      expect(fixture.navigations.map(({ route, action }) => ({ route, action }))).toEqual([
        { route: '/chat/agent-1?scope=all', action: 'REPLACE' },
      ])

      await fixture.rerender()
      await fixture.rerender()
      expect(fixture.navigations).toHaveLength(1)

      await fixture.dom.act(async () => fixture.router.navigate(-1))
      expect(route(fixture.router)).toBe('/before')
      await fixture.dom.act(async () => fixture.router.navigate(1))
      expect(route(fixture.router)).toBe('/chat/agent-1?scope=all')
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('ChatPage conversation header', () => {
  test('renders a single agent title with top-row controls and idle context actions', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatPage()

    // Once in the sidebar button, once in that button's title attribute, and once in the conversation title row;
    // not again in the embedded chat header.
    expect(html.match(/Agent Alpha/g)?.length).toBe(3)
    expect(html).toContain('Chat')
    expect(html).toContain('Inbox')
    expect(html).toContain('Context')
    expect(html).toContain('Info')
    expect(html).toContain('aria-label="Fullscreen"')
    // Usage stats are rendered inside AgentChat (not in the outer chrome) — not checked here.
    expect(html).toContain('Compact')
    expect(html).toContain('Reset')
  })

  test('renders mobile back navigation in a separate row above title and tabs', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatPage()

    expect(html).toContain('class="md:hidden shrink-0 px-3 py-2 border-b border-th-border"')
    expect(html).toMatch(
      /<div class="md:hidden shrink-0 px-3 py-2 border-b border-th-border">.*Chats.*<\/div><div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-th-border shrink-0">.*Agent Alpha.*Chat.*Inbox.*Context.*Info/s
    )
  })

  test('renders the configured model details on the Info tab', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockAgentTypeModel = 'anthropic:claude-sonnet-4-5'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatPage('system-manager', '&view=info')

    // Model source is intentional for every authoritative provenance,
    // including a root agent's type override; it is not limited to subagents.
    expect(html).toContain('Agent info')
    expect(html).toContain('Configured chain')
    expect(html).toContain('anthropic:claude-sonnet-4-5')
    expect(html).toContain('Model source')
    expect(html).toContain('Agent type override')
    expect(html).not.toContain('Model ID')
    expect(html).not.toContain('Unknown')
  })

  test('renders running execution actions in the context/action row', () => {
    mockAgentStatus = 'active'
    mockExecutionStatus = 'running'
    mockAgentTypeId = 'manager'
    mockAgentTypeModel = 'anthropic:claude-sonnet-4-5'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatPage()

    expect(html.match(/Agent Alpha/g)?.length).toBe(3)
    expect(html).not.toContain('Pause')
    expect(html).toContain('Stop')
  })

  test('renders stop control for queued, sandbox-waiting, and stopping executions', () => {
    for (const status of ['queued', 'waiting-sandbox', 'stopping'] as const) {
      mockAgentStatus = 'active'
      mockExecutionStatus = status
      mockAgentTypeId = 'manager'
      mockAgentTypeModel = 'anthropic:claude-sonnet-4-5'
      mockSquadId = null
      mockScopeType = 'system-manager'

      const html = renderChatPage()

      expect(html).not.toContain('Pause')
      expect(html).toContain('Stop')
    }
  })

  test('renders work tab for squad agents in chat view', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'worker'
    mockSquadId = 'squad-1'
    mockScopeType = 'squad-worker'

    const html = renderChatPage('squad-worker', '&view=work')

    expect(html).toContain('Agent work streams')
  })

  test('treats work view as chat for non-squad agents', () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const html = renderChatPage('system-manager', '&view=work')

    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Chat/s)
    expect(html).not.toContain('Agent work streams')
    expect(html).not.toMatch(/>Work<\/button>/)
  })
})

describe('ChatPage scope routing behavior', () => {
  test('keeps one canonical scoped agent auto-navigation call', () => {
    const source = readFileSync(join(import.meta.dir, 'ChatPage.tsx'), 'utf8')
    const scopedAgentNavigation = /navigate\(`\/chat\/\$\{agents\[0\]\.id\}\?scope=\$\{scopeFilter\}`[^)]*\)/g

    expect(source.match(scopedAgentNavigation)).toHaveLength(1)
  })

  test('auto-selects the first eligible agent while preserving the selected scope', async () => {
    mockAgentIds = ['squad-worker-agent']
    mockAgentScopeTypes = { 'squad-worker-agent': 'squad-worker' }
    const fixture = await renderChatRoute('/chat?scope=squad-worker', 1280)
    try {
      expect(route(fixture.router)).toBe('/chat/squad-worker-agent?scope=squad-worker')
      expect(fixture.navigations.map(({ route, action }) => ({ route, action }))).toEqual([
        { route: '/chat/squad-worker-agent?scope=squad-worker', action: 'REPLACE' },
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  test('changing scope clears the selected agent while preserving unrelated URL state', async () => {
    const fixture = await renderChatRoute('/chat/agent-1?scope=system-manager&view=info&fullscreen=1&keep=yes', 1280)
    try {
      const workerButton = Array.from(fixture.rendered.container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Squad Worker'
      )
      expect(workerButton).toBeDefined()

      await fixture.dom.act(async () => workerButton!.click())

      expect(route(fixture.router)).toBe('/chat?scope=squad-worker&view=info&fullscreen=1&keep=yes')
      expect(fixture.navigations.at(-1)?.action).toBe('REPLACE')
    } finally {
      await fixture.cleanup()
    }
  })

  test('auto-selects an eligible agent with the user-selected scope in the URL', async () => {
    mockAgentIds = ['system-agent', 'squad-worker-agent']
    mockAgentScopeTypes = {
      'system-agent': 'system-manager',
      'squad-worker-agent': 'squad-worker',
    }
    const fixture = await renderChatRoute('/chat/system-agent?scope=system-manager', 1280)
    try {
      const workerButton = Array.from(fixture.rendered.container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Squad Worker'
      )
      expect(workerButton).toBeDefined()

      await fixture.dom.act(async () => workerButton!.click())

      expect(route(fixture.router)).toBe('/chat/squad-worker-agent?scope=squad-worker')
      expect(fixture.navigations.map(({ route, action }) => ({ route, action }))).toEqual([
        { route: '/chat?scope=squad-worker', action: 'REPLACE' },
        { route: '/chat/squad-worker-agent?scope=squad-worker', action: 'REPLACE' },
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  test('excludes agents whose declared scope is not recognized by ChatPage', async () => {
    mockAgentIds = ['recognized-agent', 'unknown-agent', 'retired-agent']
    mockAgentScopeTypes = {
      'recognized-agent': 'system-manager',
      'unknown-agent': 'unrecognized-scope',
      'retired-agent': 'retired-scope',
    }
    const fixture = await renderChatRoute('/chat?scope=all', 375)
    try {
      expect(Boolean(fixture.rendered.container.querySelector('[title*="recognized-agent"]'))).toBe(true)
      expect(Boolean(fixture.rendered.container.querySelector('[title*="unknown-agent"]'))).toBe(false)
      expect(Boolean(fixture.rendered.container.querySelector('[title*="retired-agent"]'))).toBe(false)
      expect(fixture.navigations).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test('new system chat rejects a selected scope that cannot create that chat type', async () => {
    mockAgentScopeTypes = { 'agent-1': 'squad-worker' }
    const fixture = await renderChatRoute('/chat/agent-1?scope=squad-worker&keep=yes', 1280)
    try {
      const newChatButton = Array.from(fixture.rendered.container.querySelectorAll('button')).find(
        (button) => button.textContent === 'New System Chat'
      )
      expect(newChatButton).toBeDefined()

      await fixture.dom.act(async () => newChatButton!.click())

      expect(route(fixture.router)).toBe('/chat?scope=system-manager&keep=yes')
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('ChatPage handleAgentCreated routing', () => {
  test('navigates to /chat/:id?scope=... when onAgentCreated fires', async () => {
    mockAgentStatus = 'idle'
    mockExecutionStatus = undefined
    mockAgentTypeId = 'manager'
    mockSquadId = null
    mockScopeType = 'system-manager'

    const fixture = await renderChatRoute('/chat/agent-1?scope=all', 1280)
    try {
      expect(capturedAgentChatProps.onAgentCreated).toBeDefined()
      expect(fixture.navigations).toEqual([])

      await fixture.dom.act(async () => {
        ;(capturedAgentChatProps.onAgentCreated as (id: string) => void)('new-agent-id')
      })

      expect(route(fixture.router)).toBe('/chat/new-agent-id?scope=all')
      expect(fixture.navigations.map(({ route, action }) => ({ route, action }))).toEqual([
        { route: '/chat/new-agent-id?scope=all', action: 'REPLACE' },
      ])

      await fixture.rerender()
      expect(fixture.navigations).toHaveLength(1)
      await fixture.dom.act(async () => fixture.router.navigate(-1))
      expect(route(fixture.router)).toBe('/before')
    } finally {
      await fixture.cleanup()
    }
  })

  test('preserves an explicit agent route when that agent disappears from the list', async () => {
    mockAgentIds = ['agent-1', 'agent-2']
    const fixture = await renderChatRoute('/chat/agent-1?scope=all', 1280)
    try {
      expect(fixture.navigations).toEqual([])
      mockAgentIds = ['agent-2']
      await fixture.rerender()
      expect(route(fixture.router)).toBe('/chat/agent-1?scope=all')
      expect(fixture.navigations).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test('does not replace a missing agent deep link with the first listed agent', async () => {
    mockAgentIds = ['agent-1', 'agent-2']
    const fixture = await renderChatRoute('/chat/missing-agent?scope=system-manager', 1280)
    try {
      expect(route(fixture.router)).toBe('/chat/missing-agent?scope=system-manager')
      expect(fixture.navigations).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})
