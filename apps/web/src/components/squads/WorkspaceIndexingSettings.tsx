import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad, type MemoryConfig } from '../../api/squads'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'

interface Props {
  squadId: string
}

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '*.min.js', '*.map']

const SKIP_REASON_LABELS: Record<string, string> = {
  file_too_large: 'Too large (>100KB)',
  binary: 'Binary file',
  max_files_exceeded: 'Pattern file limit (1000)',
  unreadable: 'Unreadable',
}

function ScanStatusDisplay({ scanStatus }: { scanStatus: NonNullable<MemoryConfig['workspaceScanStatus']> }) {
  const [showSkipped, setShowSkipped] = useState(false)
  const skippedByReason = scanStatus.skipped.reduce(
    (acc, s) => {
      acc[s.reason] = (acc[s.reason] || 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  return (
    <div className="border-t border-th-border pt-2 mt-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>
          {scanStatus.filesIndexed} file{scanStatus.filesIndexed !== 1 ? 's' : ''} indexed
        </span>
        {scanStatus.skipped.length > 0 && (
          <>
            <span>·</span>
            <button
              onClick={() => setShowSkipped(!showSkipped)}
              className="ficus-button text-status-attention-600 dark:text-status-attention-400 hover:underline"
            >
              {scanStatus.skipped.length} skipped
            </button>
          </>
        )}
        <span>·</span>
        <span>{new Date(scanStatus.lastScan).toLocaleString()}</span>
      </div>
      {showSkipped && scanStatus.skipped.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {Object.entries(skippedByReason).map(([reason, count]) => (
            <div key={reason} className="text-xs">
              <span className="text-status-attention-600 dark:text-status-attention-400 font-medium">
                {SKIP_REASON_LABELS[reason] || reason}
              </span>
              <span className="text-muted"> ({count})</span>
            </div>
          ))}
          <div className="max-h-32 overflow-y-auto space-y-0.5 mt-1">
            {scanStatus.skipped.map((s, i) => (
              <div key={i} className="text-xs font-mono text-muted truncate" title={s.detail || s.reason}>
                {s.path}
                {s.detail && <span className="text-muted/60"> — {s.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkspaceIndexingSettings({ squadId }: Props) {
  const queryClient = useQueryClient()
  const { data: squad } = useQuery(queries.squads.basic(squadId))

  const memoryConfig = (squad?.metadata as { memory?: MemoryConfig } | undefined)?.memory
  const workspacePaths = memoryConfig?.workspacePaths
  const scanStatus = memoryConfig?.workspaceScanStatus

  const [isEditing, setIsEditing] = useState(false)
  const [includes, setIncludes] = useState<string[]>(workspacePaths?.include ?? [])
  const [excludes, setExcludes] = useState<string[]>(workspacePaths?.exclude ?? [])
  const [newInclude, setNewInclude] = useState('')
  const [newExclude, setNewExclude] = useState('')

  const updateMutation = useMutation({
    mutationFn: async (paths: MemoryConfig['workspacePaths']) => {
      return updateSquad(squadId, {
        metadata: { memory: { workspacePaths: paths } },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      setIsEditing(false)
    },
  })

  const startEditing = () => {
    setIncludes(workspacePaths?.include ?? [])
    setExcludes(workspacePaths?.exclude ?? [])
    setNewInclude('')
    setNewExclude('')
    setIsEditing(true)
  }

  const handleCancel = () => {
    setIsEditing(false)
    setNewInclude('')
    setNewExclude('')
  }

  const handleSave = () => {
    updateMutation.mutate({
      include: includes,
      exclude: excludes.length > 0 ? excludes : undefined,
    })
  }

  const addInclude = () => {
    const v = newInclude.trim()
    if (v && !includes.includes(v)) {
      setIncludes([...includes, v])
      setNewInclude('')
    }
  }

  const addExclude = () => {
    const v = newExclude.trim()
    if (v && !excludes.includes(v) && !DEFAULT_EXCLUDES.includes(v)) {
      setExcludes([...excludes, v])
      setNewExclude('')
    }
  }

  const removeInclude = (index: number) => {
    setIncludes(includes.filter((_, i) => i !== index))
  }

  const removeExclude = (index: number) => {
    setExcludes(excludes.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      action()
    }
  }

  return (
    <div className="border-b border-panel-border last:border-b-0 p-3">
      <div className="flex items-center justify-between mb-2">
        <label data-setting-target="workspace-indexing" className="text-sm font-medium text-primary">
          Workspace Indexing
        </label>
        {!isEditing && (
          <button
            data-setting-reveal="include-patterns exclude-patterns"
            onClick={startEditing}
            className="ficus-button text-xs text-accent-light hover:underline"
          >
            Edit
          </button>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Glob patterns relative to the workspace root. Matched files are indexed into memory for search.
          </p>

          {/* Include Patterns */}
          <div>
            <label data-setting-target="include-patterns" className="text-xs font-medium text-secondary block mb-1">
              Include Patterns
            </label>
            <div className="space-y-1 mb-2">
              {includes.map((pattern, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  <span className="text-sm font-mono text-primary flex-1">{pattern}</span>
                  <button
                    onClick={() => removeInclude(i)}
                    className="ficus-button text-xs text-muted hover:text-status-danger-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newInclude}
                onChange={(e) => setNewInclude(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, addInclude)}
                placeholder="e.g. docs/**/*.md"
                className="ficus-field flex-1 px-2 py-1.5 text-sm font-mono rounded-md border border-th-border bg-surface text-primary placeholder:text-muted  focus:ring-2 focus:ring-accent/50"
              />
              <button
                onClick={addInclude}
                disabled={!newInclude.trim()}
                className={clsx(
                  'ficus-button',
                  'px-2 py-1.5 text-sm rounded-md',
                  newInclude.trim() ? 'text-accent-light hover:bg-surface-hover' : 'text-muted cursor-not-allowed'
                )}
              >
                Add
              </button>
            </div>
          </div>

          {/* Exclude Patterns */}
          <div>
            <label data-setting-target="exclude-patterns" className="text-xs font-medium text-secondary block mb-1">
              Exclude Patterns
            </label>
            {/* Default excludes */}
            <div className="space-y-1 mb-2">
              {DEFAULT_EXCLUDES.map((pattern) => (
                <div key={pattern} className="flex items-center gap-2">
                  <span className="text-sm font-mono text-muted">{pattern}</span>
                  <span className="text-xs text-muted">(default)</span>
                </div>
              ))}
            </div>
            {/* Custom excludes */}
            <div className="space-y-1 mb-2">
              {excludes.map((pattern, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  <span className="text-sm font-mono text-primary flex-1">{pattern}</span>
                  <button
                    onClick={() => removeExclude(i)}
                    className="ficus-button text-xs text-muted hover:text-status-danger-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newExclude}
                onChange={(e) => setNewExclude(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, addExclude)}
                placeholder="e.g. tmp/**"
                className="ficus-field flex-1 px-2 py-1.5 text-sm font-mono rounded-md border border-th-border bg-surface text-primary placeholder:text-muted  focus:ring-2 focus:ring-accent/50"
              />
              <button
                onClick={addExclude}
                disabled={!newExclude.trim()}
                className={clsx(
                  'ficus-button',
                  'px-2 py-1.5 text-sm rounded-md',
                  newExclude.trim() ? 'text-accent-light hover:bg-surface-hover' : 'text-muted cursor-not-allowed'
                )}
              >
                Add
              </button>
            </div>
          </div>

          {/* Save/Cancel */}
          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancel}
              className="ficus-button px-3 py-1.5 text-sm rounded-md text-secondary hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={updateMutation.isPending}
              className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md bg-accent text-on-accent hover:bg-accent/90"
            >
              {updateMutation.isPending ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div>
          {workspacePaths && workspacePaths.include.length > 0 ? (
            <div className="space-y-2">
              <div>
                <span className="text-xs text-muted">Include:</span>
                <div className="space-y-0.5 mt-0.5">
                  {workspacePaths.include.map((p, i) => (
                    <p key={i} className="text-sm font-mono text-secondary">
                      {p}
                    </p>
                  ))}
                </div>
              </div>
              {workspacePaths.exclude && workspacePaths.exclude.length > 0 && (
                <div>
                  <span className="text-xs text-muted">Custom excludes:</span>
                  <div className="space-y-0.5 mt-0.5">
                    {workspacePaths.exclude.map((p, i) => (
                      <p key={i} className="text-sm font-mono text-secondary">
                        {p}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {scanStatus && <ScanStatusDisplay scanStatus={scanStatus} />}
            </div>
          ) : (
            <p className="text-sm text-muted">No workspace paths configured</p>
          )}
        </div>
      )}
    </div>
  )
}
