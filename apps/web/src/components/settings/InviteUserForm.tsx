import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { inviteUser, resendInvite, type InvitedUser } from '../../api/users'
import { isUserAssignableRole } from '../../api/roles'
import { queries } from '../../queryOptions'
import { queryKeys, onboardingQueryKeys } from '../../queryKeys'
import { inviteCostLine } from './seatPricing'

const DEFAULT_INVITE_ROLE_SLUG = 'operator'

/** Shared inline invitation form for Settings and initial setup. */
export function InviteUserForm({
  onCancel,
  onInvited,
}: {
  onCancel?: () => void
  onInvited?: (user: InvitedUser) => void
}) {
  const queryClient = useQueryClient()
  const { data: roles = [] } = useQuery(queries.roles.list())
  const { data: seatData } = useQuery(queries.users.seatPricing())
  const seatPricing = seatData?.pricing ?? null
  const assignableRoles = roles.filter(isUserAssignableRole)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteDisplayName, setInviteDisplayName] = useState('')
  const [inviteRoleSlug, setInviteRoleSlug] = useState(DEFAULT_INVITE_ROLE_SLUG)
  // Keep the control and the payload agreed even on an instance whose roles were
  // renamed away from `operator` — a <select> whose value matches no <option>
  // renders the first one while state still says something else.
  const selectedInviteRole =
    assignableRoles.length === 0 || assignableRoles.some((r) => r.slug === inviteRoleSlug)
      ? inviteRoleSlug
      : assignableRoles[0].slug

  const [copyState, setCopyState] = useState('Copy link')
  const inviteMutation = useMutation({
    mutationFn: () => inviteUser(inviteEmail.trim(), inviteDisplayName.trim() || undefined, [selectedInviteRole]),
    onSuccess: (user) => {
      onInvited?.(user)
      if (onInvited) {
        setInviteEmail('')
        setInviteDisplayName('')
        setInviteRoleSlug(DEFAULT_INVITE_ROLE_SLUG)
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
      queryClient.invalidateQueries({ queryKey: onboardingQueryKeys.all })
    },
  })
  const resendMutation = useMutation({
    mutationFn: () => resendInvite(inviteMutation.data!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  })
  if (inviteMutation.isSuccess && !onInvited) {
    const invited = resendMutation.data ?? inviteMutation.data
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm text-primary">
          {invited.inviteEmailFailed
            ? 'The account was created, but the invitation email could not be sent.'
            : invited.inviteUrl
              ? 'Invitation link ready to share.'
              : `Invitation sent to ${inviteEmail}.`}
        </p>
        {invited.inviteEmailFailed && (
          <button
            type="button"
            disabled={resendMutation.isPending}
            onClick={() => resendMutation.mutate()}
            className="ficus-button text-sm text-accent-light disabled:opacity-50"
          >
            {resendMutation.isPending ? 'Resending…' : 'Resend invitation'}
          </button>
        )}
        {resendMutation.isError && (
          <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
            {resendMutation.error.message}
          </p>
        )}
        {invited.inviteUrl && (
          <>
            <p className="text-xs text-muted">Share this one-time link with your teammate. It expires in 7 days.</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-surface-secondary px-3 py-2 text-xs">
                {invited.inviteUrl}
              </code>
              <button
                type="button"
                className="ficus-button text-sm text-accent-light"
                onClick={async () => {
                  try {
                    if (!navigator.clipboard) throw new Error('Clipboard unavailable')
                    await navigator.clipboard.writeText(invited.inviteUrl!)
                    setCopyState('Copied')
                  } catch {
                    setCopyState('Could not copy — select the link')
                  }
                }}
              >
                {copyState}
              </button>
            </div>
          </>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            className="ficus-button text-sm text-accent-light"
            onClick={() => {
              inviteMutation.reset()
              resendMutation.reset()
              setInviteEmail('')
              setInviteDisplayName('')
              setInviteRoleSlug(DEFAULT_INVITE_ROLE_SLUG)
              setCopyState('Copy link')
            }}
          >
            Invite another teammate
          </button>
          <button type="button" className="ficus-button text-sm text-muted" onClick={onCancel}>
            Done
          </button>
        </div>
      </div>
    )
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        inviteMutation.mutate()
      }}
    >
      <label htmlFor="invite-user-email" className="sr-only">
        Email address
      </label>
      <input
        id="invite-user-email"
        required
        type="email"
        autoComplete="email"
        value={inviteEmail}
        onChange={(e) => setInviteEmail(e.target.value)}
        placeholder="Email address"
        className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-3 py-2 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
      />
      <label htmlFor="invite-user-display-name" className="sr-only">
        Display name (optional)
      </label>
      <input
        id="invite-user-display-name"
        type="text"
        autoComplete="name"
        value={inviteDisplayName}
        onChange={(e) => setInviteDisplayName(e.target.value)}
        placeholder="Display name (optional)"
        className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-3 py-2 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
      />
      <div>
        <label htmlFor="invite-user-role" className="block text-xs text-muted mb-1">
          Role
        </label>
        <select
          id="invite-user-role"
          value={selectedInviteRole}
          onChange={(e) => setInviteRoleSlug(e.target.value)}
          className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-3 py-2 text-primary  focus:ring-1 focus:ring-accent"
        >
          {assignableRoles.length === 0 && <option value={DEFAULT_INVITE_ROLE_SLUG}>Operator</option>}
          {assignableRoles.map((role) => (
            <option key={role.id} value={role.slug}>
              {role.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted mt-1">Granted system-wide as soon as the invite is created.</p>
      </div>
      {/* Stated where the cost is actually incurred, not only in the
                header — an admin who opened this form to send one invite should
                not have to scroll back up to learn what it does to the bill. */}
      {seatPricing && <p className="text-xs text-muted">{inviteCostLine(seatPricing)}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!inviteEmail || inviteMutation.isPending}
          className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {inviteMutation.isPending ? 'Inviting...' : 'Send Invite'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="ficus-button px-4 py-2 text-sm text-muted hover:text-primary"
          >
            Cancel
          </button>
        )}
      </div>
      {inviteMutation.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {(inviteMutation.error as Error)?.message || 'Failed to invite user'}
        </p>
      )}
    </form>
  )
}
