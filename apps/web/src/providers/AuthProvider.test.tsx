import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AuthStatus } from '../api/auth'
import { acquireDomHarness } from '../test/domHarness'

/**
 * First-run funnel regression coverage: an instance with zero users has no admin
 * and is unusable, so the setup flow must win over "authenticated" — the bootstrap
 * instance password is itself a valid identity, and a page refresh during setup used
 * to drop the visitor into an adminless app shell.
 */

type FetchStub = (url: string) => { status?: number; body?: unknown }

let respond: FetchStub
let requests: string[] = []

function stubFetch() {
  requests = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requests.push(url)
    const { status = 200, body = {} } = respond(url)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

const baseStatus: AuthStatus = {
  authEnabled: true,
  mode: 'password',
  hasUsers: false,
  hasAdminUser: false,
  emailConfigured: false,
  canSelfRegister: true,
}

/** Serves /auth/status with the given status; /auth/validate is 200 only when authed. */
function serve(status: AuthStatus, { validSession }: { validSession: boolean }): FetchStub {
  return (url) => {
    if (url.includes('/auth/status')) return { body: status }
    if (url.includes('/auth/validate')) return validSession ? { body: { valid: true } } : { status: 401, body: {} }
    return { body: {} }
  }
}

describe('AuthProvider first-admin funnel', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let queryClient: import('@tanstack/react-query').QueryClient | undefined
  let AuthProvider: typeof import('./AuthProvider').AuthProvider
  let useAuth: typeof import('./AuthProvider').useAuth
  let QueryClient: typeof import('@tanstack/react-query').QueryClient
  let QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: async () => {
        await queryClient?.cancelQueries()
        queryClient?.clear()
      },
    })
    stubFetch()
    ;({ AuthProvider, useAuth } = await import('./AuthProvider'))
    ;({ QueryClient, QueryClientProvider } = await import('@tanstack/react-query'))
    ;({ root } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
    queryClient = undefined
  })

  let seen: {
    authRequired: boolean | null
    isAuthenticated: boolean
    needsFirstAdminSetup: boolean
    needsAdminCompletion: boolean
    loginWithToken: (isFirstRegistration?: boolean) => Promise<void>
    refreshSession: () => Promise<void>
  }
  let seenPathname: string

  function Probe() {
    seen = useAuth()
    return null
  }

  // `loginWithToken`'s first-registration navigation uses `useNavigate`, so
  // AuthProvider needs a Router ancestor here just like it has in main.tsx
  // (AuthProvider sits inside <BrowserRouter>).
  async function mount(children: ReactNode = <Probe />) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { MemoryRouter, useLocation } = await import('react-router-dom')
    function LocationProbe() {
      seenPathname = useLocation().pathname
      return null
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthProvider>
              {children}
              <LocationProbe />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    })
  }

  test('mounting with a valid bootstrap cookie and zero users still needs setup', async () => {
    // The reported regression: refreshing the page mid-setup. /auth/validate accepts the
    // legacy password cookie, so isAuthenticated is true — the funnel must win anyway.
    respond = serve(baseStatus, { validSession: true })
    await mount()

    expect(seen.isAuthenticated).toBe(true)
    expect(seen.needsFirstAdminSetup).toBe(true)
  })

  test('authenticated with users present is a normal session', async () => {
    respond = serve({ ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true }, { validSession: true })
    await mount()

    expect(seen.isAuthenticated).toBe(true)
    expect(seen.needsFirstAdminSetup).toBe(false)
  })

  test('unauthenticated with zero users needs setup', async () => {
    respond = serve(baseStatus, { validSession: false })
    await mount()

    expect(seen.isAuthenticated).toBe(false)
    expect(seen.needsFirstAdminSetup).toBe(true)
  })

  test('auth disabled never funnels', async () => {
    respond = serve({ ...baseStatus, authEnabled: false }, { validSession: false })
    await mount()

    expect(seen.authRequired).toBe(false)
    expect(seen.isAuthenticated).toBe(true)
    expect(seen.needsFirstAdminSetup).toBe(false)
  })

  test('creating the first admin re-reads status so setup does not loop', async () => {
    let status: AuthStatus = { ...baseStatus }
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: status }
      if (url.includes('/auth/validate')) return { body: { valid: true } }
      return { body: {} }
    }
    await mount()
    expect(seen.needsFirstAdminSetup).toBe(true)

    // Registration succeeded: the server now reports an admin user.
    status = { ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true }
    await act(async () => {
      await seen.loginWithToken()
    })

    expect(seen.isAuthenticated).toBe(true)
    expect(seen.needsFirstAdminSetup).toBe(false)
  })

  test('loginWithToken(true) navigates to /onboarding — the bootstrap first-registration path only', async () => {
    respond = serve({ ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true }, { validSession: true })
    await mount()

    await act(async () => {
      await seen.loginWithToken(true)
    })

    expect(seenPathname).toBe('/onboarding')
  })

  test('an ordinary loginWithToken() call does not navigate — logins and refreshes must not redirect', async () => {
    respond = serve({ ...baseStatus, mode: 'passkey', hasUsers: true, hasAdminUser: true }, { validSession: true })
    await mount()

    await act(async () => {
      await seen.loginWithToken()
    })

    expect(seenPathname).toBe('/')
  })

  test('first admin created but status refetch fails still leaves setup', async () => {
    let statusFails = false
    respond = (url) => {
      if (url.includes('/auth/status')) return statusFails ? { status: 500, body: {} } : { body: baseStatus }
      if (url.includes('/auth/validate')) return { body: { valid: true } }
      return { body: {} }
    }
    await mount()
    expect(seen.needsFirstAdminSetup).toBe(true)

    statusFails = true
    await act(async () => {
      await seen.loginWithToken()
    })

    expect(seen.needsFirstAdminSetup).toBe(false)
  })

  const pendingOwner = { id: 'u1', email: 'owner@example.com', displayName: null }
  const legacyWithPendingAdmin = {
    valid: true,
    identityType: 'legacy',
    firstAdmin: { adminExists: false, accounts: [pendingOwner] },
  }

  test('the bootstrap session with an account waiting for its passkey needs admin completion', async () => {
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: { ...baseStatus, hasUsers: true } }
      if (url.includes('/auth/validate')) return { body: legacyWithPendingAdmin }
      return { body: {} }
    }
    await mount()

    expect(seen.isAuthenticated).toBe(true)
    expect(seen.needsFirstAdminSetup).toBe(false)
    expect(seen.needsAdminCompletion).toBe(true)
  })

  test('a person session never needs admin completion', async () => {
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: { ...baseStatus, hasUsers: true } }
      if (url.includes('/auth/validate')) return { body: { valid: true, identityType: 'user' } }
      return { body: {} }
    }
    await mount()

    expect(seen.needsAdminCompletion).toBe(false)
  })

  test('finishing the passkey swaps the bootstrap session for the person and ends admin completion', async () => {
    let validation: unknown = legacyWithPendingAdmin
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: { ...baseStatus, hasUsers: true } }
      if (url.includes('/auth/validate')) return { body: validation }
      return { body: {} }
    }
    await mount()
    expect(seen.needsAdminCompletion).toBe(true)

    validation = { valid: true, identityType: 'user' }
    await act(async () => {
      await seen.loginWithToken(true)
    })

    expect(seen.needsAdminCompletion).toBe(false)
    expect(seenPathname).toBe('/onboarding')
  })

  test('refreshSession adopts the bootstrap cookie a failed first-admin passkey step left behind', async () => {
    // LoginPage signs in with the instance password without flipping global auth,
    // then the passkey ceremony fails after the account row exists.
    let status: AuthStatus = { ...baseStatus }
    let cookie = false
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: status }
      if (url.includes('/auth/validate')) return cookie ? { body: legacyWithPendingAdmin } : { status: 401, body: {} }
      return { body: {} }
    }
    await mount()
    expect(seen.isAuthenticated).toBe(false)

    status = { ...baseStatus, hasUsers: true }
    cookie = true
    await act(async () => {
      await seen.refreshSession()
    })

    expect(seen.isAuthenticated).toBe(true)
    expect(seen.needsFirstAdminSetup).toBe(false)
    expect(seen.needsAdminCompletion).toBe(true)
  })

  test('a 401 from a passkey-registration ceremony does not sign the session out', async () => {
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: { ...baseStatus, hasUsers: true } }
      if (url.includes('/auth/validate')) return { body: legacyWithPendingAdmin }
      return { status: 401, body: { error: 'Verification failed' } }
    }
    // The interceptor wraps window.fetch; route it through this test's stub.
    window.fetch = globalThis.fetch
    await mount()

    await act(async () => {
      await window.fetch('http://localhost/api/auth/register/token/verify', { method: 'POST' })
    })
    expect(seen.isAuthenticated).toBe(true)

    await act(async () => {
      await window.fetch('http://localhost/api/squads')
    })
    expect(seen.isAuthenticated).toBe(false)
  })

  test('bootstrap admin completion does not sync account preferences or force a valid session out', async () => {
    const { ThemeProvider, useThemeSyncStore } = await import('./ThemeProvider')
    const { ThemeAccountSync } = await import('./ThemeAccountSync')
    let validation: unknown = legacyWithPendingAdmin
    respond = (url) => {
      if (url.includes('/auth/status')) return { body: { ...baseStatus, hasUsers: true } }
      if (url.includes('/auth/validate')) return { body: validation }
      if (url.includes('/user-preferences/me')) {
        if (validation === legacyWithPendingAdmin) return { status: 401, body: { error: 'Unauthorized' } }
        return {
          body: {
            userId: 'owner',
            theme: { themeId: 'harbor', appearance: 'dark', customTheme: null, presetId: null, presetOwnerId: null },
          },
        }
      }
      return { body: {} }
    }
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const originalRequest = globalThis.requestAnimationFrame
    const originalCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    }
    globalThis.cancelAnimationFrame = (id) => {
      frames.delete(id)
    }
    let themeStore: ReturnType<typeof useThemeSyncStore>
    function ThemeProbe() {
      themeStore = useThemeSyncStore()
      return <Probe />
    }
    const paint = async () => {
      const batch = [...frames.values()]
      frames.clear()
      await act(async () => {
        for (const callback of batch) callback(0)
      })
    }
    try {
      await mount(
        <ThemeProvider>
          <ThemeAccountSync />
          <ThemeProbe />
        </ThemeProvider>
      )
      await paint()
      await paint()
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await themeStore.refresh()
      })
      expect(requests.filter((url) => url.includes('/user-preferences/me'))).toHaveLength(0)
      expect(seen.isAuthenticated).toBe(true)
      expect(seen.needsAdminCompletion).toBe(true)

      validation = { valid: true, identityType: 'user' }
      await act(async () => {
        await seen.loginWithToken(true)
      })
      await paint()
      await paint()
      await act(async () => {
        await themeStore.refresh()
      })
      expect(requests.some((url) => url.includes('/user-preferences/me'))).toBe(true)
      expect(themeStore.getSnapshot().syncAvailable).toBe(true)
      expect(seen.needsAdminCompletion).toBe(false)
    } finally {
      globalThis.requestAnimationFrame = originalRequest
      globalThis.cancelAnimationFrame = originalCancel
    }
  })

  test('status fetch failure fails closed to the login page', async () => {
    respond = () => {
      throw new Error('offline')
    }
    await mount()

    expect(seen.authRequired).toBe(true)
    expect(seen.isAuthenticated).toBe(false)
  })
})

describe('selfServiceQueryEnabled', () => {
  test('true for a genuinely authenticated user, regardless of whether auth is required', async () => {
    const { selfServiceQueryEnabled } = await import('./AuthProvider')
    expect(selfServiceQueryEnabled({ authRequired: true, isAuthenticated: true } as never)).toBe(true)
    expect(selfServiceQueryEnabled({ authRequired: false, isAuthenticated: true } as never)).toBe(true)
  })

  test('false for bootstrap identities and unfinished admin setup even with valid authentication', async () => {
    const { selfServiceQueryEnabled } = await import('./AuthProvider')
    for (const pending of [
      { session: { identityType: 'legacy' } },
      { needsFirstAdminSetup: true },
      { needsAdminCompletion: true },
    ]) {
      expect(selfServiceQueryEnabled({ authRequired: true, isAuthenticated: true, ...pending } as never)).toBe(false)
    }
    expect(selfServiceQueryEnabled({ authRequired: null, isAuthenticated: true } as never)).toBe(false)
  })

  test('true on an auth-disabled instance even when NOT authenticated — the actual bug: AppNav used to require BOTH isAuthenticated AND authRequired, so it never showed presets at all on an auth-disabled instance', async () => {
    const { selfServiceQueryEnabled } = await import('./AuthProvider')
    expect(selfServiceQueryEnabled({ authRequired: false, isAuthenticated: false } as never)).toBe(true)
  })

  test('false while auth is required and not yet authenticated, while auth status is still unknown, or with no auth context at all', async () => {
    const { selfServiceQueryEnabled } = await import('./AuthProvider')
    expect(selfServiceQueryEnabled({ authRequired: true, isAuthenticated: false } as never)).toBe(false)
    expect(selfServiceQueryEnabled({ authRequired: null, isAuthenticated: false } as never)).toBe(false)
    expect(selfServiceQueryEnabled(null)).toBe(false)
  })
})
