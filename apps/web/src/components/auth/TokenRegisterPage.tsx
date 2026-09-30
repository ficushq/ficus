import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { startRegistration } from '@simplewebauthn/browser'
import { type TokenRegistrationContext } from '../../api/auth'
import { useAuthApi } from './authApi'

interface Props {
  onSuccess: () => void
}

/**
 * The landing page for an invite or passkey-recovery link (`/register?token=…`).
 *
 * The token in the URL authorises ONE thing: registering a passkey for the address
 * it was issued to. It is not a session — nothing is signed in until the WebAuthn
 * ceremony completes, and the token is only spent when it does. So a person who
 * opens the link, changes their mind and closes the tab still has a usable invite.
 */
export function TokenRegisterPage({ onSuccess }: Props) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') ?? ''

  const { getTokenRegistrationOptions, verifyTokenRegistration } = useAuthApi()
  const [context, setContext] = useState<TokenRegistrationContext | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [credentialName, setCredentialName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  // Look the link up on mount so the page can name the account it is about to
  // set up. This call does NOT consume the token. Its challenge isn't used:
  // Register fetches a fresh one (see handleRegister).
  useEffect(() => {
    let cancelled = false
    if (!token) {
      setChecking(false)
      setError('This link is missing its token. Ask for a new invite.')
      return
    }
    getTokenRegistrationOptions(token)
      .then((ctx) => {
        if (cancelled) return
        setContext(ctx)
        setDisplayName(ctx.displayName ?? '')
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'This link is invalid or has expired.')
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [getTokenRegistrationOptions, token])

  /**
   * Enter submits. This is the first screen an invited user ever sees, and it
   * was a plain <div> of type="button" — so typing a name and pressing Enter
   * did nothing.
   *
   * The `loading` guard mirrors the button's `disabled`: browsers skip implicit
   * submission when the submit button is disabled, but a double-Enter must not
   * be able to fire a second WebAuthn registration regardless.
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    void handleRegister()
  }

  const handleRegister = async () => {
    if (!context) return
    setError(null)
    setLoading(true)
    try {
      // A fresh challenge for every attempt: the server keeps one for 5 minutes
      // and spends it on the first try, so the one from page load fails once
      // someone lingers on the form, and on every retry after a failed attempt.
      const fresh = await getTokenRegistrationOptions(token)
      const response = await startRegistration({ optionsJSON: fresh.options })
      // Recovery never carries a display name: the account already exists, so the
      // form doesn't ask and there is nothing to send (the server ignores it too).
      const result = await verifyTokenRegistration(
        token,
        response,
        context.purpose === 'recovery' ? undefined : displayName || undefined,
        credentialName || undefined
      )
      if (result.ok) {
        onSuccess()
        // Leave /register behind — the token is spent, and this component would
        // otherwise re-render forever on a path the app shell never claims.
        navigate('/', { replace: true })
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const isRecovery = context?.purpose === 'recovery'
  const inputClasses =
    'w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm'

  return (
    <div className="h-full flex items-center justify-center bg-page px-4">
      <div className="ficus-section w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-primary mb-4">
          {isRecovery ? 'Register a new passkey' : 'Set up your passkey'}
        </h1>

        {checking && <p className="text-sm text-secondary">Checking your link…</p>}

        {!checking && !context && (
          <>
            <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
              {error ?? 'This link is invalid or has expired.'}
            </p>
            <p className="text-xs text-secondary mt-4">
              Invites and recovery links can only be used once. Ask an admin for a new one, or request another recovery
              link from the sign-in page.
            </p>
            <p className="text-xs text-secondary mt-4 text-center">
              <a href="/" className="text-accent-light hover:underline">
                Back to sign in
              </a>
            </p>
          </>
        )}

        {!checking && context && (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <p className="text-sm text-secondary">
              {isRecovery ? 'Registering a new passkey for ' : 'Finish setting up '}
              <span className="font-medium text-primary">{context.email}</span>.
            </p>
            {isRecovery && (
              <p className="text-xs text-secondary">
                This replaces every passkey currently on the account and signs out its other sessions.
              </p>
            )}
            {/* Identity is only asked for when the account is genuinely being set
                up. On recovery it already exists, so re-asking would be noise —
                the only thing worth naming there is the new passkey. */}
            {!isRecovery && (
              <>
                <label htmlFor="token-register-display-name" className="sr-only">
                  User display name (optional)
                </label>
                <input
                  id="token-register-display-name"
                  type="text"
                  placeholder="User display name (optional)"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={clsx('ficus-field', inputClasses)}
                />
              </>
            )}
            <label htmlFor="token-register-passkey-name" className="sr-only">
              Passkey name (optional)
            </label>
            <input
              id="token-register-passkey-name"
              type="text"
              placeholder="Passkey name (optional)"
              value={credentialName}
              onChange={(e) => setCredentialName(e.target.value)}
              className={clsx('ficus-field', inputClasses)}
            />
            <p className="text-xs text-secondary">
              Names this passkey — for example “MacBook Touch ID” or “YubiKey”. Left blank, it is named after the device
              you are using.
            </p>
            <button
              type="submit"
              disabled={loading}
              className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
            >
              {loading ? 'Registering…' : isRecovery ? 'Replace my passkey' : 'Register with Passkey'}
            </button>
            {error && (
              <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
                {error}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
