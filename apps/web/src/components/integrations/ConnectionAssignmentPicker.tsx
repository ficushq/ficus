import clsx from 'clsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  attachIntegration,
  detachIntegration,
  configureSquadIntegration,
  assignIntegration,
  retryIntegrationProjection,
  unassignIntegration,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { FormSkeleton } from '../loading/Skeleton'

export function ConnectionAssignmentPicker({
  squadId,
  provider,
  presentation,
  canRead,
  canWrite,
  embedded = false,
  managed = false,
}: {
  squadId: string
  provider: string
  presentation: { label: string }
  canRead: boolean
  canWrite: boolean
  embedded?: boolean
  /** Managed shared vaults: several attached at once, each selected explicitly; never a default. */
  managed?: boolean
}) {
  if (managed) return <ManagedVaultAssignment {...{ squadId, provider, presentation, canRead, canWrite, embedded }} />
  return <SingleConnectionAssignment {...{ squadId, provider, presentation, canRead, canWrite, embedded }} />
}

function SingleConnectionAssignment({
  squadId,
  provider,
  presentation,
  canRead,
  canWrite,
  embedded,
}: {
  squadId: string
  provider: string
  presentation: { label: string }
  canRead: boolean
  canWrite: boolean
  embedded: boolean
}) {
  const client = useQueryClient()
  const selection = useQuery({ ...integrationQueries.squad(squadId, provider), enabled: canRead })
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: integrationQueryKeys.squad(squadId, provider) }),
      client.invalidateQueries({ queryKey: integrationQueryKeys.pool(provider) }),
    ])
  }
  const mutation = useMutation({
    mutationFn: async (connectionId: string) => {
      if (connectionId) await assignIntegration(squadId, provider, connectionId)
      else await unassignIntegration(squadId, provider)
    },
    onSuccess: refresh,
  })
  const inheritMutation = useMutation({
    mutationFn: () => configureSquadIntegration(squadId, provider, { enabled: true, inheritDefault: true }),
    onSuccess: refresh,
  })
  const accountMutation = useMutation({
    mutationFn: async (input: { id: string; action: 'attach' | 'detach' | 'default' }) => {
      if (input.action === 'detach') await detachIntegration(squadId, provider, input.id)
      else await attachIntegration(squadId, provider, input.id, input.action === 'default')
    },
    onSuccess: refresh,
  })
  const retryMutation = useMutation({
    mutationFn: () => retryIntegrationProjection(squadId, provider),
    onSuccess: refresh,
  })

  if (!canRead) return null
  if (selection.isLoading)
    return (
      <section className={clsx(!embedded && 'mt-6 border-b border-panel-border py-4')}>
        <FormSkeleton label="Loading squad connection selection" sections={1} />
      </section>
    )
  if (selection.isError)
    return (
      <p role="alert" className="mt-3 text-sm text-status-danger-600">
        Unable to load squad connection selection.
      </p>
    )
  const value = selection.data!
  const label = presentation.label
  const projectionLabel = value.projection
    ? value.projection.status === 'degraded'
      ? 'degraded'
      : value.projection.status
    : null

  return (
    <section className={clsx(!embedded && 'mt-6 border-b border-panel-border py-4')}>
      <h3 className="text-sm font-medium text-primary">Connection for this squad — {label}</h3>
      <p className="mt-1 text-xs text-muted">Choose the global {provider} connection used by this squad.</p>
      {provider === 'github' && value.scope && (
        <div className="mt-3 text-sm">
          {value.scope.inheritDefault ? (
            <p className="text-accent-light">
              Using global default{value.assignment ? `: ${value.assignment.displayName}` : ' (no account connected)'}
            </p>
          ) : (
            <button
              type="button"
              disabled={!canWrite || inheritMutation.isPending}
              onClick={() => inheritMutation.mutate()}
              className="ficus-button ficus-button-link"
            >
              Use global default
            </button>
          )}
          {inheritMutation.isError && (
            <p role="alert" className="text-status-danger-500">
              Could not restore the global default.
            </p>
          )}
        </div>
      )}
      {provider === 'github' ? (
        <div className="mt-3 space-y-2">
          {value.connections.length === 0 && (
            <p className="text-sm text-muted">Connect a GitHub account in Integrations to get started.</p>
          )}
          {value.connections.map((connection) => {
            const attached = value.attached?.find((item) => item.id === connection.id)
            const signing =
              attached && value.commitSigning?.accounts.find((item) => item.connectionId === connection.id)
            return (
              <div key={connection.id} className="flex items-center justify-between gap-3 text-sm">
                <div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!attached}
                      disabled={!canWrite || accountMutation.isPending || (!attached && !connection.enabled)}
                      onChange={() =>
                        accountMutation.mutate({ id: connection.id, action: attached ? 'detach' : 'attach' })
                      }
                    />
                    {connection.displayName}
                    {!connection.enabled && ' (disabled)'}
                  </label>
                  {signing && (
                    <p className="ml-6 text-xs text-muted">
                      {signing.state === 'on'
                        ? `Signs commits committed as ${signing.signsFor.join(' or ')}`
                        : signing.state === 'off'
                          ? `Commit signing is off for @${signing.login}: its commits are not signed`
                          : `Commit signing for @${signing.login} needs attention`}
                    </p>
                  )}
                </div>
                {attached &&
                  (attached.isDefault ? (
                    <span className="text-xs text-muted">Default</span>
                  ) : (
                    canWrite && (
                      <button
                        type="button"
                        className="ficus-button ficus-button-secondary px-2.5 py-1 disabled:opacity-50 text-xs"
                        disabled={accountMutation.isPending || !connection.enabled}
                        onClick={() => accountMutation.mutate({ id: connection.id, action: 'default' })}
                      >
                        Make default
                      </button>
                    )
                  ))}
              </div>
            )
          })}
          <p className="text-xs text-muted">
            The default account is used for git and gh. Flows can select any account attached here.
            {value.commitSigning?.accounts.some((account) => account.state === 'on') &&
              ' Each commit is signed by the attached account its committer email belongs to. Commits made as an attached account with signing off are not signed. A commit whose committer email belongs to no attached account is refused rather than signed by a different account.'}
          </p>
        </div>
      ) : canWrite ? (
        <select
          aria-label={`${label} connection for this squad`}
          className="ficus-field mt-3 block w-full rounded-md border border-th-border bg-surface px-3 py-2 text-primary"
          value={value.assignment?.id ?? ''}
          disabled={mutation.isPending}
          onChange={(event) => mutation.mutate(event.target.value)}
        >
          <option value="">No connection</option>
          {value.connections.map((connection) => (
            <option key={connection.id} value={connection.id} disabled={!connection.enabled}>
              {connection.displayName}
              {connection.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
      ) : (
        <div className="mt-3 space-y-1 text-sm">
          <p>Assigned: {value.assignment?.displayName ?? 'No connection'}</p>
          {value.connections.map((connection) => (
            <p key={connection.id} className="text-xs text-muted">
              {connection.displayName}
              {connection.enabled ? '' : ' (disabled)'}
            </p>
          ))}
        </div>
      )}
      {projectionLabel && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span>Projection: {projectionLabel}</span>
          {canWrite && projectionLabel === 'degraded' && value.assignment && (
            <button
              className="ficus-button ficus-button-link"
              type="button"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate()}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {(mutation.isError || accountMutation.isError) && (
        <p role="alert" className="mt-2 text-sm text-status-danger-600">
          Unable to update the squad connection.
        </p>
      )}
    </section>
  )
}

/**
 * Managed shared BigBrain vaults for one squad. Managers see every vault they may attach; other
 * readers see only what this squad already has (the server filters the list). Attaching never
 * makes a default and never detaches another vault; each row has its own pending state.
 */
function ManagedVaultAssignment({
  squadId,
  provider,
  presentation,
  canRead,
  canWrite,
  embedded,
}: {
  squadId: string
  provider: string
  presentation: { label: string }
  canRead: boolean
  canWrite: boolean
  embedded: boolean
}) {
  const client = useQueryClient()
  const selection = useQuery({ ...integrationQueries.squad(squadId, provider), enabled: canRead })
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [failed, setFailed] = useState<string | null>(null)
  const toggle = useMutation({
    mutationFn: async (input: { id: string; attach: boolean }) => {
      if (input.attach) await attachIntegration(squadId, provider, input.id, false)
      else await detachIntegration(squadId, provider, input.id)
    },
    onMutate: (input) => {
      setFailed(null)
      setPending((current) => ({ ...current, [input.id]: true }))
    },
    onError: (_error, input) => setFailed(input.id),
    onSettled: async (_data, _error, input) => {
      setPending(({ [input.id]: _done, ...rest }) => rest)
      await client.invalidateQueries({ queryKey: integrationQueryKeys.squad(squadId, provider) })
    },
  })
  if (!canRead) return null
  if (selection.isLoading)
    return (
      <section className={clsx(!embedded && 'mt-6 border-b border-panel-border py-4')}>
        <FormSkeleton label="Loading shared vaults for this squad" sections={1} />
      </section>
    )
  if (selection.isError)
    return (
      <p role="alert" className="mt-3 text-sm text-status-danger-600">
        Unable to load shared vaults for this squad.
      </p>
    )
  const value = selection.data!
  const attached = new Set((value.attached ?? []).map((item) => item.id))
  const rows = value.connections
  return (
    <section className={clsx(!embedded && 'mt-6 border-b border-panel-border py-4')}>
      <h3 className="text-sm font-medium text-primary">Shared vaults for this squad — {presentation.label}</h3>
      <p className="mt-1 text-xs text-muted">
        Agents in this squad get read access to each vault attached here and must name the vault they read. Members
        contribute in the BigBrain app.
      </p>
      <div className="mt-3 space-y-2">
        {rows.length === 0 && (
          <p className="text-sm text-muted">
            {canWrite ? 'No shared vaults are ready to attach yet.' : 'No shared vaults are attached to this squad.'}
          </p>
        )}
        {rows.map((connection) => {
          const isAttached = attached.has(connection.id)
          const reasonId = `vault-reason-${connection.id}`
          // A vault can be attached only while Ficus can read it; say so instead of ignoring clicks.
          const reason = !connection.enabled
            ? isAttached
              ? 'Ficus cannot read this vault right now, so agents here cannot either.'
              : 'Ficus cannot read this vault yet, so it cannot be attached.'
            : null
          return (
            <div key={connection.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isAttached}
                  aria-describedby={reason ? reasonId : undefined}
                  disabled={!canWrite || pending[connection.id] || (!isAttached && !connection.enabled)}
                  onChange={() => toggle.mutate({ id: connection.id, attach: !isAttached })}
                />
                {connection.displayName}
                {!connection.enabled && <span className="text-xs text-muted">(Ficus cannot read it)</span>}
                {failed === connection.id && (
                  <span role="alert" className="text-xs text-status-danger-600">
                    Could not update
                  </span>
                )}
              </label>
              {reason && (
                <p id={reasonId} className="ml-6 text-xs text-muted">
                  {reason} People who manage BigBrain see why, and how to fix it, on the vault in{' '}
                  <Link to="/settings?section=integrations" className="text-accent-light hover:underline">
                    Settings → Integrations → BigBrain
                  </Link>
                  .
                </p>
              )}
            </div>
          )
        })}
      </div>
      {!canWrite && rows.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          Changing this squad&apos;s vaults needs permission to manage its integrations.
        </p>
      )}
      <p className="mt-2 text-xs text-muted">
        Agents also need an agent type that allows BigBrain agent tools and the{' '}
        <span className="font-mono">bigbrain_shared_*</span> tool names (
        <Link to="/settings?section=agent-types" className="text-accent-light hover:underline">
          Agent types
        </Link>
        ).
      </p>
    </section>
  )
}
