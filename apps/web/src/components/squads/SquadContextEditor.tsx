import { useState, useCallback, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'

interface Props {
  squadId: string
  context: string | null
}

export function SquadContextEditor({ squadId, context }: Props) {
  const [value, setValue] = useState(context ?? '')
  const [saved, setSaved] = useState(false)
  const queryClient = useQueryClient()

  // Sync when prop changes (e.g. from another tab)
  useEffect(() => {
    setValue(context ?? '')
  }, [context])

  const dirty = value !== (context ?? '')

  const mutation = useMutation({
    mutationFn: (newContext: string) => updateSquad(squadId, { context: newContext || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
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

  return (
    <div>
      <div className="mb-3">
        <h3 data-setting-target="squad-context" className="text-sm font-medium text-primary">
          Squad Context
        </h3>
        <p className="text-xs text-muted mt-1">
          Custom instructions injected into every agent's system prompt. Use this for project-specific conventions,
          codebase details, or workflow preferences.
        </p>
      </div>

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add context for this squad's agents...&#10;&#10;e.g. project conventions, repo structure, coding standards, deployment notes..."
        className={clsx(
          'ficus-field',
          'w-full h-80 p-3 rounded-lg border bg-surface text-primary text-sm',
          'font-mono leading-relaxed resize-y',
          'placeholder:text-placeholder',
          ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
          dirty ? 'border-status-review-500 dark:border-status-review-400' : 'border-th-border'
        )}
      />

      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : saved ? '✓ Saved' : 'Ctrl+S to save'}</span>
        <button
          onClick={handleSave}
          disabled={!dirty || mutation.isPending}
          className={clsx(
            'ficus-button ficus-button-primary',
            'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
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
