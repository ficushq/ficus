import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkflowRunDetail } from '@ficus/client-core'
import {
  activeWorkflowAttempts,
  deliveryPullRequests,
  workflowReworkAttempt,
  type ResolvedTrackedResource,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTransition,
  type WorkStream,
} from '@ficus/shared'
import { webAppUrl } from '../api/base'
import { useStableRef } from '../hooks/useStableRef'
import { useActionsApi } from './ActionsApiProvider'
import { refreshWorkflow } from './cache'
import { usePermissions } from './permissions'
import { actionQueries } from './queries'
import { ActionText, ErrorNote, VerbButton } from './ui'

/**
 * Human decisions owned by a work stream's workflow (mirrors the web's
 * WorkflowReviewCallout): a human-approval step is decided with
 * `workflows.advance({ action: 'complete', ... })`; final delivery approval is
 * `workflows.finish(version)` or `workflows.advance({ action: 'rework', ... })`.
 * Every command carries the run's `expectedVersion` and a fresh request id.
 */

const stepOf = (run: WorkflowRun, attempt: WorkflowAttempt): WorkflowStep | undefined =>
  attempt.step ?? run.definition.steps.find((entry) => entry.id === attempt.stepId)

const stepName = (run: WorkflowRun, stepId: string) =>
  run.definition.steps.find((entry) => entry.id === stepId)?.name ?? stepId

export function outcomeLabel(outcome: string): string {
  const words = outcome.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Where an outcome sends the work, so the decider knows the effect first. */
export function outcomeEffect(run: WorkflowRun, transition: WorkflowTransition): string {
  if ('returnTo' in transition) return `Sends back to ${stepName(run, transition.returnTo)}`
  const targets = 'parallel' in transition ? transition.parallel : [transition.next]
  if (targets.length === 1 && targets[0] === 'finish') return 'Finishes the flow'
  return `Continues to ${targets.map((target) => (target === 'finish' ? 'finish' : stepName(run, target))).join(', ')}`
}

/** Delivery pull requests, codeHost-bound first (mirrors apps/web/src/lib/workStreamGithub.ts). */
export function streamPullRequests(metadata: unknown): ResolvedTrackedResource[] {
  const bound =
    !!metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).codeHost !== undefined
  return deliveryPullRequests(metadata).filter((pr) => bound || pr.source !== 'delivery')
}

/** The web app's page for a work stream, for anything the farm can't do in place. */
export function webStreamUrl(squadId: string, workStreamId: string): string {
  return webAppUrl(`/squads/${encodeURIComponent(squadId)}/work?ws=${encodeURIComponent(workStreamId)}`)
}

/** Which decisions a run is waiting on (WorkflowReviewCallout's conditions). */
export function workflowDecisions(run: WorkflowRunDetail, stream: WorkStream, focusWaitId?: string) {
  if (stream.pause || stream.status === 'done' || stream.status === 'canceled') return { gates: [], delivery: false }
  const waits = run.openWaits ?? stream.openWaits ?? []
  const focusedAttemptId = waits.find((wait) => wait.id === focusWaitId)?.flowAttemptId
  const gates =
    run.state.status === 'running'
      ? activeWorkflowAttempts(run.state)
          .filter((attempt) => stepOf(run.state, attempt)?.kind === 'human-approval')
          .sort((a, b) => Number(b.id === focusedAttemptId) - Number(a.id === focusedAttemptId))
      : []
  const delivery = run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval'
  return { gates, delivery }
}

export interface WorkflowDecisionProps {
  workStreamId: string
  /** A snapshot the caller already holds; the detail query keeps it fresh. */
  stream?: WorkStream
  focusWaitId?: string
  /** When the caller came from a workflow-owned wait, explain (and link out) if nothing is decidable here. */
  explainWhenIdle?: boolean
  onOpenAgent?: (agentId: string) => void
  onDecided?: () => void
}

export function WorkflowDecision({
  workStreamId,
  stream: snapshot,
  focusWaitId,
  explainWhenIdle = false,
  onOpenAgent,
  onDecided,
}: WorkflowDecisionProps) {
  const api = useActionsApi()
  const runQuery = useQuery(actionQueries.workflowRun(api, workStreamId))
  const streamQuery = useQuery(actionQueries.workStream(api, workStreamId))
  const stream = streamQuery.data ?? snapshot
  const run = runQuery.data

  if (runQuery.isError) {
    return explainWhenIdle ? (
      <ErrorNote error={runQuery.error} message="Couldn't load this work stream's flow." />
    ) : null
  }
  if (!run || !stream) {
    if (!explainWhenIdle) return null
    if (runQuery.isPending || (!stream && streamQuery.isPending)) {
      return <p className="g-action-note">Checking the flow…</p>
    }
    return <ErrorNote error message="Couldn't find this work stream's flow. Try it in the Ficus web app." />
  }
  const { gates, delivery } = workflowDecisions(run, stream, focusWaitId)
  if (!gates.length && !delivery) {
    if (!explainWhenIdle) return null
    return (
      <div className="g-action">
        <p className="g-action-note">
          {stream.pause
            ? 'This work is paused. Resume it to make this decision.'
            : run.state.status === 'paused'
              ? 'The flow hit a limit and needs a flow revision, which you can make in the Ficus web app.'
              : 'The flow owns this step. Review it in the Ficus web app.'}
        </p>
        <a className="g-button g-button-quiet g-verb" href={webStreamUrl(stream.squadId, stream.id)}>
          <span className="g-verb-label">Open in Ficus</span>
          <span className="g-verb-help">See the whole work stream</span>
        </a>
      </div>
    )
  }
  return (
    <div className="g-action">
      {gates.map((attempt) => (
        <HumanGate
          key={attempt.id}
          stream={stream}
          run={run}
          attempt={attempt}
          onOpenAgent={onOpenAgent}
          onDecided={onDecided}
        />
      ))}
      {delivery && <DeliveryApproval stream={stream} run={run} onOpenAgent={onOpenAgent} onDecided={onDecided} />}
    </div>
  )
}

function HumanGate({
  stream,
  run,
  attempt,
  onOpenAgent,
  onDecided,
}: {
  stream: WorkStream
  run: WorkflowRunDetail
  attempt: WorkflowAttempt
  onOpenAgent?: (agentId: string) => void
  onDecided?: () => void
}) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const onDecidedRef = useStableRef(onDecided)
  const { can, identity } = usePermissions(stream.squadId)
  const [evidence, setEvidence] = useState('')
  const notesId = useId()
  const advance = useMutation({
    mutationFn: (outcome: string) =>
      api.advanceWorkflow(
        stream.id,
        { action: 'complete', expectedVersion: run.version, attemptId: attempt.id, outcome, evidence, resume: false },
        api.newRequestId()
      ),
    onSuccess: async () => {
      setEvidence('')
      await refreshWorkflow(queryClient, stream.id)
      onDecidedRef.current?.()
    },
  })
  const step = stepOf(run.state, attempt)
  if (step?.kind !== 'human-approval') return null
  const waits = run.openWaits ?? stream.openWaits ?? []
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
  const title = step.name ?? step.id

  return (
    <section className="g-decision" aria-label={`Review ${title}`}>
      <p className="g-decision-tag">{canDecide ? 'Your review' : 'Awaiting review'}</p>
      <h3 className="g-decision-title">{title}</h3>
      <ActionText>{step.instructions}</ActionText>
      <ReviewMaterials stream={stream} run={run} attempts={sources} onOpenAgent={onOpenAgent} />
      {canDecide ? (
        <>
          <label className="g-field" htmlFor={`${notesId}-notes`}>
            Decision notes
          </label>
          <textarea
            id={`${notesId}-notes`}
            className="g-textarea"
            rows={3}
            aria-describedby={`${notesId}-hint`}
            placeholder="What you checked and why you decided"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
          <p id={`${notesId}-hint`} className="g-action-note">
            Required. Your notes are recorded with the decision and passed to the next step.
          </p>
          <div className="g-action-row">
            {Object.entries(step.outcomes).map(([outcome, transition]) => (
              <VerbButton
                key={outcome}
                verb={outcomeLabel(outcome)}
                busyVerb={`${outcomeLabel(outcome)}…`}
                help={outcomeEffect(run.state, transition)}
                tone={outcome === firstForward ? 'harvest' : 'returnTo' in transition ? 'prune' : 'plain'}
                busy={advance.isPending && advance.variables === outcome}
                disabled={advance.isPending || !evidence.trim() || blockingWaits.length > 0}
                onClick={() => advance.mutate(outcome)}
              />
            ))}
          </div>
          {blockingWaits.length > 0 && (
            <p className="g-action-note">Resolve the other open waits on this step before deciding.</p>
          )}
        </>
      ) : (
        <p className="g-action-note">
          {can('workstreams:review')
            ? 'Only the reviewers assigned to this work stream can decide.'
            : 'You need review permission in this squad to decide.'}
        </p>
      )}
      <ErrorNote error={advance.error} />
    </section>
  )
}

function DeliveryApproval({
  stream,
  run,
  onOpenAgent,
  onDecided,
}: {
  stream: WorkStream
  run: WorkflowRunDetail
  onOpenAgent?: (agentId: string) => void
  onDecided?: () => void
}) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const onDecidedRef = useStableRef(onDecided)
  const { can, identity } = usePermissions(stream.squadId)
  const [pruning, setPruning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackId = useId()
  const reworkAttempt = workflowReworkAttempt(run.state)
  const done = async () => {
    await refreshWorkflow(queryClient, stream.id)
    onDecidedRef.current?.()
  }
  const finish = useMutation({
    mutationFn: () => api.finishWorkflow(stream.id, run.version),
    onSuccess: done,
  })
  const sendBack = useMutation({
    mutationFn: (attemptId: number) =>
      api.advanceWorkflow(
        stream.id,
        { action: 'rework', expectedVersion: run.version, attemptId, feedback },
        api.newRequestId()
      ),
    onSuccess: async () => {
      setFeedback('')
      setPruning(false)
      await done()
    },
  })
  const canDecide = identity?.type === 'user' && (can('workstreams:update') || can('workstreams:respond'))
  const pending = finish.isPending || sendBack.isPending

  return (
    <section className="g-decision" aria-label="Delivery approval">
      <p className="g-decision-tag">{canDecide ? 'Ready to harvest' : 'Awaiting approval'}</p>
      <h3 className="g-decision-title">Approve delivery</h3>
      <p className="g-action-note">
        The work is complete. Look it over, then harvest to finish the work stream, or prune to send it back with what
        needs to change.
      </p>
      <ReviewMaterials
        stream={stream}
        run={run}
        attempts={reworkAttempt ? [reworkAttempt] : []}
        onOpenAgent={onOpenAgent}
      />
      {!canDecide ? (
        <p className="g-action-note">You need permission to respond to this work stream to approve delivery.</p>
      ) : pruning && reworkAttempt ? (
        <>
          <label className="g-field" htmlFor={`${feedbackId}-feedback`}>
            What needs to change
          </label>
          <textarea
            id={`${feedbackId}-feedback`}
            className="g-textarea"
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className="g-action-row">
            <VerbButton
              verb="Prune"
              busyVerb="Pruning…"
              help="Send back with this note"
              tone="prune"
              busy={sendBack.isPending}
              disabled={pending || !feedback.trim()}
              onClick={() => sendBack.mutate(reworkAttempt.id)}
            />
            <VerbButton verb="Cancel" help="Keep it as it is" tone="quiet" onClick={() => setPruning(false)} />
          </div>
        </>
      ) : (
        <div className="g-action-row">
          <VerbButton
            verb="Harvest"
            busyVerb="Harvesting…"
            help="Approve and deliver"
            tone="harvest"
            busy={finish.isPending}
            disabled={pending}
            onClick={() => finish.mutate()}
          />
          {reworkAttempt && (
            <VerbButton
              verb="Prune"
              help="Send back with a note"
              tone="prune"
              disabled={pending}
              onClick={() => setPruning(true)}
            />
          )}
        </div>
      )}
      <ErrorNote error={finish.error ?? sendBack.error} />
    </section>
  )
}

/** What to look at: the pull requests and the handoffs that produced the work. */
function ReviewMaterials({
  stream,
  run,
  attempts,
  onOpenAgent,
}: {
  stream: WorkStream
  run: WorkflowRunDetail
  attempts: WorkflowAttempt[]
  onOpenAgent?: (agentId: string) => void
}) {
  const pullRequests = streamPullRequests(stream.metadata ?? {})
  const files = stream.files?.length ?? 0
  if (!pullRequests.length && !attempts.length && !files) return null
  return (
    <div className="g-materials">
      <h4 className="g-materials-title">What to review</h4>
      {pullRequests.map((pr) => {
        const label = `Pull request #${pr.number} · ${pr.repository}`
        return pr.url ? (
          <a key={pr.key} className="g-link" href={pr.url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <span key={pr.key}>{label}</span>
        )
      })}
      {attempts.map((attempt) => {
        const agentId = run.attemptAgents[attempt.id]
        return (
          <div key={attempt.id} className="g-material">
            <p className="g-material-head">
              {stepName(run.state, attempt.stepId)} · Attempt {attempt.id}
              {attempt.outcome ? ` · ${outcomeLabel(attempt.outcome)}` : ''}
              {agentId && onOpenAgent && (
                <button
                  type="button"
                  className="g-link-button"
                  aria-label={`Open ${attempt.stepId} attempt ${attempt.id} robot chat`}
                  onClick={() => onOpenAgent(agentId)}
                >
                  Open chat
                </button>
              )}
            </p>
            {attempt.evidence && <ActionText>{attempt.evidence}</ActionText>}
          </div>
        )
      })}
      {files > 0 && (
        <p className="g-action-note">
          {files === 1 ? '1 attached file' : `${files} attached files`} (open the work stream in Ficus to view).
        </p>
      )}
    </div>
  )
}
