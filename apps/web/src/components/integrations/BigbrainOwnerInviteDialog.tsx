import { useEffect, useRef, useState } from 'react'
import { Modal } from '../Modal'
import {
  createManagedBigbrainOwnerInvite,
  type ManagedBigbrainOwnerInvite,
  type ManagedBigbrainVault,
} from '../../api/integrations'

/**
 * Owner device link for one managed vault. The link is a secret that lets its holder connect a
 * BigBrain app as the vault OWNER, so it is requested only on an explicit click, kept in this
 * component's state (never the query cache, storage or a toast), never navigated to, and cleared
 * on close, expiry or a change of vault.
 */
export function BigbrainOwnerInviteDialog({
  vault,
  isOpen,
  onClose,
}: {
  vault: ManagedBigbrainVault
  isOpen: boolean
  onClose: () => void
}) {
  const [invite, setInvite] = useState<ManagedBigbrainOwnerInvite | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const generation = useRef(0)

  // Any change of target or closing forgets the link and abandons an in-flight request.
  useEffect(() => {
    generation.current += 1
    setInvite(null)
    setError(null)
    setCopied(false)
    setPending(false)
  }, [vault.vaultId, isOpen])

  useEffect(() => {
    if (!invite) return
    const remaining = Date.parse(invite.expiresAt) - Date.now()
    const timer = setTimeout(
      () => {
        setInvite(null)
        setError('That link expired. Create a new one when you are ready to connect a device.')
      },
      Math.max(0, remaining)
    )
    return () => clearTimeout(timer)
  }, [invite])

  async function create() {
    const request = ++generation.current
    setPending(true)
    setError(null)
    try {
      const result = await createManagedBigbrainOwnerInvite(vault.vaultId, {
        requestId: crypto.randomUUID(),
        expectedGeneration: vault.desiredGeneration,
      })
      if (generation.current === request) setInvite(result)
    } catch {
      if (generation.current === request)
        setError('Could not create a device link. Refresh the vault list and try again.')
    } finally {
      if (generation.current === request) setPending(false)
    }
  }

  async function copy() {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.inviteUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Connect a device to ${vault.displayName}`}>
      <div className="space-y-3 text-sm">
        <p className="text-secondary">
          A device link connects a BigBrain app to this vault as you, its owner. Anyone holding the link gets your
          access until it is used or expires, so create it only when you are about to connect your own device.
        </p>
        <p className="text-xs text-muted">
          Invite other people from your BigBrain app after connecting. Ficus itself only reads this vault.
        </p>
        {!invite && (
          <button
            type="button"
            className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            disabled={pending}
            onClick={create}
          >
            {pending ? 'Creating link…' : 'Create device link'}
          </button>
        )}
        {invite && (
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-primary">
              Device link (single use)
              <input
                aria-label="Owner device link"
                readOnly
                className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2 font-mono text-xs"
                value={invite.inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <p className="text-xs text-muted">
              Paste it into the BigBrain app on your device. Expires {new Date(invite.expiresAt).toLocaleTimeString()}.
            </p>
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-status-danger-600">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
