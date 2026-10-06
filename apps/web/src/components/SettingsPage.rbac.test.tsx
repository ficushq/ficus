import { fireEvent } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { integrationQueryKeys, queryKeys, serverConnectionQueryKeys } from '../queryKeys'
import type { IntegrationConnection } from '../api/integrations'
import { PermissionsProvider } from '../hooks/usePermissions'

const dependencies = {
  useAuth: () => ({
    authRequired: true,
    authStatus: { mode: 'passkey', authEnabled: true, hasUsers: true, hasAdminUser: true },
    logout: async () => undefined,
  }),
  useTheme: () => ({
    theme: 'light' as const,
    themeId: 'iris',
    appearance: 'light' as const,
    toggleTheme: () => undefined,
    setTheme: () => undefined,
    setThemeId: () => undefined,
    setAppearance: () => undefined,
  }),
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

type SquadFixture = { id: string; name: string; purpose: string; status: string }
type RenderSettingsOptions = {
  human?: boolean
  managed?: boolean
  squadPermissions?: string[] | Record<string, string[]>
  integrations?: Record<string, IntegrationConnection[]>
  integrationPool?: IntegrationConnection[]
  squads?: SquadFixture[]
}

const defaultSquads: SquadFixture[] = [{ id: 'squad-1', name: 'Research', purpose: 'Research', status: 'active' }]

function seedSettingsQueries(queryClient: QueryClient, permissions: string[], options: RenderSettingsOptions = {}) {
  // Seed the updates-settings query (fetched whenever the viewer holds
  // updates:read) so no test depends on a live fetch; `managed` mirrors the
  // server's FICUS_MANAGED flag.
  queryClient.setQueryData(queryKeys.updates.settings(), {
    settings: { enabled: false, intervalMinutes: 30, remote: 'origin', branch: 'main' },
    status: { active: false, latest: null },
    managed: options.managed ?? false,
  })
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), {
    permissions,
    ...(options.human ? { identity: { type: 'user', userId: 'u1' } } : {}),
  })
  queryClient.setQueryData(serverConnectionQueryKeys.status(), {
    managed: options.managed ?? false,
    configured: options.managed ?? false,
    connected: options.managed ?? false,
    origin: 'https://studio.example.com',
    baseUrl: 'https://ficus.sh',
    manageUrl: 'https://ficus.sh/account/push',
  })
  queryClient.setQueryData(integrationQueryKeys.catalog(), {
    integrations: [
      {
        key: 'bigbrain',
        enabled: true,
        label: 'Bigbrain',
        description: 'Bigbrain',
        capabilities: [],
        assignable: true,
        authorization: { kind: 'manual' },
      },
      {
        key: 'notion',
        enabled: true,
        label: 'Notion',
        description: 'Notion',
        capabilities: [],
        assignable: true,
        authorization: { kind: 'oauth2' },
      },
    ],
  })
  queryClient.setQueryData(integrationQueryKeys.pool('bigbrain'), options.integrationPool ?? [])
  if (options.squadPermissions || options.integrations || options.squads) {
    const squads = options.squads ?? defaultSquads
    queryClient.setQueryData(queryKeys.squads.list('active'), squads)
    for (const squad of squads) {
      const squadPermissions = Array.isArray(options.squadPermissions)
        ? options.squadPermissions
        : (options.squadPermissions?.[squad.id] ?? [])
      queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: squadPermissions })
      queryClient.setQueryData(integrationQueryKeys.squad(squad.id, 'bigbrain'), {
        providerKey: 'bigbrain',
        assignment: options.integrations?.[squad.id]?.[0] ?? null,
        connections: [],
      })
    }
  }
  queryClient.setQueryData(queryKeys.auth.me(), {
    id: 'u1',
    email: 'admin@example.com',
    displayName: 'Admin',
    createdAt: '2026-01-01T00:00:00Z',
  })
  queryClient.setQueryData(queryKeys.auth.myCredentials(), [
    { id: 'cred1', credentialId: 'credential-id', displayName: 'Laptop', createdAt: '2026-01-02T00:00:00Z' },
  ])
}

async function renderSettings(
  route: string,
  permissions: string[],
  options: RenderSettingsOptions = {}
): Promise<string> {
  const { SettingsPage } = await import('./SettingsPage')
  const queryClient = new QueryClient()
  seedSettingsQueries(queryClient, permissions, options)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SettingsPage dependencies={dependencies} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('SettingsPage RBAC tabs', () => {
  test('Mobile is an independent page for a human settings reader without integration grants', async () => {
    const html = await renderSettings('/settings?section=mobile', ['settings:read'], { human: true })
    expect(html).toContain('Ficus, to go.')
    expect(html).toContain('Pick up the thread')
    expect(html).toContain('Connection &amp; Pro coverage')
    expect(html).not.toContain('Search integrations')
    expect(html).not.toContain('Connect Ficus account</button>')
  })

  test('Mobile overview is discoverable to ordinary members without protected relay details', async () => {
    const html = await renderSettings('/settings?section=mobile', [], { human: true })
    expect(html).toContain('Ficus, to go.')
    expect(html).toContain('ask your server administrator')
    expect(html).toContain('Mobile setup guide')
    expect(html).not.toContain('Connection &amp; Pro coverage')
    expect(html).not.toContain('Manage Pro and devices')
  })

  test('Mobile stays hidden without a human identity', async () => {
    const html = await renderSettings('/settings?section=mobile', ['settings:read'])
    expect(html).not.toContain('Ficus, to go.')
    expect(html).not.toContain('Connection &amp; Pro coverage')
  })

  test('Cloud Mobile explains adding the server without a relay connection form', async () => {
    const html = await renderSettings('/settings?section=mobile', ['settings:read', 'settings:write'], {
      human: true,
      managed: true,
    })
    expect(html).toContain('Add this server in the Ficus mobile app')
    expect(html).toContain('managed automatically')
    expect(html).not.toContain('Connect Ficus account</button>')
  })

  test('Integrations points to Mobile without duplicating relay management', async () => {
    const html = await renderSettings(
      '/settings?section=integrations',
      ['settings:read', 'integrations:read:bigbrain'],
      { human: true }
    )
    expect(html).toContain('href="/settings?section=mobile"')
    expect(html).toContain('Set up the mobile app and Pro coverage')
    expect(html).not.toContain('Connection &amp; Pro coverage')
  })

  beforeEach(() => undefined)

  test('opens global Integrations with an instance Bigbrain read/write grant', async () => {
    const html = await renderSettings('/settings?section=integrations', [
      'integrations:read:bigbrain',
      'integrations:write:bigbrain',
    ])

    expect(html).toContain('Integrations')
    expect(html).toContain('Search integrations')
    expect(html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).not.toContain('disabled=')
    expect(html).not.toContain('Create and validate')
    expect(html).not.toContain('Squad')
  })

  test('renders the global lifecycle read-only with instance read permission', async () => {
    const html = await renderSettings('/settings?section=integrations', ['integrations:read:bigbrain'])

    expect(html).toContain('Integrations')
    expect(html).toContain('Enable Bigbrain globally')
    expect(html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=')
    expect(html).not.toContain('Create and validate')
  })

  test('Notion-only instance permission reveals global Integrations without Bigbrain access', async () => {
    const html = await renderSettings('/settings?section=integrations', ['integrations:read:notion'])
    expect(html).toContain('Integrations')
    expect(html).toContain('Notion')
    expect(html).not.toContain('Create and validate')
  })

  test('squad-only integration permission does not reveal the global tab', async () => {
    const html = await renderSettings('/settings?section=integrations', [], {
      squadPermissions: ['integrations:read', 'integrations:write'],
    })

    expect(html).not.toContain('Bigbrain integrations')
    expect(html).not.toContain('Integrations')
    expect(html).toContain('Appearance')
  })

  test('an instance GitHub-specific grant does not expose Bigbrain management', async () => {
    const html = await renderSettings('/settings?section=integrations', ['integrations:read:github'])

    expect(html).not.toContain('Bigbrain integrations')
    expect(html).not.toContain('Integrations')
  })

  test('shows Users and Roles tabs when permissions allow them', async () => {
    const html = await renderSettings('/settings?section=users', ['users:read', 'roles:read'])

    expect(html).toContain('Access')
    expect(html).toContain('Users')
    expect(html).toContain('Roles')
    expect(html).not.toContain('>Sessions<')
  })

  test('hides Users and Roles for non-admin users but keeps self-service Sessions', async () => {
    const html = await renderSettings('/settings', [])

    expect(html).not.toContain('Users')
    expect(html).not.toContain('Roles')
    expect(html).toContain('Sessions')
  })

  test('falls back to General for a gated deep link', async () => {
    const html = await renderSettings('/settings?section=users', [])

    expect(html).toContain('Appearance')
    expect(html).toContain('Appearance')
    expect(html).not.toContain('Manage users and their role assignments')
  })

  test('account section shows editable profile and self-service passkey management', async () => {
    const html = await renderSettings('/settings?section=account', [])

    expect(html).toContain('User display name')
    expect(html).toContain('value="Admin"')
    expect(html).toContain('Save display name')
    expect(html).toContain('Passkeys')
    expect(html).toContain('Laptop')
    expect(html).toContain('Add Passkey')
  })

  test('each passkey row offers both Rename and Remove', async () => {
    const html = await renderSettings('/settings?section=account', [])

    expect(html).toContain('Rename passkey Laptop')
    expect(html).toContain('Remove passkey Laptop')
  })

  test('desktop sidebar nav is height-bound and scrolls independently of the content pane', async () => {
    const html = await renderSettings('/settings?section=users', ['users:read', 'roles:read'])

    // The sidebar wrapper (not the content pane's own `flex-1 overflow-y-auto`)
    // needs a real height constraint (`h-full`, never 100vh/100dvh per the PWA
    // safe-area doctrine — see AgentInfoPanel/SquadDetailPage's identical
    // `h-full overflow-y-auto` idiom for a bounded sibling panel) so a tall
    // 20+ item nav scrolls in place instead of spilling past the viewport.
    expect(html).toContain(
      'class="ficus-panel ficus-glass hidden md:block w-60 flex-shrink-0 h-full overflow-y-auto p-3"'
    )
    expect(html).not.toContain('100vh')
    expect(html).not.toContain('100dvh')
  })
})

describe('SettingsPage onboarding link', () => {
  test('shows a "Set up Ficus" link back to /onboarding at the top level for settings:read holders', async () => {
    const html = await renderSettings('/settings?section=features', ['settings:read'])

    expect(html).toContain('href="/onboarding"')
    expect(html).toContain('Set up Ficus')
  })

  test('hides the onboarding link for viewers without settings:read — same gate OnboardingPage itself uses', async () => {
    const html = await renderSettings('/settings?section=users', ['users:read', 'roles:read'])

    expect(html).not.toContain('href="/onboarding"')
  })

  test('hides the Updates tab entirely on a platform-managed instance, including deep-links', async () => {
    const html = await renderSettings('/settings?section=updates', ['settings:read', 'updates:read'], {
      managed: true,
    })

    expect(html).not.toContain('Updates')
    // The deep-link falls back to General instead of rendering the section.
    expect(html).toContain('Appearance')
  })

  test('keeps the Updates tab on a self-hosted instance', async () => {
    const html = await renderSettings('/settings?section=updates', ['updates:read'], { managed: false })

    expect(html).toContain('Updates')
  })

  test('the onboarding link trails the Admin group (below Updates) — setup is a launch-time task, not the lead item', async () => {
    // updates:read makes the Updates tab render — the anchor the link must trail.
    const html = await renderSettings('/settings?section=users', ['settings:read', 'users:read', 'updates:read'])

    const linkIndex = html.indexOf('href="/onboarding"')
    const updatesIndex = html.indexOf('Updates')
    expect(linkIndex).toBeGreaterThan(-1)
    expect(updatesIndex).toBeGreaterThan(-1)
    expect(linkIndex).toBeGreaterThan(updatesIndex)
  })
})

describe('SettingsPage global integration RBAC', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let queryClient: QueryClient | undefined
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let requests: Array<{ url: string; method: string }>
  let oldFetch: typeof globalThis.fetch

  const squads: SquadFixture[] = [
    { id: 'squad-1', name: 'Research', purpose: 'Research', status: 'active' },
    { id: 'squad-2', name: 'Operations', purpose: 'Operations', status: 'active' },
  ]
  const operationsConnection: IntegrationConnection = {
    id: 'conn-ops',
    providerKey: 'bigbrain',
    adapterVersion: 1,
    displayName: 'Operations Brain',
    configuration: { version: 1, apiBase: 'https://ops.bigbrain.example' },
    credentialConfigured: true,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: [],
    validatedAt: '2026-01-10T00:00:00Z',
    validationExpiresAt: '2026-02-10T00:00:00Z',
    lastErrorCode: null,
    usage: { squadCount: 0, squads: [] },
  }

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: async () => {
        await queryClient?.cancelQueries()
        queryClient?.clear()
      },
    })
    ;({ container, root } = dom.createRoot())
    requests = []
    oldFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' })
      return Response.json(null)
    }) as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = oldFetch
    await dom.cleanup()
    queryClient = undefined
  })

  const bigbrainCard = () =>
    [...container.querySelectorAll('article')].find(
      (section) => section.querySelector('h4')?.textContent === 'Bigbrain'
    )!
  const buttonTexts = (node: Element) => [...node.querySelectorAll('button')].map((button) => button.textContent)
  const observerCount = (queryKey: readonly unknown[]) =>
    queryClient!.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() ?? 0

  for (const provider of ['github', 'notion'] as const) {
    test(`${provider} callback destination selects Administration and reveals its settings after catalog loading`, async () => {
      const { SettingsPage } = await import('./SettingsPage')
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
      seedSettingsQueries(queryClient, ['integrations:read'], {})
      queryClient.removeQueries({ queryKey: integrationQueryKeys.catalog() })
      let resolveCatalog!: (value: Response) => void
      const catalogResponse = new Promise<Response>((resolve) => {
        resolveCatalog = resolve
      })
      globalThis.fetch = (async () => catalogResponse) as typeof fetch
      for (const key of ['github', 'notion']) {
        queryClient.setQueryData(integrationQueryKeys.pool(key), [])
        queryClient.setQueryData(integrationQueryKeys.oauthApp(key), {
          authority: 'platform_broker',
          configured: true,
          clientId: null,
          callbackUrl: '',
          requiredCapabilities: [],
        })
      }
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={queryClient!}>
            <MemoryRouter initialEntries={[`/settings?section=integrations&setting=integration-${provider}`]}>
              <SettingsPage dependencies={dependencies} />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      expect(container.querySelector('[aria-label="Administration sections"]')).not.toBeNull()
      await dom.act(async () => {
        resolveCatalog(
          Response.json({
            integrations: ['github', 'notion'].map((key) => ({
              key,
              enabled: true,
              label: key === 'github' ? 'GitHub' : 'Notion',
              description: key,
              capabilities: [],
              assignable: true,
              authorization: { kind: 'oauth2' },
            })),
          })
        )
        await catalogResponse
      })
      const { waitFor } = await import('@testing-library/dom')
      await waitFor(() => {
        expect(
          container.querySelector(`#integration-card-${provider} button[aria-expanded]`)?.getAttribute('aria-expanded')
        ).toBe('true')
      })
      expect(container.querySelector('[aria-label="Settings areas"] [aria-checked="true"]')?.textContent).toBe(
        'Administration'
      )
      const other = provider === 'github' ? 'notion' : 'github'
      expect(
        container.querySelector(`#integration-card-${other} button[aria-expanded]`)?.getAttribute('aria-expanded')
      ).toBe('false')
    })
  }

  test('reports an instance permission lookup failure separately from denial', async () => {
    const { SettingsPage } = await import('./SettingsPage')
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    seedSettingsQueries(queryClient, [], {})

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionsProvider
            usePermissions={() => ({
              permissions: [],
              can: () => false,
              isLoading: false,
              isError: true,
            })}
          >
            <MemoryRouter initialEntries={['/settings?section=integrations']}>
              <SettingsPage dependencies={dependencies} />
            </MemoryRouter>
          </PermissionsProvider>
        </QueryClientProvider>
      )
    })

    expect(container.textContent).toContain('Unable to check integration access. Please try again.')
    expect(container.textContent).not.toContain('You do not have permission to view global integrations.')
  })

  test('uses only instance permissions and the global pool on the canonical page', async () => {
    const { SettingsPage } = await import('./SettingsPage')
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    seedSettingsQueries(queryClient, ['integrations:read:bigbrain', 'integrations:write:bigbrain'], {
      integrationPool: [operationsConnection],
      squads,
      squadPermissions: { 'squad-1': [], 'squad-2': [] },
    })

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=integrations']}>
            <SettingsPage dependencies={dependencies} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    expect(observerCount(integrationQueryKeys.pool('bigbrain'))).toBe(0)
    await dom.act(async () => {
      fireEvent.click(bigbrainCard().querySelector('button[aria-expanded]')!)
    })
    expect(bigbrainCard().textContent).toContain('Operations Brain')
    expect(bigbrainCard().textContent).toContain('https://ops.bigbrain.example')
    expect(buttonTexts(bigbrainCard())).toContain('Create and validate')
    expect(observerCount(integrationQueryKeys.pool('bigbrain'))).toBe(1)
    expect(observerCount(queryKeys.auth.permissions('squad-1'))).toBe(0)
    expect(observerCount(integrationQueryKeys.squad('squad-1', 'bigbrain'))).toBe(0)
    expect(requests).toEqual([])
  })
})

/**
 * Interactive cover for the passkey list. Deliberately stubs `fetch` rather than
 * mock.module-ing `../api/auth`: bun's module mocks are process-wide, and this
 * suite shares a process with the auth component tests that install their own
 * stub for that exact module. Going through the real client also proves the
 * request line (PATCH /auth/me/credentials/:id) rather than just the call site.
 */
describe('SettingsPage passkey management', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let queryClient: QueryClient | undefined
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let requests: { url: string; method: string; body: unknown }[]

  const CREDENTIALS = [
    { id: 'cred1', credentialId: 'credential-id', displayName: 'Laptop', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'cred2', credentialId: 'credential-id-2', displayName: 'Phone', createdAt: '2026-01-03T00:00:00Z' },
  ]

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
      beforeUnmount: async () => {
        await queryClient?.cancelQueries()
        queryClient?.clear()
      },
    })
    requests = []
    // Route-aware: react-query refetches the credentials list on mount and after
    // every mutation, so a stub that answered everything with one shape would
    // clobber the list with a mutation response.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (method === 'PATCH') return json({ id: 'cred1', displayName: 'YubiKey 5C' })
      if (url.includes('/auth/me/credentials')) return json(CREDENTIALS)
      if (url.includes('/channel-links')) return json({ links: [], pending: [] })
      return json({})
    }) as typeof globalThis.fetch
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
    queryClient = undefined
  })

  async function renderAccount() {
    const { SettingsPage } = await import('./SettingsPage')
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: [] })
    queryClient.setQueryData(queryKeys.auth.me(), {
      id: 'u1',
      email: 'admin@example.com',
      displayName: 'Admin',
      createdAt: '2026-01-01T00:00:00Z',
    })
    queryClient.setQueryData(queryKeys.auth.myCredentials(), CREDENTIALS)
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings?section=account']}>
            <SettingsPage dependencies={dependencies} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })
  }

  /** Let a mutation's invalidate-and-refetch settle INSIDE act, so the resulting
   *  state update doesn't surface as an "update was not wrapped in act" warning. */
  const settle = async () => {
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  const buttonByAria = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)
  const buttonByText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)

  test('Rename opens an inline editor prefilled with the current name and PATCHes the new one', async () => {
    await renderAccount()

    await dom.act(async () => {
      buttonByAria('Rename passkey Laptop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const input = container.querySelector('#rename-passkey-cred1') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('Laptop')

    await dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'YubiKey 5C')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await dom.act(async () => {
      buttonByText('Save')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await settle()

    const patch = requests.find((r) => r.method === 'PATCH')
    expect(patch).toBeDefined()
    expect(patch!.url).toContain('/auth/me/credentials/cred1')
    expect(patch!.body).toEqual({ displayName: 'YubiKey 5C' })
  })

  test('a blank rename is refused client-side and never reaches the server', async () => {
    await renderAccount()

    await dom.act(async () => {
      buttonByAria('Rename passkey Laptop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = container.querySelector('#rename-passkey-cred1') as HTMLInputElement
    await dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '   ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await dom.act(async () => {
      buttonByText('Save')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
    expect(container.textContent).toContain('Passkey name required')
  })

  test('Cancel abandons the edit without sending anything', async () => {
    await renderAccount()

    await dom.act(async () => {
      buttonByAria('Rename passkey Laptop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await dom.act(async () => {
      buttonByText('Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('#rename-passkey-cred1')).toBeNull()
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
    expect(container.textContent).toContain('Laptop')
  })

  test('Remove takes two clicks — the first only arms it', async () => {
    await renderAccount()

    const remove = () => buttonByAria('Remove passkey Phone')!
    expect(remove().textContent).toBe('Remove')

    await dom.act(async () => {
      remove().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(remove().textContent).toBe('Confirm?')
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)

    await dom.act(async () => {
      remove().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    const del = requests.find((r) => r.method === 'DELETE')
    expect(del).toBeDefined()
    expect(del!.url).toContain('/auth/me/credentials/cred2')
  })
})
