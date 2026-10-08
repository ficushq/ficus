import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { desktopQueryKeys } from '../queryKeys'
import { DesktopNotifications } from './DesktopNotifications'
import type { DesktopNotificationBatch } from '../lib/desktop'

test('a desktop build that already polls notifications itself is never polled again by the web app', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  // No react-query cache is seeded here (unlike the test below): a disabled query still
  // returns any cached value, so the only way to prove the web app never polls is to
  // start from an empty cache and confirm nothing gets fetched or delivered into it.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const delivered: DesktopNotificationBatch[] = []
  const requestedUrls: string[] = []
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input))
      return Response.json(null)
    }) as typeof globalThis.fetch
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => true,
      deliverNotifications: async (value) => {
        delivered.push(value)
      },
      notificationsPolledByShell: true,
    }
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <DesktopNotifications />
        </QueryClientProvider>
      )
    )
    expect(delivered).toEqual([])
    expect(requestedUrls.some((url) => url.includes('/api/push/desktop'))).toBe(false)
  } finally {
    await dom.cleanup()
    delete window.ficusDesktopApp
    client.clear()
    globalThis.fetch = previousFetch
  }
})

test('only an enabled desktop bridge receives cached or newly fetched alerts, without marking inbox items read', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const delivered: DesktopNotificationBatch[] = []
  const batch: DesktopNotificationBatch = {
    userId: 'user',
    notifications: [
      { id: 'notification', title: 'Ready', body: 'Review', url: '/inbox', createdAt: new Date().toISOString() },
    ],
  }
  try {
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => true,
      deliverNotifications: async (value) => {
        delivered.push(value)
      },
    }
    client.setQueryData(desktopQueryKeys.enabled(), true)
    client.setQueryData(desktopQueryKeys.notifications(), batch)
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <DesktopNotifications />
        </QueryClientProvider>
      )
    )
    expect(delivered).toEqual([batch])
    await dom.act(async () => {
      client.setQueryData(desktopQueryKeys.enabled(), false)
      await client.invalidateQueries({ queryKey: desktopQueryKeys.enabled(), refetchType: 'none' })
    })
    await dom.act(async () => {
      client.setQueryData(desktopQueryKeys.notifications(), { ...batch, notifications: [] })
    })
    expect(delivered).toEqual([batch])
  } finally {
    await dom.cleanup()
    delete window.ficusDesktopApp
    client.clear()
  }
})
