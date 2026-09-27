import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import { useAuthApi } from './authApi'

interface Props {
  onSuccess: (firstAdmin: boolean) => void
  /** Called after a failed registration attempt, once the error is on screen. */
  onFailure?: () => void
  isBootstrap?: boolean
}

export function PasskeyRegister({ onSuccess, onFailure, isBootstrap = false }: Props) {
  const { getRegistrationOptions, sendVerificationEmail, verifyRegistration } = useAuthApi()
  const [step, setStep] = useState<'email' | 'verify' | 'passkey'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [credentialName, setCredentialName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Whether outbound email is set up. When false, the code is surfaced (auto-filled for the first
  // admin, or carried in an invite link) rather than mailed.
  const [emailConfigured, setEmailConfigured] = useState(true)
  const [fromInvite, setFromInvite] = useState(false)
  // True when the server (or an invite link) supplied the code: nothing to type.
  const codeAutoFilled = !emailConfigured && code !== ''

  // An admin invite link (?invite=<email>&code=<code>) pre-fills email + code and skips the send step.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const inviteEmail = params.get('invite')
    const inviteCode = params.get('code')
    if (inviteEmail && inviteCode) {
      setEmail(inviteEmail)
      setCode(inviteCode)
      setFromInvite(true)
      setEmailConfigured(false)
      setStep('verify')
    }
  }, [])

  const handleSendCode = async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await sendVerificationEmail(email)
      setEmailConfigured(res.emailConfigured ?? true)
      if (res.code) setCode(res.code) // first-user bootstrap with no email: auto-fill the code
      setStep('verify')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyAndRegister = async () => {
    setError(null)
    setLoading(true)
    try {
      const { options } = await getRegistrationOptions(email, code, displayName)
      const response = await startRegistration({ optionsJSON: options })
      const result = await verifyRegistration(email, response, displayName, credentialName || undefined)
      if (result.ok) {
        onSuccess(result.firstAdmin ?? isBootstrap)
      }
    } catch (err) {
      setError((err as Error).message)
      onFailure?.()
    } finally {
      setLoading(false)
    }
  }

  const inputClasses =
    'w-full rounded-md border-input-border bg-input-bg text-primary placeholder:text-placeholder focus:border-accent focus:ring-accent px-3 py-2 border text-sm'

  /**
   * Enter submits whichever step is on screen.
   *
   * This was a plain <div> of type="button" inputs, so pressing Enter in any
   * field did nothing at all — on the very first screen a new instance shows,
   * where the habit of typing an email and hitting Enter is strongest.
   *
   * One form rather than two: the email field stays mounted across both steps
   * (it is merely disabled after the code is sent), so splitting it would put
   * the code and name fields in a different form from the email they belong
   * to, and a browser would autofill them as unrelated.
   *
   * The guards mirror each button's `disabled` exactly. Browsers skip implicit
   * submission when the submit button is disabled, but that is a browser
   * behaviour to lean on, not one to depend on — a double-Enter while a
   * request is in flight must not fire a second registration.
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    if (step === 'email') {
      if (!email) return
      void handleSendCode()
      return
    }
    if (!code || !email) return
    void handleVerifyAndRegister()
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <label htmlFor="passkey-register-email" className="sr-only">
        Email
      </label>
      <input
        id="passkey-register-email"
        type="email"
        placeholder="Email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={clsx('ficus-field', inputClasses)}
        disabled={step !== 'email'}
      />
      {step === 'email' && (
        <button
          type="submit"
          disabled={!email || loading}
          className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
        >
          {loading ? 'Sending...' : isBootstrap ? 'Create Admin Account' : 'Send Verification Code'}
        </button>
      )}
      {step === 'verify' && (
        <>
          <p className="text-sm text-secondary">
            {codeAutoFilled
              ? fromInvite
                ? 'Your invite is verified — set a display name and register a passkey.'
                : 'No email provider is configured, so no verification code is needed — set a display name and register a passkey.'
              : 'Check your email for a 6-digit code.'}
          </p>
          {/* The code is only something to TYPE when it was mailed. The first
              admin without email and invite-link users get it from the server
              (auto-filled in state) and have nothing to do with it, so the
              field stays hidden for them. */}
          {!codeAutoFilled && (
            <>
              <label htmlFor="passkey-register-code" className="sr-only">
                Verification code
              </label>
              <input
                id="passkey-register-code"
                type="text"
                placeholder="Verification Code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={clsx('ficus-field', `${inputClasses} text-center text-2xl tracking-widest`)}
                maxLength={6}
              />
            </>
          )}
        </>
      )}
      {step === 'verify' && (
        <>
          <label htmlFor="passkey-register-display-name" className="sr-only">
            User display name (optional)
          </label>
          <input
            id="passkey-register-display-name"
            type="text"
            placeholder="User display name (optional)"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={clsx('ficus-field', inputClasses)}
          />
          {/* No helper line here: the placeholder already says "User display
              name", and the passkey-name field immediately below carries its
              own description, which is what actually needed disambiguating. */}
          <label htmlFor="passkey-register-passkey-name" className="sr-only">
            Passkey name (optional)
          </label>
          <input
            id="passkey-register-passkey-name"
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
            disabled={!code || !email || loading}
            className="ficus-button ficus-button-primary w-full px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-on-accent font-medium text-sm disabled:opacity-50"
          >
            {loading ? 'Registering...' : 'Register with Passkey'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-status-danger-600 dark:text-status-danger-400 text-sm">
          {error}
        </p>
      )}
    </form>
  )
}
