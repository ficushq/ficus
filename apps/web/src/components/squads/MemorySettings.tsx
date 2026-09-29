import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad, reindexMemory, type MemoryConfig } from '../../api/squads'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

const EMBEDDING_MODELS = [
  { value: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small (1536 dims)' },
  { value: 'text-embedding-3-large', label: 'OpenAI text-embedding-3-large (3072 dims)' },
  { value: 'text-embedding-ada-002', label: 'OpenAI text-embedding-ada-002 (1536 dims)' },
]

const DEFAULT_WEIGHTS = {
  vector: 0.55,
  keyword: 0.35,
  recency: 0.05,
  linkAuthority: 0.03,
  importance: 0.02,
}

export function MemorySettings({ squadId }: Props) {
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteMemory = !permissionsLoading && can('memory:write')
  const [isEditing, setIsEditing] = useState(false)
  const [showWeights, setShowWeights] = useState(false)

  // Get squad to read memory config from metadata
  const { data: squad, isLoading } = useQuery(queries.squads.basic(squadId))

  const memoryConfig = (squad?.metadata as { memory?: MemoryConfig } | undefined)?.memory || {
    enabled: false,
    embeddingModel: 'text-embedding-3-small',
  }

  // Form state
  const [enabled, setEnabled] = useState(memoryConfig.enabled)
  const [embeddingModel, setEmbeddingModel] = useState(memoryConfig.embeddingModel || 'text-embedding-3-small')

  // Update mutation - only sends changed fields, backend does deep merge
  const updateMutation = useMutation({
    mutationFn: async (config: Partial<MemoryConfig>) => {
      return updateSquad(squadId, {
        metadata: { memory: config },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      setIsEditing(false)
    },
  })

  // Reindex mutation
  const reindexMutation = useMutation({
    mutationFn: () => reindexMemory(squadId, 'all'),
  })

  const handleSave = () => {
    updateMutation.mutate({
      enabled,
      embeddingModel,
    })
  }

  const handleToggleEnabled = () => {
    const newEnabled = !memoryConfig.enabled
    updateMutation.mutate({ enabled: newEnabled })
    setEnabled(newEnabled)
  }

  if (isLoading) {
    return <FormSkeleton label="Loading memory settings" sections={4} />
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 data-setting-fallback="embedding-model" className="text-sm font-medium text-primary">
            Memory Settings
          </h3>
          <p className="text-xs text-muted mt-1">
            Configure the squad's shared memory system for knowledge retention and retrieval.
          </p>
        </div>
      </div>

      {/* Enable/Disable Toggle */}
      <div className="border-b border-panel-border last:border-b-0 flex items-center justify-between p-3 mb-4">
        <div className="flex items-center gap-3">
          <div
            className={clsx(
              'w-8 h-8 rounded flex items-center justify-center',
              memoryConfig.enabled ? 'bg-status-success-100 dark:bg-status-success-900/30' : 'bg-surface-secondary'
            )}
          >
            <svg
              className={clsx(
                'w-4 h-4',
                memoryConfig.enabled ? 'text-status-success-600 dark:text-status-success-400' : 'text-muted'
              )}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <span className="text-sm font-medium text-primary">Memory System</span>
            <p className="text-xs text-muted">
              {memoryConfig.enabled ? 'Memory is enabled for this squad' : 'Memory is disabled'}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggleEnabled}
          disabled={updateMutation.isPending || !canWriteMemory}
          className={clsx(
            'ficus-button',
            'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out  focus:ring-2 focus:ring-accent focus:ring-offset-2',
            memoryConfig.enabled ? 'bg-accent' : 'bg-th-border'
          )}
        >
          <span
            className={clsx(
              'pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out',
              // On the accent track the thumb takes the on-accent ink, like text on an accent button.
              memoryConfig.enabled ? 'translate-x-5 bg-on-accent' : 'translate-x-0 bg-chrome-toggle-thumb'
            )}
          />
        </button>
      </div>

      {memoryConfig.enabled && (
        <>
          {/* Embedding Model Selection */}
          <div className="border-b border-panel-border last:border-b-0 p-3 mb-4">
            <div className="flex items-center justify-between mb-2">
              <label data-setting-target="embedding-model" className="text-sm font-medium text-primary">
                Embedding Model
              </label>
              {!isEditing && canWriteMemory && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="ficus-button text-xs text-accent-light hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {isEditing ? (
              <div className="space-y-3">
                <select
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary  focus:ring-2 focus:ring-accent/50"
                >
                  {EMBEDDING_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setIsEditing(false)
                      setEmbeddingModel(memoryConfig.embeddingModel || 'text-embedding-3-small')
                    }}
                    className="ficus-button px-3 py-1.5 text-sm rounded-md text-secondary hover:bg-surface-hover"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={updateMutation.isPending || !canWriteMemory}
                    className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md bg-accent text-on-accent hover:bg-accent/90"
                  >
                    {updateMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-secondary">
                {EMBEDDING_MODELS.find((m) => m.value === memoryConfig.embeddingModel)?.label ||
                  memoryConfig.embeddingModel}
              </p>
            )}
          </div>

          {/* Ranking Weights (Collapsible) */}
          <div className="border-b border-panel-border last:border-b-0 p-3 mb-4">
            <button
              onClick={() => setShowWeights(!showWeights)}
              className="ficus-button flex items-center justify-between w-full text-left"
            >
              <span className="text-sm font-medium text-primary">Ranking Weights</span>
              <svg
                className={clsx('w-4 h-4 text-muted transition-transform', showWeights && 'rotate-180')}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showWeights && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted mb-2">Weights for hybrid search ranking. Must sum to 1.0.</p>
                {Object.entries(DEFAULT_WEIGHTS).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-sm text-secondary capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                    <span className="text-sm text-primary font-mono">{value}</span>
                  </div>
                ))}
                <p className="text-xs text-muted mt-2">Custom weights can be configured via API.</p>
              </div>
            )}
          </div>

          {/* Reindex Action */}
          <div className="border-b border-panel-border last:border-b-0 p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-primary">Reindex Memory</span>
                <p className="text-xs text-muted">Rebuild the search index from memory files and agent threads.</p>
              </div>
              <button
                onClick={() => reindexMutation.mutate()}
                disabled={reindexMutation.isPending || !canWriteMemory}
                className={clsx(
                  'ficus-button',
                  'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                  reindexMutation.isPending || !canWriteMemory
                    ? 'bg-surface-secondary text-muted cursor-not-allowed'
                    : 'border border-th-border text-secondary hover:bg-surface-hover'
                )}
              >
                {reindexMutation.isPending ? 'Reindexing...' : 'Reindex'}
              </button>
            </div>
            {reindexMutation.isSuccess && (
              <p className="text-xs text-status-success-600 dark:text-status-success-400 mt-2">
                ✓ Indexed {reindexMutation.data.filesIndexed} memory files
                {reindexMutation.data.workspaceFilesScanned > 0 && (
                  <>, scanned {reindexMutation.data.workspaceFilesScanned} workspace files</>
                )}
                {reindexMutation.data.workspaceFilesScanError && (
                  <>, error scanning workspace files: {reindexMutation.data.workspaceFilesScanError}</>
                )}
              </p>
            )}
            {reindexMutation.isError && (
              <p className="text-xs text-status-danger-500 mt-2">Failed to reindex: {String(reindexMutation.error)}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
