import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { startRegistration } from '@simplewebauthn/browser'
import { type AddPasskeyContext } from '../../api/auth'
import { ApiError } from '../../api/client'
import { useAuthApi } from './authApi'

interface Props {
  onSuccess: () => void
}

/** Read `#code=…` once and strip it from the address bar and history, so the secret doesn't linger. */
function takeCodeFromFragment(): string {
  const match = /(?:^#|&)code=([^&]+)/.exec(window.location.hash)
  if (!match) return ''
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function redeemErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'NotAllowedError') return 'Registration was cancelled.'
  if (err instanceof ApiError && err.status === 401 && /code/i.test(err.message)) {
    return 'This code is invalid, expired or already used. Create a new one from Settings → Account → Passkeys.'
  }
  if (err instanceof ApiError && err.status === 403 && /address/i.test(err.message)) {
    return 'This address isn’t an allowed address of this server. Open the link at an address shown in Settings.'
  }
  if (err instanceof ApiError && err.status === 429) return 'Too many attempts. Wait a minute and try again.'
  return (err as Error)?.message || 'Something went wrong. Try again.'
}

/**
 * `/add-passkey` — redeem a one-time code from Settings → Account → Passkeys → Add a
 * passkey for another address. The code (from the link's fragment, or typed) lets
 * its owner register ONE more passkey at this address and signs them in here. It
 * removes nothing: other passkeys and sessions stay as they are. Nothing is spent
 * until the passkey ceremony succeeds.
 */
export function AddPasskeyPage({ onSuccess }: Props) {
  const navigate = useNavigate()
  const { getAddPasskeyOptions, verifyAddPasskey } = useAuthApi()
  const [code, setCode] = useState('')
  const [typed, setTyped] = useState('')
  const [context, setContext] = useState<AddPasskeyContext | null>(null)
  const [credentialName, setCredentialName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(false)

  const lookUp = useCallback(
    async (value: string) => {
      setChecking(true)
      setError(null)
      try {
        const ctx = await getAddPasskeyOptions(value)
        setCode(value)
        setContext(ctx)
      } catch (err) {
        setContext(null)
        setError(redeemErrorMessage(err))
      } finally {
        setChecking(false)
      }
    },
    [getAddPasskeyOptions]
  )

  useEffect(() => {
    const fromLink = takeCodeFromFragment()
    if (fromLink) {
      setTyped(fromLink)
      void lookUp(fromLink)
    }
  }, [lookUp])

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault()
    if (checking || !typed.trim()) return
    void lookUp(typed.trim())
  }

  const register = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading || !context) return
    setError(null)
    setLoading(true)
    try {
      // A fresh challenge for every attempt (the one from the lookup may have expired).
      const fresh = await getAddPasskeyOptions(code)
      const response = await startRegistration({ optionsJSON: fresh.options })
      const result = await verifyAddPasskey(code, response, credentialName || undefined)
      if (result.ok) {
        onSuccess()
        navigate('/', { replace: true })
      }
    } catch (err) {
      const message = redeemErrorMessage(err)
      setError(message)
      // A dead code can't be retried: go back to asking for one.
      if (err instanceof ApiError && err.status === 401 && /code/i.test(err.message)) setContext(null)
    } finally {
      setLoading(false)
    }
  }

  const inputClasses =
    'w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm'

  return (
    <div className="h-full flex items-center justify-center bg-page px-4">
      <div className="ficus-section w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-primary mb-4">Add a passkey for this address</h1>

        {!context && (
          <form className="space-y-4" onSubmit={submitCode}>
            <p className="text-sm text-secondary">
              Enter the one-time code from Settings → Account → Passkeys → Add a passkey for another address.
            </p>
            <label htmlFor="add-passkey-code" className="sr-only">
              Code
            </label>
            <input
              id="add-passkey-code"
              type="text"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={clsx('ficus-field font-mono', inputClasses)}
            />
            <button
              type="submit"
              disabled={checking || !typed.trim()}
              className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}

        {context && (
          <form className="space-y-4" onSubmit={register}>
            <p className="text-sm text-secondary">
              Add a passkey for <span className="font-medium text-primary">{context.email}</span> at{' '}
              <span className="font-medium text-primary">{window.location.host}</span>.
            </p>
            <p className="text-xs text-secondary">Your other passkeys and sessions stay as they are.</p>
            <label htmlFor="add-passkey-name" className="sr-only">
              Passkey name (optional)
            </label>
            <input
              id="add-passkey-name"
              type="text"
              placeholder="Passkey name (optional)"
              value={credentialName}
              onChange={(e) => setCredentialName(e.target.value)}
              className={clsx('ficus-field', inputClasses)}
            />
            <button
              type="submit"
              disabled={loading}
              className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
            >
              {loading ? 'Adding…' : 'Add passkey'}
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-4 text-status-danger-600 dark:text-status-danger-400 text-sm">
            {error}
          </p>
        )}
        <p className="text-xs text-secondary mt-4 text-center">
          <a href="/" className="text-accent-light hover:underline">
            Back to sign in
          </a>
        </p>
      </div>
    </div>
  )
}
