import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { inviteUser, resendInvite, type InvitedUser } from '../../api/users'
import { isUserAssignableRole } from '../../api/roles'
import { queries } from '../../queryOptions'
import { queryKeys, onboardingQueryKeys } from '../../queryKeys'
import { inviteCostLine } from './seatPricing'
import { RoleAssignmentPicker, SCOPE_LABELS, type RoleAssignmentInput } from './RoleAssignmentPicker'

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
  // Every new person also gets the Farmer role (the farm), whatever is chosen here.
  const getsFarmer = roles.some((role) => role.slug === 'farmer')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteDisplayName, setInviteDisplayName] = useState('')
  // The roles the invite gives, in their scopes. Until the admin changes it: the default role
  // (Operator, or the first role on an instance without one) system-wide.
  const [chosen, setChosen] = useState<RoleAssignmentInput[] | null>(null)
  const defaultRole = assignableRoles.find((r) => r.slug === DEFAULT_INVITE_ROLE_SLUG) ?? assignableRoles[0]
  const assignments: RoleAssignmentInput[] =
    chosen ?? (defaultRole ? [{ roleId: defaultRole.id, scope: 'system' }] : [])
  const { data: squads = [] } = useQuery({
    ...queries.squads.list(),
    enabled: assignments.some((a) => a.scope === 'squad'),
  })
  const roleName = (id: string) => assignableRoles.find((r) => r.id === id)?.name ?? id
  const where = (a: RoleAssignmentInput) =>
    a.scope === 'squad' ? (squads.find((s) => s.id === a.squadId)?.name ?? 'a squad') : SCOPE_LABELS[a.scope]
  const addAssignment = (next: RoleAssignmentInput) =>
    setChosen((current) => {
      const list = current ?? assignments
      return list.some((a) => a.roleId === next.roleId && a.scope === next.scope && a.squadId === next.squadId)
        ? list
        : [...list, next]
    })
  // A role picked but not added yet: inviting now would quietly leave it out.
  const [pickerPending, setPickerPending] = useState(false)
  const removeAssignment = (k: number) => setChosen((current) => (current ?? assignments).filter((_, i) => i !== k))

  const [copyState, setCopyState] = useState('Copy link')
  const inviteMutation = useMutation({
    mutationFn: () => inviteUser(inviteEmail.trim(), inviteDisplayName.trim() || undefined, undefined, assignments),
    onSuccess: (user) => {
      onInvited?.(user)
      if (onInvited) {
        setInviteEmail('')
        setInviteDisplayName('')
        setChosen(null)
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
              setChosen(null)
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
        if (!assignments.length || pickerPending) return
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
      <fieldset className="space-y-2">
        <legend className="block text-xs text-muted mb-1">Roles</legend>
        {assignments.length ? (
          <ul className="space-y-1" aria-label="Roles to give">
            {assignments.map((a, k) => (
              <li
                key={`${a.roleId}:${a.scope}:${a.squadId ?? ''}`}
                className="flex items-center justify-between gap-2 rounded border border-th-border px-2 py-1 text-xs"
              >
                <span className="text-primary">
                  {roleName(a.roleId)} <span className="text-muted">· {where(a)}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${roleName(a.roleId)} (${where(a)})`}
                  onClick={() => removeAssignment(k)}
                  className="ficus-button text-muted hover:text-primary"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">Give at least one role.</p>
        )}
        <RoleAssignmentPicker
          idPrefix="invite-user"
          roles={assignableRoles}
          onAdd={addAssignment}
          addLabel="Add"
          onPendingChange={setPickerPending}
        />
        <p className="text-xs text-muted">
          {pickerPending
            ? 'Add the role you picked (or clear it) before inviting.'
            : getsFarmer
              ? 'Granted as soon as the invite is created, along with Farmer (the farm), which every new person gets.'
              : 'Granted as soon as the invite is created.'}
        </p>
      </fieldset>
      {/* Stated where the cost is actually incurred, not only in the
                header — an admin who opened this form to send one invite should
                not have to scroll back up to learn what it does to the bill. */}
      {seatPricing && <p className="text-xs text-muted">{inviteCostLine(seatPricing)}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!inviteEmail || !assignments.length || pickerPending || inviteMutation.isPending}
          className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {inviteMutation.isPending ? 'Inviting...' : 'Send Invite'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="ficus-button ficus-button-secondary px-4 py-2 text-sm">
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
