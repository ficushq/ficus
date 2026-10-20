import { useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import { useAuthApi } from './authApi'
import { desktopBrowserSignIn } from '../../lib/desktop'

interface Props {
  onSuccess: () => void
  authenticate?: typeof startAuthentication
}

export function PasskeyLogin({ onSuccess, authenticate = startAuthentication }: Props) {
  const { getLoginOptions, verifyLogin } = useAuthApi()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openingBrowser, setOpeningBrowser] = useState(false)
  const signInWithBrowser = desktopBrowserSignIn()
  const handleBrowserLogin = async () => {
    if (!signInWithBrowser || loading || openingBrowser) return
    setError(null)
    setOpeningBrowser(true)
    try {
      await signInWithBrowser()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open browser sign-in.')
    } finally {
      setOpeningBrowser(false)
    }
  }

  const handleLogin = async () => {
    setError(null)
    setLoading(true)
    try {
      const { challengeKey, options } = await getLoginOptions()
      const response = await authenticate({ optionsJSON: options })
      const result = await verifyLogin(challengeKey, response)
      if (result.ok) {
        onSuccess()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const busy = loading || openingBrowser
  const errorLine = error && (
    <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
      {error}
    </p>
  )

  // A Desktop window offers browser sign-in only for an attached self-hosted installation. Its people
  // made their passkeys in a browser or password manager, which Electron's built-in passkey prompt
  // cannot see, so the browser is the main way in and the in-app passkey (one saved in Ficus Desktop,
  // or a security key) is the alternative. Nothing starts on its own, even after a failed attempt.
  if (signInWithBrowser)
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleBrowserLogin}
            disabled={busy}
            className="ficus-button ficus-button-primary w-full px-4 py-2.5 rounded-md font-medium text-sm disabled:opacity-50"
          >
            {openingBrowser ? 'Opening your browser…' : 'Sign in with your browser'}
          </button>
          <p className="text-secondary text-sm text-center">
            Approve this sign-in in your browser with the passkey or password manager you normally use.
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogin}
          disabled={busy}
          className="ficus-button ficus-button-link block mx-auto text-sm disabled:opacity-50"
        >
          {loading ? 'Waiting for your passkey…' : 'Use a passkey or security key instead'}
        </button>
        {errorLine}
      </div>
    )

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={handleLogin}
        disabled={busy}
        className="ficus-button ficus-button-primary w-full px-4 py-2.5 rounded-md font-medium text-sm disabled:opacity-50"
      >
        {loading ? 'Waiting for your passkey…' : 'Sign in with passkey'}
      </button>
      {errorLine}
    </div>
  )
}
