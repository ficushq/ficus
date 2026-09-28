import { useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import { useAuthApi } from './authApi'

interface Props {
  onSuccess: () => void
}

export function PasskeyLogin({ onSuccess }: Props) {
  const { getLoginOptions, verifyLogin } = useAuthApi()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleLogin = async () => {
    setError(null)
    setLoading(true)
    try {
      const { challengeKey, options } = await getLoginOptions()
      const response = await startAuthentication({ optionsJSON: options })
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
        disabled={loading}
        className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
      >
        {loading ? 'Authenticating...' : 'Sign in with Passkey'}
      </button>
      {error && (
        <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
