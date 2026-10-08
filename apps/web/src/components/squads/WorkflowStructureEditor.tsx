import clsx from 'clsx'
import { connectWorkflowOutcome, removeWorkflowStep } from '../../lib/workflowEditing'
import { useState, type ReactNode } from 'react'
import {
  workflowStepSchema,
  workflowParticipantSchema,
  inferWorkflowJoin,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@ficus/shared'

const field = 'ficus-field w-full px-3 py-2 border border-th-border rounded-md bg-surface text-primary'
function Help({ children }: { children: ReactNode }) {
  return <span className="block mt-1 text-xs font-normal text-muted">{children}</span>
}

const idValid = (id: string) =>
  /^[a-z][a-z0-9-]{0,99}$/.test(id) && !['finish', 'constructor', 'prototype'].includes(id)

export function WorkflowStructureEditor({
  definition,
  onChange,
  mode = 'all',
  selectedStep,
  onlyOutcome,
  onlyBranch,
  onSelectOutcome,
  connectionRemoval,
  hideParticipant,
}: {
  definition: WorkflowDefinition
  mode?: 'all' | 'step' | 'settings'
  hideParticipant?: boolean
  selectedStep?: string
  connectionRemoval?: { label: string; help: string; onRemove: () => void }
  onlyOutcome?: string
  onlyBranch?: number
  onSelectOutcome?: (name: string | undefined, previousName?: string) => void
  onChange: (definition: WorkflowDefinition) => void
}) {
  const [participantId, setParticipantId] = useState('')
  const [stepId, setStepId] = useState('')
  const edit = (change: (draft: WorkflowDefinition) => void) => {
    const draft = structuredClone(definition)
    change(draft)
    onChange(draft)
  }
  const selectStep = (
    value: string,
    onChange: (value: string) => void,
    finish = false,
    canSelect?: (id: string) => boolean
  ) => (
    <select className={field} value={value} onChange={(e) => onChange(e.target.value)}>
      {finish && <option value="finish">Finish</option>}
      {definition.steps.map((step) => (
        <option key={step.id} value={step.id} disabled={canSelect && !canSelect(step.id)}>
          {step.name ?? step.id}
        </option>
      ))}
    </select>
  )
  const selectConnectionDestination = (from: string, outcome: string, value: string, branch?: number, finish = false) =>
    selectStep(
      value,
      (to) => onChange(connectWorkflowOutcome(definition, from, outcome, to, branch, true)),
      finish,
      (to) => {
        try {
          connectWorkflowOutcome(definition, from, outcome, to, branch, true)
          return true
        } catch {
          return false
        }
      }
    )
  return (
    <div className={clsx('space-y-5', mode === 'all' && 'border-t border-th-border pt-4')}>
      {mode === 'all' && (
        <>
          <label className="block text-sm">
            First step
            <Help>Where new work starts. The arrows, not the list order, determine what runs next.</Help>
            {selectStep(definition.entry, (value) =>
              edit((draft) => {
                draft.entry = value
              })
            )}
          </label>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-sm">
              New participant ID
              <Help>
                A local identity for an agent. Separate IDs can share an agent type while keeping independent sessions.
              </Help>
              <input
                className={field}
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                placeholder="security-reviewer"
              />
            </label>
            <button
              type="button"
              className="text-sm text-accent py-2"
              disabled={
                !idValid(participantId) ||
                !!definition.participants[participantId] ||
                Object.keys(definition.participants).length >= 64
              }
              onClick={() => {
                edit((draft) => {
                  draft.participants[participantId] = workflowParticipantSchema.parse({
                    agentTypeId: 'general',
                    session: 'reuse-within-stream',
                  })
                })
                setParticipantId('')
              }}
            >
              Add participant
            </button>
          </div>
          <div className="flex flex-wrap gap-3">
            {Object.keys(definition.participants)
              .filter((id) => !definition.steps.some((step) => step.kind === 'agent' && step.participant === id))
              .map((id) => (
                <button
                  type="button"
                  key={id}
                  className="text-xs text-secondary"
                  onClick={() =>
                    edit((draft) => {
                      delete draft.participants[id]
                    })
                  }
                >
                  Remove unused participant {id}
                </button>
              ))}
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-sm">
              New step ID
              <Help>A unique lowercase identifier with optional hyphens. Adding a step does not start an agent.</Help>
              <input
                className={field}
                value={stepId}
                onChange={(e) => setStepId(e.target.value)}
                placeholder="security-review"
              />
            </label>
            <button
              type="button"
              className="text-sm text-accent py-2"
              disabled={
                !idValid(stepId) ||
                definition.steps.some((step) => step.id === stepId) ||
                definition.steps.length >= 128
              }
              onClick={() => {
                edit((draft) => {
                  const previous = draft.steps.at(-1)
                  if (!previous) draft.entry = stepId
                  for (const target of Object.values(previous?.outcomes ?? {}))
                    if ('next' in target && target.next === 'finish') target.next = stepId
                  const participant = Object.keys(draft.participants)[0]
                  draft.steps.push(
                    workflowStepSchema.parse({
                      id: stepId,
                      ...(participant ? { participant } : { kind: 'human-approval', approver: 'assigned-reviewers' }),
                      instructions: 'Complete this step and verify the result.',
                      output: 'Result and evidence.',
                      outcomes: { completed: { next: 'finish' } },
                    })
                  )
                })
                setStepId('')
              }}
            >
              Add step
            </button>
          </div>
        </>
      )}
      {definition.steps.map(
        (step, index) =>
          mode !== 'settings' &&
          (mode !== 'step' || step.id === selectedStep) && (
            <div key={step.id} className={clsx('space-y-5', mode === 'all' && 'border-t border-th-border pt-4')}>
              {!onlyOutcome && (
                <>
                  {mode === 'all' && (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm font-medium">{step.id}</span>
                        <button
                          type="button"
                          aria-label={`Move ${step.id} earlier`}
                          disabled={index === 0}
                          className="text-xs text-accent"
                          onClick={() =>
                            edit((draft) => {
                              ;[draft.steps[index - 1], draft.steps[index]] = [
                                draft.steps[index]!,
                                draft.steps[index - 1]!,
                              ]
                            })
                          }
                        >
                          Earlier
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${step.id} later`}
                          disabled={index === definition.steps.length - 1}
                          className="text-xs text-accent"
                          onClick={() =>
                            edit((draft) => {
                              ;[draft.steps[index], draft.steps[index + 1]] = [
                                draft.steps[index + 1]!,
                                draft.steps[index]!,
                              ]
                            })
                          }
                        >
                          Later
                        </button>
                        <button
                          type="button"
                          className="text-xs text-secondary"
                          onClick={() => onChange(removeWorkflowStep(definition, step.id))}
                        >
                          Remove step {step.name ?? step.id}
                        </button>
                      </div>
                      <p className="text-xs text-secondary">
                        Outcome destinations control progression and earlier-step returns. Repair any references after
                        removing a step.
                      </p>
                    </>
                  )}
                  {!hideParticipant && step.kind === 'agent' && (
                    <label className="block text-xs text-secondary">
                      {mode === 'all' ? `${step.id} · Participant` : 'Participant'}
                      <Help>Steps using the same participant share its agent settings.</Help>
                      <select
                        className={field}
                        value={step.participant}
                        onChange={(event) =>
                          edit((draft) => {
                            const target = draft.steps[index]!
                            if (target.kind === 'agent') target.participant = event.target.value
                          })
                        }
                      >
                        {Object.keys(definition.participants).map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {step.kind === 'human-approval' && (
                    <label className="block text-xs text-secondary">
                      Approver
                      <Help>
                        Assigned reviewers limits approval to the people assigned to this work. If no reviewers are
                        assigned, any reviewer is allowed. Any reviewer allows anyone with permission to review work
                        streams in this squad. One eligible reviewer can approve or request changes.
                      </Help>
                      <select
                        className={field}
                        value={step.approver}
                        onChange={(e) =>
                          edit((draft) => {
                            ;(draft.steps[index] as Extract<WorkflowStep, { kind: 'human-approval' }>).approver = e
                              .target.value as 'reviewers' | 'assigned-reviewers'
                          })
                        }
                      >
                        <option value="assigned-reviewers">Assigned reviewers</option>
                        <option value="reviewers">Any reviewer</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              {!onlyOutcome && mode === 'step' && (
                <p className="text-xs text-muted">
                  Select a labeled arrow or outcome on the canvas to edit its handoff.
                </p>
              )}
              {Object.entries(step.outcomes)
                .filter(([name]) => (onlyOutcome ? name === onlyOutcome : mode === 'all'))
                .map(([name, target]) => (
                  <div key={name} className="space-y-5">
                    <label className="block text-sm">
                      Outcome
                      <Help>
                        The verdict the agent submits, such as approved or changes-requested. Each verdict chooses one
                        handoff.
                      </Help>
                      <input
                        className={field}
                        defaultValue={name}
                        aria-label={`Rename ${step.id} outcome ${name}`}
                        onBlur={(event) => {
                          const next = event.target.value.trim()
                          if (next === name) return
                          if (!idValid(next) || step.outcomes[next]) {
                            event.target.value = name
                            return
                          }
                          edit((draft) => {
                            draft.steps[index]!.outcomes = Object.fromEntries(
                              Object.entries(step.outcomes).map(([key, value]) => [key === name ? next : key, value])
                            )
                          })
                          onSelectOutcome?.(next, name)
                        }}
                      />
                    </label>
                    {'next' in target ? (
                      <label className="block text-xs text-secondary">
                        Next step
                        <Help>
                          Run this step after this outcome. Finish checks that all active work and completion conditions
                          are satisfied.
                        </Help>
                        {selectConnectionDestination(step.id, name, target.next, undefined, true)}
                      </label>
                    ) : 'parallel' in target ? (
                      onlyBranch !== undefined ? (
                        <label className="block text-xs text-secondary">
                          Branch destination
                          <Help>Other branches keep their connections.</Help>
                          {selectConnectionDestination(step.id, name, target.parallel[onlyBranch]!, onlyBranch)}
                        </label>
                      ) : (
                        <>
                          <fieldset className="space-y-2 text-sm">
                            <legend className="text-xs text-secondary">Parallel branches</legend>
                            <Help>
                              These steps start together. Where their arrows meet, the shared step waits for the active
                              branches and runs once. Removing all but one branch leaves an ordinary forward connection.
                            </Help>
                            {definition.steps
                              .filter((entry) => entry.id !== step.id)
                              .map((entry) => (
                                <label
                                  key={entry.id}
                                  className="flex items-center gap-2 rounded-md border border-th-border px-3 py-2"
                                >
                                  <input
                                    type="checkbox"
                                    checked={target.parallel.includes(entry.id)}
                                    onChange={(event) =>
                                      edit((draft) => {
                                        const branches = event.target.checked
                                          ? [...target.parallel, entry.id]
                                          : target.parallel.filter((id) => id !== entry.id)
                                        draft.steps[index]!.outcomes[name] =
                                          branches.length === 1
                                            ? { next: branches[0]! }
                                            : { ...target, parallel: branches }
                                      })
                                    }
                                  />
                                  {entry.id}
                                </label>
                              ))}
                          </fieldset>
                          <p className="text-xs text-secondary">
                            {inferWorkflowJoin(definition, target.parallel) === 'finish'
                              ? 'These tracks stay separate until Finish. Finish waits for all active work.'
                              : inferWorkflowJoin(definition, target.parallel)
                                ? `Waits for these branches at ${inferWorkflowJoin(definition, target.parallel)}. Change the connections to move where they meet.`
                                : 'Connect the branch paths to a shared step or Finish.'}
                          </p>
                        </>
                      )
                    ) : (
                      <>
                        <label className="block text-xs text-secondary">
                          Rework step
                          <Help>
                            The step that makes the requested corrections. This starts another attempt; an attempt limit
                            applies only if one is configured.
                          </Help>
                          {selectConnectionDestination(step.id, name, target.returnTo)}
                        </label>
                        <label className="block text-xs text-secondary">
                          After rework
                          <Help>
                            Follow graph continues along the correction step’s normal arrows. Return to requester sends
                            its result directly back to this step, skipping those arrows.
                          </Help>
                          <select
                            className={field}
                            aria-label="After rework"
                            value={target.afterRework ?? 'follow-graph'}
                            onChange={(event) =>
                              edit((draft) => {
                                draft.steps[index]!.outcomes[name] = {
                                  ...target,
                                  afterRework: event.target.value as 'follow-graph' | 'return-to-requester',
                                }
                              })
                            }
                          >
                            <option value="follow-graph">Follow graph</option>
                            <option value="return-to-requester">Return to requester</option>
                          </select>
                        </label>
                      </>
                    )}
                    <div className="space-y-2 border-t border-th-border pt-4">
                      <p className="text-xs text-muted">
                        {connectionRemoval?.help ??
                          `Removes this outcome and its handoff${'parallel' in target ? 's' : ''}. The steps stay in the flow. You can undo this change.`}
                      </p>
                      <button
                        type="button"
                        className="ficus-button ficus-button-danger px-2 py-1 text-sm"
                        onClick={() => {
                          if (connectionRemoval) {
                            connectionRemoval.onRemove()
                            return
                          }
                          edit((draft) => {
                            delete draft.steps[index]!.outcomes[name]
                          })
                          onSelectOutcome?.(undefined)
                        }}
                      >
                        {connectionRemoval?.label ??
                          ('parallel' in target ? 'Remove outcome and connections' : 'Remove connection')}
                      </button>
                    </div>
                  </div>
                ))}
              <button
                type="button"
                className="text-xs text-accent"
                disabled={Object.keys(step.outcomes).length >= 16}
                onClick={() =>
                  edit((draft) => {
                    let i = 1
                    while (draft.steps[index]!.outcomes[`outcome-${i}`]) i++
                    draft.steps[index]!.outcomes[`outcome-${i}`] = { next: 'finish' }
                    onSelectOutcome?.(`outcome-${i}`)
                  })
                }
              >
                Add outcome
              </button>
            </div>
          )
      )}
      {mode !== 'step' && (
        <>
          <label className="block text-sm">
            Routing
            <Help>Choose how much freedom agents have beyond the arrows you draw.</Help>
            <select
              className={field}
              value={definition.routing.mode}
              onChange={(e) =>
                edit((draft) => {
                  draft.routing.mode = e.target.value as typeof draft.routing.mode
                  if (draft.routing.mode === 'guided') {
                    draft.routing.returnTo = 'declared-only'
                    draft.routing.delegation = 'disabled'
                    draft.limits.maxDelegations = 0
                  }
                })
              }
            >
              {['guided', 'flexible', 'adaptive'].map((value) => (
                <option key={value} value={value}>
                  {value[0]!.toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <p className="rounded-md bg-surface-secondary p-3 text-xs text-secondary">
            {definition.routing.mode === 'guided'
              ? 'Agents follow the steps and arrows you define, including any routes back for revisions. They cannot change the workflow or bring in extra agents themselves.'
              : definition.routing.mode === 'flexible'
                ? 'Agents can ask an earlier step to revise its work or ask another agent to help with a specific task, then continue when the result comes back. Choose which options to allow below. Changing the workflow itself still needs the manager.'
                : 'Agents can request revisions, ask another agent for help, and adjust upcoming steps as they learn—for example, add an investigation step or change which step runs next. Changing existing steps, changing work already underway, changing how the workflow finishes, or increasing limits still needs the manager.'}
          </p>
          <label className="block text-sm">
            Return paths
            <Help>
              Choose whether agents can send work back only along arrows you drew, or ask any earlier connected step to
              revise its work. After the revision, work returns to the agent that requested it.
            </Help>
            <select
              className={field}
              disabled={definition.routing.mode === 'guided'}
              value={definition.routing.returnTo}
              onChange={(e) =>
                edit((draft) => {
                  draft.routing.returnTo = e.target.value as typeof draft.routing.returnTo
                })
              }
            >
              <option value="declared-only">Declared paths only</option>
              <option value="earlier-steps">Any earlier step</option>
            </select>
          </label>
          <label className="block text-sm">
            Delegation limit
            <Help>
              {definition.routing.mode === 'guided'
                ? 'Guided workflows do not allow help from extra agents. Choose Flexible or Adaptive routing to enable it.'
                : 'How many extra agents can be asked to help with a specific task across this workflow. Each sends its result back to the agent that asked. 0 disables this; agents already in the workflow do not count.'}
            </Help>
            <input
              className={field}
              type="number"
              min={0}
              max={100}
              disabled={definition.routing.mode === 'guided'}
              value={definition.routing.delegation === 'disabled' ? 0 : definition.limits.maxDelegations}
              onChange={(event) =>
                edit((draft) => {
                  draft.limits.maxDelegations = Number(event.target.value)
                  draft.routing.delegation = draft.limits.maxDelegations > 0 ? 'allowed' : 'disabled'
                })
              }
            />
          </label>
          <details className="rounded-lg border border-th-border p-3">
            <summary className="cursor-pointer text-sm text-secondary">
              Advanced limits
              {definition.limits.maxStepAttempts !== undefined &&
                ` · ${definition.limits.maxStepAttempts} attempts per step`}
              {definition.limits.maxParallelAttempts !== undefined &&
                ` · ${definition.limits.maxParallelAttempts} parallel steps`}
            </summary>
            <div className="space-y-5 pt-3">
              {(['maxStepAttempts', 'maxParallelAttempts'] as const).map((key) => (
                <label key={key} className="block text-sm">
                  {key === 'maxStepAttempts' ? 'Attempts per step (optional)' : 'Maximum parallel steps (optional)'}
                  <Help>
                    {key === 'maxStepAttempts'
                      ? 'Leave blank for unlimited attempts. An explicit limit includes the first attempt and rework; reaching it asks the owner for input.'
                      : 'Leave blank for no workflow-specific limit. Global agent capacity still applies. An explicit limit queues extra steps until an active attempt finishes.'}
                  </Help>
                  <input
                    className={field}
                    type="number"
                    min={1}
                    max={key === 'maxStepAttempts' ? 100 : 32}
                    placeholder={key === 'maxStepAttempts' ? 'No attempt limit' : 'No workflow limit'}
                    value={definition.limits[key] ?? ''}
                    onChange={(event) =>
                      edit((draft) => {
                        if (event.target.value === '') delete draft.limits[key]
                        else draft.limits[key] = Number(event.target.value)
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </details>
          {mode === 'all' && <WorkflowCompletionEditor definition={definition} onChange={onChange} />}
          {mode === 'all' && (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={definition.completion.followChanges ?? false}
                  onChange={(event) =>
                    edit((draft) => {
                      draft.completion.followChanges = event.target.checked
                    })
                  }
                />
                <span>
                  Code hosting
                  <span className="block text-xs text-muted">
                    Send updates from linked pull requests and issues to the selected workflow recipient, or the
                    delivery owner by default.
                  </span>
                </span>
              </label>
            </>
          )}
        </>
      )}
    </div>
  )
}

export function WorkflowCompletionEditor({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition
  onChange: (definition: WorkflowDefinition) => void
}) {
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        Completion policy
        <Help>What must be true after the steps finish before the work stream can be marked done.</Help>
        <select
          className={field}
          aria-label="Completion policy"
          value={definition.completion.mode}
          onChange={(e) =>
            onChange({
              ...definition,
              completion: { ...definition.completion, mode: e.target.value as typeof definition.completion.mode },
            })
          }
        >
          {['deliverable', 'review-approval', 'pr-merge', 'pr-auto-merge', 'direct-merge'].map((mode) => (
            <option key={mode} value={mode}>
              {
                {
                  deliverable: 'Verified deliverable',
                  'review-approval': 'Human delivery approval',
                  'pr-merge': 'Human merges the change',
                  'pr-auto-merge': 'Automatic merge',
                  'direct-merge': 'Direct merge',
                }[mode]
              }
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted">
        {
          {
            deliverable:
              'Finish when all active paths, direct-return requests, and blocking waits are settled. No extra review or merge is implied.',
            'review-approval': 'A human must approve final delivery, even after all agent steps finish.',
            'pr-merge': 'Wait for a human to merge the change request. Ficus verifies the merge independently.',
            'pr-auto-merge':
              'The squad must explicitly allow automatic merge. Ficus still waits for a verified merge before completion.',
            'direct-merge':
              'The squad must explicitly allow direct merge. Ficus verifies the recorded commit is in the remote base branch.',
          }[definition.completion.mode]
        }
      </p>
    </div>
  )
}
