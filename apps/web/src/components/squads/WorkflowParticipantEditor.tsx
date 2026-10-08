import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { useState } from 'react'
import clsx from 'clsx'
import { separateWorkflowParticipant } from '../../lib/workflowEditing'
import { isWorkerAgentType, type WorkflowDefinition } from '@ficus/shared'

const field = 'ficus-field w-full min-w-0 rounded-md border border-th-border bg-surface px-3 py-2 text-sm'

export function WorkflowParticipantEditor({
  definition,
  onChange,
  selected,
  onSelect,
}: {
  definition: WorkflowDefinition
  onChange: (definition: WorkflowDefinition) => void
  selected: string
  onSelect: (id: string) => void
}) {
  const [newId, setNewId] = useState('')
  const [error, setError] = useState<string>()
  const ids = Object.keys(definition.participants)
  const active = ids.includes(selected) ? selected : ids[0]
  const participant = active ? definition.participants[active] : undefined
  const usedBy = definition.steps.filter((step) => step.kind === 'agent' && step.participant === active)
  const edit = (update: (draft: WorkflowDefinition) => void) => {
    const draft = structuredClone(definition)
    update(draft)
    onChange(draft)
  }
  const validId = (id: string) =>
    /^[a-z][a-z0-9-]{0,99}$/.test(id) && !['finish', 'constructor', 'prototype'].includes(id)
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Participants define who does the work. Steps assigned to the same participant share its agent settings.
      </p>
      <div role="group" aria-label="Choose participant" className="space-y-1">
        {ids.map((id) => {
          const count = definition.steps.filter((step) => step.kind === 'agent' && step.participant === id).length
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active === id}
              className={clsx(
                'ficus-button ficus-button-ghost flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm',
                active === id && 'bg-surface-hover text-accent-light'
              )}
              onClick={() => onSelect(id)}
            >
              <span className="min-w-0 truncate">{id}</span>
              <span className="shrink-0 text-xs text-muted">
                Used by {count} {count === 1 ? 'step' : 'steps'}
              </span>
            </button>
          )
        })}
      </div>
      {participant && active && (
        <>
          <label className="block text-sm">
            Participant ID
            <input
              key={active}
              className={field}
              defaultValue={active}
              onBlur={(event) => {
                const next = event.target.value.trim()
                if (next === active) return
                if (!validId(next) || definition.participants[next]) {
                  setError('Choose an unused ID starting with a letter, using lowercase letters, numbers, and hyphens.')
                  event.target.value = active
                  return
                }
                edit((draft) => {
                  draft.participants[next] = draft.participants[active]!
                  delete draft.participants[active]
                  for (const step of draft.steps)
                    if (step.kind === 'agent' && step.participant === active) step.participant = next
                  for (const subscription of draft.subscriptions ?? []) {
                    if (
                      typeof subscription.deliver.to === 'object' &&
                      'participant' in subscription.deliver.to &&
                      subscription.deliver.to.participant === active
                    )
                      subscription.deliver.to.participant = next
                  }
                })
                setError(undefined)
                onSelect(next)
              }}
            />
          </label>
          <p className="text-xs text-muted" aria-label="Participant usage">
            {usedBy.length
              ? `Shared by ${usedBy.map((step) => step.name ?? step.id).join(', ')}. Changes below affect every listed step.`
              : 'Not assigned to any steps yet.'}
          </p>
          {usedBy.length > 1 && (
            <div className="space-y-2">
              {usedBy.map((step) => (
                <div key={step.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{step.name ?? step.id}</span>
                  <button
                    type="button"
                    aria-label={`Make ${step.name ?? step.id} separate`}
                    className="ficus-button ficus-button-link shrink-0 disabled:opacity-40"
                    disabled={ids.length >= 64}
                    onClick={() => {
                      const next = separateWorkflowParticipant(definition, step.id)
                      onChange(next.definition)
                      onSelect(next.participant)
                    }}
                  >
                    Make separate
                  </button>
                </div>
              ))}
              <p className="text-xs text-muted">Make separate copies these settings for just that step.</p>
            </div>
          )}
          <WorkflowParticipantFields
            participant={participant}
            onChange={(next) =>
              edit((draft) => {
                draft.participants[active] = next
              })
            }
          />
          <button
            type="button"
            className="ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm text-status-danger-600 dark:text-status-danger-400 disabled:opacity-40"
            disabled={
              usedBy.length > 0 ||
              definition.subscriptions?.some(
                (item) =>
                  typeof item.deliver.to === 'object' &&
                  'participant' in item.deliver.to &&
                  item.deliver.to.participant === active
              )
            }
            onClick={() =>
              edit((draft) => {
                delete draft.participants[active]
              })
            }
          >
            Remove participant
          </button>
        </>
      )}
      <div className="space-y-2 border-t border-th-border pt-4">
        <label className="block text-sm">
          New participant ID
          <input
            className={field}
            placeholder="reviewer"
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm disabled:opacity-40"
          disabled={!validId(newId) || !!definition.participants[newId] || ids.length >= 64}
          onClick={() => {
            edit((draft) => {
              draft.participants[newId] = { agentTypeId: 'general', session: 'reuse-within-stream' }
            })
            onSelect(newId)
            setNewId('')
          }}
        >
          Add participant
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {error}
        </p>
      )}
    </div>
  )
}

function WorkflowParticipantFields({
  participant,
  onChange,
}: {
  participant: WorkflowDefinition['participants'][string]
  onChange: (participant: WorkflowDefinition['participants'][string]) => void
}) {
  const { data: agentTypes = [] } = useQuery(queries.agentTypes.list())
  return (
    <div className="space-y-5">
      <label className="block text-sm">
        Agent type
        <select
          className={field}
          value={participant.agentTypeId}
          onChange={(event) => onChange({ ...participant, agentTypeId: event.target.value })}
        >
          {!agentTypes.some((type) => type.id === participant.agentTypeId && isWorkerAgentType(type)) && (
            <option value={participant.agentTypeId} disabled>
              {participant.agentTypeId} (unavailable for workers)
            </option>
          )}
          {agentTypes.filter(isWorkerAgentType).map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <span className="block text-xs text-muted mt-1">
          Supplies the role, base instructions, and tools for this participant.
        </span>
      </label>
      <WorkflowParticipantTierField participant={participant} onChange={onChange} />
      <label className="block text-sm">
        Session
        <select
          className={field}
          value={participant.session}
          onChange={(event) => onChange({ ...participant, session: event.target.value as typeof participant.session })}
        >
          <option value="reuse-within-stream">Reuse within work stream</option>
          <option value="fresh-per-attempt">Fresh each attempt</option>
        </select>
        <span className="block text-xs text-muted mt-1">
          {participant.session === 'reuse-within-stream'
            ? 'Sequential steps reuse this participant’s session and conversation history. Parallel branches each get a separate session; the main track resumes its own session after they join.'
            : 'Start a new session whenever this step runs, including when it is revisited for revisions. Previous conversation history is not retained.'}
        </span>
      </label>
      <p className="text-xs text-muted">
        Both modes receive a new handoff each time a step starts: instructions, expected result, recent recorded
        results, and open revision requests.
      </p>
    </div>
  )
}

export function WorkflowParticipantTierField({
  participant,
  onChange,
}: {
  participant: WorkflowDefinition['participants'][string]
  onChange: (participant: WorkflowDefinition['participants'][string]) => void
}) {
  const { data: tiers = [], isPending: tiersPending, isError: tiersError } = useQuery(queries.modelTiers.list())
  const availableTiers = tiers.filter((tier) => !tier.disabled)
  return (
    <>
      <label className="block text-sm">
        Model tier
        <select
          className={field}
          value={participant.tier ?? ''}
          disabled={tiersPending}
          onChange={(event) => {
            const next = { ...participant }
            if (event.target.value) next.tier = event.target.value
            else delete next.tier
            onChange(next)
          }}
        >
          <option value="">Agent type default</option>
          {participant.tier && !availableTiers.some((tier) => tier.slug === participant.tier) && (
            <option value={participant.tier} disabled>
              {participant.tier} (unavailable)
            </option>
          )}
          {availableTiers.map((tier) => (
            <option key={tier.slug} value={tier.slug}>
              {tier.label}
            </option>
          ))}
        </select>
        <span className="block text-xs text-muted mt-1">
          Choose a tier for this participant, or keep the agent type’s default model settings.
        </span>
      </label>
      {tiersError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Model tiers could not be loaded.
        </p>
      )}
    </>
  )
}
