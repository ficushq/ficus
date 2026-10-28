import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getWorkspaceEnv, setWorkspaceEnv } from '../../api/squads'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

export function SquadEnvConfig({ squadId }: Props) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteEnv = !permissionsLoading && can('env:write')

  const queryKey = ['squads', squadId, 'workspace-env']

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getWorkspaceEnv(squadId),
  })

  // Sync when data loads
  useEffect(() => {
    if (data?.content !== undefined) {
      setValue(data.content)
    }
  }, [data?.content])

  const dirty = value !== (data?.content ?? '')

  const mutation = useMutation({
    mutationFn: (content: string) => setWorkspaceEnv(squadId, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const handleSave = useCallback(() => {
    mutation.mutate(value)
  }, [value, mutation])

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
          Custom secrets and environment variables for this squad. Values are visible to agents and terminals.
        </p>
      </div>

      {data?.detectionNotice && (
        <p role="status" className="text-xs text-status-review-600 mt-1 mb-2">
          {data.detectionNotice}
        </p>
      )}

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
            'ficus-button ficus-button-primary',
            'px-3 py-1 text-sm rounded-md font-medium transition-colors',
            !dirty && 'opacity-50 cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>

      {mutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(mutation.error)}</p>
      )}
    </div>
  )
}
