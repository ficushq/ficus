import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  attachIntegration,
  detachIntegration,
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
/** Whether Ficus actually reads the vault: the host granting read access is not enough, Ficus's
 * own read connection must be on too. `detail` says why not and what happens next. */
function readStatus(vault: ManagedBigbrainVault): { label: string; reading: boolean; detail?: string } {
  if (vault.readAccess === 'revoked') return { label: 'Ficus read access revoked', reading: false }
  const connection = vault.readConnection
  if (connection?.enabled && vault.readAccess === 'active') return { label: 'Ficus can read', reading: true }
  if (vault.readAccess === 'active' && connection && !connection.enabled && connection.disabledByPerson)
    return {
      label: 'Ficus read access is off',
      reading: false,
      detail:
        'Someone turned off Ficus read access for this vault, so squads cannot read it. To turn it back on, choose Revoke Ficus read access, then Reconnect Ficus read access.',
    }
  const code = (connection && !connection.enabled ? connection.lastErrorCode : null) ?? vault.readSyncError
  if (vault.readAccess === 'active' && (code || (connection && !connection.enabled)))
    return {
      label: 'Ficus cannot read this vault yet',
      reading: false,
      detail: `Ficus could not set up its read access${
        code ? ` (${code.slice(0, 40)})` : ''
      }. It tries again automatically within a few minutes. If this does not clear, choose Revoke Ficus read access, then Reconnect Ficus read access.`,
    }
  // Granted on the host but not imported into Ficus yet counts as pending too.
  return { label: 'Ficus read access pending', reading: false }
}

const squadIntegrationsPath = (squadId: string) =>
  `/squads/${encodeURIComponent(squadId)}/settings?section=integrations`

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
  if (code === 'squad_permission_required') return 'This account cannot change integrations for that squad.'
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
        owner is <span className="font-mono">ficus</span>. People who manage BigBrain here invite members, who write
        from the BigBrain app under their own names. Ficus agents in attached squads can only read. Each vault has its
        own storage, identity and credentials, isolated from the other vaults. Ficus itself can access every shared
        vault on this server.
      </p>
      <p className="mt-2 text-xs text-muted">
        Agents read a vault only once it is attached to their squad: use <span className="font-medium">Squads</span> on
        a vault below, or the BigBrain card in a squad&apos;s Settings → Integrations. Their agent type must also allow
        BigBrain agent tools and the <span className="font-mono">bigbrain_shared_*</span> tool names (
        <Link to="/settings?section=agent-types" className="text-accent-light hover:underline">
          Agent types
        </Link>
        ).
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
            In BigBrain, the vault&apos;s owner is <span className="font-mono">ficus</span>. Once it is ready, invite
            people as members.
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
  const read = readStatus(vault)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
            {read.label} · <span className="font-mono">{vault.vaultId}</span>
          </div>
        </div>
        <Badge color={color}>{label}</Badge>
      </div>
      {read.detail && (vault.state === 'ready' || vault.state === 'degraded') && (
        <p role="status" className="mt-1 text-xs text-status-attention-700 dark:text-status-attention-300">
          {read.detail}
        </p>
      )}
      {vault.lastErrorCode && (
        <p role="alert" className="mt-1 text-xs text-status-danger-600">
          Last error: {vault.lastErrorCode}
        </p>
      )}
      {/* Says before anyone clicks who the vault's owner is (BigBrain's, not a Ficus person), who
          may connect as it, and where other members come from. */}
      {vault.state !== 'deleted' && (
        <p className="mt-1 text-xs text-muted">
          Owner in BigBrain: <span className="font-mono">{vault.ownerHandle}</span>. Invite people as members so they
          write under their own names.
          {!vault.ownerLinksAvailable &&
            ' Owner device links are no longer available for this vault; existing owner devices keep working.'}
        </p>
      )}
      {vault.backup === 'excluded' && vault.state !== 'deleted' && (
        <p className="mt-1 text-xs text-status-attention-700 dark:text-status-attention-300">
          Last backup did not include this vault.
        </p>
      )}
      {canWrite && vault.state !== 'deleted' && (
        <div className="mt-2 flex flex-wrap gap-2">
          {/* Members (and inviting them) is the primary way people get into a vault. */}
          {(vault.state === 'ready' || vault.state === 'degraded') && (
            <button
              type="button"
              aria-expanded={membersOpen}
              className="ficus-button ficus-button-primary rounded-md px-3 py-1.5"
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
      {(vault.state === 'ready' || vault.state === 'degraded') && (
        <VaultSquads vault={vault} canWrite={canWrite} reading={read.reading} onChanged={onChanged} />
      )}
      {canWrite && membersOpen && (vault.state === 'ready' || vault.state === 'degraded') && (
        <ManagedBigbrainMembers vault={vault} onVaultChanged={onChanged} />
      )}
      {/* The owner device link is an advanced, collapsed option: it grants full owner access under
          the shared `ficus` identity. Only a vault that is fully set up, published at its origin
          and not mid-change can redeem one. */}
      {canWrite &&
        vault.ownerLinksAvailable &&
        vault.state === 'ready' &&
        vault.pendingAction === null &&
        vault.origin !== null && (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={advancedOpen}
              className="ficus-button ficus-button-ghost rounded-md px-2 py-1 text-xs"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {advancedOpen ? 'Hide advanced' : 'Advanced'}
            </button>
            {advancedOpen && (
              <div
                role="note"
                className="mt-2 space-y-2 rounded-md border border-status-attention-500/50 bg-status-attention-500/10 p-3 text-xs"
              >
                <p className="font-medium text-primary">Connect a device as the vault owner</p>
                <p className="text-secondary">
                  This connects a BigBrain app with full owner access: it can manage members, moderate anyone&apos;s
                  contributions, and read and write everything. Everything written from it appears as{' '}
                  <span className="font-mono">{vault.ownerHandle}</span>, not as a person. To give someone access,
                  invite them as a member instead.
                </p>
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
                  onClick={() => setInviteOpen(true)}
                >
                  Connect owner device
                </button>
              </div>
            )}
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
      {canWrite && <BigbrainOwnerInviteDialog vault={vault} isOpen={inviteOpen} onClose={() => setInviteOpen(false)} />}
    </li>
  )
}

/**
 * Squads attached to one vault. People with BigBrain authority attach and detach here for squads
 * where they also hold `integrations:write`, through the same squad assignment routes (and server
 * checks) as each squad's own integration settings. Attaching never detaches another vault.
 */
function VaultSquads({
  vault,
  canWrite,
  reading,
  onChanged,
}: {
  vault: ManagedBigbrainVault
  canWrite: boolean
  reading: boolean
  onChanged: () => Promise<unknown>
}) {
  const client = useQueryClient()
  const writable = useQuery({ ...integrationQueries.managedBigbrainAttachableSquads(), enabled: canWrite })
  const [choice, setChoice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const attached = new Set(vault.assignedSquads.map((squad) => squad.id))
  const writableIds = new Set((writable.data ?? []).map((squad) => squad.id))
  const offered = (writable.data ?? []).filter((squad) => !attached.has(squad.id))
  const change = useMutation({
    mutationFn: async (input: { squadId: string; attach: boolean }) => {
      if (!vault.connectionId) throw new Error('not_readable')
      if (input.attach) await attachIntegration(input.squadId, 'bigbrain', vault.connectionId, false)
      else await detachIntegration(input.squadId, 'bigbrain', vault.connectionId)
    },
    onMutate: () => setError(null),
    onSuccess: (_data, input) => {
      if (input.attach) setChoice('')
    },
    onError: (failed) => setError(failure(failed)),
    onSettled: async (_data, _error, input) => {
      await Promise.all([
        onChanged(),
        client.invalidateQueries({ queryKey: integrationQueryKeys.catalog() }),
        client.invalidateQueries({ queryKey: integrationQueryKeys.squad(input.squadId, 'bigbrain') }),
      ])
    },
  })
  return (
    <div className="mt-2 text-xs">
      <div className="font-medium text-primary">Squads</div>
      {vault.assignedSquads.length === 0 ? (
        <p className="text-muted">
          Not attached to any squad. Agents can read this vault only in squads it is attached to.
        </p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-2">
          {vault.assignedSquads.map((squad) => (
            <span
              key={squad.id}
              className="inline-flex items-center gap-1 rounded-md border border-panel-border px-2 py-0.5"
            >
              <Link to={squadIntegrationsPath(squad.id)} className="text-primary hover:underline">
                {squad.name}
              </Link>
              {canWrite && writableIds.has(squad.id) && (
                <button
                  type="button"
                  aria-label={`Detach ${vault.displayName} from ${squad.name}`}
                  disabled={change.isPending}
                  className="ficus-button ficus-button-ghost rounded px-1 text-muted disabled:opacity-50"
                  onClick={() => change.mutate({ squadId: squad.id, attach: false })}
                >
                  Detach
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canWrite && (
        // Not a <form>: the card's only form is the new vault form.
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`Squad to attach ${vault.displayName} to`}
            className="ficus-field min-w-0 max-w-full rounded-md border border-th-border bg-surface px-2 py-1"
            value={choice}
            disabled={!reading || change.isPending || offered.length === 0}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">
              {offered.length === 0 && writable.isSuccess ? 'No other squads to attach' : 'Choose a squad'}
            </option>
            {offered.map((squad) => (
              <option key={squad.id} value={squad.id}>
                {squad.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!reading || !choice || change.isPending}
            className="ficus-button ficus-button-secondary rounded-md px-3 py-1 disabled:opacity-50"
            onClick={() => change.mutate({ squadId: choice, attach: true })}
          >
            {change.isPending ? 'Saving…' : 'Attach'}
          </button>
          {!reading && <span className="text-muted">Squads can be attached once Ficus can read this vault.</span>}
          {writable.isSuccess && writable.data.length === 0 && (
            <span className="text-muted">
              Vaults can be attached here only to squads whose integrations this account manages.
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-status-danger-600">
          {error}
        </p>
      )}
    </div>
  )
}
