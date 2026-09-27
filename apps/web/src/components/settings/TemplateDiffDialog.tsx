import { useEffect, useMemo } from 'react'
import clsx from 'clsx'
import { diffLines } from 'diff'
import { useStableRef } from '../../hooks/useStableRef'

interface TemplateDiffDialogProps {
  isOpen: boolean
  onClose: () => void
  title: string
  current: Record<string, unknown> | null
  template: Record<string, unknown> | null
  onRevert: () => void
  onRevertFields?: (fields: string[]) => void
  fieldOverrides?: string[]
  isReverting?: boolean
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
    }
    return sorted
  }
  return obj
}

function toFormattedJson(obj: Record<string, unknown> | null): string {
  if (!obj) return ''
  return JSON.stringify(sortKeys(obj), null, 2)
}

export function TemplateDiffDialog({
  isOpen,
  onClose,
  title,
  current,
  template,
  onRevert,
  onRevertFields,
  fieldOverrides = [],
  isReverting,
}: TemplateDiffDialogProps) {
  const onCloseRef = useStableRef(onClose)

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen])

  const diffParts = useMemo(() => {
    if (!current || !template) return null
    return diffLines(toFormattedJson(template), toFormattedJson(current))
  }, [current, template])

  const hasDiff = useMemo(() => {
    if (!diffParts) return false
    return diffParts.some((p) => p.added || p.removed)
  }, [diffParts])

  if (!isOpen) return null

  const handleRevert = () => {
    if (window.confirm('Revert to template? This will overwrite all customizations.')) {
      onRevert()
    }
  }

  const handleRevertField = (field: string) => {
    if (window.confirm(`Revert "${field}" to template?`)) {
      onRevertFields?.([field])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-chrome-scrim/50" onClick={onClose} />
      <div className="ficus-overlay relative bg-surface rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-th-border">
          <h3 className="text-lg font-semibold text-primary">{title}</h3>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded bg-status-danger-100 dark:bg-status-danger-900/40 border border-status-danger-300 dark:border-status-danger-700" />
                Template
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded bg-status-success-100 dark:bg-status-success-900/40 border border-status-success-300 dark:border-status-success-700" />
                Current
              </span>
            </div>
            <button onClick={onClose} className="ficus-button text-muted hover:text-primary text-xl leading-none">
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {fieldOverrides.length > 0 && onRevertFields && (
            <div className="bg-surface-secondary rounded border border-th-border p-3">
              <p className="text-xs font-medium text-primary mb-2">Overridden fields</p>
              <div className="flex flex-wrap gap-2">
                {fieldOverrides.map((field) => (
                  <button
                    key={field}
                    onClick={() => handleRevertField(field)}
                    disabled={isReverting}
                    className="ficus-button text-xs px-2 py-1 rounded bg-status-attention-100 dark:bg-status-attention-900/30 text-status-attention-800 dark:text-status-attention-300 hover:bg-status-attention-200 dark:hover:bg-status-attention-900/50 disabled:opacity-50 font-mono"
                  >
                    Revert {field}
                  </button>
                ))}
              </div>
            </div>
          )}
          {template === null ? (
            <p className="text-muted text-center py-8">No template available — this is a custom entry.</p>
          ) : !diffParts ? (
            <p className="text-muted text-center py-8">Unable to compute diff.</p>
          ) : !hasDiff ? (
            <p className="text-muted text-center py-8">No differences — current config matches template.</p>
          ) : (
            <div className="bg-surface-secondary rounded border border-th-border overflow-auto max-h-[60vh]">
              <pre className="text-xs font-mono p-3 leading-relaxed">
                {diffParts.map((part, i) => {
                  if (!part.added && !part.removed) {
                    // Context lines
                    const lines = part.value.split('\n')
                    // Collapse long unchanged sections
                    if (lines.length > 8) {
                      return (
                        <span key={i}>
                          <span className="text-primary">
                            {lines.slice(0, 3).join('\n')}
                            {'\n'}
                          </span>
                          <span className="text-muted bg-surface px-2 py-0.5 rounded text-xs">
                            ⋯ {lines.length - 6} unchanged lines
                          </span>
                          <span className="text-primary">
                            {'\n'}
                            {lines.slice(-3).join('\n')}
                          </span>
                        </span>
                      )
                    }
                    return (
                      <span key={i} className="text-primary">
                        {part.value}
                      </span>
                    )
                  }

                  return (
                    <span
                      key={i}
                      className={clsx(
                        part.removed &&
                          'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-800 dark:text-status-danger-300',
                        part.added &&
                          'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-800 dark:text-status-success-300'
                      )}
                    >
                      {part.value
                        .split('\n')
                        .filter((line, li, arr) => li < arr.length - 1 || line !== '')
                        .map((line, li) => (
                          <span key={li} className="block">
                            {part.removed ? '- ' : '+ '}
                            {line}
                          </span>
                        ))}
                    </span>
                  )
                })}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-th-border">
          <button onClick={onClose} className="ficus-button text-sm text-muted hover:text-primary px-3 py-1.5">
            Close
          </button>
          {template !== null && (
            <button
              onClick={handleRevert}
              disabled={isReverting || !hasDiff}
              className="ficus-button text-sm bg-status-attention-600 text-on-strong px-4 py-1.5 rounded font-medium hover:bg-status-attention-700 disabled:opacity-50"
            >
              {isReverting ? 'Reverting…' : 'Revert to Template'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
