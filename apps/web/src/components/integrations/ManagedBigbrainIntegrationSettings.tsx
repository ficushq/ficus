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
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/

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
  if (code === 'human_required' || code === 'permission_required' || code === 'owner_required')
    return 'You do not have permission to do that.'
  return code ? `That did not work (${code.slice(0, 40)}).` : 'That did not work. Try again.'
}

export function ManagedBigbrainIntegrationSettings({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient()
  const vaults = useQuery(integrationQueries.managedBigbrainVaults())
  // One create draft owns one request ID until it succeeds, so a retried submit is idempotent.
  const [draft, setDraft] = useState({ requestId: crypto.randomUUID(), displayName: '', ownerHandle: '' })
  const [createError, setCreateError] = useState<string | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.managedBigbrainVaults() })

  const create = useMutation({
    mutationFn: () => createManagedBigbrainVault(draft),
    onMutate: () => setCreateError(null),
    onSuccess: async () => {
      setDraft({ requestId: crypto.randomUUID(), displayName: '', ownerHandle: '' })
      await refresh()
    },
    onError: (error) => setCreateError(failure(error)),
  })

  return (
    <section>
      <p className="mt-1 text-xs text-muted">
        Shared vaults run on this Ficus server. People contribute from the BigBrain app; Ficus agents in squads you
        attach can only read. Each vault has its own storage, identity and credentials.
      </p>
      <div className="mt-4">
        <LoadingContent
          loading={vaults.isLoading}
          fallback={
            <LoadingSurface label="Loading shared vaults">
              <SkeletonRows count={2}>
                {(index) => (
                  <div key={index} className="space-y-2 border-b border-panel-border py-3">
                    <SkeletonLine className="w-40" />
                    <SkeletonLine className="w-56 max-w-full" />
                  </div>
                )}
              </SkeletonRows>
            </LoadingSurface>
          }
        >
          {vaults.isError && (
            <p role="alert" className="text-sm text-status-danger-600">
              Unable to load shared vaults.
            </p>
          )}
          {vaults.data?.length === 0 && <p className="text-sm text-muted">No shared vaults yet.</p>}
          <ul className="space-y-0">
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
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            Your BigBrain handle
            <input
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2 font-mono"
              value={draft.ownerHandle}
              onChange={(event) => setDraft({ ...draft, ownerHandle: event.target.value.toLowerCase() })}
              disabled={create.isPending}
              required
            />
            <span className="font-normal text-muted">
              You become the vault owner under this handle. It cannot be changed later.
            </span>
          </label>
          <button
            type="submit"
            className="ficus-button ficus-button-primary self-start rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            disabled={
              create.isPending ||
              !draft.displayName.trim() ||
              draft.displayName !== draft.displayName.trim() ||
              !HANDLE.test(draft.ownerHandle) ||
              draft.ownerHandle === 'ficus-reader'
            }
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
    <li className="border-b border-panel-border py-3 text-sm">
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
      {(canWrite || vault.isOwner) && vault.state !== 'deleted' && (
        <div className="mt-2 flex flex-wrap gap-2">
          {vault.isOwner && vault.state === 'ready' && (
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5"
              onClick={() => setInviteOpen(true)}
            >
              Connect a device
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
            Ficus server backups are not removed by this and follow your backup retention.
          </p>
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
      {vault.isOwner && (
        <BigbrainOwnerInviteDialog vault={vault} isOpen={inviteOpen} onClose={() => setInviteOpen(false)} />
      )}
    </li>
  )
}
