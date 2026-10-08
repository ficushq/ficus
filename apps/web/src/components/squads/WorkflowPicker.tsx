import { useQuery } from '@tanstack/react-query'
import { resolveWorkflow, type WorkflowDefinition, type WorkflowSource } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { WorkflowGraph } from '../WorkflowGraph'

/** Squad settings select existing flows; their definitions are managed in Administration. */
export function WorkflowPicker({
  squadId,
  value,
  onChange,
  disabled,
  preview = true,
  onUseSquadDefault,
  onCustomize,
}: {
  squadId?: string
  value?: WorkflowSource
  onChange: (source: WorkflowSource) => void
  disabled?: boolean
  preview?: boolean
  onUseSquadDefault?: () => void
  /**
   * Offer custom flows: a "Custom workflow…" choice (called with undefined for
   * a blank draft), "Customize" on a selected preset (called with a detached
   * copy of its resolved definition), and "Edit custom flow" on an inline
   * value. The caller opens the editor and sets the resulting inline source.
   */
  onCustomize?: (definition: WorkflowDefinition | undefined) => void
}) {
  const catalog = useQuery(queries.workflows.list())
  const entries = (catalog.data ?? []).filter(
    (entry) =>
      !entry.disabled &&
      (!entry.scope ||
        entry.scope.kind === 'instance' ||
        (entry.scope.kind === 'squad' && entry.scope.squadId === squadId))
  )
  const selected = value?.kind === 'preset' ? catalog.data?.find((entry) => entry.id === value.id) : undefined
  let definition = value?.kind === 'inline' ? value.definition : undefined
  let error: string | undefined
  if (value?.kind === 'preset' && selected) {
    try {
      definition = resolveWorkflow(value, selected).definition
    } catch (cause) {
      error = (cause as Error).message
    }
  }
  return (
    <div className="min-w-0 space-y-3">
      <label className="block text-sm font-medium">
        Workflow
        <select
          className="ficus-field mt-1 w-full min-w-0 rounded-md border border-th-border bg-surface px-3 py-2"
          disabled={disabled || catalog.isPending || catalog.isError}
          value={value?.kind === 'preset' ? value.id : value ? '__inline' : ''}
          onChange={(event) => {
            const next = event.target.value
            if (next === '__custom') return onCustomize?.(undefined)
            if (next === '__inline') return
            if (next) return onChange({ kind: 'preset', id: next, customizations: [] })
            onUseSquadDefault?.()
          }}
        >
          <option value="" disabled={!onUseSquadDefault}>
            {onUseSquadDefault ? 'Use squad default' : 'Choose a workflow'}
          </option>
          {value?.kind === 'inline' && (
            <option value="__inline" disabled={!onCustomize}>
              {value.definition.name} ({onCustomize ? 'custom flow' : 'saved custom flow'})
            </option>
          )}
          {value?.kind === 'preset' && !entries.some((entry) => entry.id === value.id) && (
            <option value={value.id} disabled>
              {selected?.definition.name ?? value.id} (unavailable)
            </option>
          )}
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.definition.name}
            </option>
          ))}
          {onCustomize && <option value="__custom">Custom workflow…</option>}
        </select>
      </label>
      {onCustomize && value?.kind === 'inline' && (
        <button
          type="button"
          className="ficus-button ficus-button-link text-sm"
          disabled={disabled}
          onClick={() => onCustomize(structuredClone(value.definition))}
        >
          Edit custom flow
        </button>
      )}
      {onCustomize && value?.kind === 'preset' && definition && (
        <button
          type="button"
          className="ficus-button ficus-button-link text-sm"
          disabled={disabled}
          title="Start a custom flow from this preset (it will no longer follow the preset)"
          onClick={() => onCustomize(structuredClone(definition))}
        >
          Customize
        </button>
      )}
      {(catalog.isError || error) && (
        <p role="alert" className="text-xs text-danger">
          {error ?? 'Unable to load workflows.'}
        </p>
      )}
      {preview && definition && <WorkflowGraph definition={definition} />}
    </div>
  )
}
