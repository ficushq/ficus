import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SquadPresetWorkflows } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { WorkflowPicker } from '../squads/WorkflowPicker'

/** Configure recommendations here; edit the flows themselves in Workflows. */
export function SquadPresetWorkflowsEditor({
  value,
  onChange,
  actions,
}: {
  value: SquadPresetWorkflows | null
  onChange: (value: SquadPresetWorkflows | null) => void
  actions?: ReactNode
}) {
  const catalog = useQuery(queries.workflows.list())
  const entries = (catalog.data ?? []).filter(
    (item) => !item.disabled && (!item.scope || item.scope.kind === 'instance')
  )
  return (
    <section className="min-w-0 space-y-4 border-t border-th-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? {
                      default: { kind: 'preset', id: 'solo', customizations: [] },
                      guidance: '',
                      choices: [],
                    }
                  : null
              )
            }
          />
          Recommend workflows
        </label>
        {actions}
      </div>
      <p className="text-xs text-muted">
        New squads inherit this default and these recommendations. Agents start only when a work stream needs them.
      </p>
      {value && (
        <>
          <WorkflowPicker
            preview={false}
            value={value.default}
            onChange={(source) => onChange({ ...value, default: source })}
          />
          <label className="block text-sm font-medium">
            Guidance for choosing a flow
            <textarea
              className="ficus-field mt-1 w-full"
              rows={3}
              value={value.guidance}
              onChange={(event) => onChange({ ...value, guidance: event.target.value })}
            />
          </label>
          <div className="space-y-3">
            <p className="text-sm font-medium">Recommended alternatives</p>
            {value.choices.map((choice, index) => (
              <div className="space-y-2" key={index}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <WorkflowPicker
                      preview={false}
                      value={choice.source}
                      onChange={(source) =>
                        onChange({
                          ...value,
                          choices: value.choices.map((item, i) => (i === index ? { ...item, source } : item)),
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="ficus-button text-sm text-muted"
                    onClick={() => onChange({ ...value, choices: value.choices.filter((_, i) => i !== index) })}
                  >
                    Remove
                  </button>
                </div>
                <label className="block text-sm">
                  When to use this flow
                  <input
                    className="ficus-field mt-1 w-full"
                    required
                    value={choice.when}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        choices: value.choices.map((item, i) =>
                          i === index ? { ...item, when: event.target.value } : item
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              disabled={!entries.length || value.choices.length >= 32}
              className="ficus-button text-sm text-accent-light"
              onClick={() =>
                onChange({
                  ...value,
                  choices: [
                    ...value.choices,
                    { when: '', source: { kind: 'preset', id: entries[0]!.id, customizations: [] } },
                  ],
                })
              }
            >
              Add alternative
            </button>
          </div>
        </>
      )}
    </section>
  )
}
