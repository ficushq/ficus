import { useEffect, useRef, useState, type ComponentType } from 'react'
import { useAuth } from '../providers/AuthProvider'
import { apiUrl } from '../api/client'
import { PasskeyLogin } from './auth/PasskeyLogin'
import { PasskeyRegister } from './auth/PasskeyRegister'
import { PasskeyRecoveryRequest } from './auth/PasskeyRecoveryRequest'
import { FicusLogo } from './FicusLogo'
import { desktopInstance } from '../lib/desktop'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

// The managed-instance "Open instance" link
// carries the tenant's bootstrap admin password as a URL FRAGMENT —
// `#setup=<encoded password>` — never a query param: a query string is sent
// to the server (access logs), kept in browser history, and can leak via
// Referer to any third-party resource the page loads. A fragment is neither.
const BOOTSTRAP_FRAGMENT_PATTERN = /^#setup=(.+)$/

type BootstrapFragment = { kind: 'none' } | { kind: 'invalid' } | { kind: 'password'; password: string }

/** The `#setup=` fragment in the current address, decoded. */
function readBootstrapFragment(): BootstrapFragment {
  if (typeof window === 'undefined') return { kind: 'none' }
  const match = BOOTSTRAP_FRAGMENT_PATTERN.exec(window.location.hash)
  if (!match) return { kind: 'none' }
  try {
    return { kind: 'password', password: decodeURIComponent(match[1]!) }
  } catch {
    return { kind: 'invalid' }
  }
}

type LoginPageAuth = Pick<ReturnType<typeof useAuth>, 'authStatus' | 'isAuthenticated' | 'login' | 'loginWithToken'> &
  Partial<Pick<ReturnType<typeof useAuth>, 'refreshSession'>>
type LoginPageDependencies = {
  PasskeyRegisterComponent?: ComponentType<{
    onSuccess: (firstAdmin: boolean) => void
    onFailure?: () => void
    isBootstrap?: boolean
    emailOptional?: boolean
  }>
}

export function LoginPage({ auth, dependencies }: { auth?: LoginPageAuth; dependencies?: LoginPageDependencies } = {}) {
  return auth ? (
    <LoginPageContent auth={auth} dependencies={dependencies} />
  ) : (
    <LoginPageWithAuth dependencies={dependencies} />
  )
}

function LoginPageWithAuth({ dependencies }: { dependencies?: LoginPageDependencies }) {
  return <LoginPageContent auth={useAuth()} dependencies={dependencies} />
}

function LoginPageContent({ auth, dependencies }: { auth: LoginPageAuth; dependencies?: LoginPageDependencies }) {
  const PasskeyRegisterComponent = dependencies?.PasskeyRegisterComponent ?? PasskeyRegister
  const { authStatus, isAuthenticated, login, loginWithToken, refreshSession } = auth
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showRegister, setShowRegister] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  // Bootstrap: whether the instance password step has been satisfied for first-admin setup.
  const [bootstrapAuthed, setBootstrapAuthed] = useState(false)
  // The `#setup=` fragment, read once on the first render, before the effect below strips it from
  // the address bar. Reading it in a state initializer makes it a fixed mount-time capture, also
  // under StrictMode (both initializer calls see the same, not yet stripped, hash). It is decoded
  // here too; a value that does not decode is kept as invalid so the gate can say so.
  const [bootstrapFragment] = useState<BootstrapFragment>(readBootstrapFragment)
  // Whether the fragment-prefilled auto-login is in flight, so we can show a
  // brief "Signing you in…" state instead of the manual password form.
  // Seeded from the mount-time fragment (not the gate — that isn't known yet
  // on first render) so that, once the gate DOES open, the "Signing you in…"
  // state renders on the first paint instead of flashing the manual form for a
  // frame first. Harmless when the gate never opens: this value is only ever
  // read inside the needsBootstrapPassword branch.
  const [autoLoginPending, setAutoLoginPending] = useState(() => bootstrapFragment.kind !== 'none')
  // Consume the fragment exactly once — guards against React re-renders (and
  // strict-mode's double effect invocation) re-running the auto-login.
  const fragmentConsumedRef = useRef(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || loading) return
    setError(null)
    setLoading(true)
    try {
      await login(password)
    } catch {
      setError('Invalid password')
    } finally {
      setLoading(false)
    }
  }

  // First-admin setup password gate. On hosted instances the API reports mode:'password'
  // (a FICUS_PASSWORD bootstrap credential is provisioned and no admin passkey exists yet),
  // and the first-admin registration endpoints require that bootstrap session. We log in to
  // set the cookie WITHOUT flipping global auth state, so LoginPage stays mounted to run the
  // passkey setup authenticated. Only PasskeyRegister's success promotes to full auth.
  // Shared by the manual form submit and the fragment-prefilled auto-login below —
  // `invalidMessage` differs so a stale/wrong link reads as a link problem, not a typo.
  // beginBootstrapLogin shows the attempt; submitBootstrapPassword makes it. The fragment path
  // begins while rendering (when the gate opens) and submits from its effect.
  const beginBootstrapLogin = () => {
    setError(null)
    setLoading(true)
  }
  const submitBootstrapPassword = async (pw: string, invalidMessage: string): Promise<boolean> => {
    try {
      const res = await fetch(apiUrl('/auth/login'), {
        method: 'POST',
        // Another instance on this host may already have set ficus_session.
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
        credentials: 'include',
        body: JSON.stringify({ password: pw }),
      })
      if (!res.ok) {
        let message = invalidMessage
        if (res.status !== 401) {
          try {
            const body = (await res.json()) as { error?: unknown }
            if (typeof body.error === 'string' && body.error.trim()) message = body.error
          } catch {
            /* Keep the fallback for non-JSON errors. */
          }
        }
        setError(message)
        return false
      }
      setPassword('')
      setBootstrapAuthed(true)
      return true
    } catch {
      setError('Unable to reach Ficus. Please try again.')
      return false
    } finally {
      setLoading(false)
    }
  }

  const handleBootstrapLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || loading) return
    beginBootstrapLogin()
    await submitBootstrapPassword(password, 'Invalid password')
  }

  // First-admin setup password gate. See handleBootstrapLogin's comment for why this
  // exists; computed unconditionally (not just inside the !hasUsers render branch) so
  // the fragment-consuming effect below can gate on the exact same condition.
  const needsBootstrapPassword =
    !!authStatus && !authStatus.hasUsers && authStatus.mode === 'password' && !bootstrapAuthed && !isAuthenticated

  // Stripping is UNCONDITIONAL: a `#setup=<password>` credential must never
  // linger in the address bar or a bookmark, regardless of whether this
  // instance is even in the needs-bootstrap-password state (already has
  // users, invite-passkey mode, or the still-loading→not-bootstrap
  // resolution). Deliberately NOT gated on needsBootstrapPassword, unlike the
  // auto-LOGIN below. It never acts on the value itself, so a closed gate
  // never triggers a network call, an error message, or any other visible
  // state change. Idempotent: StrictMode's replay finds the hash already gone.
  useEffect(() => {
    if (BOOTSTRAP_FRAGMENT_PATTERN.test(window.location.hash)) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  // When the needs-bootstrap-password gate opens (at mount, or later once an
  // async authStatus resolves) without a usable fragment, settle the optimistic
  // "Signing you in…" seed while rendering: with no fragment there is nothing to
  // do, and a fragment that does not decode shows why the manual form is back.
  // No other auth mode (local self-host, invite-passkey, ordinary login) is touched.
  // A decoded fragment begins its login in the same render instead.
  const [fragmentSettled, setFragmentSettled] = useState(false)
  if (needsBootstrapPassword && !fragmentSettled) {
    setFragmentSettled(true)
    if (bootstrapFragment.kind === 'password') {
      beginBootstrapLogin()
    } else {
      setAutoLoginPending(false)
      if (bootstrapFragment.kind === 'invalid') {
        setError("That sign-in link didn't work — enter the instance password below.")
      }
    }
  }

  // Submit the decoded fragment once the gate is open. autoLoginPending is
  // already true from its seed, and clears when the attempt finishes.
  useEffect(() => {
    if (fragmentConsumedRef.current) return
    if (!needsBootstrapPassword || bootstrapFragment.kind !== 'password') return
    fragmentConsumedRef.current = true
    // An async task: every state update in it follows the awaited request.
    void (async () => {
      try {
        await submitBootstrapPassword(
          bootstrapFragment.password,
          "That sign-in link didn't work — enter the instance password below."
        )
      } finally {
        setAutoLoginPending(false)
      }
    })()
    // submitBootstrapPassword is recreated each render and only ever runs once here.
  }, [needsBootstrapPassword, bootstrapFragment])

  if (authStatus && !authStatus.hasUsers) {
    return (
      <div className="h-full flex items-center justify-center bg-page px-4">
        <div className="ficus-section w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold text-primary mb-4">Set up Ficus</h1>
          {needsBootstrapPassword ? (
            autoLoginPending ? (
              <p className="text-sm text-secondary mb-4">Signing you in…</p>
            ) : (
              <form onSubmit={handleBootstrapLogin}>
                <p className="text-sm text-secondary mb-4">
                  Enter the instance password to create the first admin account.
                </p>
                <label htmlFor="bootstrap-password" className="sr-only">
                  Instance password
                </label>
                <input
                  id="bootstrap-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Instance password"
                  autoComplete="current-password"
                  autoFocus
                  aria-invalid={!!error}
                  aria-describedby={error ? 'bootstrap-error' : undefined}
                  className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm"
                />
                {error && (
                  <p
                    id="bootstrap-error"
                    role="alert"
                    className="text-status-danger-600 dark:text-status-danger-400 text-sm mt-2"
                  >
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={loading || !password.trim()}
                  className="ficus-button ficus-button-primary w-full mt-3 px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
                >
                  {loading ? 'Verifying...' : 'Continue'}
                </button>
              </form>
            )
          ) : (
            <>
              <p className="text-sm text-secondary mb-4">Create the first admin account.</p>
              {/* A failed passkey step can leave the new account behind (its row is
                  created before the ceremony). Re-reading the session then hands
                  over to the finish-setup screen, which can retry without a new
                  verification code. */}
              <PasskeyRegisterComponent
                onSuccess={loginWithToken}
                onFailure={refreshSession ? () => void refreshSession() : undefined}
                isBootstrap
                // Only managed cloud requires the first admin's email; an older server that
                // doesn't say still requires it.
                emailOptional={authStatus?.firstAdminEmailRequired === false}
              />
            </>
          )}
        </div>
      </div>
    )
  }

  if (authStatus?.mode === 'passkey') {
    // Invite-only with no allowed domains: nothing a stranger can type would be
    // accepted, so offering "Create account" only walks them into a 403. The server
    // tells us whether SOME address could register (canSelfRegister) and deliberately
    // does NOT tell anonymous visitors which domains are allowed — in domain mode we
    // keep the affordance and let the register call's own error speak.
    const selfRegisterBlocked = authStatus.canSelfRegister === false
    const registering = showRegister && !selfRegisterBlocked
    const heading = showRecovery ? 'Lost your passkey?' : registering ? 'Create Account' : 'Sign in to Ficus'
    // A Desktop window names its instance (as its header does once signed in); switching instances
    // happens from Desktop's File menu, not here.
    const instance = desktopInstance()
    // Recovery sends a sign-in link by email, so it is only offered where this server can send one.
    const recoveryAvailable = authStatus.emailConfigured
    return (
      <div className="h-full flex items-center justify-center bg-page px-4">
        <div className="ficus-section w-full max-w-sm p-6">
          {showRecovery || registering ? (
            <h1 className="text-lg font-semibold text-primary mb-4">{heading}</h1>
          ) : (
            <div className="flex flex-col items-center gap-3 mb-6 text-center">
              <FicusLogo className="w-10 h-10" decorative />
              <h1 className="text-xl font-semibold text-primary">{heading}</h1>
              {instance && (
                <p
                  data-testid="login-instance"
                  className="max-w-full truncate rounded-full border border-panel-border bg-surface-secondary px-3 py-1 text-sm text-secondary"
                >
                  {instance.name}
                </p>
              )}
            </div>
          )}
          {showRecovery ? (
            <PasskeyRecoveryRequest onBack={() => setShowRecovery(false)} />
          ) : registering ? (
            <>
              <PasskeyRegisterComponent onSuccess={loginWithToken} />
              <p className="text-xs text-secondary mt-4 text-center">
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="ficus-button ficus-button-ghost px-3 py-1.5"
                >
                  Back to login
                </button>
              </p>
            </>
          ) : (
            <>
              <PasskeyLogin onSuccess={loginWithToken} />
              {/* Invite-only instances simply omit the create-account affordance.
                  No explanatory line: an invitee arrives via their emailed link
                  rather than this screen, so the note only ever told a legitimate
                  user something they could not act on. */}
              {selfRegisterBlocked ? null : (
                <p className="text-xs text-secondary mt-4 text-center">
                  <button
                    type="button"
                    onClick={() => setShowRegister(true)}
                    className="ficus-button ficus-button-ghost px-3 py-1.5"
                  >
                    Create account
                  </button>
                </p>
              )}
              {/* Passkeys are the only credential here, so losing one is a lockout. Offered whenever
                  this server can email (invite-independent; the endpoint answers the same for an
                  unknown address, so it leaks nothing). Without email delivery it could never arrive. */}
              {recoveryAvailable && (
                <p className="text-sm text-secondary mt-6 pt-4 border-t border-panel-border text-center">
                  <button
                    type="button"
                    onClick={() => setShowRecovery(true)}
                    className="ficus-button ficus-button-ghost px-3 py-1.5"
                  >
                    Lost your passkey?
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center bg-page px-4">
      <div className="ficus-section w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-primary mb-4">Login</h1>
        <form onSubmit={handleSubmit}>
          <label htmlFor="login-password" className="sr-only">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            autoFocus
            aria-invalid={!!error}
            aria-describedby={error ? 'login-error' : undefined}
            className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm"
          />
          {error && (
            <p
              id="login-error"
              role="alert"
              className="text-status-danger-600 dark:text-status-danger-400 text-sm mt-2"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="ficus-button ficus-button-primary w-full mt-3 px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  )
}
