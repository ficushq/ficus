import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from './test/domHarness'
import type { AuthStatus, AuthValidation } from './api/auth'

/**
 * Top-level gate: which of {nothing, login/setup, app shell} App renders for a given
 * auth state. The regression under test is the refresh path — a valid bootstrap
 * password cookie on an instance with zero users used to render the (adminless,
 * unusable) app shell instead of the first-admin funnel.
 */

let status: AuthStatus
let validSession: boolean
let validation: AuthValidation = { valid: true }

const baseStatus: AuthStatus = {
  authEnabled: true,
  mode: 'password',
  hasUsers: false,
  hasAdminUser: false,
  emailConfigured: false,
  canSelfRegister: true,
}

describe('App auth gate', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let render: (path?: string) => Promise<void>
  let queryClient: import('@tanstack/react-query').QueryClient | null = null

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => {
        Object.assign(window, { SyntaxError, TypeError })
        Object.defineProperty(window.navigator, 'serviceWorker', {
          configurable: true,
          value: { controller: null, addEventListener() {}, ready: new Promise(() => {}) },
        })
      },
      beforeUnmount: async () => {
        await queryClient?.cancelQueries()
        queryClient?.clear()
      },
    })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/auth/status')) {
        return Response.json(status)
      }
      if (url.includes('/auth/validate')) {
        return validSession ? Response.json(validation) : Response.json({ error: 'nope' }, { status: 401 })
      }
      // Everything the app shell fetches on mount: empty collections.
      return Response.json([])
    }) as typeof fetch

    const [
      { default: App },
      { AuthProvider },
      { WebSocketContext },
      { QueryClient, QueryClientProvider },
      router,
      { ThemeProvider },
    ] = await Promise.all([
      import('./App'),
      import('./providers/AuthProvider'),
      import('./hooks/useWebSocket'),
      import('@tanstack/react-query'),
      import('react-router-dom'),
      import('./providers/ThemeProvider'),
    ])
    const { MemoryRouter } = router
    ;({ container, root } = dom.createRoot())
    render = async (path = '/') => {
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      await dom.act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[path]}>
              <ThemeProvider>
                <AuthProvider>
                  <WebSocketContext.Provider value={{ subscribe: () => () => {}, isConnected: true }}>
                    <App />
                  </WebSocketContext.Provider>
                </AuthProvider>
              </ThemeProvider>
            </MemoryRouter>
          </QueryClientProvider>
        )
      })
    }
  })

  afterEach(async () => {
    await dom.cleanup()
    queryClient = null
    validation = { valid: true }
  })

  test('the bootstrap session with an unfinished admin renders the finish screen, not the shell', async () => {
    // The first-admin passkey step failed after its account was created: users exist,
    // no admin has a passkey, and the instance password cookie is still valid.
    status = { ...baseStatus, hasUsers: true }
    validSession = true
    validation = {
      valid: true,
      identityType: 'legacy',
      firstAdmin: { adminExists: false, accounts: [{ id: 'u1', email: 'owner@example.com', displayName: null }] },
    }
    await render('/settings')

    expect(container.textContent).toContain('Finish creating your admin account')
    expect(container.textContent).toContain('owner@example.com')
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull()
  })

  test("the bootstrap session with nobody waiting keeps today's shell", async () => {
    status = { ...baseStatus, hasUsers: true }
    validSession = true
    validation = { valid: true, identityType: 'legacy', firstAdmin: { adminExists: false, accounts: [] } }
    await render()

    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Finish creating your admin account')
  })

  test('authenticated bootstrap session with zero users renders first-admin setup', async () => {
    // Refresh mid-setup: the instance password cookie validates, but no admin exists.
    status = { ...baseStatus }
    validSession = true
    await render()

    expect(container.textContent).toContain('Set up Ficus')
    expect(container.textContent).toContain('Create the first admin account')
    // The bootstrap password was already accepted — don't ask for it again.
    expect(container.textContent).not.toContain('Enter the instance password')
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull()
  })

  test('authenticated with users present renders the app shell', async () => {
    status = { ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true }
    validSession = true
    await render()

    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Set up Ficus')
  })

  test('unauthenticated with zero users keeps the bootstrap password step', async () => {
    status = { ...baseStatus }
    validSession = false
    await render()

    expect(container.textContent).toContain('Set up Ficus')
    expect(container.textContent).toContain('Enter the instance password')
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull()
  })

  test('auth disabled renders the app shell', async () => {
    status = { ...baseStatus, authEnabled: false }
    validSession = false
    await render()

    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Set up Ficus')
  })

  // The invite / recovery deep link is opened by someone with NO session — the gate
  // would otherwise swallow /register and show the login page, which is exactly how
  // invites became a dead end on invite-only instances.
  test('an unauthenticated /register?token=… lands on the passkey ceremony, not login', async () => {
    status = { ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: false }
    validSession = false
    await render('/register?token=some-invite-token')

    expect(container.textContent).toContain('passkey')
    expect(container.textContent).not.toContain('Sign in with Passkey')
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull()
  })

  test('an already-signed-in visitor opening an invite still gets the ceremony', async () => {
    // The link may be for a DIFFERENT account than the current session.
    status = { ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true }
    validSession = true
    await render('/register?token=some-invite-token')

    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull()
    expect(container.textContent).toContain('passkey')
  })
})
