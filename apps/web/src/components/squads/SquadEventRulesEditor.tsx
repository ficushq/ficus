import { EventRulePredicates } from './EventRulePredicates'
import { EventRulePreview } from './EventRulePreview'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SquadEventRule } from '@ficus/shared'
import { integrationQueries } from '../../queryOptions'
import { WorkflowPicker } from './WorkflowPicker'

export function SquadEventRulesEditor({
  squadId,
  provider,
  value,
  onChange,
  disabled,
  metadata,
}: {
  squadId: string
  provider: string
  value: SquadEventRule[]
  onChange: (rules: SquadEventRule[]) => void
  disabled: boolean
  metadata?: unknown
}) {
  const [labelsText, setLabelsText] = useState<Record<string, string>>({})
  const catalog = useQuery(integrationQueries.outputs())
  const selection = useQuery(integrationQueries.squad(squadId, provider))
  const accounts = selection.data?.attached ?? (selection.data?.assignment ? [selection.data.assignment] : [])
  const events = (catalog.data ?? []).filter((event) => event.integration === provider)
  const update = (index: number, patch: Partial<SquadEventRule>) =>
    onChange(value.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  const move = (index: number, offset: number) => {
    const next = [...value]
    const [rule] = next.splice(index, 1)
    next.splice(index + offset, 0, rule!)
    onChange(next)
  }
  const field = 'ficus-field mt-1 w-full rounded-md border border-panel-border bg-surface px-3 py-2 text-sm'
  return (
    <section className="space-y-3 border-t border-panel-border pt-5" aria-label={`${provider} event rules`}>
      <div>
        <h4 className="font-medium text-primary">Event rules</h4>
        <p className="mt-1 text-xs text-muted">
          Rules run from top to bottom; only the first matching enabled rule acts. All filters within a rule must match.
          Manager and consultant notifications are fallbacks for unlinked events. Events linked to an active or queued
          work stream use only that stream’s subscriptions, including its pause and wait settings.
        </p>
      </div>
      {catalog.isError && (
        <p role="alert" className="text-sm text-status-danger-500">
          Unable to load events.
        </p>
      )}
      {value.map((rule, index) => (
        <fieldset
          key={rule.id}
          disabled={disabled}
          className="min-w-0 rounded-lg border border-panel-border p-3 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) => update(index, { enabled: event.target.checked })}
              />
              Rule {index + 1}
            </label>
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-2 py-1 text-xs disabled:opacity-40"
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={`Move rule ${index + 1} up`}
              >
                Up
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-2 py-1 text-xs disabled:opacity-40"
                disabled={index === value.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`Move rule ${index + 1} down`}
              >
                Down
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-danger px-2 py-1 text-xs"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                aria-label={`Remove rule ${index + 1}`}
              >
                Remove
              </button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              When
              <select
                className={field}
                value={rule.source.output}
                onChange={(event) => {
                  const output = event.target.value
                  update(index, {
                    source: {
                      ...rule.source,
                      output,
                      version: events.find((item) => item.output === output)?.version ?? 1,
                    },
                    match: undefined,
                    predicates: undefined,
                    filters: {
                      ...rule.filters,
                      audience: ['issue.assigned', 'issue.unassigned', 'pull_request.review_requested'].includes(output)
                        ? 'connected-account'
                        : output.includes('comment') || output === 'pull_request.reviewed'
                          ? 'assigned-or-mentioned'
                          : 'any',
                    },
                  })
                }}
              >
                {!events.some((event) => event.output === rule.source.output) && (
                  <option value={rule.source.output}>{rule.source.output}</option>
                )}
                {events.map((event) => (
                  <option key={`${event.output}:${event.version}`} value={event.output}>
                    {event.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Account
              <select
                className={field}
                value={rule.source.connectionId ?? ''}
                onChange={(event) =>
                  update(index, { source: { ...rule.source, connectionId: event.target.value || undefined } })
                }
              >
                <option value="">Any account assigned to this squad</option>
                {rule.source.connectionId &&
                  !accounts.some((connection) => connection.id === rule.source.connectionId) && (
                    <option value={rule.source.connectionId}>Saved account (unavailable)</option>
                  )}
                {accounts.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rule.filters.squadRouting}
              onChange={(event) => update(index, { filters: { ...rule.filters, squadRouting: event.target.checked } })}
            />
            Use shared {provider === 'linear' ? 'team' : 'repository'} scope
          </label>
          <p className="text-xs text-muted">
            {rule.filters.squadRouting
              ? `The event must match the shared ${provider === 'linear' ? 'team' : 'repository'} scope above AND the filters below. An empty shared scope matches nothing.`
              : 'The shared scope above is ignored for this rule. Only the filters below apply, within the connected account’s access.'}{' '}
            Blank filters add no restriction. Multiple labels match if any one is present.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {provider === 'github' && (
              <>
                <label className="text-sm">
                  Repository filter
                  <input
                    className={field}
                    value={rule.filters.repository ?? ''}
                    placeholder="owner/repo or owner/*"
                    onChange={(event) =>
                      update(index, { filters: { ...rule.filters, repository: event.target.value || undefined } })
                    }
                  />
                </label>
                <label className="text-sm">
                  Issue / PR labels (optional)
                  <input
                    className={field}
                    value={labelsText[rule.id] ?? rule.filters.labels?.join(', ') ?? ''}
                    placeholder="Any label"
                    onChange={(event) => {
                      setLabelsText((prior) => ({ ...prior, [rule.id]: event.target.value }))
                      update(index, {
                        filters: {
                          ...rule.filters,
                          labels: event.target.value
                            .split(',')
                            .map((label) => label.trim())
                            .filter(Boolean),
                        },
                      })
                    }}
                  />
                </label>
                <label className="text-sm sm:col-span-2">
                  Account involvement
                  <select
                    className={field}
                    value={rule.filters.audience}
                    onChange={(event) =>
                      update(index, {
                        filters: {
                          ...rule.filters,
                          audience: event.target.value as SquadEventRule['filters']['audience'],
                        },
                      })
                    }
                  >
                    <option value="connected-account">Assigned account or requested reviewer</option>
                    <option value="assigned-or-mentioned">Account is assigned or @mentioned</option>
                    <option value="any">Any matching event</option>
                  </select>
                  <span className="mt-1 block text-xs text-muted">
                    {rule.filters.audience === 'any'
                      ? 'No assignment or mention is required. Bot events can match. Comments and reviews authored by the selected account are always ignored. The other filters still apply.'
                      : rule.filters.audience === 'connected-account' &&
                          rule.source.output === 'pull_request.review_requested'
                        ? 'Match a review requested from the selected account, or a team review request delivered to that connection.'
                        : rule.filters.audience === 'connected-account' &&
                            ['issue.assigned', 'issue.unassigned'].includes(rule.source.output)
                          ? 'Match only when the selected account is the person being assigned or unassigned.'
                          : 'Match when the selected account is an assignee on the issue or PR, or is @mentioned in the event text. Ignore events authored by that account or a bot.'}{' '}
                    With “Any account,” one attached account matching is enough.
                  </span>
                </label>
              </>
            )}
            {provider === 'linear' && (
              <label className="text-sm">
                Team filter
                <input
                  className={field}
                  value={rule.filters.teamId ?? ''}
                  placeholder="Any connected team"
                  onChange={(event) =>
                    update(index, { filters: { ...rule.filters, teamId: event.target.value || undefined } })
                  }
                />
              </label>
            )}
          </div>
          {rule.match && (
            <p className="text-xs text-muted">
              Additional saved filters:{' '}
              {Object.entries(rule.match)
                .map(([key, binding]) => `${key} = ${String(binding.value)}`)
                .join(' · ')}
            </p>
          )}
          <EventRulePredicates
            rule={rule}
            position={index + 1}
            onChange={(predicates) => update(index, { predicates })}
          />
          <label className="block text-sm">
            Then
            <select
              className={field}
              value={rule.action.type}
              onChange={(event) => update(index, { action: { type: event.target.value } as SquadEventRule['action'] })}
            >
              <option value="notify-manager">Notify manager (unlinked events)</option>
              <option value="notify-consultant">Notify new consultant</option>
              <option value="start-workstream">Create work stream</option>
              <option value="ignore">Ignore</option>
            </select>
          </label>
          {rule.action.type === 'notify-manager' && (
            <p className="text-xs text-muted">
              Notify the squad manager only when the event is not already associated with a work stream. Disabling this
              rule does not disable work-stream subscriptions.
            </p>
          )}
          {rule.action.type === 'notify-consultant' && (
            <p className="text-xs text-muted">
              Start a fresh consultant chat only when the event is not already associated with a work stream. Redelivery
              keeps the same chat.
            </p>
          )}
          {rule.action.type === 'start-workstream' && (
            <>
              <WorkflowPicker
                squadId={squadId}
                value={rule.action.workflow}
                disabled={disabled}
                preview={false}
                onChange={(workflow) =>
                  update(index, { action: { ...rule.action, type: 'start-workstream', workflow } })
                }
                onUseSquadDefault={() =>
                  update(index, { action: { ...rule.action, type: 'start-workstream', workflow: undefined } })
                }
              />
              <p className="text-xs text-muted">
                Creates a paused work stream and notifies its owner to prepare the workspace. Workers start only after
                the owner resumes it.
              </p>
            </>
          )}
          {rule.action.type !== 'ignore' && (
            <label className="block text-sm">
              Instructions (optional)
              <textarea
                className={field}
                rows={3}
                maxLength={10000}
                value={rule.action.additionalContext ?? ''}
                placeholder="How should this event be handled?"
                onChange={(event) => {
                  if (rule.action.type === 'ignore') return
                  update(index, {
                    action: {
                      ...rule.action,
                      additionalContext: event.target.value || undefined,
                    },
                  })
                }}
              />
              <span className="mt-1 block text-xs text-muted">
                Sent as instructions from this rule, alongside the external event details.
              </span>
            </label>
          )}
        </fieldset>
      ))}
      {!value.length && (
        <p className="text-sm text-muted">
          No squad actions. Existing work streams still receive their subscribed events.
        </p>
      )}
      <button
        type="button"
        disabled={disabled || !events.length || value.length >= 32}
        className="ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm disabled:opacity-40"
        onClick={() =>
          onChange([
            {
              id: `event-${crypto.randomUUID()}`,
              enabled: true,
              source: { integration: provider, output: events[0]!.output, version: events[0]!.version },
              filters: { squadRouting: true, audience: 'connected-account' },
              action: { type: 'notify-manager' },
            },
            ...value,
          ])
        }
      >
        Add event rule
      </button>
      <EventRulePreview provider={provider} rules={value} metadata={metadata} events={events} accounts={accounts} />
    </section>
  )
}
