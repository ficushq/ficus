import { waitFor } from '@testing-library/dom'
import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { EntityReferenceModal, preloadEntityReference } from './EntityReferenceModal'
import { EntityReferenceLink } from './EntityReferenceLink'

const id = 'fa27abb6-4c92-4cc6-aff9-a8da616346c1'

test('reference hover preloads before clicking, and pending/error states keep the link label stable', async () => {
  let start!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  let release!: () => void
  const responseReady = new Promise<void>((resolve) => {
    release = resolve
  })
  const dom = await acquireDomHarness({
    configureWindow(window) {
      window.fetch = async () => {
        start()
        await responseReady
        return new window.Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      }
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <EntityReferenceLink reference={{ kind: 'ws', id }}>My work</EntityReferenceLink>
        </QueryClientProvider>
      )
    )
    const link = dom.window.document.querySelector('button')!
    await dom.act(async () => {
      link.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
      await started
    })
    expect(link.getAttribute('aria-busy')).toBe('false')
    await dom.act(async () => link.click())
    expect(link.textContent).toBe('My work')
    expect(link.getAttribute('aria-busy')).toBe('true')
    expect(link.className).toContain('motion-safe:animate-pulse')
    expect(dom.window.document.body.textContent).not.toContain('Loading')
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event.query.state.status !== 'error') return
        unsubscribe()
        resolve()
      })
    })
    await dom.act(async () => {
      release()
      await failed
    })
    await dom.act(async () => {
      await new Promise<void>((resolve) => {
        const ready = () => dom.window.document.body.textContent?.includes('could not be opened')
        if (ready()) return resolve()
        const observer = new dom.window.MutationObserver(() => {
          if (!ready()) return
          observer.disconnect()
          resolve()
        })
        observer.observe(dom.window.document.body, { childList: true, subtree: true, characterData: true })
      })
    })
    expect(dom.window.document.body.textContent).toContain('could not be opened')
    expect(link.textContent).toBe('My work')
    expect(link.className).not.toContain('animate-pulse')
  } finally {
    release()
    await dom.cleanup()
    client.clear()
  }
})

test('preloading a cached agent prefix populates the canonical destination cache', async () => {
  const { queries } = await import('../queryOptions')
  const client = new QueryClient()
  try {
    const agent = { id, squadId: 'ficus' }
    const prefix = id.slice(0, 8)
    client.setQueryData(queries.agents.detail(prefix).queryKey, agent)
    await preloadEntityReference(client, { kind: 'agent', id: prefix })
    expect(client.getQueryData(queries.agents.detail(id).queryKey)).toEqual(agent)
  } finally {
    client.clear()
  }
})

test('work stream references resolve by ID and present a closable permission/error state', async () => {
  const requests: string[] = []
  const dom = await acquireDomHarness({
    url: 'https://example.test/mounted/chat',
    configureWindow(window) {
      window.fetch = async (url) => {
        requests.push(String(url))
        return new window.Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      }
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let closed = false
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <EntityReferenceModal
            reference={{ kind: 'ws', id }}
            onClose={() => {
              closed = true
            }}
          />
        </QueryClientProvider>
      )
    )
    await dom.act(async () => {
      await new Promise<void>((resolve) => {
        const ready = () => dom.window.document.body.textContent?.includes('could not be opened')
        if (ready()) return resolve()
        const observer = new dom.window.MutationObserver(() => {
          if (ready()) {
            observer.disconnect()
            resolve()
          }
        })
        observer.observe(dom.window.document.body, { childList: true, subtree: true, characterData: true })
      })
    })
    expect(requests.some((url) => url.endsWith(`/api/workstreams/${id}`))).toBe(true)
    expect(dom.window.location.pathname).toBe('/mounted/chat')
    const close = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    expect(close).not.toBeNull()
    await dom.act(async () => close.click())
    expect(closed).toBe(true)
  } finally {
    await dom.cleanup()
    client.clear()
  }
})

test('agent prefixes navigate to squad Chats with the full ID and preserve Back history', async () => {
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
  const { queries } = await import('../queryOptions')
  const dom = await acquireDomHarness({})
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const prefix = id.slice(0, 8)
  client.setQueryData(queries.agents.detail(prefix).queryKey, { id, squadId: 'ficus' })
  let closed = false
  const router = createMemoryRouter(
    [
      {
        path: '/source',
        element: (
          <EntityReferenceModal
            reference={{ kind: 'agent', id: prefix }}
            onClose={() => {
              closed = true
            }}
          />
        ),
      },
      { path: '/squads/:squadId/agents', element: <p>Squad chats</p> },
    ],
    { initialEntries: ['/source'] }
  )
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      )
    )
    expect(closed).toBe(true)
    expect(router.state.location.pathname).toBe('/squads/ficus/agents')
    expect(router.state.location.search).toBe(`?agent=${id}`)
    expect(router.state.historyAction).toBe('PUSH')
    // Unmount the resolver before going back, as closing the reference does in the app.
    await dom.act(async () => root.unmount())
    await router.navigate(-1)
    expect(router.state.location.pathname).toBe('/source')
  } finally {
    router.dispose()
    await dom.cleanup()
    client.clear()
  }
})

for (const status of [403, 404, 409]) {
  test(`agent resolution ${status} never invokes Activity's opener or leaks response details`, async () => {
    const { MemoryRouter } = await import('react-router-dom')
    const dom = await acquireDomHarness({
      configureWindow(window) {
        window.fetch = async () => new window.Response(JSON.stringify({ error: 'private agent detail' }), { status })
      },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let opened = false
    let closed = false
    try {
      const { root } = dom.createRoot()
      await dom.act(async () => {
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <EntityReferenceModal
                reference={{ kind: 'agent', id: 'abc12345' }}
                onOpenAgent={() => {
                  opened = true
                }}
                onClose={() => {
                  closed = true
                }}
              />
            </QueryClientProvider>
          </MemoryRouter>
        )
      })
      await dom.act(async () => {
        await waitFor(() =>
          expect(dom.window.document.body.textContent).toContain('ambiguous, unavailable, or inaccessible')
        )
      })
      expect(dom.window.document.body.textContent).toContain('ambiguous, unavailable, or inaccessible')
      expect(dom.window.document.body.textContent).not.toContain('private agent detail')
      expect(opened).toBe(false)
      await dom.act(() => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
      expect(closed).toBe(true)
    } finally {
      client.clear()
      await dom.cleanup()
    }
  })
}
