import { Link } from 'react-router-dom'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { ChatIcon, ChevronDownIcon, ChevronRightIcon } from './icons'
import { WorkStreamReviewers } from './WorkStreamReviewers'
import { WorkflowGraph } from './WorkflowGraph'
import { useId, useState, type ComponentProps } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkStream, WorkflowCommand, WorkflowSource } from '@ficus/shared'
import {
  activeWorkflowAttempts,
  formatWorkflowUsage,
  workflowRevisionOperations,
  workflowDefinitionSchema,
} from '@ficus/shared'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { client } from '../api/clientInstance'
import { usePermissions } from '../hooks/usePermissions'
import { WorkflowEditor } from './squads/WorkflowEditor'

function WorkflowRunPanelContent({
  stream,
  onOpenAgent,
  focusWaitId,
}: {
  stream: WorkStream
  onOpenAgent?: () => void
  focusWaitId?: string
}) {
  const { slugFor } = useSquadSlugs()
  const { data: run, error } = useQuery(queries.workflows.run(stream.id))
  const { can } = usePermissions(stream.squadId)
  const queryClient = useQueryClient()
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const previewId = useId()
  const [selectedAttempt, setSelectedAttempt] = useState<number>()
  const [presetId, setPresetId] = useState('')
  const [editing, setEditing] = useState(false)
  const [base, setBase] = useState<typeof run>()
  const [draft, setDraft] = useState<WorkflowSource>()
  const [reason, setReason] = useState('')
  const [restart, setRestart] = useState(false)
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
  }
  const advance = useMutation({
    mutationFn: (command: WorkflowCommand) => client.workflows.advance(stream.id, command, crypto.randomUUID()),
    onSuccess: () => {
      setEditing(false)
      refresh()
    },
  })
  const save = useMutation({
    mutationFn: () =>
      client.workflows.create({
        id: presetId,
        scope: { kind: 'squad', squadId: stream.squadId },
        definition: run!.state.definition,
      }),
    onSuccess: () => {
      setPresetId('')
      refresh()
    },
  })
  if (error) return <p className="text-sm text-status-danger-400">Could not load the workflow.</p>
  if (!run) return null
  const workflowName = run.state.definition.name?.trim() ? run.state.definition.name : undefined
  const activeAttempts = activeWorkflowAttempts(run.state)
  const focusedAttempt = (run.openWaits ?? stream.openWaits ?? []).find(
    (wait) => wait.id === focusWaitId
  )?.flowAttemptId
  const attempt = activeAttempts.find((entry) => entry.id === (selectedAttempt ?? focusedAttempt)) ?? activeAttempts[0]
  const terminal = ['done', 'canceled'].includes(stream.status)
  const showReviewers =
    run.state.definition.steps.some((step) => step.kind === 'human-approval') &&
    (!terminal || !!stream.assignedReviewerIds?.length)
  const waits = run.openWaits ?? stream.openWaits ?? []
  const waiting = (stepId: string) =>
    activeAttempts.some(
      (a) => a.stepId === stepId && waits.some((w) => w.flowAttemptId == null || w.flowAttemptId === a.id)
    )
  function revise() {
    if (!draft || draft.kind !== 'inline') return
    const definition = workflowDefinitionSchema.parse(draft.definition)
    const operations = workflowRevisionOperations(base!.state.definition, definition)
    advance.mutate({
      action: 'revise',
      expectedVersion: base!.version,
      attemptId: base!.state.activeAttemptId,
      operations,
      reason,
      active: restart ? 'restart' : 'keep',
    })
  }
  const agentLink = (agentId: string, label: string, title: string) => (
    <Link
      key={agentId}
      to={`/squads/${slugFor(stream.squadId)}/agents?agent=${encodeURIComponent(agentId)}`}
      onClick={onOpenAgent}
      className="inline-flex items-center gap-1 text-xs text-accent-light hover:underline py-1"
      aria-label={title}
    >
      <ChatIcon className="h-3.5 w-3.5" />
      {label}
    </Link>
  )
  const stepAgentLinks = (stepId: string) => {
    // A step may have several branch/retry agents. Never guess from the participant alone.
    const agents = new Map<string, number>()
    for (const entry of run.state.attempts) {
      const agentId = run.attemptAgents[entry.id]
      if (entry.stepId === stepId && agentId) agents.set(agentId, entry.id)
    }
    if (!agents.size) return null
    return (
      <div className="flex flex-wrap gap-x-3">
        {[...agents].map(([agentId, attemptId]) =>
          agentLink(
            agentId,
            agents.size === 1 ? 'Open chat' : `Attempt ${attemptId} chat`,
            `Open ${stepId} attempt ${attemptId} agent chat`
          )
        )}
      </div>
    )
  }
  const failure = advance.error ?? save.error
  return (
    <section className="min-w-0 border-t border-th-border pt-4 space-y-3 [overflow-wrap:anywhere]">
      <div className="flex justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          <button
            type="button"
            aria-label={workflowName ? `Workflow preview: ${workflowName}` : 'Workflow preview'}
            aria-expanded={previewExpanded}
            aria-controls={previewId}
            onClick={() => setPreviewExpanded((expanded) => !expanded)}
            className="flex w-full items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden="true" className="shrink-0">
              {previewExpanded ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">Workflow{workflowName && ` · ${workflowName}`}</span>
          </button>
        </h3>
      </div>
      <div id={previewId} hidden={!previewExpanded}>
        {previewExpanded && (
          <div className="space-y-5">
            <WorkflowGraph
              definition={run.state.definition}
              run={run.state}
              renderStepDetails={stepAgentLinks}
              openWaits={waits}
              integrationDeliveries={run.integrationDeliveries}
              metadata={stream.metadata ?? {}}
              paused={!!stream.pause}
              queued={stream.status === 'queued'}
            />
            <section aria-label="Workflow steps" className="space-y-3">
              <h4 className="text-xs font-medium text-secondary">Steps</h4>
              {activeAttempts.length > 1 && (
                <label className="block text-sm">
                  Active step
                  <select
                    className="ficus-field w-full p-2 border border-th-border rounded-md"
                    value={attempt?.id}
                    onChange={(event) => setSelectedAttempt(Number(event.target.value))}
                  >
                    {activeAttempts.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.stepId} · Attempt {entry.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {run.state.joins
                ?.filter((join) => join.status === 'open')
                .map((join) => (
                  <p key={join.id} className="text-xs text-secondary">
                    Join at {join.join}: {join.arrived.length}/{join.branches.length} branches ready
                  </p>
                ))}
              <ol className="space-y-2 text-sm">
                {run.state.definition.steps.map((entry) => (
                  <li key={entry.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {entry.id}{' '}
                      <span className="text-xs text-secondary">
                        {entry.kind === 'agent' ? entry.participant : 'Human approval'}
                      </span>
                      {stepAgentLinks(entry.id)}
                    </div>
                    <span className="shrink-0 text-xs text-secondary">
                      {activeAttempts.some((attempt) => attempt.stepId === entry.id)
                        ? stream.status === 'queued'
                          ? 'Queued'
                          : waiting(entry.id)
                            ? 'Waiting for input'
                            : 'Current'
                        : run.state.pendingStarts?.some((pending) => pending.stepId === entry.id)
                          ? 'Queued for capacity'
                          : run.state.completedStepIds.includes(entry.id)
                            ? 'Completed'
                            : 'Upcoming'}
                    </span>
                  </li>
                ))}
              </ol>
              {run.state.returns
                .filter((entry) => entry.status === 'open')
                .map((entry) => (
                  <p key={entry.id} className="text-sm text-secondary">
                    Return to {entry.resumeAt}: {entry.feedback}
                  </p>
                ))}
              {run.state.pauseReason && (
                <p className="text-sm text-secondary">Attempt limit reached for {run.state.pauseReason.stepId}.</p>
              )}
            </section>
            <div className="space-y-3 border-t border-th-border pt-3">
              {run.usage && (
                <details className="text-xs text-secondary">
                  <summary className="cursor-pointer py-1 font-medium">Step usage</summary>
                  <dl className="mt-3 space-y-2">
                    {Object.entries(run.usage.steps).map(
                      ([stepId, usage]) =>
                        usage && (
                          <div key={stepId}>
                            <dt className="font-medium">
                              {run.state.definition.steps.find((step) => step.id === stepId)?.name ?? stepId}
                            </dt>
                            <dd>{formatWorkflowUsage(usage)}</dd>
                          </div>
                        )
                    )}
                  </dl>
                  {!!run.usage.unattributed.executions && (
                    <p className="mt-3">
                      Unattributed usage: {formatWorkflowUsage(run.usage.unattributed)}. Older measurements cannot be
                      assigned to a step.
                    </p>
                  )}
                </details>
              )}
              <details>
                <summary className="text-sm text-secondary cursor-pointer">Handoff history</summary>
                <ol className="space-y-3 pt-3">
                  {run.state.attempts.map((entry) => (
                    <li key={entry.id} className="text-sm">
                      <span className="font-medium">
                        {entry.stepId} · Attempt {entry.id} · {entry.status}
                      </span>
                      {run.usage?.attempts[entry.id] && (
                        <p className="text-xs text-secondary">{formatWorkflowUsage(run.usage.attempts[entry.id]!)}</p>
                      )}
                      {run.attemptAgents[entry.id] && (
                        <div>
                          {agentLink(
                            run.attemptAgents[entry.id]!,
                            'Open chat',
                            `Open ${entry.stepId} attempt ${entry.id} agent chat`
                          )}
                        </div>
                      )}
                      {entry.evidence && <p className="text-secondary whitespace-pre-wrap">{entry.evidence}</p>}
                      {entry.feedback && <p className="text-secondary whitespace-pre-wrap">{entry.feedback}</p>}
                    </li>
                  ))}
                </ol>
                {run.state.revisions?.map((entry) => (
                  <p key={entry.version} className="text-xs text-secondary mt-2">
                    Revision {entry.version}: {entry.reason}
                  </p>
                ))}
              </details>

              {(can('workflows:create') || (!terminal && can('workstreams:revise-flow')) || showReviewers) && (
                <details>
                  <summary className="cursor-pointer py-1 text-sm text-secondary">Manage workflow</summary>
                  <div className="mt-3 space-y-3">
                    {showReviewers && <WorkStreamReviewers stream={stream} />}
                    {!terminal && can('workstreams:revise-flow') && (
                      <>
                        {!editing ? (
                          <button
                            type="button"
                            className="ficus-button px-3 py-2 text-sm text-accent"
                            onClick={() => {
                              setBase({ ...run, state: { ...run.state, activeAttemptId: attempt?.id ?? null } })
                              setDraft({ kind: 'inline', definition: run.state.definition })
                              setEditing(true)
                            }}
                          >
                            Revise flow
                          </button>
                        ) : (
                          <div className="space-y-3">
                            <WorkflowEditor squadId={stream.squadId} value={draft} onChange={setDraft} />
                            <label className="block text-sm">
                              Reason
                              <input
                                className="ficus-field w-full p-2 border border-th-border rounded-md"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                              />
                            </label>
                            <label className="flex gap-2 text-sm">
                              <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
                              Restart the active step in a fresh session
                            </label>
                            <div className="flex gap-3">
                              <button
                                type="button"
                                className="ficus-button px-3 py-2 text-sm text-accent"
                                disabled={
                                  advance.isPending ||
                                  !reason.trim() ||
                                  draft?.kind !== 'inline' ||
                                  !workflowDefinitionSchema.safeParse(draft.definition).success
                                }
                                onClick={revise}
                              >
                                Apply revision
                              </button>
                              <button
                                type="button"
                                className="ficus-button px-3 py-2 text-sm text-secondary"
                                onClick={() => setEditing(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {can('workflows:create') && (
                      <details>
                        <summary className="text-sm text-secondary cursor-pointer">Save as a reusable preset</summary>
                        <p className="text-xs text-secondary mt-2">
                          Copies this definition, including any task-specific instructions. Review it before sharing.
                        </p>
                        <div className="flex gap-2 mt-2">
                          <input
                            aria-label="New preset ID"
                            placeholder="my-workflow"
                            className="ficus-field p-2 border border-th-border rounded-md"
                            value={presetId}
                            onChange={(e) => setPresetId(e.target.value)}
                          />
                          <button
                            type="button"
                            className="ficus-button px-3 py-2 text-sm text-accent"
                            disabled={!presetId || save.isPending}
                            onClick={() => save.mutate()}
                          >
                            Save preset
                          </button>
                        </div>
                      </details>
                    )}
                  </div>
                </details>
              )}
            </div>
            {failure && (
              <p role="alert" className="text-sm text-status-danger-400">
                {failure.message}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// Each detail identity owns its disclosure state; query refreshes keep it intact.
export function WorkflowRunPanel(props: ComponentProps<typeof WorkflowRunPanelContent>) {
  return <WorkflowRunPanelContent key={props.stream.id} {...props} />
}
