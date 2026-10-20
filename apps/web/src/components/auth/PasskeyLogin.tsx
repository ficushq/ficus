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

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={handleLogin}
        disabled={loading || openingBrowser}
        className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
      >
        {loading ? 'Authenticating...' : 'Sign in with Passkey'}
      </button>
      {signInWithBrowser && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleBrowserLogin}
            disabled={loading || openingBrowser}
            className="ficus-button ficus-button-secondary w-full px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
          >
            {openingBrowser ? 'Opening browser...' : 'Sign in with browser'}
          </button>
          <p className="text-secondary text-sm">Use your usual passkey provider in your browser.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
