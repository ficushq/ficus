import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { GlobalSquadActivityItem, WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable, type ApiRoutes } from '../test/apiMock'
import { useHoverTimer } from '../test/hoverTimer'
import { untilSettled } from '../test/untilRendered'
import { WebSocketContext, type WebSocketContextValue } from '../hooks/useWebSocket'
import { REFRESH_DEBOUNCE_MS, WorkStreamRecentActivity } from './WorkStreamRecentActivity'

const stream = { id: 'ws-1', number: 12, squadId: 'squad-1', title: 'Make retries safe' } as WorkStream

const row = (index: number): GlobalSquadActivityItem => ({
  id: `row-${index}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0) - index * 60_000).toISOString(),
  agentId: 'agent-engineer',
  agentTypeId: 'engineer',
  kind: 'message',
  summary: `Step ${index} done`,
  preview: [{ text: `Step ${index} done` }],
  ref: { type: 'agent', agentId: 'agent-engineer', view: 'chat' },
  context: { workStream: { id: stream.id, number: 12, title: stream.title, step: 'implement' } },
  squadId: stream.squadId,
})

/** A socket that records its subscriptions, so a test can push a squad activity event or drop the line. */
function fakeSocket(isConnected = true) {
  const listeners = new Map<string, () => void>()
  const value = {
    isConnected,
    subscribe: (topic: string, callback: () => void) => {
      listeners.set(topic, callback)
      return () => listeners.delete(topic)
    },
  } as unknown as WebSocketContextValue
  return { value, listeners, push: () => listeners.get(`squadActivity:${stream.squadId}`)?.() }
}

async function renderRecent(
  activity: ApiRoutes[string],
  inspect: (page: {
    body: HTMLElement
    requests: () => number
    socket: ReturnType<typeof fakeSocket>
    rerender: (socket: WebSocketContextValue) => Promise<void>
    unmount: () => Promise<void>
    act: (fn: () => Promise<void> | void) => Promise<void>
    until: (check: () => void) => Promise<void>
  }) => Promise<void>
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let requests = 0
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      '/api/activity': (request) => {
        requests++
        return typeof activity === 'function' ? activity(request) : activity
      },
    },
    beforeUnmount: async () => queryClient.cancelQueries(),
    afterUnmount: () => queryClient.clear(),
  })
  const socket = fakeSocket()
  const rendered = dom.createRoot()
  const render = (value: WebSocketContextValue) =>
    dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WebSocketContext.Provider value={value}>
              <WorkStreamRecentActivity stream={stream} />
            </WebSocketContext.Provider>
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
  try {
    await render(socket.value)
    const body = dom.window.document.body
    await untilSettled(dom, () => expect(body.querySelector('[aria-label="Loading recent activity"]')).toBeNull())
    await inspect({
      body,
      requests: () => requests,
      socket,
      rerender: render,
      unmount: () => dom.act(async () => rendered.root.unmount()),
      act: (fn) => dom.act(async () => void (await fn())),
      until: (check) => untilSettled(dom, check),
    })
  } finally {
    await dom.cleanup()
  }
}

const page = (items: GlobalSquadActivityItem[]) => ({ items, hasMore: false, nextCursor: null, squads: {} })

describe('WorkStreamRecentActivity', () => {
  test('says so when the stream has no activity yet', async () => {
    await renderRecent(page([]), async ({ body }) => {
      expect(body.textContent).toContain('No activity yet.')
      expect(body.querySelector('[data-recent-activity-row]')).toBeNull()
    })
  })

  test('says so when its activity cannot be loaded, and keeps the link to Activity', async () => {
    await renderRecent(apiUnavailable, async ({ body }) => {
      expect(body.textContent).toContain('Recent activity could not be loaded.')
      const link = [...body.querySelectorAll('a')].find((anchor) => anchor.textContent === 'View all in Activity')
      expect(link?.getAttribute('href')).toBe('/activity?workStream=ws-1')
    })
  })

  test('refetches once for a burst of squad activity, after the debounce', async () => {
    await renderRecent(page([1, 2].map(row)), async ({ body, requests, socket, act, until }) => {
      expect(body.querySelectorAll('[data-recent-activity-row]')).toHaveLength(2)
      expect(requests()).toBe(1)
      const timer = useHoverTimer(REFRESH_DEBOUNCE_MS)
      try {
        await act(() => {
          socket.push()
          socket.push()
          socket.push()
        })
        // Each event restarts the one pending refresh; nothing is fetched until it fires.
        expect(timer.pending()).toBe(1)
        expect(requests()).toBe(1)
        await timer.advance()
      } finally {
        timer.restore()
      }
      await until(() => expect(requests()).toBe(2))
    })
  })

  test('unsubscribes and drops a pending refresh when it unmounts', async () => {
    await renderRecent(page([row(1)]), async ({ requests, socket, act, unmount }) => {
      expect(socket.listeners.has('squadActivity:squad-1')).toBe(true)
      const timer = useHoverTimer(REFRESH_DEBOUNCE_MS)
      try {
        await act(() => socket.push())
        expect(timer.pending()).toBe(1)
        await unmount()
        expect(socket.listeners.size).toBe(0)
        expect(timer.pending()).toBe(0)
        expect(requests()).toBe(1)
      } finally {
        timer.restore()
      }
    })
  })

  test('refetches after the socket reconnects, since events may have been missed', async () => {
    await renderRecent(page([row(1)]), async ({ requests, rerender, until }) => {
      expect(requests()).toBe(1)
      await rerender(fakeSocket(false).value)
      expect(requests()).toBe(1)
      await rerender(fakeSocket(true).value)
      await until(() => expect(requests()).toBe(2))
    })
  })
})
