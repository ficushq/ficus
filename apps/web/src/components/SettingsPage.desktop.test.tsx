import { fireEvent } from '@testing-library/dom'
import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'

function buildDependencies(logout: () => Promise<void>) {
  return {
    useAuth: () => ({
      authRequired: true,
      authStatus: { mode: 'passkey', authEnabled: true, hasUsers: true, hasAdminUser: true },
      logout,
    }),
    useTheme: () => ({ theme: 'light' as const, toggleTheme: () => undefined }),
    usePushNotifications: () => ({
      isSupported: false,
      isSubscribed: false,
      permission: 'default' as const,
      subscriptions: [],
      currentSubscriptionId: null,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      removeSubscription: () => undefined,
      error: null,
    }),
    useNotificationSound: () => ({ enabled: false, toggle: () => undefined }),
    createPingSound: () => undefined,
    useOfflineCache: () => ({ cacheStats: { entryCount: 0 }, clearCache: async () => undefined }),
    usePWA: () => ({
      isStandalone: false,
      canInstall: false,
      isSupported: true,
      platform: 'desktop' as const,
      updateAvailable: false,
      isOnline: true,
      promptInstall: () => undefined,
      applyUpdate: () => undefined,
    }),
  }
}

function seedAccountQueries(queryClient: QueryClient) {
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: [] })
  queryClient.setQueryData(queryKeys.auth.me(), {
    id: 'u1',
    email: 'admin@example.com',
    displayName: 'Admin',
    createdAt: '2026-01-01T00:00:00Z',
  })
  queryClient.setQueryData(queryKeys.auth.myCredentials(), [])
}

afterEach(() => {
  delete window.ficusDesktopApp
})

test('a paired remote instance shows Disconnect and calls disconnect, never logout', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seedAccountQueries(queryClient)
  let logoutCalls = 0
  let disconnectCalls = 0
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    instance: {
      kind: 'remote',
      name: 'noah',
      disconnect: async () => {
        disconnectCalls++
      },
    },
  }
  try {
    const { SettingsPage } = await import('./SettingsPage')
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=account']}>
            <SettingsPage
              dependencies={buildDependencies(async () => {
                logoutCalls++
              })}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    expect(container.textContent).toContain('Disconnect this Mac from noah')
    expect(container.textContent).not.toContain('Sign out of this device')
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Disconnect')
    expect(button).not.toBeUndefined()

    await dom.act(async () => fireEvent.click(button!))

    expect(disconnectCalls).toBe(1)
    expect(logoutCalls).toBe(0)
  } finally {
    await dom.cleanup()
  }
})

test('without a paired remote instance the logout row is unchanged', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seedAccountQueries(queryClient)
  let logoutCalls = 0
  try {
    const { SettingsPage } = await import('./SettingsPage')
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=account']}>
            <SettingsPage
              dependencies={buildDependencies(async () => {
                logoutCalls++
              })}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    expect(container.textContent).toContain('Sign out of this device')
    expect(container.textContent).not.toContain('Disconnect this Mac from')
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Logout')
    expect(button).not.toBeUndefined()

    await dom.act(async () => fireEvent.click(button!))

    expect(logoutCalls).toBe(1)
  } finally {
    await dom.cleanup()
  }
})

test('a remote instance with a non-function disconnect keeps the existing Logout row', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seedAccountQueries(queryClient)
  let logoutCalls = 0
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    instance: {
      kind: 'remote',
      name: 'noah',
      // @ts-expect-error exercising a malformed disconnect from an untrusted/older bridge
      disconnect: 'not a function',
    },
  }
  try {
    const { SettingsPage } = await import('./SettingsPage')
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=account']}>
            <SettingsPage
              dependencies={buildDependencies(async () => {
                logoutCalls++
              })}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    expect(container.textContent).toContain('Sign out of this device')
    expect(container.textContent).not.toContain('Disconnect this Mac from')
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Logout')
    expect(button).not.toBeUndefined()

    await dom.act(async () => fireEvent.click(button!))

    expect(logoutCalls).toBe(1)
  } finally {
    await dom.cleanup()
  }
})

test('a rejected disconnect shows an inline error instead of failing silently', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seedAccountQueries(queryClient)
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    instance: {
      kind: 'remote',
      name: 'noah',
      disconnect: async () => {
        throw new Error('Disconnect failed')
      },
    },
  }
  try {
    const { SettingsPage } = await import('./SettingsPage')
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=account']}>
            <SettingsPage dependencies={buildDependencies(async () => {})} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Disconnect')
    expect(button).not.toBeUndefined()

    await dom.act(async () => fireEvent.click(button!))

    expect(container.textContent).toContain('Disconnect failed')
  } finally {
    await dom.cleanup()
  }
})

test('a remote instance without disconnect keeps the existing Logout row', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seedAccountQueries(queryClient)
  let logoutCalls = 0
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    instance: { kind: 'remote', name: 'noah' },
  }
  try {
    const { SettingsPage } = await import('./SettingsPage')
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=account']}>
            <SettingsPage
              dependencies={buildDependencies(async () => {
                logoutCalls++
              })}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    expect(container.textContent).toContain('Sign out of this device')
    expect(container.textContent).not.toContain('Disconnect this Mac from')
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Logout')
    expect(button).not.toBeUndefined()

    await dom.act(async () => fireEvent.click(button!))

    expect(logoutCalls).toBe(1)
  } finally {
    await dom.cleanup()
  }
})
