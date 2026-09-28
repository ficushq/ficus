import clsx from 'clsx'
import { useState } from 'react'
import { startRegistration as browserStartRegistration } from '@simplewebauthn/browser'
import type { PendingAdminAccount } from '../../api/auth'
import { createInviteLink as apiCreateInviteLink } from '../../api/users'
import { useAuthApi } from './authApi'

export interface FinishAdminSetupDependencies {
  createInviteLink: (userId: string) => Promise<{ inviteUrl?: string }>
  startRegistration: typeof browserStartRegistration
}

const defaultDependencies: FinishAdminSetupDependencies = {
  createInviteLink: apiCreateInviteLink,
  startRegistration: browserStartRegistration,
}

interface Props {
  /** Accounts waiting to become the first admin with a passkey, oldest first. Never empty. */
  accounts: PendingAdminAccount[]
  /** Called once the passkey is registered and the browser holds that account's session. */
  onSuccess: (firstAdmin: boolean) => void | Promise<void>
  onSignOut: () => void
  dependencies?: Partial<FinishAdminSetupDependencies>
}

/** The link token, or null when the server did not hand back a usable link. */
function tokenFromInviteUrl(inviteUrl: string | undefined): string | null {
  if (!inviteUrl) return null
  try {
    return new URL(inviteUrl, window.location.origin).searchParams.get('token')
  } catch {
    return null
  }
}

/** A readable reason for a failed attempt. WebAuthn's own messages are written for developers. */
function failureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'Passkey creation was cancelled or timed out.'
  }
  const message = error instanceof Error ? error.message.trim() : ''
  return message || 'Passkey creation failed.'
}

/**
 * Shown instead of the app while the browser is signed in with the bootstrap
 * instance password and an account is still waiting for its first admin passkey:
 * a first-admin registration whose passkey step failed, or an admin whose passkeys
 * were lost in a restore. That session belongs to nobody, so the app cannot work
 * properly until the account has a passkey.
 *
 * It finishes setup in THIS window with the same one-time registration link an
 * admin can issue from Settings → Users: the bootstrap session creates the link,
 * the normal link ceremony registers the passkey, and the server swaps the
 * bootstrap session for the account's own. A passkey created in another browser
 * would not be usable here, which is why the link is never handed out to open
 * elsewhere. A failed ceremony leaves the link unspent, so Retry reuses it.
 */
export function FinishAdminSetupPage({ accounts, onSuccess, onSignOut, dependencies }: Props) {
  const { createInviteLink, startRegistration } = { ...defaultDependencies, ...dependencies }
  const { getTokenRegistrationOptions, verifyTokenRegistration } = useAuthApi()
  const [accountId, setAccountId] = useState(accounts[0]!.id)
  const account = accounts.find((candidate) => candidate.id === accountId) ?? accounts[0]!
  const [displayName, setDisplayName] = useState(account.displayName ?? '')
  const [credentialName, setCredentialName] = useState('')
  // The unspent link for `link.accountId`. Kept across a failed attempt so Retry
  // doesn't mint (and rate-limit) a new link for every try.
  const [link, setLink] = useState<{ accountId: string; token: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const chooseAccount = (next: PendingAdminAccount) => {
    setAccountId(next.id)
    setDisplayName(next.displayName ?? '')
    setError(null)
  }

  const finish = async () => {
    setError(null)
    setLoading(true)
    let token = link?.accountId === account.id ? link.token : null
    try {
      if (!token) {
        token = tokenFromInviteUrl((await createInviteLink(account.id)).inviteUrl)
        if (!token) throw new Error('Ficus could not create a passkey setup link. Try again.')
        setLink({ accountId: account.id, token })
      }
      const context = await getTokenRegistrationOptions(token)
      const response = await startRegistration({ optionsJSON: context.options })
      const result = await verifyTokenRegistration(
        token,
        response,
        displayName.trim() || undefined,
        credentialName.trim() || undefined
      )
      if (result.ok) await onSuccess(result.firstAdmin === true)
    } catch (err) {
      const message = failureMessage(err)
      // A dead link can't be retried; the next attempt creates a fresh one.
      if (/invalid or has expired/i.test(message)) setLink(null)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (loading) return
    void finish()
  }

  const inputClasses =
    'w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm'

  return (
    <div className="h-full flex items-center justify-center bg-page px-4">
      <div className="ficus-section w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-primary mb-2">Finish creating your admin account</h1>
        <p className="text-sm text-secondary mb-4">
          You're signed in with the instance password, which isn't an account. Create a passkey on this device to finish
          setting up your admin account.
        </p>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {accounts.length === 1 ? (
            <p className="text-sm text-secondary">
              Account: <span className="font-medium text-primary break-all">{account.email}</span>
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm text-secondary mb-1">Choose your account</legend>
              {accounts.map((candidate) => (
                <label key={candidate.id} className="flex items-center gap-2 text-sm text-primary min-w-0">
                  <input
                    type="radio"
                    name="finish-admin-account"
                    value={candidate.id}
                    checked={candidate.id === account.id}
                    onChange={() => chooseAccount(candidate)}
                    disabled={loading}
                  />
                  <span className="break-all">{candidate.email}</span>
                </label>
              ))}
            </fieldset>
          )}
          <label htmlFor="finish-admin-display-name" className="sr-only">
            User display name (optional)
          </label>
          <input
            id="finish-admin-display-name"
            type="text"
            placeholder="User display name (optional)"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={clsx('ficus-field', inputClasses)}
          />
          <label htmlFor="finish-admin-passkey-name" className="sr-only">
            Passkey name (optional)
          </label>
          <input
            id="finish-admin-passkey-name"
            type="text"
            placeholder="Passkey name (optional)"
            value={credentialName}
            onChange={(e) => setCredentialName(e.target.value)}
            className={clsx('ficus-field', inputClasses)}
          />
          <button
            type="submit"
            disabled={loading}
            className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
          >
            {loading ? 'Creating passkey…' : error ? 'Retry' : 'Create passkey'}
          </button>
          {error && (
            <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
              {error}
            </p>
          )}
        </form>
        <p className="text-xs text-secondary mt-4 text-center">
          <button type="button" onClick={onSignOut} className="ficus-button text-accent-light hover:underline">
            Sign out
          </button>
        </p>
      </div>
    </div>
  )
}
