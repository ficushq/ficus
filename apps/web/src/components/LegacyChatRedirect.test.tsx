import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { assistantAgentChatPath, type Agent, type Squad } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { untilRendered } from '../test/untilRendered'
import { queries } from '../queryOptions'
import { LegacyChatRedirect } from './LegacyChatRedirect'

const now = new Date('2026-11-21T00:00:00Z')
const squad = { id: 'squad-1', name: 'Ficus', createdAt: now } as unknown as Squad
const agents = {
  worker: { id: 'worker', squadId: 'squad-1', agentTypeId: 'engineer', status: 'idle', metadata: {} },
  system: { id: 'system', squadId: null, agentTypeId: 'manager', status: 'idle', metadata: {} },
} as unknown as Record<string, Agent>

async function redirectFrom(url: string) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  // An unloadable agent is seeded as already failed, so the test never reaches the network.
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  })
  cache.setQueryData(queries.squads.list().queryKey, [squad])
  for (const agent of Object.values(agents)) cache.setQueryData(queries.agents.detail(agent.id).queryKey, agent)
  cache
    .getQueryCache()
    .build(cache, { queryKey: queries.agents.detail('gone').queryKey })
    .setState({ status: 'error', error: new Error('Not found'), fetchStatus: 'idle', errorUpdatedAt: Date.now() })
  let location = ''
  function Probe() {
    const current = useLocation()
    location = current.pathname + current.search
    return null
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path="/chat" element={<LegacyChatRedirect />} />
              <Route path="/chat/:agentId" element={<LegacyChatRedirect />} />
              <Route path="*" element={null} />
            </Routes>
            <Probe />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await untilRendered(dom, () => expect(location.startsWith('/chat')).toBe(false))
    return location
  } finally {
    await dom.cleanup()
    cache.clear()
  }
}

test('an old /chat link to a squad agent opens its squad Chats tab', async () => {
  expect(await redirectFrom('/chat/worker')).toBe('/squads/ficus/agents?agent=worker')
  expect(await redirectFrom('/chat/worker?scope=squad-worker&view=info')).toBe('/squads/ficus/agents?agent=worker')
})

test('an old /chat link to a squadless agent opens the Assistant view of it', async () => {
  expect(await redirectFrom('/chat/system?scope=system-manager')).toBe(assistantAgentChatPath('system'))
})

test('an old /chat link to an agent that cannot be loaded still leaves the legacy page for the Assistant', async () => {
  expect(await redirectFrom('/chat/gone')).toBe(assistantAgentChatPath('gone'))
})

test('the bare chat page and its new-chat link open the Assistant', async () => {
  expect(await redirectFrom('/chat')).toBe('/?chat=open')
  expect(await redirectFrom('/chat?new')).toBe('/?chat=open')
})
