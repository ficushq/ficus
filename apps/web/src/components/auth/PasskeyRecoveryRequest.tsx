import { useState } from 'react'
import { useAuthApi } from './authApi'

interface Props {
  onBack: () => void
}

/**
 * "I lost my passkey" — request a one-time link that lets you register a new one.
 *
 * The confirmation is deliberately worded as "if that address has an account":
 * the server answers identically whether or not it does, and a message that said
 * "check your inbox" would undo that by confirming the account exists.
 */
export function PasskeyRecoveryRequest({ onBack }: Props) {
  const { requestPasskeyRecovery } = useAuthApi()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || loading) return
    setError(null)
    setLoading(true)
    try {
      await requestPasskeyRecovery(email.trim())
      setSent(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          If <span className="font-medium text-primary">{email}</span> has an account here, a one-time link to register
          a new passkey is on its way.
        </p>
        <p className="text-xs text-secondary">
          The link expires in an hour and can only be used once. Using it replaces every passkey currently on the
          account and signs out its other sessions.
        </p>
        <p className="text-xs text-secondary text-center">
          <button type="button" onClick={onBack} className="ficus-button text-accent-light hover:underline">
            Back to login
          </button>
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-secondary">
        Enter your email and we’ll send a one-time link to register a new passkey.
      </p>
      <label htmlFor="recover-email" className="sr-only">
        Email
      </label>
      <input
        id="recover-email"
        type="email"
        placeholder="Email"
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm"
      />
      <button
        type="submit"
        disabled={!email.trim() || loading}
        className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
      >
        {loading ? 'Sending…' : 'Send recovery link'}
      </button>
      {error && (
        <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
          {error}
        </p>
      )}
      <p className="text-xs text-secondary text-center">
        <button type="button" onClick={onBack} className="ficus-button text-accent-light hover:underline">
          Back to login
        </button>
      </p>
    </form>
  )
}
