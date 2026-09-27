import { useState, useCallback, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getWorkspaceEnv,
  getWorkspaceEnvSecrets,
  setWorkspaceEnv,
  setWorkspaceEnvSecrets,
  type SquadEnvSecretStatus,
} from '../../api/squads'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

export function SquadEnvConfig({ squadId }: Props) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [selectedSecretKeys, setSelectedSecretKeys] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [secretsSaved, setSecretsSaved] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteEnv = !permissionsLoading && can('env:write')

  const queryKey = ['squads', squadId, 'workspace-env']
  const secretsQueryKey = ['squads', squadId, 'workspace-env-secrets']

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getWorkspaceEnv(squadId),
  })

  const {
    data: secretsData,
    isLoading: secretsLoading,
    error: secretsError,
  } = useQuery({
    queryKey: secretsQueryKey,
    queryFn: () => getWorkspaceEnvSecrets(squadId),
  })

  // Sync when data loads
  useEffect(() => {
    if (data?.content !== undefined) {
      setValue(data.content)
    }
  }, [data?.content])

  useEffect(() => {
    if (secretsData?.secrets) {
      setSelectedSecretKeys(secretsData.secrets.filter((secret) => secret.exposed).map((secret) => secret.key))
    }
  }, [secretsData?.secrets])

  const dirty = value !== (data?.content ?? '')
  const savedSecretKeys = useMemo(
    () => (secretsData?.secrets ?? []).filter((secret) => secret.exposed).map((secret) => secret.key),
    [secretsData?.secrets]
  )
  const secretsDirty = selectedSecretKeys.slice().sort().join('\n') !== savedSecretKeys.slice().sort().join('\n')

  const mutation = useMutation({
    mutationFn: (content: string) => setWorkspaceEnv(squadId, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const secretsMutation = useMutation({
    mutationFn: (keys: string[]) => setWorkspaceEnvSecrets(squadId, keys),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: secretsQueryKey })
      setSecretsSaved(true)
      setTimeout(() => setSecretsSaved(false), 2000)
    },
  })

  const handleSave = useCallback(() => {
    mutation.mutate(value)
  }, [value, mutation])

  const handleSaveSecrets = useCallback(() => {
    secretsMutation.mutate(selectedSecretKeys)
  }, [selectedSecretKeys, secretsMutation])

  const toggleSecret = useCallback((secret: SquadEnvSecretStatus) => {
    setSelectedSecretKeys((current) =>
      current.includes(secret.key) ? current.filter((key) => key !== secret.key) : [...current, secret.key]
    )
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (dirty) handleSave()
      }
    },
    [dirty, handleSave]
  )

  if (isLoading) {
    return (
      <div>
        <h4 className="text-sm font-medium text-primary mb-2">Environment Variables</h4>
        <FormSkeleton label="Loading environment variables" sections={1} />
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h4 className="text-sm font-medium text-primary mb-2">Environment Variables</h4>
        <div className="text-sm text-status-danger-500 py-4">Failed to load environment variables</div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2">
        <h4 className="text-sm font-medium text-primary">Environment Variables</h4>
        <p className="text-xs text-muted mt-1">
          Secrets and environment variables for agents and terminal sessions. User-authored values are stored separately
          from generated Secret Store exports.
        </p>
      </div>

      <textarea
        value={value}
        disabled={!canWriteEnv}
        onChange={(e) => canWriteEnv && setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="# Example:&#10;ANSIBLE_VAULT_PASSWORD=secret&#10;AWS_ACCESS_KEY_ID=AKIA...&#10;MY_API_KEY=xxx"
        className={clsx(
          'ficus-field',
          'w-full h-40 p-3 rounded-lg border bg-surface text-primary text-sm',
          'font-mono leading-relaxed resize-y',
          'placeholder:text-placeholder',
          ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
          dirty ? 'border-status-review-500 dark:border-status-review-400' : 'border-th-border'
        )}
      />

      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : saved ? '✓ Saved' : 'Ctrl+S to save'}</span>
        <button
          onClick={handleSave}
          disabled={!canWriteEnv || !dirty || mutation.isPending}
          className={clsx(
            'ficus-button',
            'px-3 py-1 text-sm rounded-md font-medium transition-colors',
            dirty ? 'bg-accent text-on-accent hover:bg-accent/90' : 'bg-surface-secondary text-muted cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>

      {mutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(mutation.error)}</p>
      )}

      <div className="mt-6 border-t border-th-border pt-4">
        <h4 data-setting-target="exposed-secret-store-keys" className="text-sm font-medium text-primary">
          Exposed Secret Store Keys
        </h4>
        <p className="text-xs text-muted mt-1">
          Select only the global secrets this squad sandbox may read as environment variables. Values are never shown
          here, but selected secrets are rendered into the squad sandbox .tau/.env file.
        </p>

        {secretsLoading ? (
          <FormSkeleton label="Loading secret assignments" sections={2} />
        ) : secretsError ? (
          <div className="text-sm text-status-danger-500 py-4">Failed to load Secret Store keys</div>
        ) : (
          <div className="mt-3 space-y-2 max-h-64 overflow-auto rounded-lg border border-th-border p-3">
            {(secretsData?.secrets ?? []).map((secret) => {
              const checked = selectedSecretKeys.includes(secret.key)
              return (
                <label key={secret.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className={clsx('font-mono', secret.isSet ? 'text-primary' : 'text-muted')}>
                    {secret.key}
                    {secret.globallyExposed && (
                      <span className="ml-2 font-sans text-xs text-accent-light">globally exposed</span>
                    )}
                    {!secret.isSet && (
                      <span className="ml-2 font-sans text-xs text-muted">
                        {checked ? 'not set; uncheck to remove exposure' : 'not set'}
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    checked={checked || secret.globallyExposed}
                    disabled={!canWriteEnv || secret.globallyExposed || (!secret.isSet && !checked)}
                    onChange={() => canWriteEnv && toggleSecret(secret)}
                    className="h-4 w-4 rounded border-th-border text-accent-light focus:ring-accent/50 disabled:opacity-50"
                  />
                </label>
              )
            })}
          </div>
        )}

        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-muted">
            {secretsDirty
              ? 'Unsaved secret exposure changes'
              : secretsSaved
                ? '✓ Secret exposure saved'
                : 'Values hidden'}
          </span>
          <button
            onClick={handleSaveSecrets}
            disabled={!canWriteEnv || !secretsDirty || secretsMutation.isPending}
            className={clsx(
              'ficus-button',
              'px-3 py-1 text-sm rounded-md font-medium transition-colors',
              secretsDirty
                ? 'bg-accent text-on-accent hover:bg-accent/90'
                : 'bg-surface-secondary text-muted cursor-not-allowed'
            )}
          >
            {secretsMutation.isPending ? 'Saving...' : 'Save exposed secrets'}
          </button>
        </div>

        {secretsMutation.isError && (
          <p className="text-xs text-status-danger-500 mt-2">
            Failed to save exposed secrets: {String(secretsMutation.error)}
          </p>
        )}
      </div>
    </div>
  )
}
