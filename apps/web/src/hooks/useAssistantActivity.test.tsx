import { afterEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssistantActivityPage } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { assistantQueryKeys, queryKeys } from '../queryKeys'
import { useAssistantActivity } from './useAssistantActivity'

const owner = '507a9ac0-164e-4f49-9441-e57522bdc52b'
const other = '6a1c0b4e-8c2d-4f3e-9a7b-1c2d3e4f5a6b'
const page = (unreadConversations: number): AssistantActivityPage => ({
  totals: {
    unreadConversations,
    unreadUpdates: unreadConversations,
    workingTasks: 1,
    waitingTasks: 0,
    needsInputTasks: 0,
    unavailableTasks: 0,
  },
  conversations: [],
  hasMore: false,
})

let latest: ReturnType<typeof useAssistantActivity> | undefined
function Probe() {
  latest = useAssistantActivity()
  return <span data-testid="count">{latest.unreadConversations}</span>
}

function seed(queryClient: QueryClient, userId: string, permissions: string[]) {
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), {
    permissions,
    identity: { type: 'user', userId },
  })
}

const fetchSpy = spyOn(globalThis, 'fetch')
afterEach(() => {
  fetchSpy.mockClear()
  latest = undefined
})

test('reports unread conversations from cached activity without any network or realtime activity', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    seed(queryClient, owner, ['chat:send'])
    queryClient.setQueryData(assistantQueryKeys.activity(owner, 0), page(3))
    const { root, container } = dom.createRoot()
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>
      )
    })
    expect(container.textContent).toBe('3')
    expect(latest?.ownerId).toBe(owner)
    expect(fetchSpy).not.toHaveBeenCalled()

    // A failed refresh keeps the previous count instead of collapsing to zero.
    const query = queryClient.getQueryCache().find({ queryKey: assistantQueryKeys.activity(owner, 0) })!
    await dom.act(async () => {
      query.setState({ status: 'error', error: new Error('offline'), fetchStatus: 'idle' })
    })
    expect(container.textContent).toBe('3')

    // Switching the signed-in owner must not reuse the previous owner's cached activity.
    await dom.act(async () => {
      seed(queryClient, other, ['chat:send'])
    })
    // The permissions observer notifies asynchronously; wait for the re-render it triggers.
    for (let attempt = 0; attempt < 20 && latest?.ownerId !== other; attempt++)
      await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    expect(latest?.ownerId).toBe(other)
    expect(latest?.activity).toBeUndefined()
    expect(container.textContent).toBe('0')
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
})

test('stays idle without chat:send', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    seed(queryClient, owner, ['squads:read'])
    queryClient.setQueryData(assistantQueryKeys.activity(owner, 0), page(5))
    const { root, container } = dom.createRoot()
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>
      )
    })
    expect(container.textContent).toBe('0')
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
})
