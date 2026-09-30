import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys, integrationQueryKeys } from '../../queryKeys'
import { getSecret, setSecret, deleteSecret, restartSystem, type SecretValidation } from '../../api/secrets'
import { ApiError } from '../../api/client'
import { useRestartPolling } from './useRestartPolling'
import { usePermissions } from '../../hooks/usePermissions'
import { buildSecretRegistry, groupByCategory, isGitHubTokenSecretKey, visibleRegistryEntries } from './secretsRegistry'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

type RestartState = 'idle' | 'needs-restart' | 'restarting' | 'waiting-down' | 'waiting-up'

function validationFeedback(validation: SecretValidation): { tone: 'ok' | 'warn'; text: string } | null {
  if (validation.status === 'valid') {
    const text =
      validation.tokenType === 'classic'
        ? `Validated as @${validation.login} (classic PAT, scopes: ${validation.scopes?.join(', ') || 'none'})`
        : `Validated as @${validation.login} (fine-grained token)`
    return { tone: validation.warnings.length ? 'warn' : 'ok', text }
  }
  return validation.status === 'unverified'
    ? { tone: 'warn', text: `Saved without validation — ${validation.message}` }
    : null
}

function validationFromApiError(error: unknown): SecretValidation | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const candidate = (error.payload as { validation?: unknown } | undefined)?.validation
  if (!candidate || typeof candidate !== 'object' || !('status' in candidate)) return null
  const status = (candidate as { status?: unknown }).status
  if (status === 'invalid' || status === 'unverified') {
    return typeof (candidate as { message?: unknown }).message === 'string' ? (candidate as SecretValidation) : null
  }
  const valid = candidate as Partial<Extract<SecretValidation, { status: 'valid' }>>
  return status === 'valid' &&
    typeof valid.login === 'string' &&
    (valid.tokenType === 'classic' || valid.tokenType === 'fine-grained') &&
    (valid.scopes === undefined ||
      (Array.isArray(valid.scopes) && valid.scopes.every((scope) => typeof scope === 'string'))) &&
    Array.isArray(valid.warnings) &&
    valid.warnings.every((warning) => typeof warning === 'string')
    ? (candidate as SecretValidation)
    : null
}

function overrideableRejection(error: unknown): Extract<SecretValidation, { status: 'valid' }> | null {
  const validation = validationFromApiError(error)
  return validation?.status === 'valid' && validation.warnings.length ? validation : null
}

export function SecretsSection({ scope = 'git' }: { scope?: 'git' | 'machines' }) {
  const queryClient = useQueryClient()
  const { data: secretsData, isLoading } = useQuery(queries.secrets.list())
  const { data: gitDefaults } = useQuery(queries.secrets.gitAuthorDefaults())
  const metadata = useMemo(() => secretsData?.secrets ?? [], [secretsData])
  // Keys the hosted platform manages on this instance: rendered read-only
  // ("Managed by your platform") with no values and no editable fields.
  const managedKeys = useMemo(() => new Set(secretsData?.managedKeys ?? []), [secretsData])
  const managed = secretsData?.managed === true
  const exeBacked = secretsData?.exeBacked === true
  const [restartState, setRestartState] = useState<RestartState>('idle')
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWriteSecrets =
    !permissionsLoading && (can('secrets:write') || (scope === 'git' && can('secrets:write:integration')))
  const canRestartSystem = !permissionsLoading && can('system:restart')

  useRestartPolling(restartState, setRestartState)

  const restartMutation = useMutation({
    mutationFn: restartSystem,
    onSuccess: () => {
      setRestartState('waiting-down')
    },
    onError: () => {
      // Request might fail if server shuts down before responding
      setRestartState('waiting-down')
    },
  })

  const registry = useMemo(
    () =>
      visibleRegistryEntries(
        buildSecretRegistry(metadata).filter((entry) =>
          scope === 'git' ? entry.category === 'Git' : entry.category === 'Machines'
        ),
        managedKeys,
        { managed, exeBacked }
      ),
    [metadata, managedKeys, managed, exeBacked, scope]
  )
  const groups = groupByCategory(registry, metadata)
  const loadingCardCount = useLoadingShapeCount('settings:secrets', isLoading ? undefined : groups.length, {
    fallbackCount: 5,
    maxCount: 10,
  })

  if (scope === 'machines' && (isLoading || secretsData?.managed !== false || !groups.length)) return null

  if (isLoading) {
    return <CollectionSkeleton label="Loading Git settings" count={loadingCardCount} layout="cards" />
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">{scope === 'git' ? 'Git' : 'exe.dev credentials'}</h3>
        <p className="text-sm text-muted mt-1">
          {scope === 'git'
            ? 'Default commit author for agents. Leave overrides unset to use the connected GitHub account; squads can override these values.'
            : 'Configure the account key used to provision exe.dev machines. The private key is encrypted at rest.'}
        </p>
      </div>

      {restartState !== 'idle' && (
        <div
          className={clsx(
            'flex items-center justify-between rounded-lg px-4 py-3 border',
            restartState === 'needs-restart' &&
              'bg-status-review-50 dark:bg-status-review-900/20 border-status-review-200 dark:border-status-review-800',
            (restartState === 'waiting-down' || restartState === 'waiting-up') &&
              'bg-status-progress-50 dark:bg-status-progress-900/20 border-status-progress-200 dark:border-status-progress-800'
          )}
        >
          <div>
            {restartState === 'needs-restart' && (
              <>
                <p className="text-sm font-medium text-status-review-800 dark:text-status-review-200">
                  Restart required
                </p>
                <p className="text-xs text-status-review-600 dark:text-status-review-400 mt-0.5">
                  You changed a secret that requires a system restart to take effect.
                </p>
              </>
            )}
            {restartState === 'waiting-down' && (
              <>
                <p className="text-sm font-medium text-status-progress-800 dark:text-status-progress-200">
                  Shutting down…
                </p>
                <p className="text-xs text-status-progress-600 dark:text-status-progress-400 mt-0.5">
                  Waiting for the server to stop.
                </p>
              </>
            )}
            {restartState === 'waiting-up' && (
              <>
                <p className="text-sm font-medium text-status-progress-800 dark:text-status-progress-200">
                  Starting up…
                </p>
                <p className="text-xs text-status-progress-600 dark:text-status-progress-400 mt-0.5">
                  Waiting for the server to come back online.
                </p>
              </>
            )}
          </div>
          {restartState === 'needs-restart' && canRestartSystem && (
            <button
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
              className="ficus-button text-sm bg-status-review-600 text-on-strong px-4 py-1.5 rounded font-medium hover:bg-status-review-700 disabled:opacity-50 shrink-0"
            >
              {restartMutation.isPending ? 'Restarting…' : 'Restart Now'}
            </button>
          )}
          {(restartState === 'waiting-down' || restartState === 'waiting-up') && (
            <div className="animate-spin h-5 w-5 border-2 border-status-progress-500 border-t-transparent rounded-full shrink-0" />
          )}
        </div>
      )}

      {groups.map((group) => {
        return (
          <div key={group.category} className="ficus-section overflow-hidden">
            <div className="divide-y divide-th-border">
              {group.secrets.map((secret) => (
                <div key={secret.key} data-setting-target={`secret-${secret.key.toLowerCase()}`}>
                  {managedKeys.has(secret.key) ? (
                    <ManagedSecretRow key={secret.key} name={secret.name} description={secret.description} />
                  ) : (
                    <SecretRow
                      key={secret.key}
                      secretKey={secret.key}
                      name={secret.name}
                      description={secret.description}
                      isSet={secret.meta.isSet}
                      updatedAt={secret.meta.updatedAt}
                      requiresRestart={secret.requiresRestart}
                      sensitive={secret.sensitive !== false}
                      inheritedValue={
                        secret.key === 'GIT_USER_NAME'
                          ? gitDefaults?.github?.gitUserName
                          : secret.key === 'GIT_USER_EMAIL'
                            ? gitDefaults?.github?.gitUserEmail
                            : undefined
                      }
                      inheritedLogin={gitDefaults?.github?.login}
                      canWrite={canWriteSecrets}
                      onChanged={(didRequireRestart) => {
                        queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all })
                        queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all })
                        if (didRequireRestart) setRestartState('needs-restart')
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ManagedSecretRow({ name, description }: { name: string; description: string }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-primary">{name}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent-light">Managed by your platform</span>
      </div>
      <p className="text-xs text-muted mt-0.5">{description}</p>
      <p className="text-xs text-muted mt-0.5">
        Configured by your hosting provider. It is not stored here and cannot be viewed or edited.
      </p>
    </div>
  )
}

function SecretRow({
  secretKey,
  name,
  description,
  isSet,
  updatedAt,
  requiresRestart,
  sensitive = true,
  inheritedValue,
  inheritedLogin,
  canWrite,
  onChanged,
}: {
  secretKey: string
  name: string
  description: string
  isSet: boolean
  updatedAt: string | null
  requiresRestart?: boolean
  sensitive?: boolean
  inheritedValue?: string
  inheritedLogin?: string
  canWrite: boolean
  onChanged: (didRequireRestart: boolean) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reveal'>('view')
  const [value, setValue] = useState('')
  const [revealedValue, setRevealedValue] = useState<string | null>(null)
  const [displayValue, setDisplayValue] = useState<string | null>(null)
  const [lastValidation, setLastValidation] = useState<SecretValidation | null>(null)
  const validated = isGitHubTokenSecretKey(secretKey)

  // For non-sensitive fields, auto-load the current value for display
  useEffect(() => {
    if (!sensitive && isSet) {
      getSecret(secretKey)
        .then((r) => setDisplayValue(r.value))
        .catch(() => {})
    } else {
      setDisplayValue(null)
    }
  }, [sensitive, isSet, secretKey])

  const saveMutation = useMutation({
    mutationFn: (vars: { value: string; force?: boolean }) => setSecret(secretKey, vars.value, { force: vars.force }),
    onSuccess: (result) => {
      setLastValidation(result.validation ?? null)
      setMode('view')
      setDisplayValue(value)
      setValue('')
      onChanged(!!requiresRestart)
    },
  })
  const rejectedValidation = validationFromApiError(saveMutation.error)
  const overrideable = overrideableRejection(saveMutation.error)
  const feedback = lastValidation ? validationFeedback(lastValidation) : null

  const deleteMutation = useMutation({
    mutationFn: () => deleteSecret(secretKey),
    onSuccess: () => {
      setMode('view')
      setValue('')
      setRevealedValue(null)
      setDisplayValue(null)
      setLastValidation(null)
      onChanged(!!requiresRestart)
    },
  })

  const handleReveal = async () => {
    try {
      const result = await getSecret(secretKey)
      setRevealedValue(result.value)
      setMode('reveal')
      // Auto-hide after 10s
      setTimeout(() => {
        setRevealedValue(null)
        setMode('view')
      }, 10000)
    } catch {
      // Secret might have been deleted
    }
  }

  const handleEdit = () => {
    saveMutation.reset()
    setLastValidation(null)
    setMode('edit')
    setRevealedValue(null)
  }

  const handleSave = (force = false) => {
    if (value) saveMutation.mutate({ value, force })
  }

  const handleCancel = () => {
    saveMutation.reset()
    setMode('view')
    setValue('')
    setRevealedValue(null)
  }

  const handleDelete = () => {
    if (confirm(`Clear ${name}?`)) {
      deleteMutation.mutate()
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-primary">{name}</span>
            <span
              className={clsx(
                'text-xs px-1.5 py-0.5 rounded',
                isSet
                  ? 'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-700 dark:text-status-success-400'
                  : 'bg-status-review-100 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-400'
              )}
            >
              {isSet ? (inheritedValue ? 'Override' : 'Set') : inheritedValue ? 'GitHub default' : 'Not set'}
            </span>
            {requiresRestart && (
              <span className="text-xs text-muted" title="Changing this requires a system restart">
                ⟳
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">{description}</p>
          {inheritedValue && (
            <p className="text-xs text-secondary mt-1">
              GitHub default (@{inheritedLogin}): <span className="font-mono">{inheritedValue}</span>
              {isSet
                ? '. Clear the override to use this default.'
                : '. Used automatically unless overridden for a squad.'}
            </p>
          )}
          {mode === 'view' && feedback && (
            <p
              className={clsx(
                'text-xs mt-0.5',
                feedback.tone === 'ok'
                  ? 'text-status-success-600 dark:text-status-success-400'
                  : 'text-status-review-700 dark:text-status-review-400'
              )}
            >
              {feedback.text}
            </p>
          )}
          {mode === 'view' &&
            lastValidation?.status === 'valid' &&
            lastValidation.warnings.map((warning) => (
              <p key={warning} className="text-xs text-status-review-700 dark:text-status-review-400 mt-0.5">
                {warning}
              </p>
            ))}
          {!sensitive && displayValue && mode === 'view' && (
            <p className="text-xs text-secondary mt-0.5 font-mono">{displayValue}</p>
          )}
          {updatedAt && (
            <p className="text-xs text-muted mt-0.5">Updated {formatRelativeTime(new Date(updatedAt).getTime())}</p>
          )}
        </div>

        {mode === 'view' && canWrite && (
          <div className="flex items-center gap-2 shrink-0">
            {isSet && sensitive && (
              <>
                <button
                  onClick={handleReveal}
                  className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium"
                >
                  Reveal
                </button>
                <span className="text-muted">·</span>
              </>
            )}
            <button
              onClick={handleEdit}
              className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium"
            >
              {isSet ? 'Edit' : inheritedValue ? 'Override' : 'Set'}
            </button>
            {isSet && (
              <>
                <span className="text-muted">·</span>
                <button
                  onClick={handleDelete}
                  className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {mode === 'reveal' && revealedValue !== null && (
        <div className="mt-2 flex items-center gap-2">
          <code className="text-xs bg-surface-secondary px-2 py-1 rounded font-mono text-primary break-all flex-1">
            {revealedValue}
          </code>
          <button onClick={handleCancel} className="ficus-button text-xs text-muted hover:text-primary shrink-0">
            Hide
          </button>
        </div>
      )}

      {mode === 'edit' && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type={sensitive ? 'password' : 'text'}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                saveMutation.reset()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
                if (e.key === 'Escape') handleCancel()
              }}
              placeholder={inheritedValue ?? (isSet ? 'Enter new value...' : 'Enter value...')}
              className="ficus-field flex-1 text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
              autoFocus
            />
            <button
              onClick={() => handleSave()}
              disabled={!value || saveMutation.isPending}
              className="ficus-button ficus-button-primary inline-flex items-center gap-1.5 text-xs bg-accent text-on-accent px-3 py-1 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
            >
              {saveMutation.isPending && validated && (
                <span className="animate-spin h-3 w-3 border-2 border-chrome-highlight border-t-transparent rounded-full" />
              )}
              {saveMutation.isPending ? (validated ? 'Validating with GitHub…' : 'Saving...') : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
            >
              Cancel
            </button>
          </div>
          {overrideable ? (
            <div className="space-y-1">
              {overrideable.warnings.map((warning) => (
                <p key={warning} className="text-xs text-status-review-700 dark:text-status-review-400">
                  {warning}
                </p>
              ))}
              <button
                onClick={() => handleSave(true)}
                disabled={saveMutation.isPending}
                className="ficus-button text-xs bg-status-review-600 text-on-strong px-3 py-1 rounded font-medium disabled:opacity-50"
              >
                Save anyway
              </button>
            </div>
          ) : saveMutation.error ? (
            <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
              {rejectedValidation?.status === 'invalid'
                ? rejectedValidation.message
                : saveMutation.error.message || 'Save failed'}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
