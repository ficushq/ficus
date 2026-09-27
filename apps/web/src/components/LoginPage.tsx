import { useEffect, useRef, useState, type ComponentType } from 'react'
import { useAuth } from '../providers/AuthProvider'
import { apiUrl } from '../api/client'
import { PasskeyLogin } from './auth/PasskeyLogin'
import { PasskeyRegister } from './auth/PasskeyRegister'
import { PasskeyRecoveryRequest } from './auth/PasskeyRecoveryRequest'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

// The managed-instance "Open instance" link
// carries the tenant's bootstrap admin password as a URL FRAGMENT —
// `#setup=<encoded password>` — never a query param: a query string is sent
// to the server (access logs), kept in browser history, and can leak via
// Referer to any third-party resource the page loads. A fragment is neither.
const BOOTSTRAP_FRAGMENT_PATTERN = /^#setup=(.+)$/

type LoginPageAuth = Pick<ReturnType<typeof useAuth>, 'authStatus' | 'isAuthenticated' | 'login' | 'loginWithToken'> &
  Partial<Pick<ReturnType<typeof useAuth>, 'refreshSession'>>
type LoginPageDependencies = {
  PasskeyRegisterComponent?: ComponentType<{
    onSuccess: (firstAdmin: boolean) => void
    onFailure?: () => void
    isBootstrap?: boolean
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
  // Whether the fragment-prefilled auto-login is in flight, so we can show a
  // brief "Signing you in…" state instead of the manual password form.
  // Seeded synchronously from a mount-time hash check (not the gate — that
  // isn't known yet on first render) so that, once the gate DOES open, the
  // "Signing you in…" state renders on the first paint instead of flashing
  // the manual form for a frame first. Harmless when the gate never opens:
  // this value is only ever read inside the needsBootstrapPassword branch.
  const [autoLoginPending, setAutoLoginPending] = useState(
    () => typeof window !== 'undefined' && BOOTSTRAP_FRAGMENT_PATTERN.test(window.location.hash)
  )
  // The raw (still-encoded) `#setup=` value captured at mount, or null if
  // there was none — see the mount-capture effect below. `undefined` means
  // the capture effect hasn't run yet.
  const capturedFragmentRef = useRef<string | null | undefined>(undefined)
  // Consume the captured fragment exactly once — guards against React
  // re-renders (and strict-mode's double effect invocation) re-running the
  // auto-login.
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
  const runBootstrapLogin = async (pw: string, invalidMessage: string): Promise<boolean> => {
    setError(null)
    setLoading(true)
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
      setError('Unable to reach Tau. Please try again.')
      return false
    } finally {
      setLoading(false)
    }
  }

  const handleBootstrapLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || loading) return
    await runBootstrapLogin(password, 'Invalid password')
  }

  // First-admin setup password gate. See handleBootstrapLogin's comment for why this
  // exists; computed unconditionally (not just inside the !hasUsers render branch) so
  // the fragment-consuming effect below can gate on the exact same condition.
  const needsBootstrapPassword =
    !!authStatus && !authStatus.hasUsers && authStatus.mode === 'password' && !bootstrapAuthed && !isAuthenticated

  // Capture-and-strip is UNCONDITIONAL: a `#setup=<password>` credential must
  // never linger in the address bar or a bookmark, regardless of whether this
  // instance is even in the needs-bootstrap-password state (already has
  // users, invite-passkey mode, or the still-loading→not-bootstrap
  // resolution). Deliberately NOT gated on needsBootstrapPassword, unlike the
  // auto-LOGIN below. Only captures the raw value for the consume effect to
  // decide what to do with; it never decodes or acts on it itself, so a
  // closed gate never triggers a network call, an error message, or any
  // other visible state change.
  //
  // Idempotent by construction (the `!== undefined` guard, with the ref
  // initialized to `undefined`): this is what makes it safe under
  // StrictMode's mount→cleanup→mount replay (active in main.tsx), which
  // invokes this effect twice in the same commit. Without the guard, the
  // fragment is already stripped from `location.hash` by the first
  // invocation, so the replay's `else` branch would see no match and
  // overwrite the real capture with `null` — invisible whenever the gate
  // was already open at mount (the consume effect's own single-fire guard
  // latches during the first invocation, before the replay can clobber
  // anything), but silently dropping the auto-login on the real production
  // shape: authStatus starts `null` and resolves asynchronously, so the gate
  // is still closed during this replay and only opens on a later render —
  // by which point the already-clobbered `null` looked like "nothing was
  // ever captured".
  useEffect(() => {
    if (capturedFragmentRef.current !== undefined) return
    const match = BOOTSTRAP_FRAGMENT_PATTERN.exec(window.location.hash)
    if (match) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      capturedFragmentRef.current = match[1]!
    } else {
      capturedFragmentRef.current = null
    }
  }, [])

  // Auto-consume whatever the capture effect above found, strictly gated on the
  // needs-bootstrap-password first-run state — no other auth mode (local
  // self-host, invite-passkey, ordinary login) is touched. The capture effect
  // (declared above this one) always runs first within any given commit, and
  // is idempotent (see its comment), so `capturedFragmentRef.current` holds
  // the ORIGINAL mount-time capture by the time this reads it — including on
  // a later render where the gate opens only after an async authStatus
  // resolution, and including under StrictMode's mount-time effect replay.
  useEffect(() => {
    if (fragmentConsumedRef.current) return
    if (!needsBootstrapPassword) return
    const raw = capturedFragmentRef.current
    if (!raw) {
      // Nothing was captured (or the gate opened before the capture effect
      // ran, which shouldn't happen given effect ordering, but resolve any
      // optimistic "Signing you in…" seed either way rather than risk a stuck state).
      setAutoLoginPending(false)
      return
    }
    fragmentConsumedRef.current = true

    let pw: string
    try {
      pw = decodeURIComponent(raw)
    } catch {
      setAutoLoginPending(false)
      setError("That sign-in link didn't work — enter the instance password below.")
      return
    }

    setAutoLoginPending(true)
    void runBootstrapLogin(pw, "That sign-in link didn't work — enter the instance password below.").finally(() => {
      setAutoLoginPending(false)
    })
  }, [needsBootstrapPassword])

  if (authStatus && !authStatus.hasUsers) {
    return (
      <div className="h-full flex items-center justify-center bg-page px-4">
        <div className="ficus-section w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold text-primary mb-4">Set up Tau</h1>
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
                  className="ficus-button ficus-button-primary w-full mt-3 px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
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
    const heading = showRecovery ? 'Lost your passkey?' : registering ? 'Create Account' : 'Login'
    return (
      <div className="h-full flex items-center justify-center bg-page px-4">
        <div className="ficus-section w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold text-primary mb-4">{heading}</h1>
          {showRecovery ? (
            <PasskeyRecoveryRequest onBack={() => setShowRecovery(false)} />
          ) : registering ? (
            <>
              <PasskeyRegisterComponent onSuccess={loginWithToken} />
              <p className="text-xs text-secondary mt-4 text-center">
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="ficus-button text-accent-light hover:underline"
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
                    className="ficus-button text-accent-light hover:underline"
                  >
                    Create account
                  </button>
                </p>
              )}
              {/* Passkeys are the only credential here, so losing one is a lockout.
                  Offered unconditionally: it is invite-independent, and the endpoint
                  answers the same for an unknown address, so it leaks nothing. */}
              <p className="text-xs text-secondary mt-2 text-center">
                <button
                  type="button"
                  onClick={() => setShowRecovery(true)}
                  className="ficus-button text-accent-light hover:underline"
                >
                  Lost your passkey?
                </button>
              </p>
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
            className="ficus-button ficus-button-primary w-full mt-3 px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  )
}
