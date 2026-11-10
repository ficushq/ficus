import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '../queryKeys'
import { ChatApiProvider } from '../api/ChatApiProvider'

const systemManagerFilters = { agentTypeId: 'system-manager', scopeType: 'system-manager' }
let mockAgents: unknown[] = []

const idleAgent = {
  id: 'agent-1',
  agentTypeId: 'system-manager',
  squadId: null,
  status: 'idle',
  metadata: {},
  context: { scope: { type: 'system-manager' } },
  createdAt: '2026-05-05T00:00:00.000Z',
  updatedAt: '2026-05-05T00:00:00.000Z',
  lastMessageAt: '2026-05-05T00:00:00.000Z',
  sessionUsage: {
    context: { percent: 42, contextWindow: 100000 },
    stats: { tokens: { total: 1234 }, cost: 0.56 },
  },
}

const ChatFixture = ({ agentId, headerExtra }: { agentId?: string; headerExtra?: ReactNode }) => (
  <div data-testid="injected-chat-fixture" data-agent-id={agentId ?? 'new'}>
    {headerExtra}
  </div>
)

const { LegacyChatDrawer: ChatDrawer, runDeleteAgent, applyPostDeleteDrawerState } = await import('./ChatDrawer')

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  queryClient.setQueryData(queryKeys.agents.list(systemManagerFilters), mockAgents)
  return queryClient
}

function renderDrawer(path = '/?chat=expanded') {
  return renderToStaticMarkup(
    <QueryClientProvider client={createQueryClient()}>
      <ChatApiProvider overrides={{ listAgents: async () => mockAgents as never }}>
        <MemoryRouter initialEntries={[path]}>
          <ChatDrawer dependencies={{ ChatComponent: ChatFixture }} />
        </MemoryRouter>
      </ChatApiProvider>
    </QueryClientProvider>
  )
}

describe('ChatDrawer header controls', () => {
  test('fully hides a closed assistant even with flex panel styling', () => {
    const html = renderDrawer('/')
    expect(html).toContain('style="display:none"')
    expect(html).not.toContain('data-testid="injected-chat-fixture"')
  })

  test('launcher has no fullscreen control and shows the approved suggestions', () => {
    const html = renderDrawer('/?chat=open')
    expect(html).not.toContain('title="Expand"')
    expect(html).not.toContain('data-testid="injected-chat-fixture"')
    expect(html).toContain('Summarize progress across my squads')
    expect(html).toContain('Help me set up a new project')
    expect(html).not.toContain('Help me investigate a failed work stream')
  })

  test('shows context usage and idle actions for selected system manager agents', () => {
    mockAgents = [{ ...idleAgent, status: 'idle' }]

    const html = renderDrawer()

    expect(html).toContain('data-testid="injected-chat-fixture"')
    expect(html).toContain('aria-label="Context used"')
    expect(html).toContain('42%')
    expect(html).toContain('aria-label="Agent actions"')
    expect(html).not.toContain('>Reset<')
    expect(html).not.toContain('>Delete<')
  })

  test('hides Compact, Reset, and Delete when selected agent is running', () => {
    mockAgents = [{ ...idleAgent, status: 'running' }]

    const html = renderDrawer()

    expect(html).toContain('aria-label="Context used"')
    expect(html).not.toContain('>Compact<')
    expect(html).not.toContain('Reset')
    expect(html).not.toContain('Delete')
  })

  test('shows only window controls for a new chat with no selected agent', () => {
    mockAgents = []

    const html = renderDrawer()

    expect(html).not.toContain('aria-label="Context used"')
    expect(html).not.toContain('>Compact<')
    expect(html).not.toContain('Reset')
    expect(html).not.toContain('Delete')
    expect(html).toContain('Close (Esc)')
  })

  test('delete confirmation operation deletes the agent and resets drawer state', async () => {
    const deleteFn = mock(async () => undefined)
    const setSelection = mock(() => undefined)
    const startNewChat = mock(() => undefined)
    const setAgentActionsOpen = mock(() => undefined)

    await runDeleteAgent('agent-1', deleteFn)
    applyPostDeleteDrawerState({ setSelection, startNewChat, setAgentActionsOpen })

    expect(deleteFn).toHaveBeenCalledWith('agent-1')
    expect(setSelection).toHaveBeenCalledWith('new')
    expect(startNewChat).toHaveBeenCalled()
    expect(setAgentActionsOpen).toHaveBeenCalledWith(false)
  })
})
