import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import type { WorkStream } from '@ficus/shared'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { usePermissions } from '../hooks/usePermissions'
import { webStatus } from '../lib/statusPresentation'
import { workflowProgress, type WorkflowProgressState, type WorkflowProgressStep } from '../lib/workflowProgress'
import { CheckIcon, UndoIcon } from './icons'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from './loading/Skeleton'
import { useAgentTypeNames } from '../hooks/useAgentTypeNames'

/** One marker per state, different in shape as well as color so states never rely on color alone. */
function StepMarker({ state }: { state: WorkflowProgressState }) {
  const ring = 'flex h-4 w-4 shrink-0 items-center justify-center rounded-full'
  if (state === 'done')
    return (
      <span
        aria-hidden
        data-progress-state={state}
        className={clsx(ring, webStatus('success').surfaceClass, webStatus('success').textClass)}
      >
        <CheckIcon className="h-3 w-3" />
      </span>
    )
  if (state === 'rework')
    return (
      <span
        aria-hidden
        data-progress-state={state}
        className={clsx(ring, webStatus('attention').surfaceClass, webStatus('attention').textClass)}
      >
        <UndoIcon className="h-2.5 w-2.5" />
      </span>
    )
  if (state === 'active')
    return (
      <span aria-hidden data-progress-state={state} className={clsx(ring, webStatus('progress').surfaceClass)}>
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full animate-pulse motion-reduce:animate-none',
            webStatus('progress').markerClass
          )}
        />
      </span>
    )
  if (state === 'waiting')
    return (
      <span
        aria-hidden
        data-progress-state={state}
        className={clsx(ring, 'border-2', webStatus('humanWait').borderClass)}
      >
        <span className={clsx('h-1.5 w-1.5 rounded-full', webStatus('humanWait').markerClass)} />
      </span>
    )
  return (
    <span
      aria-hidden
      data-progress-state={state}
      className={clsx(
        ring,
        'border',
        state === 'queued' ? clsx('border-2', webStatus('queue').borderClass) : 'border-th-border',
        state === 'not-run' && 'border-dashed'
      )}
    />
  )
}

function StepRow({
  step,
  agentHref,
  onOpenAgent,
}: {
  step: WorkflowProgressStep
  agentHref?: string
  onOpenAgent?: () => void
}) {
  const current = step.state === 'active' || step.state === 'waiting' || step.state === 'rework'
  return (
    <li className="flex items-start gap-2.5" data-progress-step={step.id} aria-current={current ? 'step' : undefined}>
      <span className="mt-0.5">
        <StepMarker state={step.state} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span
          className={clsx(
            'min-w-0 wrap-break-word',
            step.state === 'upcoming' || step.state === 'not-run' ? 'text-secondary' : 'text-primary',
            current && 'font-medium'
          )}
        >
          {step.name}
        </span>
        <span className="text-xs text-muted">
          {agentHref ? (
            <Link
              to={agentHref}
              onClick={onOpenAgent}
              className="text-accent-light hover:text-link-hover hover:underline"
            >
              {step.who}
            </Link>
          ) : (
            step.who
          )}
          {step.parallel && ' · in parallel'}
        </span>
      </div>
      <span
        className={clsx(
          'shrink-0 text-xs',
          step.state === 'waiting'
            ? webStatus('humanWait').textClass
            : step.state === 'rework'
              ? webStatus('attention').textClass
              : 'text-secondary'
        )}
      >
        {step.label}
      </span>
    </li>
  )
}

/** Three placeholder rows shaped like steps, so the section keeps its place while the flow loads. */
function ProgressSkeleton() {
  return (
    <LoadingSurface label="Loading progress">
      <ol className="space-y-2">
        <SkeletonRows count={3}>
          {(index) => (
            <li key={index} className="flex items-center gap-2.5">
              <SkeletonBlock className="h-4 w-4 shrink-0 rounded-full" />
              <SkeletonLine className={index % 2 ? 'w-1/2' : 'w-2/3'} />
            </li>
          )}
        </SkeletonRows>
      </ol>
    </LoadingSurface>
  )
}

/**
 * Where the stream is up to: its flow as a compact step list, above the workflow graph disclosure.
 * The listing rule (and when a flow shows only its current steps) is documented on workflowProgress.
 * While the flow loads it holds its place with a skeleton; a stream without one shows nothing.
 */
export function WorkStreamProgress({ stream, onOpenAgent }: { stream: WorkStream; onOpenAgent?: () => void }) {
  const { data: run, isPending } = useQuery(queries.workflows.run(stream.id))
  const { slugFor } = useSquadSlugs()
  const { can, identity, isLoading: permissionsLoading } = usePermissions(stream.squadId)
  const hasApproval = !!run?.state.definition.steps.some((step) => step.kind === 'human-approval')
  // Names approvers; without it (loading, refused) they read "Assigned reviewer" or "Reviewer".
  const { data: reviewers } = useQuery({ ...queries.workflows.reviewers(stream.squadId), enabled: hasApproval })
  const typeNames = useAgentTypeNames()
  if (isPending)
    return (
      <section aria-label="Progress" className="space-y-2">
        <h3 className="text-xs font-medium text-secondary">Progress</h3>
        <ProgressSkeleton />
      </section>
    )
  if (!run) return null
  const progress = workflowProgress(run.state, {
    status: stream.status,
    openWaits: run.openWaits ?? stream.openWaits ?? [],
    attemptAgents: run.attemptAgents,
    paused: !!stream.pause,
    slotWait: stream.slotWait,
    assignedReviewerIds: stream.assignedReviewerIds ?? [],
    inactiveAssignedReviewerIds: stream.inactiveAssignedReviewerIds,
    requestingUserId: stream.requestingUserId,
    reviewers,
    viewer: permissionsLoading ? undefined : { can, identity },
    typeNames,
  })
  const agentHref = (step: WorkflowProgressStep) =>
    step.agentId ? `/squads/${slugFor(stream.squadId)}/agents?agent=${encodeURIComponent(step.agentId)}` : undefined
  return (
    <section aria-label="Progress" className="space-y-2">
      <h3 className="text-xs font-medium text-secondary">Progress</h3>
      {progress.kind === 'current' && (
        <p className="text-xs text-muted">
          This flow branches, so the workflow below shows its full shape. {progress.done} of {progress.total} steps
          done.
        </p>
      )}
      {progress.steps.length > 0 ? (
        <ol className="space-y-2 text-sm">
          {progress.steps.map((step) => (
            <StepRow key={step.id} step={step} agentHref={agentHref(step)} onOpenAgent={onOpenAgent} />
          ))}
        </ol>
      ) : (
        progress.kind === 'current' && <p className="text-sm text-secondary">No step is running right now.</p>
      )}
    </section>
  )
}
