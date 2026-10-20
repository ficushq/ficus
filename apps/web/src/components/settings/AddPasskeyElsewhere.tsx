import { useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import { issuePasskeyCode, passkeyCodeOptions, type PasskeyCodeIssue } from '../../api/auth'
import { ApiError } from '../../api/client'
import { Modal } from '../Modal'
import { CopyButton } from './SettingsRow'

const TITLE = 'Add a passkey for another address'

const api = { passkeyCodeOptions, issuePasskeyCode, startAuthentication }
export type AddPasskeyElsewhereApi = typeof api

function issueErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'NotAllowedError') return 'Confirmation was cancelled.'
  if (err instanceof ApiError && err.status === 401) {
    return 'Your passkey couldn’t be confirmed at this address. Try from an address your passkey works at (for example the local address).'
  }
  if (err instanceof ApiError && err.status === 429) return 'Too many codes requested. Try again in 15 minutes.'
  return (err as Error)?.message || 'Could not create a code.'
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** The /add-passkey page a link points at (origin + APP_BASE_PATH), without the code fragment. */
function pageUrl(url: string): string {
  return url.split('#')[0]
}

/**
 * Account → Passkeys: create a one-time link (and typeable code) that adds a passkey
 * for this account at ANOTHER allowed address of this server — for example after
 * the public address changes, since passkeys are bound to the hostname they were
 * created on. It needs a fresh passkey confirmation, never removes a passkey and
 * never signs anyone out. The code is shown once and kept only in this dialog's state.
 */
export function AddPasskeyElsewhere({ apiOverride }: { apiOverride?: Partial<AddPasskeyElsewhereApi> } = {}) {
  const { passkeyCodeOptions, issuePasskeyCode, startAuthentication } = { ...api, ...apiOverride }
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<PasskeyCodeIssue | null>(null)
  const [origin, setOrigin] = useState<string>('')

  const close = () => {
    setOpen(false)
    setIssued(null)
    setError(null)
    setOrigin('')
  }

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { options, challengeKey } = await passkeyCodeOptions()
      const response = await startAuthentication({ optionsJSON: options })
      const result = await issuePasskeyCode(challengeKey, response)
      setIssued(result)
      setOrigin(result.links[0]?.origin ?? '')
    } catch (err) {
      setError(issueErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const link = issued?.links.find((l) => l.origin === origin) ?? issued?.links[0]
  const expiresAt = issued ? new Date(issued.expiresAt) : null

  return (
    <div className="mt-4">
      <button
        type="button"
        data-setting-target="add-passkey-elsewhere"
        onClick={() => setOpen(true)}
        className="ficus-button ficus-button-secondary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0"
      >
        {TITLE}
      </button>
      <Modal
        isOpen={open}
        onClose={close}
        title={TITLE}
        closeOnEscape
        footer={
          issued ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={close}
                className="ficus-button ficus-button-primary px-4 py-2 rounded-md text-sm"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="ficus-button ficus-button-secondary px-4 py-2 rounded-md text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className="ficus-button ficus-button-primary px-4 py-2 rounded-md text-sm disabled:opacity-50"
              >
                {busy ? 'Waiting for passkey…' : 'Continue with passkey'}
              </button>
            </div>
          )
        }
      >
        {!issued ? (
          <div className="space-y-3 text-sm text-secondary">
            <p>
              Use this when this server has another address (for example a new public address) and your passkeys only
              work here. Passkeys belong to the address they were created at.
            </p>
            <p>
              Confirm with one of your passkeys to get a one-time link. It adds a passkey; nothing is removed and nobody
              is signed out.
            </p>
            {error && (
              <p role="alert" className="text-status-danger-600 dark:text-status-danger-400">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4 text-sm text-secondary">
            <p>
              Open this link at the other address. It works once, until{' '}
              <span className="font-medium text-primary">{expiresAt?.toLocaleTimeString()}</span> (15 minutes). It is
              shown only now.
            </p>
            {issued.links.length > 1 && (
              <div>
                <label htmlFor="add-passkey-elsewhere-origin" className="block text-xs text-muted mb-1">
                  Address
                </label>
                <select
                  id="add-passkey-elsewhere-origin"
                  value={link?.origin}
                  onChange={(e) => setOrigin(e.target.value)}
                  className="ficus-field w-full px-3 py-2 rounded-md border border-input-border bg-input-bg text-primary"
                >
                  {issued.links.map((l) => (
                    <option key={l.origin} value={l.origin}>
                      {hostOf(l.origin)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {link && (
              <div className="flex items-start gap-2">
                <code data-testid="add-passkey-link" className="flex-1 min-w-0 break-all text-xs text-primary">
                  {link.url}
                </code>
                <CopyButton value={link.url} label="Copy link" />
              </div>
            )}
            <div>
              <p className="text-xs text-muted mb-1">
                Or go to{' '}
                <span className="text-primary break-all">{link ? pageUrl(link.url) : 'the other address'}</span> and
                type this code:
              </p>
              <div className="flex items-center gap-2">
                <code data-testid="add-passkey-code" className="flex-1 font-mono text-base tracking-wider text-primary">
                  {issued.code}
                </code>
                <CopyButton value={issued.code} label="Copy code" />
              </div>
            </div>
            <p className="text-xs text-muted">
              Creating another code cancels this one. Anyone with the code can add a passkey to your account until it is
              used or expires, so only open it yourself.
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}
