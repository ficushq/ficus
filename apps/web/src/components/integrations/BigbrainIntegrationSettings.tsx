import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { integrationAction, removeIntegration, type IntegrationConnection } from '../../api/integrations'
import { ApiError } from '../../api/client'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { useStableRef } from '../../hooks/useStableRef'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { BigbrainLocalSetupPanel } from './BigbrainLocalSetupPanel'
import { useAdjustOnChange } from '../../hooks/useAdjustOnChange'
import { ConnectionSquads } from './ConnectionSquads'
import { ConnectionList, ConnectionRow } from './ConnectionRow'
import { connectionConfirmQuestion, connectionStatus } from './connectionStatus'

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
  // Losing write access, or another set of connections, drops a pending confirmation while
  // rendering. The layout effect retires feedback from requests made with write access in that same
  // commit, so a response that arrives afterwards cannot show feedback to a reader.
  useAdjustOnChange([canWrite, connectionIds], (previous) => {
    if (!canWrite || previous?.[1] !== connectionIds) clearCredentialDrafts()
  })
  useLayoutEffect(() => {
    if (!canWrite) feedbackSequence.current += 1
  }, [canWrite])

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
      {connections.length > 0 && (
        <ConnectionList className="mt-3">
          {connections.map((connection) => {
            const actionPending = action.isPending && action.variables?.connectionId === connection.id
            const validating = actionPending && action.variables?.action === 'validate'
            const pending = (pendingTargets[connection.id] ?? 0) > 0
            const confirming = confirmation?.connectionId === connection.id ? confirmation : null
            const confirm = (operation: Confirmation['operation']) =>
              setConfirmation({ operation, connectionId: connection.id, usage: connection.usage })
            return (
              <ConnectionRow
                key={connection.id}
                title={connection.displayName}
                meta={
                  <>
                    <p className="break-all">Vault: {connection.configuration.vaultPath}</p>
                    <p className="break-all">Executable: {connection.configuration.executablePath}</p>
                    <p>
                      {connection.credentialConfigured ? 'Local connection selected' : 'Local connection unavailable'} ·
                      Validation expires: {connection.validationExpiresAt ?? 'not validated'}
                    </p>
                  </>
                }
                status={validating ? { label: 'Validating…', color: 'neutral' } : connectionStatus(connection)}
                // A local vault has no reconnect: an invalid one is repaired from the setup panel below.
                inline={
                  canWrite && !connection.enabled
                    ? {
                        label: actionPending ? 'Enabling…' : 'Enable',
                        disabled: pending,
                        onClick: () => action.mutate({ connectionId: connection.id, action: 'enable' }),
                      }
                    : null
                }
                menu={
                  canWrite
                    ? [
                        {
                          label: 'Validate',
                          disabled: pending,
                          onSelect: () => action.mutate({ connectionId: connection.id, action: 'validate' }),
                        },
                        connection.enabled && {
                          label: 'Disable…',
                          disabled: pending,
                          onSelect: () => confirm('disable'),
                        },
                        { label: 'Remove…', danger: true, disabled: pending, onSelect: () => confirm('remove') },
                      ]
                    : []
                }
                confirmation={
                  canWrite && confirming
                    ? {
                        message: (
                          <>
                            <p>
                              {connectionConfirmQuestion(
                                confirming.operation,
                                connection.displayName,
                                confirming.usage.squadCount,
                                'BigBrain'
                              )}
                            </p>
                            {confirming.usage.squads.length > 0 && (
                              <p className="mt-1 text-xs">
                                {confirming.usage.squads.map((squad) => squad.name).join(', ')}
                              </p>
                            )}
                          </>
                        ),
                        confirmLabel: confirming.operation === 'remove' ? 'Remove' : 'Disable',
                        disabled: pending,
                        onConfirm: () => {
                          const confirmAssigned = confirming.usage.squadCount > 0
                          if (confirming.operation === 'disable')
                            action.mutate({ connectionId: connection.id, action: 'disable', confirmAssigned })
                          else remove.mutate({ connectionId: connection.id, confirmAssigned })
                        },
                        onCancel: () => setConfirmation(null),
                      }
                    : null
                }
              >
                {connection.lastErrorCode && (
                  <p role="alert" className="mt-2 text-sm text-status-danger-600 dark:text-status-danger-400">
                    {connection.lastErrorCode}
                  </p>
                )}
                <ConnectionSquads
                  provider="bigbrain"
                  providerLabel="BigBrain"
                  connection={connection}
                  connections={connections}
                  noun="vault"
                />
              </ConnectionRow>
            )
          })}
        </ConnectionList>
      )}
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
