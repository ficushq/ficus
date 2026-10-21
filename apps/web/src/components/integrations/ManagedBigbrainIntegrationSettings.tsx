import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  createManagedBigbrainVault,
  deleteManagedBigbrainVault,
  renameManagedBigbrainVault,
  retryManagedBigbrainVault,
  setManagedBigbrainReadAccess,
  type ManagedBigbrainVault,
} from '../../api/integrations'
import { ApiError } from '../../api/client'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { Badge, type BadgeColor } from '../Badge'
import { ConfirmButton } from '../ConfirmButton'
import { LoadingContent, LoadingSurface, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { BigbrainOwnerInviteDialog } from './BigbrainOwnerInviteDialog'
import { ManagedBigbrainMembers } from './ManagedBigbrainMembers'

const STATE_LABEL: Record<ManagedBigbrainVault['state'], [string, BadgeColor]> = {
  requested: ['Requested', 'queue'],
  provisioning: ['Setting up', 'progress'],
  ready: ['Ready', 'success'],
  degraded: ['Degraded', 'attention'],
  failed: ['Failed', 'danger'],
  deleting: ['Deleting', 'neutral'],
  deleted: ['Deleted', 'neutral'],
}
const READ_LABEL: Record<ManagedBigbrainVault['readAccess'], string> = {
  pending: 'Ficus read access pending',
  active: 'Ficus can read',
  revoked: 'Ficus read access revoked',
}

function failure(error: unknown): string {
  const code =
    error instanceof ApiError && error.payload && typeof error.payload === 'object'
      ? String((error.payload as { code?: unknown }).code ?? '')
      : ''
  if (code === 'generation_conflict') return 'This vault changed meanwhile. Review its current state and try again.'
  if (code === 'name_conflict') return 'Another vault already uses that name.'
  if (code === 'confirmation_mismatch') return 'The name you typed does not match this vault.'
  if (code === 'integration_disabled') return 'Enable the BigBrain integration first.'
  if (code === 'unavailable' || code === 'host_unreachable' || code === 'maintenance')
    return 'Managed BigBrain is temporarily unavailable on this server. Try again shortly.'
  if (code === 'owner_unavailable') return 'Owner device links are not available for this vault.'
  if (code === 'human_required' || code === 'permission_required') return 'You do not have permission to do that.'
  return code ? `That did not work (${code.slice(0, 40)}).` : 'That did not work. Try again.'
}

const newDraft = () => ({ requestId: crypto.randomUUID(), displayName: '' })

export function ManagedBigbrainIntegrationSettings({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient()
  const vaults = useQuery(integrationQueries.managedBigbrainVaults())
  // One create draft owns one request ID until it succeeds, so a retried submit is idempotent.
  const [draft, setDraft] = useState<{ requestId: string; displayName: string }>(newDraft)
  const [createError, setCreateError] = useState<string | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.managedBigbrainVaults() })

  const create = useMutation({
    mutationFn: () => createManagedBigbrainVault(draft),
    onMutate: () => setCreateError(null),
    onSuccess: async () => {
      setDraft(newDraft())
      await refresh()
    },
    onError: (error) => setCreateError(failure(error)),
  })

  return (
    <section>
      <p className="mt-1 text-xs text-muted">
        Shared vaults run on this Ficus server and belong to it, not to one person. In BigBrain each new vault&apos;s
        owner is <span className="font-mono">ficus</span>: people who manage BigBrain here connect devices as a
        vault&apos;s owner and invite members, who write from the BigBrain app under their own names. Ficus agents in
        attached squads can only read. Each vault has its own storage, identity and credentials, isolated from the other
        vaults. Ficus itself can access every shared vault on this server.
      </p>
      <div className="mt-4">
        <LoadingContent
          loading={vaults.isLoading}
          fallback={
            <LoadingSurface label="Loading shared vaults">
              <div className="divide-y divide-panel-border">
                <SkeletonRows count={2}>
                  {(index) => (
                    <div key={index} className="space-y-2 py-3">
                      <SkeletonLine className="w-40" />
                      <SkeletonLine className="w-56 max-w-full" />
                    </div>
                  )}
                </SkeletonRows>
              </div>
            </LoadingSurface>
          }
        >
          {vaults.isError && (
            <p role="alert" className="text-sm text-status-danger-600">
              Unable to load shared vaults.
            </p>
          )}
          {vaults.data?.length === 0 && <p className="text-sm text-muted">No shared vaults yet.</p>}
          {/* Dividers only between rows: the form below draws the single line after the list. */}
          <ul className="divide-y divide-panel-border">
            {vaults.data?.map((vault) => (
              <VaultRow key={vault.vaultId} vault={vault} canWrite={canWrite} onChanged={refresh} />
            ))}
          </ul>
        </LoadingContent>
      </div>
      {canWrite && (
        <form
          className="mt-5 flex flex-col gap-2 border-t border-th-border pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <h4 className="text-sm font-medium text-primary">New shared vault</h4>
          <p className="text-xs text-muted">
            In BigBrain, the vault&apos;s owner is <span className="font-mono">ficus</span>. People who manage BigBrain
            here can connect devices as that owner.
          </p>
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            Vault name
            <input
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2"
              value={draft.displayName}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
              disabled={create.isPending}
              required
            />
          </label>
          <button
            type="submit"
            className="ficus-button ficus-button-primary self-start rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            disabled={create.isPending || !draft.displayName.trim() || draft.displayName !== draft.displayName.trim()}
          >
            {create.isPending ? 'Creating…' : 'Create vault'}
          </button>
          {createError && (
            <p role="alert" className="text-sm text-status-danger-600">
              {createError}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

function VaultRow({
  vault,
  canWrite,
  onChanged,
}: {
  vault: ManagedBigbrainVault
  canWrite: boolean
  onChanged: () => Promise<unknown>
}) {
  const [label, color] = STATE_LABEL[vault.state]
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const fence = () => ({ requestId: crypto.randomUUID(), expectedGeneration: vault.desiredGeneration })
  // Each row owns its mutations: a slow response for one vault never touches another row.
  const operation = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onMutate: () => setFeedback(null),
    onSuccess: async () => {
      setRenaming(null)
      setConfirmName(null)
      await onChanged()
    },
    onError: async (error) => {
      setFeedback({ kind: 'error', message: failure(error) })
      await onChanged()
    },
  })
  const busy = operation.isPending || vault.state === 'deleting'

  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-primary">{vault.displayName}</div>
          <div className="text-xs text-muted">
            {READ_LABEL[vault.readAccess]} · <span className="font-mono">{vault.vaultId}</span>
          </div>
        </div>
        <Badge color={color}>{label}</Badge>
      </div>
      {vault.lastErrorCode && (
        <p role="alert" className="mt-1 text-xs text-status-danger-600">
          Last error: {vault.lastErrorCode}
        </p>
      )}
      {/* Says before anyone clicks who the vault's owner is (BigBrain's, not a Ficus person), who
          may connect as it, and where other members come from. */}
      {vault.state !== 'deleted' && (
        <p className="mt-1 text-xs text-muted">
          Owner in BigBrain: <span className="font-mono">{vault.ownerHandle}</span>.{' '}
          {vault.ownerLinksAvailable
            ? 'People who manage BigBrain here can connect a device as this owner.'
            : 'Owner device links are no longer available for this vault; existing owner devices keep working.'}{' '}
          Members invited here write under their own names.
        </p>
      )}
      {vault.backup === 'excluded' && vault.state !== 'deleted' && (
        <p className="mt-1 text-xs text-status-attention-700 dark:text-status-attention-300">
          Last backup did not include this vault.
        </p>
      )}
      {canWrite && vault.state !== 'deleted' && (
        <div className="mt-2 flex flex-wrap gap-2">
          {/* Only a vault that is fully set up, published at its origin and not mid-change can
              redeem a device link; anything else would hand out a link that cannot work. */}
          {vault.ownerLinksAvailable &&
            vault.state === 'ready' &&
            vault.pendingAction === null &&
            vault.origin !== null && (
              <button
                type="button"
                className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5"
                onClick={() => setInviteOpen(true)}
              >
                Connect owner device
              </button>
            )}
          {(vault.state === 'ready' || vault.state === 'degraded') && (
            <button
              type="button"
              aria-expanded={membersOpen}
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5"
              onClick={() => setMembersOpen((open) => !open)}
            >
              {membersOpen ? 'Hide members' : 'Members'}
            </button>
          )}
          {canWrite && (vault.state === 'failed' || vault.retryable) && (
            <button
              type="button"
              disabled={busy}
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 disabled:opacity-50"
              onClick={() => operation.mutate(() => retryManagedBigbrainVault(vault.vaultId, fence()))}
            >
              Retry
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              disabled={busy}
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 disabled:opacity-50"
              onClick={() => setRenaming(vault.displayName)}
            >
              Rename
            </button>
          )}
          {canWrite && vault.readAccess === 'active' && (
            <ConfirmButton
              label="Revoke Ficus read access"
              confirmLabel="Confirm revoke"
              disabled={busy}
              className="rounded-md px-3 py-1.5"
              onConfirm={() =>
                operation.mutate(() => setManagedBigbrainReadAccess(vault.vaultId, { ...fence(), action: 'revoke' }))
              }
            />
          )}
          {canWrite && vault.readAccess === 'revoked' && (
            <button
              type="button"
              disabled={busy}
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 disabled:opacity-50"
              onClick={() =>
                operation.mutate(() => setManagedBigbrainReadAccess(vault.vaultId, { ...fence(), action: 'reconnect' }))
              }
            >
              Reconnect Ficus read access
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              disabled={busy}
              className="ficus-button ficus-button-danger rounded-md px-3 py-1.5 disabled:opacity-50"
              onClick={() => setConfirmName('')}
            >
              Delete
            </button>
          )}
        </div>
      )}
      {renaming !== null && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            operation.mutate(() => renameManagedBigbrainVault(vault.vaultId, { ...fence(), displayName: renaming }))
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            New name
            <input
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-1.5"
              value={renaming}
              maxLength={120}
              onChange={(event) => setRenaming(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !renaming.trim() || renaming !== renaming.trim() || renaming === vault.displayName}
            className="ficus-button ficus-button-primary rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5"
            onClick={() => setRenaming(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {confirmName !== null && (
        <div
          role="alert"
          className="mt-2 space-y-2 rounded-md border border-status-danger-500/50 bg-status-danger-500/10 p-3 text-sm"
        >
          <p>
            Deleting removes this vault&apos;s server, data and every member&apos;s access now. Copies inside existing
            Ficus server backups are not removed by this and follow the server&apos;s backup retention. Restoring this
            server from a backup taken before now brings this vault back, with Ficus read access off.
          </p>
          {vault.assignedSquads.length > 0 ? (
            <div>
              <p>These squads lose read access:</p>
              <ul className="ml-4 list-disc">
                {vault.assignedSquads.map((squad) => (
                  <li key={squad.id}>{squad.name}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p>No squads currently read this vault.</p>
          )}
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            Type the vault name to confirm
            <input
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-1.5"
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || confirmName !== vault.displayName}
              className="ficus-button ficus-button-danger rounded-md px-3 py-1.5 disabled:opacity-50"
              onClick={() =>
                operation.mutate(() =>
                  deleteManagedBigbrainVault(vault.vaultId, {
                    ...fence(),
                    confirmedVaultId: vault.vaultId,
                    confirmedName: confirmName,
                  })
                )
              }
            >
              Delete vault
            </button>
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5"
              onClick={() => setConfirmName(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {canWrite && membersOpen && (vault.state === 'ready' || vault.state === 'degraded') && (
        <ManagedBigbrainMembers vault={vault} onVaultChanged={onChanged} />
      )}
      {feedback && (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={clsx(
            'mt-2 text-sm',
            feedback.kind === 'error' ? 'text-status-danger-600' : 'text-status-success-700'
          )}
        >
          {feedback.message}
        </p>
      )}
      {canWrite && <BigbrainOwnerInviteDialog vault={vault} isOpen={inviteOpen} onClose={() => setInviteOpen(false)} />}
    </li>
  )
}
