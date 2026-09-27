import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { IntegrationSubscription, WorkflowDefinition } from '@ficus/shared'
import { integrationQueries } from '../../queryOptions'

const field = 'ficus-field w-full min-w-0 rounded-md border border-th-border bg-surface px-3 py-2 text-sm'
export function WorkflowEventEditor({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition
  onChange: (definition: WorkflowDefinition) => void
}) {
  const catalog = useQuery(integrationQueries.outputs())
  const [source, setSource] = useState('')
  const outputs = Array.isArray(catalog.data) ? catalog.data : []
  const edit = (index: number, update: (subscription: IntegrationSubscription) => void) => {
    const draft = structuredClone(definition)
    update(draft.subscriptions![index]!)
    onChange(draft)
  }
  return (
    <section className="space-y-3 border-t border-th-border pt-4" aria-label="Integration events">
      <h4 className="font-medium">Integration events</h4>
      <p className="text-xs text-muted">
        Match events to work stream metadata and choose who receives them. Events notify participants without advancing
        the flow.
      </p>
      <div className="rounded-lg border border-th-border p-3 space-y-2">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={definition.completion.followChanges ?? false}
            onChange={(event) =>
              onChange({ ...definition, completion: { ...definition.completion, followChanges: event.target.checked } })
            }
          />
          <span>
            <span className="block font-medium">Code hosting</span>
            <span className="block text-xs text-muted mt-1">
              Send updates from linked pull requests and issues to the selected workflow recipient, or the delivery
              owner by default.
            </span>
          </span>
        </label>
        <p className="text-xs text-muted">
          Includes PR comments, reviews, CI, and merges, plus issue comments, edits, and assignment changes. Uses the
          stream’s linked resources and authorized account. GitHub is supported today; no individual event rules are
          needed.
        </p>
        {definition.completion.followChanges && (
          <label className="block text-sm">
            Send code hosting events to
            <select
              aria-label="Code hosting recipient"
              className={`${field} mt-1`}
              value={
                typeof definition.completion.changeEventsTo === 'object'
                  ? `step:${definition.completion.changeEventsTo.step}`
                  : 'delivery-owner'
              }
              onChange={(event) =>
                onChange({
                  ...definition,
                  completion: {
                    ...definition.completion,
                    changeEventsTo:
                      event.target.value === 'delivery-owner'
                        ? 'delivery-owner'
                        : { step: event.target.value.slice(5) },
                  },
                })
              }
            >
              <option value="delivery-owner">Delivery owner (automatic)</option>
              {definition.steps
                .filter((step) => step.kind === 'agent')
                .map((step) => (
                  <option key={step.id} value={`step:${step.id}`}>
                    {step.id}
                  </option>
                ))}
            </select>
            <span className="block mt-1 text-xs text-muted">
              Or drag the Code hosting handle to an agent step. Events are retained when its agent cannot receive them;
              they do not start a future step.
            </span>
          </label>
        )}
      </div>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced event configuration</summary>
        <h5 className="text-sm font-medium">Custom integration events</h5>
        <p className="text-xs text-muted">
          Configure individual events such as Linear issue assigned. Code hosting already bundles linked PR and issue
          events; configure those here only when you need a specific event or matching rule.
        </p>
        {(definition.subscriptions ?? []).map((subscription, index) => {
          const descriptor = outputs.find(
            (item) =>
              item.integration === subscription.source.integration &&
              item.output === subscription.source.output &&
              item.version === subscription.source.version
          )
          const to = subscription.deliver.to
          return (
            <div key={subscription.id} className="space-y-3 rounded-lg border border-th-border p-3">
              <div className="flex items-start justify-between gap-2">
                <h5 className="text-sm">
                  {descriptor?.title ?? `${subscription.source.integration} · ${subscription.source.output}`}
                </h5>
                <button
                  type="button"
                  className="text-xs text-muted"
                  onClick={() =>
                    onChange({ ...definition, subscriptions: definition.subscriptions!.filter((_, i) => i !== index) })
                  }
                >
                  Remove event
                </button>
              </div>
              {descriptor?.description && <p className="text-xs text-muted">{descriptor.description}</p>}
              <label className="block text-sm">
                Send to
                <span className="block text-xs text-muted mb-1">
                  Active participants means all currently active consumers. Delivery owner is the participant
                  responsible for final delivery. A named step or participant targets just that consumer.
                </span>
                <select
                  className={field}
                  value={
                    typeof to === 'string' ? to : 'step' in to ? `step:${to.step}` : `participant:${to.participant}`
                  }
                  onChange={(event) =>
                    edit(index, (draft) => {
                      const value = event.target.value
                      draft.deliver.to = value.startsWith('step:')
                        ? { step: value.slice(5) }
                        : value.startsWith('participant:')
                          ? { participant: value.slice(12) }
                          : (value as 'active' | 'delivery-owner')
                    })
                  }
                >
                  <option value="active">Active participants</option>
                  <option value="delivery-owner">Delivery owner</option>
                  {definition.steps
                    .filter((step) => step.kind === 'agent')
                    .map((step) => (
                      <option key={step.id} value={`step:${step.id}`}>
                        Step: {step.id}
                      </option>
                    ))}
                  {Object.keys(definition.participants).map((id) => (
                    <option key={id} value={`participant:${id}`}>
                      Participant: {id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                When inactive
                <span className="block text-xs text-muted mb-1">
                  Keep the event until its consumer runs, or send it to the squad manager. An event does not start a
                  future agent.
                </span>
                <select
                  className={field}
                  value={subscription.deliver.whenInactive}
                  onChange={(event) =>
                    edit(index, (draft) => {
                      draft.deliver.whenInactive = event.target.value as 'retain' | 'manager'
                    })
                  }
                >
                  <option value="retain">Keep for the next active attempt</option>
                  <option value="manager">Notify the squad manager</option>
                </select>
              </label>
              {Object.entries(subscription.match).map(([path, binding]) => (
                <div key={path} className="space-y-2 border-l border-th-border pl-3">
                  <div className="flex justify-between gap-2">
                    <span className="text-sm">{path}</span>
                    <button
                      type="button"
                      className="text-xs text-muted"
                      disabled={Object.keys(subscription.match).length === 1}
                      onClick={() =>
                        edit(index, (draft) => {
                          delete draft.match[path]
                        })
                      }
                    >
                      Remove match
                    </button>
                  </div>
                  <label className="block text-xs text-muted">
                    Match against
                    <span className="block text-xs text-muted mb-1">
                      Compare this event field to a work stream metadata value or to a fixed value. Every match must
                      pass.
                    </span>
                    <select
                      className={field}
                      value={'streamMetadata' in binding ? 'metadata' : 'value'}
                      onChange={(event) =>
                        edit(index, (draft) => {
                          const type = descriptor?.fields[path]?.type
                          draft.match[path] =
                            event.target.value === 'metadata'
                              ? { streamMetadata: path }
                              : { value: type === 'boolean' ? true : type === 'number' ? 0 : '' }
                        })
                      }
                    >
                      <option value="metadata">Work stream metadata</option>
                      <option value="value">A fixed value</option>
                    </select>
                  </label>
                  <label className="block text-xs text-muted">
                    {'streamMetadata' in binding ? 'Metadata path' : 'Value'}
                    <span className="block text-xs text-muted mb-1">
                      {'streamMetadata' in binding
                        ? 'A dot-separated path on the work stream, for example github.pr.number. Missing metadata leaves this event unbound.'
                        : `Must match the event field’s ${descriptor?.fields[path]?.type ?? 'declared'} type.`}
                    </span>
                    <input
                      className={field}
                      value={'streamMetadata' in binding ? binding.streamMetadata : String(binding.value)}
                      onChange={(event) =>
                        edit(index, (draft) => {
                          const value = event.target.value
                          draft.match[path] =
                            'streamMetadata' in binding
                              ? { streamMetadata: value }
                              : {
                                  value:
                                    typeof binding.value === 'number'
                                      ? Number(value)
                                      : typeof binding.value === 'boolean'
                                        ? value === 'true'
                                        : value,
                                }
                        })
                      }
                    />
                  </label>
                </div>
              ))}
              {descriptor && (
                <label className="block text-sm">
                  Add a match
                  <span className="block text-xs text-muted mb-1">
                    Choose another typed event field to narrow which updates belong to this work stream.
                  </span>
                  <select
                    className={field}
                    value=""
                    onChange={(event) => {
                      if (event.target.value)
                        edit(index, (draft) => {
                          draft.match[event.target.value] = { streamMetadata: event.target.value }
                        })
                    }}
                  >
                    <option value="">Choose an event field…</option>
                    {Object.entries(descriptor.fields)
                      .filter(([path]) => !subscription.match[path])
                      .map(([path, field]) => (
                        <option key={path} value={path}>
                          {path} — {field.description}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          )
        })}
        {catalog.isError ? (
          <p role="alert" className="text-sm text-danger">
            Could not load integration events.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="min-w-0 flex-1 text-sm">
              Event
              <span className="block text-xs text-muted mb-1">
                Select an output supplied by an installed integration. Its fields determine which metadata you can
                match.
              </span>
              <select className={field} value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="">Choose an integration event…</option>
                {outputs.map((output, index) => (
                  <option key={`${output.integration}:${output.output}:${output.version}`} value={index}>
                    {output.integration} · {output.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ficus-button px-3 py-2 text-sm text-accent-light"
              disabled={!source || (definition.subscriptions?.length ?? 0) >= 32}
              onClick={() => {
                const output = outputs[Number(source)]
                if (!output) return
                let i = 1
                while (definition.subscriptions?.some((item) => item.id === `event-${i}`)) i++
                const path = Object.keys(output.fields)[0] ?? 'resource'
                onChange({
                  ...definition,
                  subscriptions: [
                    ...(definition.subscriptions ?? []),
                    {
                      id: `event-${i}`,
                      source: { integration: output.integration, output: output.output, version: output.version },
                      match: { [path]: { streamMetadata: path } },
                      deliver: { to: 'active', whenInactive: 'retain' },
                    },
                  ],
                })
                setSource('')
              }}
            >
              Add event
            </button>
          </div>
        )}
      </details>
    </section>
  )
}
