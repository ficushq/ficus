import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import type { Agent, SessionUsage } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ChatApiProvider } from '../api/ChatApiProvider'
import { PermissionsProvider } from '../hooks/usePermissions'
import { AgentConversation } from './AgentConversationBody'
import { QueryInvalidator } from './QueryInvalidator'

/**
 * The composer's context ring, end to end in the browser: a running turn's
 * `agent.updated` frame (Core sends one after every persisted message) must
 * refetch the agent and visibly move the ring's label, with no reload.
 *
 * The usage figures are from a live agent mid-turn: one step on its 1M-token
 * window moved the context from 71,679 to 72,606 tokens (7.17% to 7.26%), while
 * the session's cumulative token count (mostly cache reads) passed a million.
 */
type Callback = (entry: { event: string; data: unknown }) => void

const usage = (contextTokens: number, sessionTotal: number): SessionUsage => ({
  stats: {
    userMessages: 1,
    assistantMessages: 19,
    totalMessages: 40,
    tokens: { input: 38, output: 4_791, cacheRead: sessionTotal - 63_990, cacheWrite: 59_161, total: sessionTotal },
    cost: 0,
  },
  context: { tokens: contextTokens, contextWindow: 1_000_000, percent: (contextTokens / 1_000_000) * 100 },
})

/** Renders the composer status the way AgentChat hands it to the composer. */
const TestAgentChat = ({
  composerStatus,
}: {
  composerStatus?: ReactNode | ((state: { waitingForSandbox: boolean }) => ReactNode)
}) => <div>{typeof composerStatus === 'function' ? composerStatus({ waitingForSandbox: false }) : composerStatus}</div>

describe('AgentConversation context ring', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let client: QueryClient
  let captured: Map<string, Callback>
  let serverUsage: SessionUsage
  let agentFetches: number

  const subscribe = (topic: string, callback: Callback) => {
    captured.set(topic, callback)
    return () => captured.delete(topic)
  }
  const usePermissions = () => ({ permissions: [], can: () => true, isLoading: false, isError: false })
  const ringLabel = () =>
    dom.window.document.querySelector('button[aria-label^="Context "]')?.getAttribute('aria-label') ?? null

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    root = dom.createRoot().root
    // The app's own freshness window: only an invalidation can refetch the agent mid-turn.
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } })
    captured = new Map()
    serverUsage = usage(71_679, 1_087_969)
    agentFetches = 0
  })

  afterEach(async () => {
    await dom.cleanup()
    client.clear()
  })

  test('a running turn moves the ring after each persisted message, without a reload', async () => {
    const getAgent = async (id: string) => {
      agentFetches += 1
      return { id, squadId: 'squad-a', status: 'active', terminatedAt: null, sessionUsage: serverUsage } as Agent
    }
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider usePermissions={usePermissions}>
            <ChatApiProvider
              overrides={{ getAgent, getActiveExecution: async () => ({ active: true, status: 'running' }) }}
            >
              <AgentConversation agentId="agent-a" dependencies={{ AgentChatComponent: TestAgentChat as never }} />
            </ChatApiProvider>
            <QueryInvalidator dependencies={{ queryClient: client, subscribe }} />
          </PermissionsProvider>
        </QueryClientProvider>
      )
    })
    await dom.act(async () => {
      await waitFor(() => expect(ringLabel()).toBe('Context 7.2% used'))
    })
    const fetchesBefore = agentFetches

    // The next step persists; Core rewrites the agent's usage and announces it.
    serverUsage = usage(72_606, 1_160_441)
    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: 'agent-a', squadId: 'squad-a' } })
    })
    await dom.act(async () => {
      await waitFor(() => expect(ringLabel()).toBe('Context 7.3% used'))
    })
    expect(agentFetches).toBeGreaterThan(fetchesBefore)

    // The numbers behind the ring are the context's own, consistent with the percentage,
    // never the session's cumulative usage (1.2M here, more than the window holds).
    const title = dom.window.document.querySelector('button[aria-label^="Context "]')?.getAttribute('title')
    expect(title).toBe('Context 7.3% used · 72.6k of 1.0M tokens')
  })
})
