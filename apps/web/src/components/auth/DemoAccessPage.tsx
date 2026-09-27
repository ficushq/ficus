import { useCallback, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { PairingCode } from '../settings/PairingCode'
import { renderPairing } from '../settings/pairingQr'
import { useAuthApi } from './authApi'

type Pairing = Awaited<ReturnType<typeof renderPairing>> & { code: string }

/**
 * `/demo` — app-store reviewer access on a designated demo instance.
 *
 * Rendered before the auth gate because the visitor has no account: the private
 * access code they were given yields an ordinary 90-second, single-use pairing
 * code for the shared demo account, which the Tau app scans (or opens through
 * the deep link on the same phone). Nothing here signs the browser in.
 */
export function DemoAccessPage({ enabled }: { enabled: boolean }) {
  const { demoPair } = useAuthApi()
  const [secret, setSecret] = useState('')
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const pair = useCallback(async () => {
    if (!secret) return
    setLoading(true)
    setError(null)
    try {
      const value = await demoPair(secret)
      setPairing({ ...(await renderPairing(value)), code: value.code })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setError(
        /demo_not_seeded/.test(message)
          ? 'This instance has not been set up for review yet. Ask the team to run `tau demo seed`.'
          : /rate_limited|429/.test(message)
            ? 'Too many attempts. Wait a minute and try again.'
            : 'That access code was not accepted.'
      )
      setPairing(null)
    } finally {
      setLoading(false)
    }
  }, [demoPair, secret])

  const clearPairing = useCallback(() => setPairing(null), [])

  if (!enabled) return <Navigate to="/" replace />

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void pair()
  }

  return (
    <div className="h-full flex items-center justify-center bg-page px-4">
      <div className="ficus-section w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-primary mb-1">Review Tau</h1>
        <p className="text-sm text-secondary mb-4">
          Enter the reviewer access code to pair the Tau app with the demo workspace. The pairing code is single-use and
          expires in 90 seconds; generate another for each device.
        </p>
        {pairing ? (
          <PairingCode
            pairing={pairing}
            onExpired={clearPairing}
            onRegenerate={() => void pair()}
            regenerating={loading}
            hint="Scan with the Tau app, or open the link on this phone."
          />
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="demo-access-code" className="sr-only">
              Reviewer access code
            </label>
            <input
              id="demo-access-code"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Reviewer access code"
              autoComplete="off"
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? 'demo-access-error' : undefined}
              className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm"
            />
            {error && (
              <p id="demo-access-error" className="text-sm text-status-danger-600 dark:text-status-danger-400 mt-2">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading || !secret}
              className="ficus-button ficus-button-primary w-full mt-3 px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
            >
              {loading ? 'Generating…' : 'Generate pairing code'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
