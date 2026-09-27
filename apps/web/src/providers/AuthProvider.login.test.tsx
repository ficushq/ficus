import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AuthStatus } from '../api/auth'
import { acquireDomHarness } from '../test/domHarness'

/**
 * Password login must carry the CSRF header. Browser cookies ignore ports, so a
 * ficus_session cookie from another tau instance on the same host rides along
 * with this request; without the header the CSRF middleware answered 403 and
 * the page reported "Invalid password" for a password that was correct.
 */

type Captured = { url: string; init: RequestInit | undefined }
let captured: Captured[] = []
let loginResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } }

const status: AuthStatus = {
  authEnabled: true,
  mode: 'password',
  hasUsers: false,
  hasAdminUser: false,
  emailConfigured: false,
  canSelfRegister: true,
}

function stubFetch() {
  captured = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    const reply = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/auth/status')) return reply(status)
    if (url.includes('/auth/validate')) return reply({}, 401)
    if (url.includes('/auth/login')) return reply(loginResponse.body, loginResponse.status)
    return reply({})
  }) as typeof fetch
}

describe('AuthProvider password login', () => {
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

  let seen: { isAuthenticated: boolean; login: (password: string) => Promise<void> }

  function Probe() {
    seen = useAuth()
    return null
  }

  async function mount(children: ReactNode = <Probe />) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { MemoryRouter } = await import('react-router-dom')
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthProvider>{children}</AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    })
  }

  test('sends the CSRF header with the cookie-bearing login request', async () => {
    loginResponse = { status: 200, body: { ok: true } }
    await mount()
    await act(async () => {
      await seen.login('secret')
    })
    const login = captured.find((c) => c.url.includes('/auth/login'))
    expect(login).toBeDefined()
    const headers = login!.init?.headers as Record<string, string>
    expect(headers['X-Tau-Csrf']).toBe('1')
    expect(login!.init?.credentials).toBe('include')
    expect(seen.isAuthenticated).toBe(true)
  })

  test('surfaces the server error instead of a generic "Invalid password"', async () => {
    loginResponse = { status: 403, body: { error: 'Password auth disabled. Use passkey login.' } }
    await mount()
    let message = ''
    await act(async () => {
      await seen.login('secret').catch((err: Error) => {
        message = err.message
      })
    })
    expect(message).toBe('Password auth disabled. Use passkey login.')
    expect(seen.isAuthenticated).toBe(false)
  })

  test('keeps the generic message when the body carries no error string', async () => {
    loginResponse = { status: 401, body: {} }
    await mount()
    let message = ''
    await act(async () => {
      await seen.login('wrong').catch((err: Error) => {
        message = err.message
      })
    })
    expect(message).toBe('Invalid password')
  })
})
