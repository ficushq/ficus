import { fireEvent } from '@testing-library/dom'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { mock } from 'bun:test'
import type { AuthStatus } from '../api/auth'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

/**
 * Pins the tenant-side half of the bootstrap-password prefill: the platform's
 * "Open instance" link carries `#setup=<encoded password>`. LoginPage must,
 * on the needs-bootstrap-password first-run state ONLY, read that fragment,
 * strip it from the address bar immediately (so it never lingers in a
 * bookmark or survives a manual refresh), auto-run the bootstrap login, and
 * either land on the create-first-admin passkey step (success) or fall back
 * to exactly today's manual "Instance password" form (failure) — never a
 * stuck state.
 *
 * Same happy-dom + act + createRoot harness as LoginPage.firstRegistration.
 * test.tsx, for the same reason: this exercises real effects and a real
 * fetch call, which renderToStaticMarkup (used by LoginPage.test.tsx) cannot.
 * `@simplewebauthn/browser` is stubbed only so the PasskeyRegister import
 * graph links — none of these tests drive an actual passkey ceremony.
 */
// `| null` matches the real AuthProvider's shape (useState<AuthStatus | null>(null)) —
// null is the "still loading" state, needed by the async-resolution test below.
let authStatus: AuthStatus | null
let isAuthenticated = false
let loginCalls: { url: string; body: unknown }[] = []
let loginShouldSucceed = true
let requireCsrf = false

mock.module('@simplewebauthn/browser', () => ({
  startRegistration: async () => ({}),
  startAuthentication: async () => ({}),
}))

import { LoginPage } from './LoginPage'

describe('LoginPage — bootstrap password prefill via URL fragment', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let win: Awaited<ReturnType<typeof acquireDomHarness>>['window']

  function setUpWindow(url: string) {
    win.history.replaceState(null, '', url)
  }

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
    })
    win = dom.window
    isAuthenticated = false
    loginCalls = []
    loginShouldSucceed = true
    requireCsrf = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/auth/login')) {
        loginCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
        if (requireCsrf && new Headers(init?.headers).get(CSRF_HEADER) !== '1') {
          return Response.json({ error: 'Missing CSRF token' }, { status: 403 })
        }
        return loginShouldSucceed ? new Response(null, { status: 200 }) : new Response(null, { status: 401 })
      }
      return Response.json({})
    }) as typeof fetch
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  async function renderAt(url: string) {
    setUpWindow(url)
    ;({ container, root } = dom.createRoot())
    await dom.act(async () => {
      root.render(
        <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
      )
    })
    // Flush the auto-login's fetch + state updates.
    await dom.act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  test('fragment present + needs-bootstrap state: posts /auth/login with the decoded password, strips the fragment, advances to the passkey step', async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    const password = 'p@ss+word/1'

    await renderAt(`http://localhost/#setup=${encodeURIComponent(password)}`)

    expect(loginCalls.length).toBe(1)
    expect(loginCalls[0]?.body).toEqual({ password })
    expect(win.location.hash).toBe('')
    expect(container.textContent).toContain('Create the first admin account')
    expect(container.textContent).not.toContain('Enter the instance password')
  })

  test('manual first-admin login succeeds when another instance has set a session cookie', async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    requireCsrf = true
    win.document.cookie = 'ficus_session=another-instance-session; Path=/'
    await renderAt('http://localhost/tau-gh-smoke/')
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await dom.act(async () => fireEvent.input(input, { target: { value: 'correct-smoke-password' } }))
    await dom.act(async () => {
      fireEvent.submit(input.closest('form')!)
      await Promise.resolve()
    })
    expect(loginCalls).toHaveLength(1)
    expect(loginCalls[0]?.body).toEqual({ password: 'correct-smoke-password' })
    expect(container.textContent).toContain('Create the first admin account')
    expect(container.textContent).not.toContain('Invalid password')
  })

  test('fragment first-admin login also sends CSRF protection with an existing session', async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    requireCsrf = true
    win.document.cookie = 'ficus_session=another-instance-session; Path=/'
    await renderAt('http://localhost/#setup=correct-smoke-password')
    expect(loginCalls).toHaveLength(1)
    expect(container.textContent).toContain('Create the first admin account')
  })

  test('async authStatus resolution: gate CLOSED at mount (authStatus still loading), OPENS after — auto-login still fires despite StrictMode double-invoking the capture effect on mount', async () => {
    // Review fix (2nd pass): main.tsx wraps the real app in <StrictMode>, which
    // double-invokes mount effects (mount → cleanup → mount again, synchronously,
    // before any subsequent render). The capture effect used to have an
    // unconditional `else { capturedFragmentRef.current = null }` — on the
    // REPLAY invocation the fragment was already stripped from the URL by the
    // first invocation, so the replay saw no match and clobbered the real
    // captured password back to null. That was invisible whenever the gate was
    // ALREADY open at mount (this file's other tests): the consume effect's own
    // single-fire guard (fragmentConsumedRef) had already latched during the
    // capture effect's first invocation, before the replay could clobber
    // anything. It only broke the real, common production shape: authStatus
    // starts `null` (AuthProvider's actual loading state) and resolves
    // asynchronously — gate closed at mount, opens on a LATER render, by which
    // point the ref had already been clobbered.
    authStatus = null
    const password = 'p@ss+word/1'
    setUpWindow(`http://localhost/#setup=${encodeURIComponent(password)}`)
    ;({ container, root } = dom.createRoot())

    await dom.act(async () => {
      root.render(
        <StrictMode>
          <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
        </StrictMode>
      )
    })
    await dom.act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Gate closed at mount: the fragment must already be stripped (universal
    // credential hygiene), but nothing has auto-logged in yet.
    expect(win.location.hash).toBe('')
    expect(loginCalls.length).toBe(0)

    // authStatus resolves asynchronously to the needs-bootstrap-password state —
    // the same element, a plain re-render, not a remount.
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    await dom.act(async () => {
      root.render(
        <StrictMode>
          <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
        </StrictMode>
      )
    })
    await dom.act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loginCalls.length).toBe(1)
    expect(loginCalls[0]?.body).toEqual({ password })
    expect(container.textContent).toContain('Create the first admin account')
  })

  test('fragment present but login fails: falls back to the manual form, fragment still stripped, no stuck state', async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    loginShouldSucceed = false
    const password = 'wrong-or-stale'

    await renderAt(`http://localhost/#setup=${encodeURIComponent(password)}`)

    expect(loginCalls.length).toBe(1)
    expect(win.location.hash).toBe('')
    // Falls back to exactly the manual form — never stuck on a spinner/blank state.
    expect(container.textContent).toContain('Enter the instance password')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
    // A gentle note, not a scary raw error.
    expect(container.textContent).toContain("didn't work")
  })

  test('fragment present but the instance already has users: ignored entirely, normal flow, no auto-login', async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: true, hasAdminUser: true }
    const password = 'irrelevant'

    await renderAt(`http://localhost/#setup=${encodeURIComponent(password)}`)

    expect(loginCalls.length).toBe(0)
    expect(container.textContent).toContain('Login')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })

  test("fragment present but mode isn't 'password': ignored entirely, normal flow, no auto-login", async () => {
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false }
    const password = 'irrelevant'

    await renderAt(`http://localhost/#setup=${encodeURIComponent(password)}`)

    expect(loginCalls.length).toBe(0)
    // mode:'passkey' + no bootstrap password to gate on → straight to first-admin setup.
    expect(container.textContent).toContain('Create the first admin account')
  })

  test('fragment present but the gate is closed (already has users): the fragment is still stripped on mount, even though nothing is auto-logged in', async () => {
    // Review fix: the credential-hygiene claim is universal — a `#setup=`
    // link opened against an instance that doesn't need it (already has
    // users, or invite-passkey mode) must not leave the password sitting in
    // the address bar / a bookmark just because the auto-LOGIN itself is
    // correctly skipped.
    authStatus = { authEnabled: true, mode: 'password', hasUsers: true, hasAdminUser: true }
    const password = 'irrelevant-but-must-not-linger'

    await renderAt(`http://localhost/#setup=${encodeURIComponent(password)}`)

    expect(win.location.hash).toBe('')
    expect(loginCalls.length).toBe(0)
    expect(container.textContent).toContain('Login')
  })

  test('fragment present but mode is passkey (no bootstrap gate to close): the fragment is still stripped on mount', async () => {
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false }
    const password = 'irrelevant-but-must-not-linger'

    await renderAt(`http://localhost/#setup=${encodeURIComponent(password)}`)

    expect(win.location.hash).toBe('')
    expect(loginCalls.length).toBe(0)
    expect(container.textContent).toContain('Create the first admin account')
  })

  test("no fragment: exactly today's behavior — the manual instance-password prompt, no auto-login", async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }

    await renderAt('http://localhost/')

    expect(loginCalls.length).toBe(0)
    expect(container.textContent).toContain('Enter the instance password')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })
})
