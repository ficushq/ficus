import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  syncMemoryPull,
  syncMemoryPush,
  updateSquad,
  type MemoryConfig,
  type GitSyncProvider,
  type S3SyncProvider,
} from '../../api/squads'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

export function MemorySyncSettings({ squadId }: Props) {
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteMemory = !permissionsLoading && can('memory:write')
  const [showAddProvider, setShowAddProvider] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [providerType, setProviderType] = useState<'git' | 's3'>('git')

  // Git form state
  const [gitRepoUrl, setGitRepoUrl] = useState('')
  const [gitBranch, setGitBranch] = useState('main')
  const [gitSshKeyName, setGitSshKeyName] = useState('')
  const [gitAutoPull, setGitAutoPull] = useState(true)
  const [gitAutoPush, setGitAutoPush] = useState(true)

  // Query sync status
  const {
    data: syncStatus,
    isLoading: statusLoading,
    isSuccess: statusSuccess,
  } = useQuery(queries.squads.memory.syncStatus(squadId))
  const providerSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:memory-sync-providers`,
    statusSuccess ? (syncStatus?.providers.length ?? 0) : undefined,
    { fallbackCount: 2, maxCount: 6 }
  )

  // Query squad for config
  const { data: squad } = useQuery(queries.squads.basic(squadId))

  // Query SSH keys for dropdown
  const { data: sshKeys = [] } = useQuery(queries.squads.sshKeys(squadId))

  const memoryConfig = (squad?.metadata as { memory?: MemoryConfig } | undefined)?.memory

  // Pull mutation
  const pullMutation = useMutation({
    mutationFn: () => syncMemoryPull(squadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.memory.syncStatus(squadId) })
    },
  })

  // Push mutation
  const pushMutation = useMutation({
    mutationFn: () => syncMemoryPush(squadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.memory.syncStatus(squadId) })
    },
  })

  // Add provider mutation
  const addProviderMutation = useMutation({
    mutationFn: async (provider: GitSyncProvider) => {
      const currentMetadata = (squad?.metadata as Record<string, unknown>) || {}
      const currentMemory = (currentMetadata.memory as MemoryConfig) || { enabled: true }
      const currentSync = currentMemory.sync || { providers: [], conflictPolicy: 'manual' as const }

      return updateSquad(squadId, {
        metadata: {
          ...currentMetadata,
          memory: {
            ...currentMemory,
            sync: {
              ...currentSync,
              providers: [...currentSync.providers, provider],
            },
          },
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.memory.syncStatus(squadId) })
      setShowAddProvider(false)
      resetForm()
      // Auto-initialize by triggering a pull (which clones the repo if needed)
      pullMutation.mutate()
    },
  })

  // Update provider mutation (replaces provider at index)
  const updateProviderMutation = useMutation({
    mutationFn: async ({ index, provider }: { index: number; provider: GitSyncProvider | S3SyncProvider }) => {
      const currentMetadata = (squad?.metadata as Record<string, unknown>) || {}
      const currentMemory = (currentMetadata.memory as MemoryConfig) || { enabled: true }
      const currentSync = currentMemory.sync || { providers: [], conflictPolicy: 'manual' as const }

      const newProviders = [...currentSync.providers]
      newProviders[index] = provider

      return updateSquad(squadId, {
        metadata: {
          ...currentMetadata,
          memory: {
            ...currentMemory,
            sync: {
              ...currentSync,
              providers: newProviders,
            },
          },
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.memory.syncStatus(squadId) })
      setEditingIndex(null)
      resetForm()
    },
  })

  // Remove provider mutation
  const removeProviderMutation = useMutation({
    mutationFn: async (index: number) => {
      const currentMetadata = (squad?.metadata as Record<string, unknown>) || {}
      const currentMemory = (currentMetadata.memory as MemoryConfig) || { enabled: true }
      const currentSync = currentMemory.sync || { providers: [], conflictPolicy: 'manual' as const }

      const newProviders = currentSync.providers.filter((_, i) => i !== index)

      return updateSquad(squadId, {
        metadata: {
          ...currentMetadata,
          memory: {
            ...currentMemory,
            sync: {
              ...currentSync,
              providers: newProviders,
            },
          },
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.memory.syncStatus(squadId) })
    },
  })

  const resetForm = () => {
    setGitRepoUrl('')
    setGitBranch('main')
    setGitSshKeyName('')
    setGitAutoPull(true)
    setGitAutoPush(true)
    setEditingIndex(null)
  }

  const startEditing = (index: number) => {
    const providers = memoryConfig?.sync?.providers || []
    const provider = providers[index]
    if (!provider) return

    setEditingIndex(index)
    setShowAddProvider(false)
    setProviderType(provider.type)

    if (provider.type === 'git') {
      setGitRepoUrl(provider.repoUrl)
      setGitBranch(provider.branch)
      setGitSshKeyName(provider.sshKeyName)
      setGitAutoPull(provider.autoPull)
      setGitAutoPush(provider.autoPush)
    }
  }

  const handleSubmitGitProvider = (e: React.FormEvent) => {
    e.preventDefault()
    if (!gitRepoUrl || !gitSshKeyName) return

    const provider: GitSyncProvider = {
      type: 'git',
      repoUrl: gitRepoUrl,
      branch: gitBranch,
      sshKeyName: gitSshKeyName,
      autoPull: gitAutoPull,
      autoPush: gitAutoPush,
    }

    if (editingIndex !== null) {
      updateProviderMutation.mutate({ index: editingIndex, provider })
    } else {
      addProviderMutation.mutate(provider)
    }
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never'
    const date = new Date(dateStr)
    return date.toLocaleString()
  }

  // Check if memory is enabled
  if (!memoryConfig?.enabled) {
    return (
      <div data-setting-target="memory-sync" className="text-sm text-muted py-4">
        Enable memory system to configure sync
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 data-setting-target="memory-sync" className="text-sm font-medium text-primary">
            Memory Sync
          </h3>
          <p className="text-xs text-muted mt-1">Sync memory with external Git repositories or S3 buckets.</p>
        </div>
        {!showAddProvider && editingIndex === null && canWriteMemory && (
          <button
            onClick={() => setShowAddProvider(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md font-medium bg-accent text-on-accent hover:bg-accent/90 transition-colors"
          >
            Add Provider
          </button>
        )}
      </div>

      {/* Sync Status */}
      {statusLoading ? (
        <CollectionSkeleton label="Loading memory sync status" count={providerSkeletonCount} />
      ) : syncStatus && syncStatus.providers.length > 0 ? (
        <div className="space-y-3 mb-4">
          {syncStatus.providers.map((provider, index) => (
            <div key={index} className="border-b border-panel-border last:border-b-0 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className={clsx(
                      'w-2 h-2 rounded-full',
                      provider.initialized ? 'bg-status-success-500' : 'bg-status-review-500'
                    )}
                  />
                  <span className="text-sm font-medium text-primary capitalize">{provider.type} Provider</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => startEditing(index)}
                    disabled={editingIndex !== null || showAddProvider || !canWriteMemory}
                    className="ficus-button text-xs text-accent-light hover:underline disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeProviderMutation.mutate(index)}
                    disabled={removeProviderMutation.isPending || !canWriteMemory}
                    className="ficus-button text-xs text-status-danger-500 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                <div>Last Pull: {formatDate(provider.lastPull)}</div>
                <div>Last Push: {formatDate(provider.lastPush)}</div>
              </div>
              {provider.error && <p className="text-xs text-status-danger-500 mt-2">{provider.error}</p>}
            </div>
          ))}

          {/* Manual Sync Buttons */}
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={() => pullMutation.mutate()}
              disabled={pullMutation.isPending || !canWriteMemory}
              className={clsx(
                'ficus-button',
                'flex-1 px-3 py-2 text-sm rounded-md font-medium transition-colors border',
                pullMutation.isPending || !canWriteMemory
                  ? 'bg-surface-secondary text-muted cursor-not-allowed border-th-border'
                  : 'border-th-border text-secondary hover:bg-surface-hover'
              )}
            >
              {pullMutation.isPending ? 'Pulling...' : '↓ Pull'}
            </button>
            <button
              onClick={() => pushMutation.mutate()}
              disabled={pushMutation.isPending || !canWriteMemory}
              className={clsx(
                'ficus-button',
                'flex-1 px-3 py-2 text-sm rounded-md font-medium transition-colors border',
                pushMutation.isPending || !canWriteMemory
                  ? 'bg-surface-secondary text-muted cursor-not-allowed border-th-border'
                  : 'border-th-border text-secondary hover:bg-surface-hover'
              )}
            >
              {pushMutation.isPending ? 'Pushing...' : '↑ Push'}
            </button>
          </div>

          {pullMutation.isSuccess && (
            <p className="text-xs text-status-success-600 dark:text-status-success-400">
              ✓ Pulled {pullMutation.data.filesChanged || 0} files
              {pullMutation.data.conflicts?.length ? ` (${pullMutation.data.conflicts.length} conflicts)` : ''}
            </p>
          )}
          {pullMutation.isError && (
            <p className="text-xs text-status-danger-500">Pull failed: {String(pullMutation.error)}</p>
          )}
          {pushMutation.isSuccess && (
            <p className="text-xs text-status-success-600 dark:text-status-success-400">
              ✓ Pushed {pushMutation.data.filesPushed || 0} files
            </p>
          )}
          {pushMutation.isError && (
            <p className="text-xs text-status-danger-500">Push failed: {String(pushMutation.error)}</p>
          )}
        </div>
      ) : !showAddProvider ? (
        <div className="text-sm text-muted py-4 text-center border border-dashed border-th-border rounded-lg mb-4">
          No sync providers configured
        </div>
      ) : null}

      {/* Add/Edit Provider Form */}
      {(showAddProvider || editingIndex !== null) && (
        <div className="border-b border-panel-border last:border-b-0 p-4">
          <h4 className="text-sm font-medium text-primary mb-3">
            {editingIndex !== null ? 'Edit Sync Provider' : 'Add Sync Provider'}
          </h4>

          {/* Provider Type Tabs (only when adding) */}
          {editingIndex === null && (
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setProviderType('git')}
                className={clsx(
                  'ficus-button',
                  'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                  providerType === 'git'
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface text-secondary hover:bg-surface-hover'
                )}
              >
                Git
              </button>
              <button
                onClick={() => setProviderType('s3')}
                className={clsx(
                  'ficus-button',
                  'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                  providerType === 's3'
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface text-secondary hover:bg-surface-hover'
                )}
              >
                S3
              </button>
            </div>
          )}

          {providerType === 'git' ? (
            <form onSubmit={handleSubmitGitProvider} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">
                  Repository URL <span className="text-status-danger-500">*</span>
                </label>
                <input
                  type="text"
                  value={gitRepoUrl}
                  onChange={(e) => setGitRepoUrl(e.target.value)}
                  placeholder="git@github.com:org/repo.git"
                  className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Branch</label>
                <input
                  type="text"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                  placeholder="main"
                  className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-secondary mb-1">
                  SSH Key <span className="text-status-danger-500">*</span>
                </label>
                {sshKeys.length > 0 ? (
                  <select
                    value={gitSshKeyName}
                    onChange={(e) => setGitSshKeyName(e.target.value)}
                    className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary  focus:ring-2 focus:ring-accent/50"
                  >
                    <option value="">Select SSH key...</option>
                    {sshKeys.map((key) => (
                      <option key={key.name} value={key.name}>
                        {key.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-muted py-2">
                    No SSH keys configured. Add one in the SSH Keys section above.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={gitAutoPull}
                    onChange={(e) => setGitAutoPull(e.target.checked)}
                    className="rounded border-th-border text-accent-light focus:ring-accent"
                  />
                  <span className="text-sm text-secondary">Auto-pull on webhook</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={gitAutoPush}
                    onChange={(e) => setGitAutoPush(e.target.checked)}
                    className="rounded border-th-border text-accent-light focus:ring-accent"
                  />
                  <span className="text-sm text-secondary">Auto-push on write</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddProvider(false)
                    resetForm()
                  }}
                  className="ficus-button px-3 py-1.5 text-sm rounded-md font-medium text-secondary hover:bg-surface-hover"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    !gitRepoUrl ||
                    !gitSshKeyName ||
                    addProviderMutation.isPending ||
                    updateProviderMutation.isPending ||
                    !canWriteMemory
                  }
                  className={clsx(
                    'ficus-button',
                    'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
                    gitRepoUrl && gitSshKeyName && canWriteMemory
                      ? 'bg-accent text-on-accent hover:bg-accent/90'
                      : 'bg-surface-secondary text-muted cursor-not-allowed'
                  )}
                >
                  {editingIndex !== null
                    ? updateProviderMutation.isPending
                      ? 'Saving...'
                      : 'Save Changes'
                    : addProviderMutation.isPending
                      ? 'Adding...'
                      : 'Add Git Provider'}
                </button>
              </div>

              {addProviderMutation.isError && (
                <p className="text-xs text-status-danger-500 mt-2">
                  Failed to add provider: {String(addProviderMutation.error)}
                </p>
              )}
              {updateProviderMutation.isError && (
                <p className="text-xs text-status-danger-500 mt-2">
                  Failed to update provider: {String(updateProviderMutation.error)}
                </p>
              )}
            </form>
          ) : (
            <div className="text-sm text-muted py-4 text-center">
              S3 provider configuration coming soon.
              <p className="text-xs mt-1">Configure via API for now.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
