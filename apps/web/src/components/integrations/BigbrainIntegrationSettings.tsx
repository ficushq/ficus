import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  createIntegration,
  integrationAction,
  removeIntegration,
  replaceIntegrationCredential,
  type IntegrationConnection,
} from '../../api/integrations'
import { ApiError } from '../../api/client'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { ConfirmButton } from '../ConfirmButton'
import { useStableRef } from '../../hooks/useStableRef'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'

function boundedError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : fallback
}

function operationError(operation: string, error: unknown): string {
  return `${operation} failed: ${boundedError(error, 'Please try again.')}`.slice(0, 200)
}

type Usage = IntegrationConnection['usage']
type Confirmation = {
  operation: 'disable' | 'replace' | 'remove'
  connectionId: string
  usage: Usage
  credential?: string
  editorEpoch?: number
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
  const [displayName, setDisplayName] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [credential, setCredential] = useState('')
  const [replacingId, setReplacingId] = useState<string | null>(null)
  const [nextCredential, setNextCredential] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [feedback, setFeedback] = useState<OperationFeedback | null>(null)
  const [pendingTargets, setPendingTargets] = useState<Record<string, number>>({})
  const feedbackSequence = useRef(0)
  const replacementEpoch = useRef(0)
  const connectionIds = connections.map((connection) => connection.id).join(':')
  const liveConnectionIdsRef = useStableRef(new Set(connections.map((connection) => connection.id)))
  const replacingIdRef = useStableRef(replacingId)
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
    setDisplayName('')
    setApiBase('')
    setCredential('')
    replacementEpoch.current += 1
    setReplacingId(null)
    setNextCredential('')
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

  const create = useMutation({
    mutationFn: (variables: { displayName: string; apiBase: string; credential: string }) =>
      createIntegration(variables),
    onMutate: beginOperation,
    onSuccess: async (_data, _variables, sequence) => {
      if (isLatest(sequence)) {
        setDisplayName('')
        setApiBase('')
        setCredential('')
      }
      showLatestFeedback(sequence, { kind: 'success', message: 'Connection created.' })
      await refresh()
    },
    onError: (error, _variables, sequence) =>
      showLatestFeedback(sequence, { kind: 'error', message: operationError('Creating the connection', error) }),
  })

  const action = useMutation({
    mutationFn: (variables: {
      connectionId: string
      action: 'validate' | 'enable' | 'disable'
      confirmAssigned?: boolean
    }) => integrationAction(variables.connectionId, variables.action, variables.confirmAssigned),
    onMutate: beginTargetOperation,
    onSuccess: async (_data, variables, context) => {
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

  const replaceCredential = useMutation({
    mutationFn: (variables: {
      connectionId: string
      credential: string
      editorEpoch: number
      confirmAssigned?: boolean
    }) => replaceIntegrationCredential(variables.connectionId, variables.credential, variables.confirmAssigned),
    onMutate: beginTargetOperation,
    onSuccess: async (_data, variables, context) => {
      if (
        isLatest(context?.sequence) &&
        isLiveTarget(variables.connectionId) &&
        replacingIdRef.current === variables.connectionId &&
        replacementEpoch.current === variables.editorEpoch
      ) {
        setNextCredential('')
        setReplacingId(null)
      }
      showLatestFeedback(context?.sequence, {
        kind: 'success',
        message: 'Credential replaced. Validate the connection before enabling it.',
      })
      await refresh()
    },
    onError: (error, variables, context) => {
      const usage = usageFrom(error)
      if (
        usage &&
        isLatest(context?.sequence) &&
        isLiveTarget(variables.connectionId) &&
        replacingIdRef.current === variables.connectionId &&
        replacementEpoch.current === variables.editorEpoch
      ) {
        setConfirmation({
          operation: 'replace',
          connectionId: variables.connectionId,
          usage,
          credential: variables.credential,
          editorEpoch: variables.editorEpoch,
        })
        return
      }
      if (isLiveTarget(variables.connectionId))
        showLatestFeedback(context?.sequence, {
          kind: 'error',
          message: operationError('Replacing the credential', error),
        })
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
        {!embedded && <h3 className="text-sm font-medium text-primary">Bigbrain</h3>}
        <p className="mt-1 text-xs text-muted">
          Connections are global. A connection never enables conversation export; each conversation requires separate
          consent.
        </p>
        <LoadingSurface label="Loading Bigbrain connections" className="mt-4 space-y-3">
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
          {boundedError(pool.error, 'Unable to load Bigbrain connections.')}
        </p>
      </section>
    )

  return (
    <section className={embedded ? undefined : 'mt-6 border-b border-panel-border py-5'}>
      {!embedded && <h3 className="text-sm font-medium text-primary">Bigbrain</h3>}
      <p className="text-xs text-muted mt-1">
        Connections are global. A connection never enables conversation export; each conversation requires separate
        consent.
      </p>
      <div className="mt-4 space-y-4">
        {connections.map((connection) => {
          const actionPending = action.isPending && action.variables?.connectionId === connection.id
          const replacePending =
            replaceCredential.isPending && replaceCredential.variables?.connectionId === connection.id
          const pending = (pendingTargets[connection.id] ?? 0) > 0
          const confirming = confirmation?.connectionId === connection.id ? confirmation : null
          return (
            <article key={connection.id} className="border-b border-panel-border py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-primary">{connection.displayName}</div>
                  <div className="text-xs text-muted">API base: {connection.configuration.apiBase}</div>
                </div>
                <div className="rounded-full border border-th-border px-2 py-1 text-xs text-muted">
                  {lifecycleLabel(connection, actionPending && action.variables?.action === 'validate')}
                </div>
              </div>
              <div className="mt-2 text-xs text-muted">
                {connection.credentialConfigured ? 'Credential configured' : 'Credential not configured'} · Validation
                expires: {connection.validationExpiresAt ?? 'not validated'}
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
                  <button
                    disabled={pending}
                    onClick={() => {
                      replacementEpoch.current += 1
                      feedbackSequence.current += 1
                      setFeedback(null)
                      setReplacingId(connection.id)
                      setNextCredential('')
                      setConfirmation(null)
                    }}
                    className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 disabled:opacity-50"
                  >
                    Replace credential
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
              {canWrite && replacingId === connection.id && (
                <form
                  className="mt-3 flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    replaceCredential.mutate({
                      connectionId: connection.id,
                      credential: nextCredential,
                      editorEpoch: replacementEpoch.current,
                    })
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs font-medium text-primary">
                    New credential
                    <input
                      aria-label={`Replacement Bigbrain credential for ${connection.displayName}`}
                      className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2 text-primary"
                      type="password"
                      autoComplete="off"
                      value={nextCredential}
                      onChange={(event) => {
                        replacementEpoch.current += 1
                        setConfirmation(null)
                        setNextCredential(event.target.value)
                      }}
                      disabled={replacePending}
                      required
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={pending}
                      className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
                    >
                      {replacePending ? 'Replacing…' : 'Save credential'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        replacementEpoch.current += 1
                        feedbackSequence.current += 1
                        setFeedback(null)
                        setNextCredential('')
                        setReplacingId(null)
                        setConfirmation(null)
                      }}
                      className="ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
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
                      else if (confirming.operation === 'replace')
                        replaceCredential.mutate({
                          connectionId: connection.id,
                          credential: confirming.credential ?? '',
                          editorEpoch: confirming.editorEpoch ?? -1,
                          confirmAssigned: true,
                        })
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
      {canWrite && (
        <form
          className="mt-5 flex flex-col gap-2 border-t border-th-border pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({ displayName, apiBase, credential })
          }}
        >
          <h4 className="text-sm font-medium text-primary">Add connection</h4>
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            Display name
            <input
              aria-label="Bigbrain display name"
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={create.isPending}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            API base
            <input
              aria-label="Bigbrain API base"
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2"
              type="url"
              value={apiBase}
              onChange={(event) => setApiBase(event.target.value)}
              disabled={create.isPending}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-primary">
            Credential
            <input
              aria-label="Bigbrain credential"
              className="ficus-field rounded-md border border-th-border bg-surface px-3 py-2"
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              disabled={create.isPending}
              required
            />
          </label>
          <button
            type="submit"
            className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            disabled={create.isPending}
          >
            {create.isPending ? 'Creating and validating…' : 'Create and validate'}
          </button>
        </form>
      )}
      {connections.length === 0 && !canWrite && (
        <p className="text-xs text-muted mt-2">No Bigbrain connections configured.</p>
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
