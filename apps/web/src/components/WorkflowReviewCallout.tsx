import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  activeWorkflowAttempts,
  effectiveWorkflowStep,
  workflowOutcomeRequiresEvidence,
  workflowReworkAttempt,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTransition,
  type WorkStream,
} from '@ficus/shared'
import type { WorkflowRunDetail as RunDetail } from '@ficus/client-core'
import { client } from '../api/clientInstance'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { usePermissions } from '../hooks/usePermissions'
import { actionErrorMessage } from '../lib/actionError'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { Badge } from './Badge'
import { MarkdownContent } from './MarkdownContent'
import { ChatIcon, PullRequestIcon } from './icons'

const stepOf = (run: WorkflowRun, attempt: WorkflowAttempt): WorkflowStep | undefined =>
  effectiveWorkflowStep(run, attempt)

const stepName = (run: WorkflowRun, stepId: string) =>
  run.definition.steps.find((entry) => entry.id === stepId)?.name ?? stepId

export function outcomeLabel(outcome: string): string {
  const words = outcome.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Where an outcome sends the work, so a reviewer knows the effect before deciding. */
export function outcomeEffect(run: WorkflowRun, transition: WorkflowTransition): string {
  if ('returnTo' in transition) return `Sends back to ${stepName(run, transition.returnTo)}`
  const targets = 'parallel' in transition ? transition.parallel : [transition.next]
  if (targets.length === 1 && targets[0] === 'finish') return 'Finishes the flow'
  return `Continues to ${targets.map((target) => (target === 'finish' ? 'finish' : stepName(run, target))).join(', ')}`
}

/**
 * The attention surface for human gates, delivery approval and delivery checks.
 * It sits at the top of the work stream detail
 * so the reviewer sees what to review and how to decide without scrolling
 * through the flow graph.
 */
export function WorkflowReviewCallout({
  stream,
  focusWaitId,
  onOpenAgent,
}: {
  stream: WorkStream
  focusWaitId?: string
  onOpenAgent?: () => void
}) {
  const { data: run } = useQuery(queries.workflows.run(stream.id))
  if (!run || stream.pause || stream.status === 'done' || stream.status === 'canceled') return null
  const waits = run.openWaits ?? stream.openWaits ?? []
  const focusedAttemptId = waits.find((wait) => wait.id === focusWaitId)?.flowAttemptId
  const gates =
    run.state.status === 'running'
      ? activeWorkflowAttempts(run.state)
          .filter((attempt) => stepOf(run.state, attempt)?.kind === 'human-approval')
          .sort((a, b) => Number(b.id === focusedAttemptId) - Number(a.id === focusedAttemptId))
      : []
  const deliveryApproval =
    run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval'
  const deliveryCheck = run.state.status === 'completion-ready' && !deliveryApproval
  if (deliveryCheck) return <DeliveryCheck stream={stream} run={run} />
  if (!gates.length && !deliveryApproval) return null
  return (
    <div className="space-y-3">
      {gates.map((attempt) => (
        <HumanGate key={attempt.id} stream={stream} run={run} attempt={attempt} onOpenAgent={onOpenAgent} />
      ))}
      {deliveryApproval && <DeliveryApproval stream={stream} run={run} onOpenAgent={onOpenAgent} />}
    </div>
  )
}

function useRefresh(stream: WorkStream) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.workStreamDetail(stream.id) })
    queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
  }
}

/** Finishing verifies the existing server policy; it never promises a merge or approves a review. */
function DeliveryCheck({ stream, run }: { stream: WorkStream; run: RunDetail }) {
  const { can } = usePermissions(stream.squadId)
  const refresh = useRefresh(stream)
  const finish = useMutation({
    mutationFn: () => client.workflows.finish(stream.id, run.version),
    onSuccess: refresh,
  })
  if (!can('workstreams:update') && !can('workstreams:respond')) return null
  const isDeliverable = run.state.definition.completion.mode === 'deliverable'
  return (
    <section aria-label="Delivery requirements" className="p-4 rounded-xl bg-surface-secondary space-y-3">
      <h3 className="text-sm font-medium text-primary">Ready for delivery</h3>
      <p className="text-sm text-secondary">
        {isDeliverable
          ? 'The workflow has finished. Mark the work stream complete when the result is ready.'
          : 'Delivery requirements must be satisfied before this work stream can be marked complete. Checking does not merge or approve a pull request.'}
      </p>
      <button
        type="button"
        className="ficus-button ficus-button-primary px-3 py-2 text-sm disabled:opacity-50"
        disabled={finish.isPending}
        onClick={() => finish.mutate()}
      >
        {finish.isPending ? 'Checking…' : isDeliverable ? 'Mark complete' : 'Check delivery'}
      </button>
      {finish.error && (
        <p role="alert" className="text-sm text-status-danger-400">
          {actionErrorMessage(finish.error)}
        </p>
      )}
    </section>
  )
}

function HumanGate({
  stream,
  run,
  attempt,
  onOpenAgent,
}: {
  stream: WorkStream
  run: RunDetail
  attempt: WorkflowAttempt
  onOpenAgent?: () => void
}) {
  const { can, identity } = usePermissions(stream.squadId)
  const refresh = useRefresh(stream)
  const [evidence, setEvidence] = useState('')
  const advance = useMutation({
    mutationFn: (outcome: string) =>
      client.workflows.advance(
        stream.id,
        { action: 'complete', expectedVersion: run.version, attemptId: attempt.id, outcome, evidence, resume: false },
        crypto.randomUUID()
      ),
    onSuccess: () => {
      setEvidence('')
      refresh()
    },
  })
  const step = stepOf(run.state, attempt)
  if (step?.kind !== 'human-approval') return null
  const waits = run.openWaits ?? stream.openWaits ?? []
  const gateWait = waits.find((wait) => wait.flowAttemptId === attempt.id && wait.resolutionHandler === 'workflow')
  const blockingWaits = waits.filter(
    (wait) =>
      (wait.flowAttemptId == null || wait.flowAttemptId === attempt.id) &&
      !(wait.resolutionHandler === 'workflow' && wait.flowAttemptId === attempt.id)
  )
  const assigned = stream.assignedReviewerIds ?? []
  const restricted = step.approver === 'assigned-reviewers' && assigned.length > 0
  const canDecide =
    can('workstreams:review') && (!restricted || (identity?.type === 'user' && assigned.includes(identity.userId)))
  const sources = (attempt.sourceAttemptIds ?? [])
    .map((id) => run.state.attempts.find((entry) => entry.id === id))
    .filter((entry): entry is WorkflowAttempt => !!entry)
  const firstForward = Object.entries(step.outcomes).find(([, transition]) => !('returnTo' in transition))?.[0]
  // Approving forward needs no notes; sending work back does, because they are the rework feedback.
  const outcomes = Object.entries(step.outcomes)
  const labelsWhere = (required: boolean) =>
    outcomes
      .filter(([, transition]) => workflowOutcomeRequiresEvidence(step, transition) === required)
      .map(([outcome]) => outcomeLabel(outcome))
  const notesRequiredFor = labelsWhere(true)
  const notesOptionalFor = labelsWhere(false)
  const notesHint = !notesRequiredFor.length
    ? 'Optional.'
    : !notesOptionalFor.length
      ? 'Required.'
      : `Optional for ${notesOptionalFor.join(', ')}; required for ${notesRequiredFor.join(', ')}.`
  return (
    <section aria-label={`Review ${step.name ?? step.id}`} className="p-4 rounded-xl bg-surface-secondary space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <Badge color="review">{canDecide ? 'Your review' : 'Awaiting review'}</Badge>
        <h3 className="text-sm font-medium text-primary">{step.name ?? step.id}</h3>
        {gateWait && (
          <span className="text-xs text-muted ml-auto shrink-0">{new Date(gateWait.openedAt).toLocaleString()}</span>
        )}
      </header>
      <div className="text-sm text-secondary max-h-64 overflow-y-auto">
        <MarkdownContent className="prose-xs">{step.instructions}</MarkdownContent>
      </div>
      <ReviewMaterials stream={stream} run={run} attempts={sources} onOpenAgent={onOpenAgent} />
      {canDecide ? (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-secondary">
            Decision notes
            <textarea
              aria-label="Decision and evidence"
              aria-describedby={`decision-hint-${attempt.id}`}
              placeholder="What you checked and why you decided"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              className="ficus-field mt-1 w-full p-2 text-sm border border-th-border rounded-md"
            />
          </label>
          <p id={`decision-hint-${attempt.id}`} className="text-xs text-muted">
            {notesHint} Your notes are recorded with the decision and passed to the next step.
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(step.outcomes).map(([outcome, transition]) => (
              <button
                key={outcome}
                type="button"
                title={outcomeEffect(run.state, transition)}
                className={clsx(
                  'ficus-button px-3 py-2 text-sm rounded-md disabled:opacity-50',
                  outcome === firstForward ? 'ficus-button-primary' : 'ficus-button-secondary'
                )}
                disabled={
                  advance.isPending ||
                  blockingWaits.length > 0 ||
                  (!evidence.trim() && workflowOutcomeRequiresEvidence(step, transition))
                }
                onClick={() => advance.mutate(outcome)}
              >
                {outcomeLabel(outcome)}
                <span className="block text-xs font-normal opacity-80">{outcomeEffect(run.state, transition)}</span>
              </button>
            ))}
          </div>
          {blockingWaits.length > 0 && (
            <p className="text-xs text-muted">Resolve the other open waits on this step before deciding.</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">
          {can('workstreams:review')
            ? 'Only the reviewers assigned to this work stream can decide.'
            : 'You need review permission in this squad to decide.'}
        </p>
      )}
      {advance.error && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {actionErrorMessage(advance.error)}
        </p>
      )}
    </section>
  )
}

function DeliveryApproval({
  stream,
  run,
  onOpenAgent,
}: {
  stream: WorkStream
  run: RunDetail
  onOpenAgent?: () => void
}) {
  const { can, identity } = usePermissions(stream.squadId)
  const refresh = useRefresh(stream)
  const [sendingBack, setSendingBack] = useState(false)
  const [feedback, setFeedback] = useState('')
  const reworkAttempt = workflowReworkAttempt(run.state)
  const finish = useMutation({
    mutationFn: () => client.workflows.finish(stream.id, run.version),
    onSuccess: refresh,
  })
  const sendBack = useMutation({
    mutationFn: () =>
      client.workflows.advance(
        stream.id,
        { action: 'rework', expectedVersion: run.version, attemptId: reworkAttempt!.id, feedback },
        crypto.randomUUID()
      ),
    onSuccess: () => {
      setFeedback('')
      setSendingBack(false)
      refresh()
    },
  })
  const canDecide = identity?.type === 'user' && (can('workstreams:update') || can('workstreams:respond'))
  const pending = finish.isPending || sendBack.isPending
  const failure = finish.error ?? sendBack.error
  return (
    <section aria-label="Delivery approval" className="p-4 rounded-xl bg-surface-secondary space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <Badge color="review">{canDecide ? 'Your approval' : 'Awaiting approval'}</Badge>
        <h3 className="text-sm font-medium text-primary">Approve delivery</h3>
      </header>
      <p className="text-sm text-secondary">
        The work is complete. Review the results, then approve delivery to finish the work stream or send it back with
        what needs to change.
      </p>
      <ReviewMaterials
        stream={stream}
        run={run}
        attempts={reworkAttempt ? [reworkAttempt] : []}
        onOpenAgent={onOpenAgent}
      />
      {canDecide ? (
        sendingBack ? (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-secondary">
              What needs to change
              <textarea
                aria-label="Send-back feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                className="ficus-field mt-1 w-full p-2 text-sm border border-th-border rounded-md"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ficus-button ficus-button-primary px-3 py-2 text-sm rounded-md disabled:opacity-50"
                disabled={pending || !feedback.trim()}
                onClick={() => sendBack.mutate()}
              >
                {sendBack.isPending ? 'Sending back…' : 'Send back'}
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-3 py-2 text-sm rounded-md"
                onClick={() => setSendingBack(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ficus-button ficus-button-primary px-3 py-2 text-sm rounded-md disabled:opacity-50"
              disabled={pending}
              onClick={() => finish.mutate()}
            >
              {finish.isPending ? 'Approving…' : 'Approve and complete'}
            </button>
            {reworkAttempt && (
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-3 py-2 text-sm rounded-md disabled:opacity-50"
                disabled={pending}
                onClick={() => setSendingBack(true)}
              >
                Send back
              </button>
            )}
          </div>
        )
      ) : (
        <p className="text-xs text-muted">You need permission to respond to this work stream to approve delivery.</p>
      )}
      {failure && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {actionErrorMessage(failure)}
        </p>
      )}
    </section>
  )
}

/** What the reviewer should look at: the pull request and the handoff that produced the work. */
function ReviewMaterials({
  stream,
  run,
  attempts,
  onOpenAgent,
}: {
  stream: WorkStream
  run: RunDetail
  attempts: WorkflowAttempt[]
  onOpenAgent?: () => void
}) {
  const { slugFor } = useSquadSlugs()
  const pullRequests = workStreamPullRequests(stream.metadata ?? {})
  const files = stream.files?.length ?? 0
  if (!pullRequests.length && !attempts.length && !files) return null
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-secondary">What to review</h4>
      {pullRequests.map((pullRequest) => {
        const reference = (
          <>
            <PullRequestIcon className="w-3.5 h-3.5 shrink-0" />
            Pull request #{pullRequest.number}
            <span className="text-muted">· {pullRequest.repository}</span>
          </>
        )
        return pullRequest.url ? (
          <a
            key={pullRequest.key}
            href={pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-accent-light hover:underline"
          >
            {reference}
          </a>
        ) : (
          <span key={pullRequest.key} className="inline-flex items-center gap-1.5 text-sm">
            {reference}
          </span>
        )
      })}
      {attempts.map((attempt) => {
        const agentId = run.attemptAgents[attempt.id]
        return (
          <div key={attempt.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-secondary">
              <span className="font-medium">
                {stepName(run.state, attempt.stepId)} · Attempt {attempt.id}
                {attempt.outcome ? ` · ${outcomeLabel(attempt.outcome)}` : ''}
              </span>
              {agentId && (
                <Link
                  to={`/squads/${slugFor(stream.squadId)}/agents?agent=${encodeURIComponent(agentId)}`}
                  onClick={onOpenAgent}
                  className="inline-flex items-center gap-1 text-accent-light hover:underline"
                  aria-label={`Open ${attempt.stepId} attempt ${attempt.id} agent chat`}
                >
                  <ChatIcon className="h-3.5 w-3.5" />
                  Open chat
                </Link>
              )}
            </div>
            {attempt.evidence && (
              <div className="mt-1 max-h-48 overflow-y-auto text-secondary">
                <MarkdownContent className="prose-xs">{attempt.evidence}</MarkdownContent>
              </div>
            )}
          </div>
        )
      })}
      {files > 0 && (
        <p className="text-xs text-muted">
          {files === 1 ? '1 attached file is' : `${files} attached files are`} listed under Files below.
        </p>
      )}
    </div>
  )
}
