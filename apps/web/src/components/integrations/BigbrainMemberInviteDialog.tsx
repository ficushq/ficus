import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { Modal } from '../Modal'
import { ACCESS_LABEL } from './bigbrainMemberAccess'
import {
  createManagedBigbrainMemberInvite,
  type ManagedBigbrainMemberAccess,
  type ManagedBigbrainMemberInvite,
  type ManagedBigbrainVault,
} from '../../api/integrations'

function failureCode(error: unknown): string {
  return error instanceof ApiError && error.payload && typeof error.payload === 'object'
    ? String((error.payload as { code?: unknown }).code ?? '')
    : ''
}
/** The server will never return a link for this request ID again: the next try needs a new one. */
const TERMINAL = new Set(['operation_failed', 'invite_expired', 'request_conflict'])

/** Why no link was created, and what to do. Never echoes server text (no secret ever lands here). */
function inviteFailure(code: string): string {
  if (TERMINAL.has(code))
    return 'No invite link could be confirmed. Check Pending invites and cancel any that are not recognised, then create a new one.'
  if (
    ['tls_unavailable', 'maintenance', 'unavailable', 'host_unreachable', 'busy', 'upstream_unavailable'].includes(code)
  )
    return 'This vault is not reachable at its address yet, so no link was created. Try again in a few minutes.'
  if (code === 'generation_conflict') return 'This vault changed meanwhile. Refresh the vault list and try again.'
  if (code === 'rate_limited' || code === 'capacity')
    return 'Too many invite links were created recently. Cancel unused invites or try again later.'
  if (code === 'human_required' || code === 'permission_required') return 'You do not have permission to do that.'
  return 'Could not create an invite link. Refresh the vault list and try again.'
}

const draft = () => ({ requestId: crypto.randomUUID(), displayName: '', access: 'read' as ManagedBigbrainMemberAccess })

/**
 * Member invite link for one managed vault. The link is a secret that makes whoever redeems it
 * first a new member, so it is requested only on an explicit submit, kept in this component's
 * state (never the query cache, storage or a toast), never navigated to, and cleared on close,
 * expiry or a change of vault. A retried submit of the same draft reuses its request ID, so the
 * server returns the same link instead of minting another.
 */
export function BigbrainMemberInviteDialog({
  vault,
  isOpen,
  onClose,
  onInvited,
}: {
  vault: ManagedBigbrainVault
  isOpen: boolean
  onClose: () => void
  /** A new invite exists (the member list should refresh). Never receives the link. */
  onInvited: () => void
}) {
  const [form, setForm] = useState(draft)
  const [invite, setInvite] = useState<ManagedBigbrainMemberInvite | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const generation = useRef(0)

  // Any change of target or closing forgets the link and abandons an in-flight request.
  useEffect(() => {
    generation.current += 1
    setForm(draft())
    setInvite(null)
    setError(null)
    setCopied(false)
    setPending(false)
  }, [vault.vaultId, isOpen])

  useEffect(() => {
    if (!invite) return
    const timer = setTimeout(
      () => {
        setInvite(null)
        setError('That link expired. Create a new one.')
      },
      Math.max(0, Date.parse(invite.expiresAt) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [invite])

  // Editing the draft is a different request: it gets a new request ID.
  const edit = (patch: Partial<Omit<ReturnType<typeof draft>, 'requestId'>>) =>
    setForm((current) => ({ ...current, ...patch, requestId: crypto.randomUUID() }))
  const name = form.displayName
  // Surrounding spaces are trimmed on submit, never a reason to refuse.
  const trimmed = name.trim()
  const valid = trimmed !== '' && trimmed.length <= 120

  async function create() {
    const request = ++generation.current
    setPending(true)
    setError(null)
    try {
      const result = await createManagedBigbrainMemberInvite(vault.vaultId, {
        requestId: form.requestId,
        expectedGeneration: vault.desiredGeneration,
        displayName: trimmed,
        access: form.access,
      })
      if (generation.current !== request) return
      setInvite(result)
      onInvited()
    } catch (error) {
      if (generation.current !== request) return
      const code = failureCode(error)
      // Transient failures retry the same request (the server then returns the same link);
      // a terminal one never will, so the next try is a new request.
      if (TERMINAL.has(code)) setForm((current) => ({ ...current, requestId: crypto.randomUUID() }))
      setError(inviteFailure(code))
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
    <Modal isOpen={isOpen} onClose={onClose} title={`Invite a member to ${vault.displayName}`}>
      <div className="space-y-3 text-sm">
        <p className="text-secondary">
          An invite link adds one person to this vault as a new member with their own name, so everything they write is
          attributed to them. It works once and expires after 24 hours.
        </p>
        <p className="text-xs text-muted">
          Send it only to that person, privately (for example in a direct message): whoever opens it first becomes the
          member. Ficus records who created each invite and itself only reads this vault.
        </p>
        {!invite && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (valid && !pending) void create()
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-primary">
              Name
              <input
                className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2"
                value={name}
                maxLength={240}
                disabled={pending}
                onChange={(event) => edit({ displayName: event.target.value })}
                required
              />
            </label>
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-primary">Access</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {(['read', 'write'] as const).map((access) => (
                  <label key={access} className="flex items-center gap-2 text-sm text-primary">
                    <input
                      type="radio"
                      name="member-access"
                      value={access}
                      checked={form.access === access}
                      disabled={pending}
                      onChange={() => edit({ access })}
                    />
                    {ACCESS_LABEL[access]}
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              type="submit"
              className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
              disabled={pending || !valid}
            >
              {pending ? 'Creating link…' : 'Create invite link'}
            </button>
          </form>
        )}
        {invite && (
          <div className="space-y-2">
            <p className="text-xs text-primary">
              Invite for <span className="font-medium">{invite.displayName}</span> ({ACCESS_LABEL[invite.access]}).
            </p>
            <label className="flex flex-col gap-1 text-xs font-medium text-primary">
              Invite link (single use)
              <input
                aria-label="Member invite link"
                readOnly
                className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2 font-mono text-xs"
                value={invite.inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <p className="text-xs text-muted">
              They paste it into the BigBrain app. Expires {new Date(invite.expiresAt).toLocaleString()}. Until then it
              is listed under pending invites, where it can be cancelled.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
                onClick={() => {
                  generation.current += 1
                  setInvite(null)
                  setCopied(false)
                  setForm(draft())
                }}
              >
                Invite someone else
              </button>
            </div>
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
