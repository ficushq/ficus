import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { integrationAction, removeIntegration, type IntegrationConnection } from '../../api/integrations'
import { ApiError } from '../../api/client'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { ConfirmButton } from '../ConfirmButton'
import { useStableRef } from '../../hooks/useStableRef'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { BigbrainLocalSetupPanel } from './BigbrainLocalSetupPanel'

function boundedError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : fallback
}

function operationError(operation: string, error: unknown): string {
  return `${operation} failed: ${boundedError(error, 'Please try again.')}`.slice(0, 200)
}

type Usage = IntegrationConnection['usage']
type Confirmation = {
  operation: 'disable' | 'remove'
  connectionId: string
  usage: Usage
}
type OperationFeedback = { kind: 'success' | 'error'; message: string }

function usageFrom(error: unknown): Usage | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.payload || typeof error.payload !== 'object') {
    return null
  }
  const usage = (error.payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const value = usage as { squadCount?: unknown; squads?: unknown }
  if (typeof value.squadCount !== 'number' || !Array.isArray(value.squads)) return null
  const squads = value.squads
    .filter((squad): squad is { id: string; name: string } =>
      Boolean(
        squad &&
        typeof squad === 'object' &&
        typeof (squad as { id?: unknown }).id === 'string' &&
        typeof (squad as { name?: unknown }).name === 'string'
      )
    )
    .slice(0, 100)
    .map((squad) => ({ id: squad.id, name: squad.name.slice(0, 200) }))
  return { squadCount: value.squadCount, squads }
}

function lifecycleLabel(connection: IntegrationConnection, validating: boolean): string {
  if (validating) return 'Validating…'
  if (connection.authState === 'invalid') return 'Invalid'
  if (!connection.enabled) return 'Configured · disabled'
  if (connection.healthState === 'healthy') return 'Enabled · healthy'
  if (connection.healthState === 'degraded') return 'Enabled · degraded'
  if (connection.healthState === 'unreachable') return 'Enabled · unreachable'
  return 'Enabled · health unknown'
}

export function BigbrainIntegrationSettings({
  canRead,
  canWrite,
  embedded = false,
}: {
  canRead: boolean
  canWrite: boolean
  embedded?: boolean
}) {
  const client = useQueryClient()
  const pool = useQuery({ ...integrationQueries.pool('bigbrain'), enabled: canRead })
  const connections = pool.data ?? []
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [feedback, setFeedback] = useState<OperationFeedback | null>(null)
  const [pendingTargets, setPendingTargets] = useState<Record<string, number>>({})
  const feedbackSequence = useRef(0)
  const connectionIds = connections.map((connection) => connection.id).join(':')
  const liveConnectionIdsRef = useStableRef(new Set(connections.map((connection) => connection.id)))
  const beginOperation = () => {
    setFeedback(null)
    setConfirmation(null)
    return ++feedbackSequence.current
  }
  const beginTargetOperation = (variables: { connectionId: string }) => {
    setPendingTargets((current) => ({
      ...current,
      [variables.connectionId]: (current[variables.connectionId] ?? 0) + 1,
    }))
    return { sequence: beginOperation(), connectionId: variables.connectionId }
  }
  const finishTargetOperation = (_data: unknown, _error: unknown, variables: { connectionId: string }) => {
    setPendingTargets((current) => {
      const count = (current[variables.connectionId] ?? 1) - 1
      if (count > 0) return { ...current, [variables.connectionId]: count }
      const { [variables.connectionId]: _finished, ...rest } = current
      return rest
    })
  }
  const isLatest = (sequence: number | undefined) => feedbackSequence.current === sequence
  const isLiveTarget = (connectionId: string) => liveConnectionIdsRef.current.has(connectionId)
  const showLatestFeedback = (sequence: number | undefined, nextFeedback: OperationFeedback) => {
    if (isLatest(sequence)) setFeedback(nextFeedback)
  }
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.all })
  const clearCredentialDrafts = useCallback(() => {
    setConfirmation(null)
  }, [])
  useEffect(() => {
    if (!canWrite) {
      feedbackSequence.current += 1
      clearCredentialDrafts()
    }
  }, [canWrite, clearCredentialDrafts])
  useEffect(() => {
    setConfirmation(null)
  }, [connectionIds])

  const action = useMutation({
    mutationFn: (variables: {
      connectionId: string
      action: 'validate' | 'enable' | 'disable'
      confirmAssigned?: boolean
    }) => integrationAction(variables.connectionId, variables.action, variables.confirmAssigned),
    onMutate: beginTargetOperation,
    onSuccess: async (data, variables, context) => {
      if ('lastErrorCode' in data && data.lastErrorCode) {
        showLatestFeedback(context?.sequence, {
          kind: 'error',
          message: `Validation failed (${data.lastErrorCode}). Open BigBrain.app, then use Connect BigBrain again to repair it.`,
        })
        await refresh()
        return
      }
      const message =
        variables.action === 'validate'
          ? 'Connection validated.'
          : variables.action === 'enable'
            ? 'Connection enabled.'
            : 'Connection disabled.'
      if (isLiveTarget(variables.connectionId)) showLatestFeedback(context?.sequence, { kind: 'success', message })
      await refresh()
    },
    onError: (error, variables, context) => {
      const usage = usageFrom(error)
      if (
        variables.action === 'disable' &&
        usage &&
        isLatest(context?.sequence) &&
        isLiveTarget(variables.connectionId)
      ) {
        setConfirmation({ operation: 'disable', connectionId: variables.connectionId, usage })
        return
      }
      const operation =
        variables.action === 'validate'
          ? 'Validating the connection'
          : variables.action === 'enable'
            ? 'Enabling the connection'
            : 'Disabling the connection'
      if (isLiveTarget(variables.connectionId))
        showLatestFeedback(context?.sequence, { kind: 'error', message: operationError(operation, error) })
    },
    onSettled: finishTargetOperation,
  })

  const remove = useMutation({
    mutationFn: (variables: { connectionId: string; confirmAssigned?: boolean }) =>
      removeIntegration(variables.connectionId, variables.confirmAssigned),
    onMutate: beginTargetOperation,
    onSuccess: async (_data, variables, context) => {
      if (isLiveTarget(variables.connectionId))
        showLatestFeedback(context?.sequence, { kind: 'success', message: 'Connection removed.' })
      await refresh()
    },
    onError: (error, variables, context) => {
      const usage = usageFrom(error)
      if (usage && isLatest(context?.sequence) && isLiveTarget(variables.connectionId)) {
        setConfirmation({ operation: 'remove', connectionId: variables.connectionId, usage })
        return
      }
      if (isLiveTarget(variables.connectionId))
        showLatestFeedback(context?.sequence, {
          kind: 'error',
          message: operationError('Removing the connection', error),
        })
    },
    onSettled: finishTargetOperation,
  })

  if (!canRead) return null
  if (pool.isLoading)
    return (
      <section className={embedded ? undefined : 'mt-6 border-b border-panel-border py-5'}>
        {!embedded && <h3 className="text-sm font-medium text-primary">BigBrain</h3>}
        <p className="mt-1 text-xs text-muted">
          Desktop local runtime and same-host self-hosted Ficus are supported. Vaults belong to the connected Core host.
        </p>
        <LoadingSurface label="Loading BigBrain connections" className="mt-4 space-y-3">
          <SkeletonRows count={2}>
            {(index) => (
              <div key={index} className="border-b border-panel-border py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 space-y-2">
                    <SkeletonLine className={index ? 'w-32' : 'w-40'} />
                    <SkeletonLine className="w-56 max-w-full" />
                  </div>
                  <SkeletonBlock className="h-8 w-20" />
                </div>
              </div>
            )}
          </SkeletonRows>
        </LoadingSurface>
      </section>
    )
  if (pool.isError)
    return (
      <section className={embedded ? undefined : 'mt-6 border-b border-panel-border py-4'}>
        <p role="alert" className="text-sm text-status-danger-600">
          {boundedError(pool.error, 'Unable to load BigBrain connections.')}
        </p>
      </section>
    )

  return (
    <section className={embedded ? undefined : 'mt-6 border-b border-panel-border py-5'}>
      {!embedded && <h3 className="text-sm font-medium text-primary">BigBrain</h3>}
      <p className="text-xs text-muted mt-1">
        Desktop local runtime and same-host self-hosted Ficus are supported. Vaults belong to the connected Core host,
        not the browser. The connector exposes tools, not file mounts; trusted host runtime has no filesystem isolation
        from agent shells. Desktop attached to Cloud cannot access a vault on your Mac.
      </p>
      <div className="mt-4 space-y-4">
        {connections.map((connection) => {
          const actionPending = action.isPending && action.variables?.connectionId === connection.id
          const pending = (pendingTargets[connection.id] ?? 0) > 0
          const confirming = confirmation?.connectionId === connection.id ? confirmation : null
          return (
            <article key={connection.id} className="border-b border-panel-border py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-primary">{connection.displayName}</div>
                  <div className="text-xs text-muted break-all">
                    Vault: {connection.configuration.vaultPath}
                    <br />
                    Executable: {connection.configuration.executablePath}
                  </div>
                </div>
                <div className="rounded-full border border-th-border px-2 py-1 text-xs text-muted">
                  {lifecycleLabel(connection, actionPending && action.variables?.action === 'validate')}
                </div>
              </div>
              <div className="mt-2 text-xs text-muted">
                {connection.credentialConfigured ? 'Local connection selected' : 'Local connection unavailable'} ·
                Validation expires: {connection.validationExpiresAt ?? 'not validated'}
              </div>
              {connection.lastErrorCode && <div role="alert">{connection.lastErrorCode}</div>}
              {canWrite && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    disabled={pending}
                    onClick={() => action.mutate({ connectionId: connection.id, action: 'validate' })}
                    className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 disabled:opacity-50"
                  >
                    {actionPending && action.variables?.action === 'validate' ? 'Validating…' : 'Validate'}
                  </button>
                  <button
                    disabled={pending}
                    onClick={() =>
                      action.mutate({ connectionId: connection.id, action: connection.enabled ? 'disable' : 'enable' })
                    }
                    className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 disabled:opacity-50"
                  >
                    {actionPending && action.variables?.action !== 'validate'
                      ? connection.enabled
                        ? 'Disabling…'
                        : 'Enabling…'
                      : connection.enabled
                        ? 'Disable'
                        : 'Enable'}
                  </button>
                  <ConfirmButton
                    className="rounded-md px-3 py-1.5"
                    key={`${connectionIds}:${connection.id}`}
                    label="Remove"
                    confirmLabel="Confirm remove"
                    disabled={pending}
                    onConfirm={() => remove.mutate({ connectionId: connection.id })}
                  />
                </div>
              )}
              {confirming && (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-status-attention-500/50 bg-status-attention-500/10 p-3 text-sm"
                >
                  <p>
                    This connection is used by {confirming.usage.squadCount} squad
                    {confirming.usage.squadCount === 1 ? '' : 's'}.
                  </p>
                  {confirming.usage.squads.length > 0 && (
                    <p className="mt-1 text-xs">{confirming.usage.squads.map((squad) => squad.name).join(', ')}</p>
                  )}
                  <button
                    className="ficus-button ficus-button-secondary mt-2 rounded-md border border-status-attention-600 px-3 py-1.5"
                    onClick={() => {
                      if (confirming.operation === 'disable')
                        action.mutate({ connectionId: connection.id, action: 'disable', confirmAssigned: true })
                      else remove.mutate({ connectionId: connection.id, confirmAssigned: true })
                    }}
                  >
                    Confirm impact
                  </button>
                </div>
              )}
            </article>
          )
        })}
      </div>
      {canWrite && <BigbrainLocalSetupPanel hasConnections={connections.length > 0} />}
      {connections.length === 0 && !canWrite && (
        <p className="text-xs text-muted mt-2">No BigBrain connections configured.</p>
      )}
      {feedback && (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={clsx(
            'mt-3 text-sm',
            feedback.kind === 'error' ? 'text-status-danger-600' : 'text-status-success-700'
          )}
        >
          {feedback.message}
        </p>
      )}
    </section>
  )
}
