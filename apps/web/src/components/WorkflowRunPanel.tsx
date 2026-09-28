import { Link } from 'react-router-dom'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { ChatIcon } from './icons'
import { WorkStreamReviewers } from './WorkStreamReviewers'
import { WorkflowGraph } from './WorkflowGraph'
import { useState } from 'react'
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

export function WorkflowRunPanel({
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
  const finish = useMutation({
    mutationFn: () => client.workflows.finish(stream.id, run!.version),
    onSuccess: refresh,
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
  const activeAttempts = activeWorkflowAttempts(run.state)
  const focusedAttempt = (run.openWaits ?? stream.openWaits ?? []).find(
    (wait) => wait.id === focusWaitId
  )?.flowAttemptId
  const attempt = activeAttempts.find((entry) => entry.id === (selectedAttempt ?? focusedAttempt)) ?? activeAttempts[0]
  const step = attempt?.step ?? run.state.definition.steps.find((entry) => entry.id === attempt?.stepId)
  const terminal = ['done', 'canceled'].includes(stream.status)
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
  const failure = advance.error ?? finish.error ?? save.error
  return (
    <section className="border-t border-th-border pt-4 space-y-3">
      <div className="flex justify-between gap-3">
        <h3 className="text-sm font-medium">{run.state.definition.name}</h3>
        <span className="text-xs text-secondary">
          {terminal
            ? stream.status
            : run.state.status === 'completion-ready'
              ? 'Ready for delivery'
              : run.state.status === 'paused'
                ? 'Needs a decision'
                : step?.id}
        </span>
      </div>
      {run.state.definition.steps.some((step) => step.kind === 'human-approval') && (
        <WorkStreamReviewers stream={stream} />
      )}
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
      {waits.map((wait) => (
        <p key={wait.id} className="text-sm text-secondary">
          {wait.flowAttemptId == null
            ? 'Whole stream'
            : `${run.state.attempts.find((a) => a.id === wait.flowAttemptId)?.stepId ?? 'Step'} · Attempt ${wait.flowAttemptId}`}
          : {wait.message ?? 'Waiting for input'}
        </p>
      ))}
      {run.usage && <p className="text-xs text-secondary">{formatWorkflowUsage(run.usage.total)}</p>}
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
              {run.usage?.steps[entry.id] && (
                <span className="block text-xs text-secondary">{formatWorkflowUsage(run.usage.steps[entry.id]!)}</span>
              )}
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

      {/* Human decisions and delivery approval render in WorkflowReviewCallout at the top of the detail. */}
      {!terminal &&
        !stream.pause &&
        run.state.status === 'completion-ready' &&
        run.state.definition.completion.mode !== 'review-approval' &&
        (can('workstreams:update') || can('workstreams:respond')) && (
          <button
            type="button"
            className="text-sm text-accent"
            disabled={finish.isPending}
            onClick={() => finish.mutate()}
          >
            Complete delivery · {run.state.definition.completion.mode}
          </button>
        )}
      {!!run.usage?.unattributed.executions && (
        <p className="text-xs text-secondary">
          Unattributed usage: {formatWorkflowUsage(run.usage.unattributed)}. Older measurements cannot be assigned to a
          step.
        </p>
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
      {!terminal && can('workstreams:revise-flow') && (
        <>
          {!editing ? (
            <button
              type="button"
              className="text-sm text-accent"
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
                  className="text-sm text-accent"
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
                <button type="button" className="text-sm text-secondary" onClick={() => setEditing(false)}>
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
              className="text-sm text-accent"
              disabled={!presetId || save.isPending}
              onClick={() => save.mutate()}
            >
              Save preset
            </button>
          </div>
        </details>
      )}
      {failure && (
        <p role="alert" className="text-sm text-status-danger-400">
          {failure.message}
        </p>
      )}
    </section>
  )
}
