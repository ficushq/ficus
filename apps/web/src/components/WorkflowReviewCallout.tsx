import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  codeHostDeliveryLabel,
  readDeliveryState,
  trackedResourceLabel,
  workflowReworkAttempt,
  type WorkflowAttempt,
  type WorkStream,
} from '@ficus/shared'
import type { WorkflowRunDetail as RunDetail } from '@ficus/client-core'
import { client } from '../api/clientInstance'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { usePermissions } from '../hooks/usePermissions'
import { useWorkflowRefresh } from '../hooks/useWorkflowRefresh'
import { actionErrorMessage } from '../lib/actionError'
import {
  attemptSummary,
  documentTitle,
  humanGateContext,
  openHumanGates,
  plainText,
  PULL_REQUEST_COMPLETION_MODES,
} from '../lib/workflowReview'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { queries } from '../queryOptions'
import { Badge, type BadgeColor } from './Badge'
import { ExpandableMarkdown } from './ExpandableMarkdown'
import { WorkflowReviewModal } from './WorkflowReviewModal'
import { ChatIcon, PullRequestIcon } from './icons'

/**
 * The attention surface for human gates, delivery approval and delivery checks.
 * It sits at the top of the work stream detail so the reviewer sees what needs a decision without
 * scrolling through the flow graph. A human gate is a compact summary here; reviewing it opens the
 * full review surface (`WorkflowReviewModal`), where the handoff reads as a document beside the decision.
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
  const gates = openHumanGates(stream, run, focusWaitId)
  const deliveryApproval =
    run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval'
  const deliveryCheck = run.state.status === 'completion-ready' && !deliveryApproval
  if (deliveryCheck) return <DeliveryCheck stream={stream} run={run} />
  if (!gates.length && !deliveryApproval) return null
  return (
    <div className="space-y-3">
      {gates.map((attempt) => (
        <HumanGateCard key={attempt.id} stream={stream} run={run} attempt={attempt} onOpenAgent={onOpenAgent} />
      ))}
      {deliveryApproval && <DeliveryApproval stream={stream} run={run} onOpenAgent={onOpenAgent} />}
    </div>
  )
}

/** Finishing verifies the existing server policy; it never promises a merge or approves a review. */
function DeliveryCheck({ stream, run }: { stream: WorkStream; run: RunDetail }) {
  const { can } = usePermissions(stream.squadId)
  const refresh = useWorkflowRefresh(stream)
  const finish = useMutation({
    mutationFn: () => client.workflows.finish(stream.id, run.version),
    onSuccess: refresh,
  })
  const canFinish = can('workstreams:update') || can('workstreams:respond')
  const pullRequests = workStreamPullRequests(stream.metadata ?? {})
  // The squad finishes a PR-mode stream itself when its pull request merges; the person's job is the PR.
  if (PULL_REQUEST_COMPLETION_MODES.has(run.state.definition.completion.mode) && pullRequests.length)
    return <PullRequestDelivery stream={stream} pullRequests={pullRequests} finish={canFinish ? finish : undefined} />
  if (!canFinish) return null
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

const PULL_REQUEST_STATE: Record<'open' | 'merged' | 'closed', { label: string; color: BadgeColor }> = {
  open: { label: 'Open', color: 'neutral' },
  merged: { label: 'Merged', color: 'success' },
  closed: { label: 'Closed', color: 'danger' },
}

/**
 * PR completion modes at completion-ready: the pull request is the work. Checking delivery is only a
 * manual fallback (the squad runs it when the PR merges), so it stays quiet here and appears only once
 * every delivery PR is known merged; otherwise it lives in the work stream's More actions menu.
 */
function PullRequestDelivery({
  stream,
  pullRequests,
  finish,
}: {
  stream: WorkStream
  pullRequests: ReturnType<typeof workStreamPullRequests>
  finish?: { isPending: boolean; error: Error | null; mutate: () => void }
}) {
  const states = readDeliveryState(stream.metadata).pullRequests
  const merged = pullRequests.every((pullRequest) => states[pullRequest.key]?.state === 'merged')
  const checks = codeHostDeliveryLabel(stream.delivery)
  const primary = pullRequests.find((pullRequest) => pullRequest.url)
  return (
    <section aria-label="Review pull request" className="p-4 rounded-xl bg-surface-secondary space-y-3">
      <h3 className="text-sm font-medium text-primary">Review pull request</h3>
      <ul className="space-y-1.5">
        {pullRequests.map((pullRequest) => {
          const state = states[pullRequest.key]?.state
          const label = (
            <>
              <PullRequestIcon className="h-4 w-4 shrink-0" />
              {trackedResourceLabel(pullRequest)}
            </>
          )
          return (
            <li key={pullRequest.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {pullRequest.url ? (
                <a
                  href={pullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-accent-light hover:text-link-hover hover:underline"
                >
                  {label}
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-medium text-primary">{label}</span>
              )}
              {state && <Badge color={PULL_REQUEST_STATE[state].color}>{PULL_REQUEST_STATE[state].label}</Badge>}
            </li>
          )
        })}
      </ul>
      {checks && <p className="text-xs text-secondary">{checks}</p>}
      <p className="text-sm text-secondary">When the PR merges, the squad completes this work stream automatically.</p>
      {(primary?.url || (finish && merged)) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {primary?.url && (
            <a
              href={primary.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ficus-button ficus-button-primary inline-flex min-h-10 items-center px-4 py-2 text-sm"
            >
              Open pull request
            </a>
          )}
          {finish && merged && (
            <button
              type="button"
              className="ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
              disabled={finish.isPending}
              onClick={() => finish.mutate()}
            >
              {finish.isPending ? 'Checking…' : 'Check delivery'}
            </button>
          )}
        </div>
      )}
      {finish?.error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {actionErrorMessage(finish.error)}
        </p>
      )}
    </section>
  )
}

/** A gate's summary: what it is, what it reviews, how it starts. Deciding happens in the review surface. */
function HumanGateCard({
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
  const { slugFor } = useSquadSlugs()
  const [reviewing, setReviewing] = useState(false)
  const gate = humanGateContext(stream, run, attempt, { can, identity })
  if (!gate) return null
  const name = gate.step.name ?? gate.step.id
  const instructions = plainText(gate.step.instructions)
  const proposal = gate.sources.map((source) => documentTitle(source.evidence)).find(Boolean)
  return (
    <section aria-label={`Review ${name}`} className="p-4 rounded-xl bg-surface-secondary space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <Badge color="review">{gate.canDecide ? 'Your review' : 'Awaiting review'}</Badge>
        <h3 className="text-sm font-medium text-primary">{name}</h3>
        {gate.gateWait && (
          <span className="text-xs text-muted ml-auto shrink-0">
            {new Date(gate.gateWait.openedAt).toLocaleString()}
          </span>
        )}
      </header>
      {gate.sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
          {gate.sources.map((source) => {
            const agentId = run.attemptAgents[source.id]
            return (
              <span key={source.id} className="inline-flex flex-wrap items-center gap-x-3">
                <span className="font-medium">{attemptSummary(run.state, source)}</span>
                {agentId && (
                  <Link
                    to={`/squads/${slugFor(stream.squadId)}/agents?agent=${encodeURIComponent(agentId)}`}
                    onClick={onOpenAgent}
                    className="inline-flex items-center gap-1 text-accent-light hover:underline"
                    aria-label={`Open ${source.stepId} attempt ${source.id} agent chat`}
                  >
                    <ChatIcon className="h-3.5 w-3.5" />
                    Open chat
                  </Link>
                )}
              </span>
            )
          })}
        </div>
      )}
      {instructions && (
        <p className="text-sm leading-relaxed text-secondary line-clamp-3" title={instructions}>
          {instructions}
        </p>
      )}
      {proposal && (
        <p className="text-sm text-primary">
          <span className="text-muted">Proposal · </span>
          <span className="font-medium">{proposal}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
        <button
          type="button"
          onClick={() => setReviewing(true)}
          className="ficus-button ficus-button-secondary min-h-10 px-4 py-2 text-sm"
        >
          {gate.canDecide ? 'Review and decide' : 'Read proposal'}
        </button>
        {gate.readOnlyReason && <p className="text-xs text-muted">{gate.readOnlyReason}</p>}
      </div>
      {reviewing && (
        <WorkflowReviewModal
          stream={stream}
          attemptId={attempt.id}
          onClose={() => setReviewing(false)}
          onOpenAgent={onOpenAgent}
          onOpenWorkStream={() => setReviewing(false)}
        />
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
  const refresh = useWorkflowRefresh(stream)
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
              <span className="font-medium">{attemptSummary(run.state, attempt)}</span>
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
              <ExpandableMarkdown className="mt-1" markdownClassName="text-secondary" label="handoff">
                {attempt.evidence}
              </ExpandableMarkdown>
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
