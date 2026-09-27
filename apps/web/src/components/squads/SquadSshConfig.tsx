import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getSshConfig, setSshConfig, getKnownHosts, setKnownHosts } from '../../api/squads'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

export function SquadSshConfig({ squadId }: Props) {
  return (
    <div className="space-y-6">
      <SshConfigEditor squadId={squadId} />
      <KnownHostsEditor squadId={squadId} />
    </div>
  )
}

function SshConfigEditor({ squadId }: { squadId: string }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteSsh = !permissionsLoading && can('ssh:write')

  const queryKey = ['squads', squadId, 'ssh-config']

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getSshConfig(squadId),
  })

  // Sync when data loads
  useEffect(() => {
    if (data?.config !== undefined) {
      setValue(data.config)
    }
  }, [data?.config])

  const dirty = value !== (data?.config ?? '')

  const mutation = useMutation({
    mutationFn: (config: string) => setSshConfig(squadId, config),
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
        <h4 className="text-sm font-medium text-primary mb-2">SSH Config</h4>
        <FormSkeleton label="Loading SSH config" sections={1} />
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h4 className="text-sm font-medium text-primary mb-2">SSH Config</h4>
        <div className="text-sm text-status-danger-500 py-4">Failed to load SSH config</div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2">
        <h4 className="text-sm font-medium text-primary">SSH Config</h4>
        <p className="text-xs text-muted mt-1">
          Custom SSH configuration (e.g., Host aliases, identity files). Applied to ~/.ssh/config in the workspace.
        </p>
      </div>

      <textarea
        value={value}
        disabled={!canWriteSsh}
        onChange={(e) => canWriteSsh && setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="# Example:&#10;Host github.com&#10;  IdentityFile ~/.ssh/my-deploy-key&#10;  StrictHostKeyChecking accept-new"
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
          disabled={!canWriteSsh || !dirty || mutation.isPending}
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
    </div>
  )
}

function KnownHostsEditor({ squadId }: { squadId: string }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteSsh = !permissionsLoading && can('ssh:write')

  const queryKey = ['squads', squadId, 'ssh-known-hosts']

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getKnownHosts(squadId),
  })

  // Sync when data loads
  useEffect(() => {
    if (data?.knownHosts !== undefined) {
      setValue(data.knownHosts)
    }
  }, [data?.knownHosts])

  const dirty = value !== (data?.knownHosts ?? '')

  const mutation = useMutation({
    mutationFn: (knownHosts: string) => setKnownHosts(squadId, knownHosts),
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
        <h4 data-setting-target="known-hosts" className="text-sm font-medium text-primary mb-2">
          Known Hosts
        </h4>
        <FormSkeleton label="Loading known hosts" sections={1} />
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h4 data-setting-target="known-hosts" className="text-sm font-medium text-primary mb-2">
          Known Hosts
        </h4>
        <div className="text-sm text-status-danger-500 py-4">Failed to load known hosts</div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2">
        <h4 data-setting-target="known-hosts" className="text-sm font-medium text-primary">
          Known Hosts
        </h4>
        <p className="text-xs text-muted mt-1">
          SSH known hosts entries. Applied to ~/.ssh/known_hosts in the workspace.
        </p>
      </div>

      <textarea
        value={value}
        disabled={!canWriteSsh}
        onChange={(e) => canWriteSsh && setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="# Example:&#10;github.com ssh-ed25519 AAAAC3NzaC1lZDI1..."
        className={clsx(
          'ficus-field',
          'w-full h-32 p-3 rounded-lg border bg-surface text-primary text-sm',
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
          disabled={!canWriteSsh || !dirty || mutation.isPending}
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
    </div>
  )
}
