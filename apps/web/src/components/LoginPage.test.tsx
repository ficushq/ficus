import { beforeEach, describe, expect, test } from 'bun:test'
import { LoginPage } from './LoginPage'
import { renderToStaticMarkup } from 'react-dom/server'

let authStatus: {
  authEnabled: boolean
  mode: 'password' | 'passkey'
  hasUsers: boolean
  hasAdminUser: boolean
  canSelfRegister?: boolean
} | null = null
let isAuthenticated = false

describe('LoginPage auth modes', () => {
  beforeEach(() => {
    isAuthenticated = false
  })

  test('renders first admin passkey registration directly when no password is configured', async () => {
    // mode:'passkey' with no users = no bootstrap password to gate on → direct setup.
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Set up Ficus')
    expect(html).toContain('Create the first admin account')
    expect(html).toContain('Create Admin Account')
    expect(html).not.toContain('Register with Passkey')
  })

  test('first-run requires the bootstrap password step when mode is password', async () => {
    // Hosted per-tenant instances report mode:'password' (a FICUS_PASSWORD bootstrap
    // credential is provisioned) with no admin yet — the setup UI must gate on it.
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Set up Ficus')
    expect(html).toContain('Enter the instance password')
    expect(html).toContain('type="password"')
    // Passkey registration must not be reachable until the password step is satisfied.
    expect(html).not.toContain('Send Verification Code')
  })

  test('an authenticated bootstrap session skips straight to first-admin setup', async () => {
    // Refresh mid-setup: the instance password cookie is already held, and with zero
    // users it can only be the bootstrap identity — don't re-ask for the password.
    authStatus = { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false }
    isAuthenticated = true
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Set up Ficus')
    expect(html).toContain('Create the first admin account')
    expect(html).not.toContain('Enter the instance password')
  })

  test('renders passkey login in passkey mode', async () => {
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Sign in with Passkey')
    expect(html).toContain('Create account')
  })

  test('hides the create-account affordance when self-registration is impossible', async () => {
    // Invite-only with no allowed domains: the server says nobody new can register,
    // so offering the button would only lead to a 403.
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: false }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Sign in with Passkey')
    // The affordance is simply absent — no explanatory line, since an invitee
    // arrives via their emailed link rather than this screen.
    expect(html).not.toContain('Create account')
    expect(html).not.toContain('invite-only')
  })

  test('keeps the create-account affordance in domain-allowlist / open modes', async () => {
    // The server reports only that SOME address could register — never which domains.
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: true }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Create account')
    expect(html).not.toContain('invite-only')
  })

  test('first-user bootstrap setup is never suppressed by the signup policy', async () => {
    // Zero users: first-admin creation deliberately bypasses the allowlist. Even if a
    // stale/false canSelfRegister arrived, the setup flow must still render.
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false, canSelfRegister: false }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Set up Ficus')
    expect(html).toContain('Create the first admin account')
    expect(html).not.toContain('invite-only')
  })

  test('renders legacy password form in password mode', async () => {
    authStatus = { authEnabled: true, mode: 'password', hasUsers: true, hasAdminUser: false }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('type="password"')
    expect(html).toContain('Login')
  })

  test('offers passkey recovery in passkey mode', async () => {
    // Passkeys are the only credential in this mode, so losing one is a lockout —
    // there has to be a visible way out that does not need a session.
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: true }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    expect(html).toContain('Lost your passkey?')
  })

  test('recovery is offered even on an invite-only instance', async () => {
    // Recovery is orthogonal to signup policy: it only ever reaches an account that
    // already exists, so hiding it behind canSelfRegister would strand invited users.
    authStatus = { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: false }
    const html = renderToStaticMarkup(
      <LoginPage auth={{ authStatus, isAuthenticated, login: async () => {}, loginWithToken: async () => {} }} />
    )

    // Invite-only is expressed by the ABSENCE of the create-account affordance.
    expect(html).not.toContain('Create account')
    expect(html).toContain('Lost your passkey?')
  })
})
