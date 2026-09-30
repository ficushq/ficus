import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AuthUser } from '@ficus/client-core'
import { addEmail, verifyAddedEmail } from '../../api/auth'

const fieldClasses =
  'ficus-field flex-1 px-3 py-2 text-sm rounded-md border border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:ring-2 focus:ring-accent/50 min-h-[44px] md:min-h-0'
const primaryClasses =
  'ficus-button ficus-button-primary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed'
const secondaryClasses =
  'ficus-button ficus-button-secondary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0'

/**
 * Add an email to an account created without one (the first admin on a self-hosted or desktop
 * instance), or change the current one. Where the instance can mail, the new address is
 * confirmed with a code; otherwise it is saved directly.
 */
export function AccountEmailForm({
  hasEmail,
  onSaved,
  api = { addEmail, verifyAddedEmail },
}: {
  /** Whether the account already has a real address (vs the no-email placeholder). */
  hasEmail: boolean
  onSaved: (user: AuthUser) => void
  api?: { addEmail: typeof addEmail; verifyAddedEmail: typeof verifyAddedEmail }
}) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [awaitingCode, setAwaitingCode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setOpen(false)
    setEmail('')
    setCode('')
    setAwaitingCode(false)
    setError(null)
  }

  const add = useMutation({
    mutationFn: () => api.addEmail(email.trim()),
    onSuccess: (result) => {
      setError(null)
      if (result.verificationRequired) setAwaitingCode(true)
      else if (result.user) {
        onSaved(result.user)
        reset()
      }
    },
    onError: (err: Error) => setError(err.message || 'Failed to save email'),
  })
  const verify = useMutation({
    mutationFn: () => api.verifyAddedEmail(email.trim(), code.trim()),
    onSuccess: ({ user }) => {
      onSaved(user)
      reset()
    },
    onError: (err: Error) => setError(err.message || 'Failed to verify email'),
  })

  if (!open) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted">
          {hasEmail
            ? 'Used for account recovery and email notifications.'
            : 'Add an email for account recovery and email notifications.'}
        </p>
        <button type="button" onClick={() => setOpen(true)} className={secondaryClasses}>
          {hasEmail ? 'Change email' : 'Add email'}
        </button>
      </div>
    )
  }

  const pending = add.isPending || verify.isPending
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return
        if (awaitingCode) {
          if (code.trim()) verify.mutate()
        } else if (email.trim()) add.mutate()
      }}
    >
      <label htmlFor="account-add-email" className="block text-sm text-muted">
        {hasEmail ? 'New email' : 'Email'}
      </label>
      <input
        id="account-add-email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={awaitingCode}
        autoFocus
        className={fieldClasses}
      />
      {awaitingCode && (
        <>
          <p className="text-xs text-secondary">Check your email for a 6-digit code.</p>
          <label htmlFor="account-add-email-code" className="sr-only">
            Verification code
          </label>
          <input
            id="account-add-email-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Verification code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoFocus
            className={fieldClasses}
          />
        </>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="submit"
          disabled={pending || !(awaitingCode ? code.trim() : email.trim())}
          className={primaryClasses}
        >
          {pending ? 'Saving...' : awaitingCode ? 'Verify and save' : 'Save email'}
        </button>
        <button type="button" onClick={reset} className={secondaryClasses}>
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {error}
        </p>
      )}
    </form>
  )
}
