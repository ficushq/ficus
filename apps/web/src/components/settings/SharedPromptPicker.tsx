import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queries } from '../../queryOptions'

/** The subset of a shared prompt the picker needs — keeps the view testable without the full record. */
export interface IncludeOption {
  id: string
  name: string
  disabled: boolean
}

/**
 * Ordered editor for an agent type's `includes` list. Order is meaningful —
 * includes are composed into the prompt in list order — so rows carry move
 * up/down controls rather than a checkbox set.
 *
 * Pure: takes the full catalog as a prop so it renders without a query client.
 */
export function SharedPromptPickerView({
  value,
  all,
  onChange,
  actions,
  loading,
}: {
  value: string[]
  all: IncludeOption[]
  onChange: (next: string[]) => void
  actions?: ReactNode
  /**
   * The catalog query is cold when an agent type editor first opens, and an
   * empty catalog makes every configured id look unresolvable. While loading,
   * keep the rows but withhold the `missing` verdict and freeze the controls
   * rather than inviting an edit based on a half-loaded picture.
   */
  loading?: boolean
}) {
  const byId = new Map(all.map((include) => [include.id, include]))
  const selected = new Set(value)
  const addable = all.filter((include) => !include.disabled && !selected.has(include.id))

  const move = (index: number, delta: number) => {
    const next = [...value]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div>
      <label className="text-xs text-muted flex items-center gap-2 mb-1">
        <span>Shared prompts</span>
        {actions}
      </label>
      <div className="border border-th-border rounded bg-surface-secondary p-2 space-y-1">
        {value.length === 0 ? (
          <div className="text-xs text-muted">No includes. This type uses its system prompt alone.</div>
        ) : (
          value.map((id, index) => {
            const include = byId.get(id)
            return (
              <div key={`${id}:${index}`} className="flex items-center gap-2 text-sm text-primary">
                <span className="flex-1 min-w-0 truncate">
                  <span className="font-medium">{include?.name ?? id}</span>{' '}
                  <span className="text-xs text-muted font-mono">{id}</span>
                  {include?.disabled && (
                    <span className="ml-1 text-xs text-status-attention-600 dark:text-status-attention-400">
                      disabled
                    </span>
                  )}
                  {!include && !loading && (
                    <span className="ml-1 text-xs text-status-danger-600 dark:text-status-danger-400">missing</span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Move ${id} up`}
                  disabled={loading || index === 0}
                  onClick={() => move(index, -1)}
                  className="ficus-button ficus-button-ghost text-xs disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label={`Move ${id} down`}
                  disabled={loading || index === value.length - 1}
                  onClick={() => move(index, 1)}
                  className="ficus-button ficus-button-ghost text-xs disabled:opacity-30"
                >
                  ▼
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${id}`}
                  disabled={loading}
                  onClick={() => onChange(value.filter((_entry, position) => position !== index))}
                  className="ficus-button ficus-button-ghost text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300"
                >
                  ✕
                </button>
              </div>
            )
          })
        )}
        <select
          aria-label="Add include"
          value=""
          disabled={loading || addable.length === 0}
          onChange={(event) => {
            if (!event.target.value) return
            onChange([...value, event.target.value])
          }}
          className="ficus-field mt-1 w-full border border-th-border bg-surface px-2 py-1 text-sm"
        >
          <option value="">
            {loading
              ? 'Loading shared prompts…'
              : addable.length
                ? 'Add shared prompt…'
                : 'No more shared prompts available'}
          </option>
          {addable.map((include) => (
            <option key={include.id} value={include.id}>
              {include.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/** `SharedPromptPickerView` bound to the shared-prompt catalog. */
export function SharedPromptPicker({
  value,
  onChange,
  actions,
}: {
  value: string[]
  onChange: (next: string[]) => void
  actions?: ReactNode
}) {
  const { data: includes = [], isPending } = useQuery(queries.sharedPrompts.list())
  return (
    <SharedPromptPickerView value={value} all={includes} onChange={onChange} actions={actions} loading={isPending} />
  )
}
