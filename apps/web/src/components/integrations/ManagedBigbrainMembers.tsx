import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import {
  cancelManagedBigbrainMemberInvite,
  removeManagedBigbrainMember,
  setManagedBigbrainMemberAccess,
  type ManagedBigbrainMember,
  type ManagedBigbrainMemberAccess,
  type ManagedBigbrainVault,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { Badge } from '../Badge'
import { ConfirmButton } from '../ConfirmButton'
import { LoadingContent, LoadingSurface, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { ACCESS_LABEL, BigbrainMemberInviteDialog } from './BigbrainMemberInviteDialog'

function memberFailure(error: unknown): string {
  const code =
    error instanceof ApiError && error.payload && typeof error.payload === 'object'
      ? String((error.payload as { code?: unknown }).code ?? '')
      : ''
  if (code === 'generation_conflict') return 'This vault changed meanwhile. Review its current state and try again.'
  if (code === 'not_found') return 'That member or invite no longer exists. The list has been refreshed.'
  if (code === 'forbidden') return 'Ficus does not change the vault owner or its own read access.'
  if (code === 'rate_limited') return 'Too many member changes recently. Try again later.'
  if (['unavailable', 'host_unreachable', 'maintenance', 'busy', 'upstream_unavailable'].includes(code))
    return 'Managed BigBrain is temporarily unavailable on this server. Try again shortly.'
  if (code === 'human_required' || code === 'permission_required') return 'You do not have permission to do that.'
  return code ? `That did not work (${code.slice(0, 40)}).` : 'That did not work. Try again.'
}

function systemNote(member: ManagedBigbrainMember): string | null {
  if (member.system === 'owner') return 'Vault owner. People who manage BigBrain here connect devices as it.'
  if (member.system === 'reader') return 'Ficus read access for attached squads.'
  if (member.status === 'pending') return 'Added by email in the BigBrain app; not signed in yet.'
  return null
}

/**
 * Members of one managed vault, for people who manage BigBrain here: who is in the vault, pending
 * invites (cancel), invite a member, change access, remove. The owner and Ficus's reader are
 * system members, shown but never editable. Invite links never enter this list or its cache.
 */
export function ManagedBigbrainMembers({
  vault,
  onVaultChanged,
}: {
  vault: ManagedBigbrainVault
  onVaultChanged: () => Promise<unknown>
}) {
  const client = useQueryClient()
  const roster = useQuery(integrationQueries.managedBigbrainMembers(vault.vaultId))
  const [inviteOpen, setInviteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = () =>
    client.invalidateQueries({ queryKey: integrationQueryKeys.managedBigbrainMembers(vault.vaultId) })
  const fence = () => ({ requestId: crypto.randomUUID(), expectedGeneration: vault.desiredGeneration })
  const change = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onMutate: () => setError(null),
    onSuccess: () => refresh(),
    onError: async (failure) => {
      setError(memberFailure(failure))
      await Promise.all([refresh(), onVaultChanged()])
    },
  })
  const busy = change.isPending
  const editable = vault.state === 'ready' && vault.pendingAction === null

  return (
    <section aria-label={`Members of ${vault.displayName}`} className="mt-3 rounded-md border border-th-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-medium text-primary">Members</h5>
        {editable && vault.origin !== null && (
          <button
            type="button"
            className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
            onClick={() => setInviteOpen(true)}
          >
            Invite member
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        Each member has their own name in BigBrain, and what they write is attributed to them. Removing a member ends
        their access on every device; what they wrote stays, under their name.
      </p>
      <LoadingContent
        loading={roster.isLoading}
        fallback={
          <LoadingSurface label="Loading members">
            <SkeletonRows count={3}>
              {(index) => (
                <div key={index} className="py-2">
                  <SkeletonLine className="w-48 max-w-full" />
                </div>
              )}
            </SkeletonRows>
          </LoadingSurface>
        }
      >
        {roster.isError && (
          <p role="alert" className="mt-2 text-sm text-status-danger-600">
            {memberFailure(roster.error)}
          </p>
        )}
        {roster.data && (
          <>
            <ul className="mt-2 divide-y divide-panel-border">
              {roster.data.members.map((member) => (
                <li key={member.handle} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="truncate font-medium text-primary">{member.displayName}</span>
                      <span className="truncate font-mono text-xs text-muted">{member.handle}</span>
                      {member.system && <Badge color="neutral">System</Badge>}
                      {member.status === 'pending' && <Badge color="queue">Pending</Badge>}
                    </div>
                    {systemNote(member) && <div className="text-xs text-muted">{systemNote(member)}</div>}
                  </div>
                  {member.editable && editable ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-muted">
                        <span className="sr-only">Access for {member.displayName}</span>
                        <select
                          className="ficus-field rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
                          value={member.access === 'none' ? '' : member.access}
                          disabled={busy}
                          onChange={(event) => {
                            // Read now: the controlled select shows the saved access again on re-render.
                            const access = event.target.value as ManagedBigbrainMemberAccess
                            change.mutate(() =>
                              setManagedBigbrainMemberAccess(vault.vaultId, member.handle, { ...fence(), access })
                            )
                          }}
                        >
                          {member.access === 'none' && <option value="">{ACCESS_LABEL.none}</option>}
                          <option value="read">{ACCESS_LABEL.read}</option>
                          <option value="write">{ACCESS_LABEL.write}</option>
                        </select>
                      </label>
                      <ConfirmButton
                        label="Remove"
                        confirmLabel="Confirm remove"
                        ariaLabel={`Remove ${member.displayName}`}
                        title="Ends this member's access on every device. Their handle is never reused."
                        disabled={busy}
                        className="rounded-md px-3 py-1.5 text-sm"
                        onConfirm={() =>
                          change.mutate(() => removeManagedBigbrainMember(vault.vaultId, member.handle, fence()))
                        }
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-muted">{ACCESS_LABEL[member.access]}</span>
                  )}
                </li>
              ))}
            </ul>
            {roster.data.membersTruncated && (
              <p className="mt-1 text-xs text-muted">Showing the first {roster.data.members.length} members.</p>
            )}
            <h6 className="mt-3 text-xs font-medium text-primary">Pending invites</h6>
            {roster.data.invites.length === 0 ? (
              <p className="text-xs text-muted">No pending invites.</p>
            ) : (
              <ul className="divide-y divide-panel-border">
                {roster.data.invites.map((invite) => (
                  <li key={invite.inviteId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate text-primary">{invite.displayName}</div>
                      <div className="text-xs text-muted">
                        {ACCESS_LABEL[invite.access]} · expires {new Date(invite.expiresAt).toLocaleString()}
                      </div>
                    </div>
                    {editable && (
                      <ConfirmButton
                        label="Cancel invite"
                        confirmLabel="Confirm cancel"
                        ariaLabel={`Cancel invite for ${invite.displayName}`}
                        disabled={busy}
                        className="rounded-md px-3 py-1.5 text-sm"
                        onConfirm={() =>
                          change.mutate(() =>
                            cancelManagedBigbrainMemberInvite(vault.vaultId, invite.inviteId, fence())
                          )
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {roster.data.invitesTruncated && (
              <p className="mt-1 text-xs text-muted">Showing the first {roster.data.invites.length} invites.</p>
            )}
          </>
        )}
      </LoadingContent>
      {error && (
        <p role="alert" className="mt-2 text-sm text-status-danger-600">
          {error}
        </p>
      )}
      <BigbrainMemberInviteDialog
        vault={vault}
        isOpen={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => void refresh()}
      />
    </section>
  )
}
