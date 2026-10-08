import clsx from 'clsx'
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
}: {
  squadId: string
  provider: string
  presentation: { label: string }
  canRead: boolean
  canWrite: boolean
  embedded?: boolean
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
            return (
              <div key={connection.id} className="flex items-center justify-between gap-3 text-sm">
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
