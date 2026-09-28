import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ConversationClientProvider } from '@ficus/client-react'
import { WebSocketContext } from '../hooks/useWebSocket'

const agent = {
  id: 'parent-1',
  agentTypeId: 'manager',
  squadId: null,
  status: 'idle',
  metadata: { name: 'Agent Alpha' },
  context: { scope: { type: 'system-manager' } },
  createdAt: '2026-05-05T00:00:00.000Z',
  lastMessageAt: '2026-05-05T00:00:00.000Z',
  sessionUsage: { context: { percent: 42, contextWindow: 100000 }, stats: { tokens: { total: 1234 }, cost: 0.56 } },
}

const child = { ...agent, id: 'sa-1', metadata: { name: 'Researcher', purpose: 'Research the API' }, status: 'running' }

const { AgentConversation } = await import('./AgentConversationBody')
const { SubagentsInlinePanel } = await import('./SubagentsInlinePanel')

function createClient(children = [child]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  for (const a of [agent, child]) {
    queryClient.setQueryData(['agents', 'detail', a.id], a)
    queryClient.setQueryData(['agents', 'activeExecution', a.id], null)
    queryClient.setQueryData(['agents', a.id, 'sandboxStatus'], null)
    queryClient.setQueryData(['agents', 'children', a.id], [])
  }
  queryClient.setQueryData(['agents', 'children', 'parent-1'], children)
  queryClient.setQueryData(['agentTypes', 'detail', 'manager'], {
    id: 'manager',
    name: 'manager',
    model: 'anthropic:claude-sonnet-4-5',
  })
  return queryClient
}

function renderConversation(entry: string, children = [child], embedded = false) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={createClient(children)}>
        <ConversationClientProvider client={{} as never}>
          <AgentConversation agentId="parent-1" embedded={embedded} />
        </ConversationClientProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

function renderPanel(entry: string, children = [child]) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={createClient(children)}>
        <ConversationClientProvider client={{} as never}>
          {/* Per-render context override: the panel's transcript subscribes for real. */}
          <WebSocketContext.Provider value={{ isConnected: false, subscribe: () => () => undefined }}>
            <SubagentsInlinePanel parentAgentId="parent-1" />
          </WebSocketContext.Provider>
        </ConversationClientProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('AgentConversation subagents UX', () => {
  test('does not render modal content from a subagent query param', () => {
    const html = renderConversation('/?subagent=missing')
    expect(html).not.toContain('No subagents.')
    expect(html).not.toContain('Select a subagent to view its transcript.')
  })

  test('embedded child conversation does not show subagent controls', () => {
    const html = renderConversation('/', [child], true)
    expect(html).not.toContain('Subagents')
  })
})

describe('SubagentsInlinePanel', () => {
  test('renders child list and selected conversation from deep link', () => {
    const html = renderPanel('/?view=subagents&subagent=sa-1')
    expect(html).toContain('Researcher')
    expect(html).toContain('Loading conversation')
    expect(html).toContain('<main class="flex flex-col grow min-w-0 min-h-0 overflow-hidden">')
  })

  test('renders an empty state without modal chrome when no children exist', () => {
    const html = renderPanel('/?view=subagents&subagent=sa-1', [])
    expect(html).toContain('No subagents.')
    expect(html).not.toContain('Select a subagent to view its transcript.')
  })
})
