import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createInviteLink, resendInvite, type InvitedUser, type UserListEntry } from '../../api/users'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { InviteUserForm } from '../settings/InviteUserForm'
import { userSetupStatus } from '../settings/userSetupStatus'

export function InviteTeamStep() {
  const { can } = usePermissions()
  const members = useQuery({ ...queries.users.list(), enabled: can('users:read') })
  // Raw invitation links are returned once. Keep them only in this mounted step,
  // including while its accordion is closed, never in browser storage or list APIs.
  const [invitations, setInvitations] = useState<Record<string, InvitedUser>>({})
  const recordInvitation = (user: InvitedUser) => setInvitations((current) => ({ ...current, [user.id]: user }))
  const users = [...(members.data ?? [])]
  for (const user of Object.values(invitations)) {
    if (!users.some((member) => member.id === user.id))
      users.push({ ...user, hasPasskey: false, passkeyCount: 0, inviteExpiresAt: null })
  }
  return (
    <div className="space-y-5">
      {can('users:read') && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-primary">Team members{users.length ? ` · ${users.length}` : ''}</p>
          {members.isLoading && <p className="text-xs text-muted">Loading teammates…</p>}
          {members.isError && (
            <div role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
              Could not load teammates.{' '}
              <button className="ficus-button underline" onClick={() => members.refetch()}>
                Retry
              </button>
            </div>
          )}
          {users.length > 0 ? (
            <div className="divide-y divide-th-border">
              {users.map((user) => (
                <InvitedMember
                  key={user.id}
                  user={user}
                  invitation={invitations[user.id]}
                  canInvite={can('users:create')}
                  onUpdated={recordInvitation}
                />
              ))}
            </div>
          ) : (
            !members.isLoading && !members.isError && <p className="text-xs text-muted">No teammates yet.</p>
          )}
        </div>
      )}
      {can('users:create') ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-primary">Invite a teammate</p>
          <InviteUserForm onInvited={recordInvitation} />
        </div>
      ) : (
        <p className="text-xs text-muted">Inviting teammates requires permission to create users.</p>
      )}
    </div>
  )
}

function InvitedMember({
  user,
  invitation,
  canInvite,
  onUpdated,
}: {
  user: UserListEntry
  invitation?: InvitedUser
  canInvite: boolean
  onUpdated: (user: InvitedUser) => void
}) {
  const client = useQueryClient()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const status = userSetupStatus(user)
  const pending = status.pending && !user.disabledAt
  const expired = user.inviteExpiresAt !== null && new Date(user.inviteExpiresAt).getTime() <= Date.now()
  const link = pending && !expired ? invitation?.inviteUrl : undefined
  const mutation = useMutation({
    mutationFn: (delivery: 'link' | 'email') =>
      delivery === 'link' ? createInviteLink(user.id) : resendInvite(user.id),
    onSuccess: (result) => {
      setCopyState('idle')
      onUpdated(result)
      client.invalidateQueries({ queryKey: queryKeys.users.all })
    },
  })
  return (
    <div className="space-y-2 py-3" data-team-member={user.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-primary">{user.displayName || user.email}</p>
          {user.displayName && <p className="break-all text-xs text-muted">{user.email}</p>}
          <p className="text-xs text-muted">
            {user.disabledAt ? 'Disabled' : user.hasPasskey ? 'Joined' : expired ? 'Invite expired' : 'Invited'}
          </p>
        </div>
        {pending &&
          canInvite &&
          (link ? (
            <button
              type="button"
              aria-label={`Copy invite link for ${user.email}`}
              className="ficus-button text-sm text-accent-light"
              onClick={async () => {
                try {
                  if (!navigator.clipboard) throw new Error('Clipboard unavailable')
                  await navigator.clipboard.writeText(link)
                  setCopyState('copied')
                } catch {
                  setCopyState('failed')
                }
              }}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy link'}
            </button>
          ) : (
            <button
              type="button"
              disabled={mutation.isPending}
              aria-label={`Create invite link for ${user.email}`}
              className="ficus-button text-sm text-accent-light disabled:opacity-50"
              onClick={() => mutation.mutate('link')}
            >
              {mutation.isPending ? 'Creating…' : 'Create invite link'}
            </button>
          ))}
      </div>
      {pending && canInvite && !link && (
        <p className="text-xs text-muted">A new link replaces any previous invitation link. No email is sent.</p>
      )}
      {pending && invitation?.inviteEmailFailed && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p role="status" className="text-muted">
            The invitation email could not be sent.
          </p>
          {canInvite && (
            <button
              type="button"
              className="ficus-button text-accent-light"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('email')}
            >
              Resend invitation
            </button>
          )}
        </div>
      )}
      {pending && invitation && !invitation.inviteEmailFailed && (
        <p role="status" className="text-xs text-muted">
          {link ? 'Invitation link ready to share.' : `Invitation sent to ${user.email}.`}
        </p>
      )}
      {copyState === 'failed' && link && (
        <div className="space-y-1">
          <p role="alert" className="text-xs text-muted">
            Could not copy. Select the link to copy it manually.
          </p>
          <input
            aria-label={`Invitation link for ${user.email}`}
            readOnly
            value={link}
            className="ficus-field w-full px-3 py-2 text-xs"
          />
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {mutation.error.message}
        </p>
      )}
    </div>
  )
}
