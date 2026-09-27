import { useState } from 'react'
import clsx from 'clsx'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  deleteUser,
  disableUser,
  enableUser,
  resendInvite,
  assignUserRole,
  removeUserRole,
  type UserListEntry,
} from '../../api/users'
import { isUserAssignableRole, type RoleSummary } from '../../api/roles'
import { userSetupStatus } from './userSetupStatus'
import { resendInviteFeedback } from './resendInviteFeedback'
import { seatUsageLine } from './seatPricing'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton, LoadingSurface, SkeletonBlock, SkeletonRows } from '../loading/Skeleton'
import { InviteUserForm } from './InviteUserForm'
import { InviteLinkPanel, type IssuedInviteLink } from './InviteLinkPanel'

export function UsersSection() {
  const queryClient = useQueryClient()
  const { data: users = [], isLoading } = useQuery(queries.users.list())
  const loadingRowCount = useLoadingShapeCount('settings:users', isLoading ? undefined : users.length, {
    fallbackCount: 4,
    maxCount: 10,
  })
  const { data: roles = [] } = useQuery(queries.roles.list())
  // Seat billing, or null on any instance the hosted platform doesn't price
  // (self-hosted, or managed with no pricing delivered). Null means show NO
  // pricing at all — there is no fallback price to fall back to, and inventing
  // one would misstate someone's bill. Head count and billed seats are computed
  // server-side from the same population the platform bills, never from
  // `users.length` here, which would count disabled accounts as paid seats.
  const { data: seatData } = useQuery(queries.users.seatPricing())
  const seatPricing = seatData?.pricing ?? null
  // Agent roles (default-worker/-manager/-consultant) are derived from an agent's
  // type and can't be held by a person, so they never belong in a human picker.
  const assignableRoles = roles.filter(isUserAssignableRole)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteLink, setInviteLink] = useState<IssuedInviteLink | null>(null)
  const [expandedUser, setExpandedUser] = useState<string | null>(null)
  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
    },
  })

  const disableMutation = useMutation({
    mutationFn: disableUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
    },
  })

  const enableMutation = useMutation({
    mutationFn: enableUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
    },
  })

  if (isLoading) {
    return <CollectionSkeleton label="Loading users" count={loadingRowCount} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">Users</h3>
          <p className="text-sm text-muted mt-1">Manage users and their role assignments.</p>
          {seatPricing && <p className="text-xs text-muted mt-1">{seatUsageLine(seatPricing)}</p>}
        </div>
        <button
          onClick={() => setShowInvite(!showInvite)}
          className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-hover"
        >
          Invite User
        </button>
      </div>

      {showInvite && <InviteUserForm onCancel={() => setShowInvite(false)} />}

      {inviteLink && (
        <InviteLinkPanel
          invite={inviteLink}
          onDone={() => {
            setInviteLink(null)
            setShowInvite(false)
          }}
        />
      )}

      <div className="ficus-section overflow-hidden">
        {users.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted text-sm">No users yet. Invite someone to get started.</div>
        ) : (
          <div className="divide-y divide-th-border">
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                roles={assignableRoles}
                isExpanded={expandedUser === user.id}
                onToggleExpand={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                onDelete={() => {
                  if (confirm(`Delete user ${user.email}?`)) {
                    deleteMutation.mutate(user.id)
                  }
                }}
                isDeleting={deleteMutation.isPending}
                // A resend on a no-email install mints a link the admin has to
                // hand over — surface it through the very same panel creation
                // uses rather than inventing a second place to look.
                onInviteLink={setInviteLink}
                onToggleDisable={() => {
                  if (user.disabledAt) {
                    enableMutation.mutate(user.id)
                  } else {
                    if (confirm(`Disable user ${user.email}? They will not be able to log in.`)) {
                      disableMutation.mutate(user.id)
                    }
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function UserRow({
  user,
  roles,
  isExpanded,
  onToggleExpand,
  onDelete,
  isDeleting,
  onInviteLink,
  onToggleDisable,
}: {
  user: UserListEntry
  roles: RoleSummary[]
  isExpanded: boolean
  onToggleExpand: () => void
  onDelete: () => void
  isDeleting: boolean
  onInviteLink: (invite: IssuedInviteLink) => void
  onToggleDisable: () => void
}) {
  const queryClient = useQueryClient()
  const {
    data: userRoles = [],
    isLoading: rolesLoading,
    isSuccess: rolesSuccess,
  } = useQuery({
    ...queries.users.roles(user.id),
    enabled: isExpanded,
  })
  const roleSkeletonCount = useLoadingShapeCount(
    `settings:user:${user.id}:roles`,
    rolesSuccess ? userRoles.length : undefined,
    { fallbackCount: 2, maxCount: 6 }
  )

  const [assignRoleId, setAssignRoleId] = useState('')
  const [assignScope, setAssignScope] = useState<'system' | 'squad'>('system')
  const [assignSquadId, setAssignSquadId] = useState('')
  // Squads the current user can see (backend already filters to accessible ones);
  // only fetched when scoping an assignment to a specific squad.
  const { data: assignableSquads = [] } = useQuery({ ...queries.squads.list(), enabled: assignScope === 'squad' })

  const assignMutation = useMutation({
    mutationFn: () =>
      assignUserRole(user.id, {
        roleId: assignRoleId,
        scope: assignScope,
        squadId: assignScope === 'squad' ? assignSquadId : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.roles(user.id) })
      setAssignRoleId('')
      setAssignScope('system')
      setAssignSquadId('')
    },
  })

  const removeMutation = useMutation({
    mutationFn: (assignmentId: string) => removeUserRole(user.id, assignmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.roles(user.id) })
    },
  })

  const isDisabled = user.disabledAt !== null && user.disabledAt !== undefined
  const setup = userSetupStatus(user)

  const resendMutation = useMutation({
    mutationFn: () => resendInvite(user.id),
    onSuccess: (result) => {
      // The list carries the invite's expiry, and the resend moved it.
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
      if (result.inviteUrl) onInviteLink({ url: result.inviteUrl, forAdmin: user.isAdmin === true })
    },
  })
  const resendFeedback = resendInviteFeedback(resendMutation)

  return (
    <div className={clsx('px-4 py-3', isDisabled && 'opacity-50')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1 min-w-0">
          {/* flex-wrap + a non-shrinking, non-wrapping pill: without both, a
              narrow row squeezes the pill until its label wraps INSIDE the
              rounded-full background (which renders as an ellipse) and the
              text collides with the actions column. The email truncates
              instead, since it is the one element that can be arbitrarily
              long. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-primary truncate max-w-full">{user.email}</span>
            {user.displayName && <span className="text-sm text-muted truncate">({user.displayName})</span>}
            {isDisabled && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-status-danger-100 text-status-danger-700 dark:bg-status-danger-900/30 dark:text-status-danger-400 font-medium whitespace-nowrap shrink-0">
                Disabled
              </span>
            )}
            {/* An unfinished invite is worth saying out loud even on a disabled
                account; "Active" would just contradict the Disabled pill. */}
            {(setup.pending || !isDisabled) && (
              <span
                title={setup.title}
                className={clsx(
                  'text-xs px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap shrink-0',
                  setup.pending
                    ? 'bg-status-review-100 text-status-review-800 dark:bg-status-review-900/30 dark:text-status-review-400'
                    : 'bg-status-success-100 text-status-success-700 dark:bg-status-success-900/30 dark:text-status-success-400'
                )}
              >
                {setup.label}
              </span>
            )}
          </div>
          {(user.createdAt || setup.detail) && (
            <p className="text-xs text-muted mt-0.5">
              {[user.createdAt && `Created ${new Date(user.createdAt).toLocaleDateString()}`, setup.detail]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={onToggleExpand}
            className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium"
          >
            {isExpanded ? 'Hide Roles' : 'Manage Roles'}
          </button>
          <span className="text-muted">·</span>
          {/* Offered on every pending row, lapsed or not: a still-live invite is
              routinely resent because the mail was lost or deleted, and a lapsed
              one otherwise leaves deleting the account as the only recourse.
              Never on a joined row — see the server's 409. */}
          {setup.pending && (
            <>
              <button
                onClick={() => resendMutation.mutate()}
                disabled={resendMutation.isPending}
                className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium disabled:opacity-50"
              >
                {resendMutation.isPending ? 'Resending...' : 'Resend Invite'}
              </button>
              <span className="text-muted">·</span>
            </>
          )}
          <button
            onClick={onToggleDisable}
            className={clsx(
              'ficus-button',
              'text-xs font-medium',
              isDisabled
                ? 'text-status-success-600 dark:text-status-success-400 hover:text-status-success-800 dark:hover:text-status-success-300'
                : 'text-status-review-600 dark:text-status-review-400 hover:text-status-review-800 dark:hover:text-status-review-300'
            )}
          >
            {isDisabled ? 'Enable' : 'Disable'}
          </button>
          <span className="text-muted">·</span>
          <button
            onClick={onDelete}
            disabled={isDeleting}
            className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

      {resendFeedback.message && (
        <p
          role={resendFeedback.isProblem ? 'alert' : 'status'}
          className={clsx(
            'text-xs mt-1',
            resendFeedback.isProblem
              ? 'text-status-danger-600 dark:text-status-danger-400'
              : 'text-status-success-600 dark:text-status-success-400'
          )}
        >
          {resendFeedback.message}
        </p>
      )}

      {isExpanded && (
        <div className="mt-3 ml-2 space-y-3">
          {rolesLoading ? (
            <LoadingSurface label="Loading user roles" className="flex flex-wrap gap-1.5">
              <SkeletonRows count={Math.max(1, roleSkeletonCount)}>
                {(index) => <SkeletonBlock key={index} className={index % 2 ? 'h-7 w-20' : 'h-7 w-28'} />}
              </SkeletonRows>
            </LoadingSurface>
          ) : (
            <>
              {userRoles.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {userRoles.map((assignment) => (
                    <span
                      key={assignment.id}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-accent/10 text-accent-light"
                    >
                      {assignment.roleName || assignment.roleSlug || 'Role'}
                      {assignment.scope && assignment.scope !== 'system' && (
                        <span className="text-muted">({assignment.scope})</span>
                      )}
                      <button
                        onClick={() => removeMutation.mutate(assignment.id)}
                        className="ficus-button ml-0.5 text-accent-light hover:text-status-danger-500 font-bold"
                        title={`Remove ${assignment.roleName || assignment.roleSlug || 'role'}`}
                        aria-label={`Remove ${assignment.roleName || assignment.roleSlug || 'role'}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={`assign-role-${user.id}`} className="sr-only">
                  Role to assign
                </label>
                <select
                  id={`assign-role-${user.id}`}
                  value={assignRoleId}
                  onChange={(e) => setAssignRoleId(e.target.value)}
                  className="ficus-field text-xs bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary  focus:ring-1 focus:ring-accent"
                >
                  <option value="">Select role...</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <label htmlFor={`assign-scope-${user.id}`} className="sr-only">
                  Assignment scope
                </label>
                <select
                  id={`assign-scope-${user.id}`}
                  value={assignScope}
                  onChange={(e) => setAssignScope(e.target.value as 'system' | 'squad')}
                  className="ficus-field text-xs bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary  focus:ring-1 focus:ring-accent"
                >
                  <option value="system">System</option>
                  <option value="squad">Squad</option>
                </select>
                {assignScope === 'squad' && (
                  <>
                    <label htmlFor={`assign-squad-${user.id}`} className="sr-only">
                      Squad
                    </label>
                    <select
                      id={`assign-squad-${user.id}`}
                      value={assignSquadId}
                      onChange={(e) => setAssignSquadId(e.target.value)}
                      className="ficus-field text-xs bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary  focus:ring-1 focus:ring-accent max-w-44"
                    >
                      <option value="">Select squad…</option>
                      {assignableSquads.map((squad) => (
                        <option key={squad.id} value={squad.id}>
                          {squad.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <button
                  onClick={() => assignMutation.mutate()}
                  disabled={!assignRoleId || assignMutation.isPending || (assignScope === 'squad' && !assignSquadId)}
                  className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
                >
                  {assignMutation.isPending ? 'Assigning...' : 'Assign'}
                </button>
              </div>
              {assignMutation.isError && (
                <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
                  {(assignMutation.error as Error)?.message || 'Failed to assign role'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
