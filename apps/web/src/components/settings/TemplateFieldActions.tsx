import { useMemo, useState } from 'react'
import { diffLines } from 'diff'
import clsx from 'clsx'

interface TemplateFieldActionsProps {
  field: string
  current: Record<string, unknown> | null
  template: Record<string, unknown> | null
  fieldOverrides: string[]
  onRevert: (field: string) => void
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

function toFormattedValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(sortKeys(value), null, 2)
}

function ruleKey(rule: Record<string, unknown>): string {
  return String(rule.id ?? rule.event ?? '*')
}

function getTemplateValue(obj: Record<string, unknown> | null, field: string): unknown {
  if (!obj) return undefined
  if (field.startsWith('channels.')) {
    const channel = field.slice('channels.'.length)
    return (obj.channels as Record<string, unknown> | undefined)?.[channel]
  }
  if (field.startsWith('rules.')) {
    const key = field.slice('rules.'.length)
    return ((obj.rules as Record<string, unknown>[] | undefined) ?? []).find((rule) => ruleKey(rule) === key)
  }
  return obj[field]
}

export function TemplateFieldActions({
  field,
  current,
  template,
  fieldOverrides,
  onRevert,
  isReverting,
}: TemplateFieldActionsProps) {
  const [isDiffOpen, setIsDiffOpen] = useState(false)
  const currentValue = getTemplateValue(current, field)
  const templateValue = getTemplateValue(template, field)
  const isOverridden = fieldOverrides.includes(field)

  const diffParts = useMemo(() => {
    if (template === null) return []
    return diffLines(toFormattedValue(templateValue), toFormattedValue(currentValue))
  }, [currentValue, template, templateValue])

  const hasDiff = diffParts.some((part) => part.added || part.removed)
  if (!hasDiff && !isOverridden) return null

  const handleRevert = () => {
    if (window.confirm(`Revert "${field}" to template?`)) onRevert(field)
  }

  return (
    <span className="inline-flex items-center gap-1">
      {hasDiff && (
        <button
          type="button"
          onClick={() => setIsDiffOpen(true)}
          className="ficus-button ficus-button-link text-[11px]"
        >
          Diff
        </button>
      )}
      {isOverridden && (
        <button
          type="button"
          onClick={handleRevert}
          disabled={isReverting}
          className="ficus-button ficus-button-link text-[11px] text-status-attention-600 dark:text-status-attention-400 hover:text-status-attention-800 dark:hover:text-status-attention-300 disabled:opacity-50"
        >
          Revert
        </button>
      )}
      {isDiffOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-chrome-scrim/50" onClick={() => setIsDiffOpen(false)} />
          <div className="ficus-overlay relative bg-surface rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[75vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-th-border">
              <h3 className="text-base font-semibold text-primary">Template Diff — {field}</h3>
              <button
                onClick={() => setIsDiffOpen(false)}
                className="ficus-button ficus-button-ghost text-xl leading-none"
              >
                ✕
              </button>
            </div>
            <div className="overflow-auto p-4">
              <pre className="text-xs font-mono bg-surface-secondary rounded border border-th-border p-3 leading-relaxed whitespace-pre-wrap">
                {diffParts.map((part, index) => (
                  <span
                    key={index}
                    className={clsx(
                      part.removed &&
                        'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-800 dark:text-status-danger-300',
                      part.added &&
                        'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-800 dark:text-status-success-300',
                      !part.added && !part.removed && 'text-primary'
                    )}
                  >
                    {part.value}
                  </span>
                ))}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-th-border">
              {isOverridden && (
                <button
                  onClick={handleRevert}
                  disabled={isReverting}
                  className="ficus-button ficus-button-primary text-sm bg-status-attention-600 text-on-strong px-4 py-1.5 rounded font-medium hover:bg-status-attention-700 disabled:opacity-50"
                >
                  Revert Field
                </button>
              )}
              <button
                onClick={() => setIsDiffOpen(false)}
                className="ficus-button ficus-button-secondary text-sm px-3 py-1.5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  )
}
