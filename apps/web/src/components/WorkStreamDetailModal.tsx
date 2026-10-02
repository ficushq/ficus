import { WorktreeCleanupSettings } from './WorktreeCleanupSettings'
import { workStreamTitle, workStreamWaitActor } from '@ficus/shared'
import { WORK_STREAM_STATUS_ROLE } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { getWsDisplayState, workStreamStatusLabel, workStreamWaitBadge } from '../lib/workStreamStatusPresentation'
export { getWsDisplayState, WS_STATUS_LABELS, WS_STATUS_BADGE_COLORS } from '../lib/workStreamStatusPresentation'
import { workStreamGithubRepository, workStreamPullRequests } from '../lib/workStreamGithub'
import { WorkStreamPauseControls } from './WorkStreamPauseControls'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { WorkflowReviewCallout } from './WorkflowReviewCallout'
import { WorkStreamDeliverySetupCallout } from './WorkStreamDeliverySetupCallout'
import clsx from 'clsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { resolveWorkStreamWait } from '../api/squads'
import { MarkdownContent } from './MarkdownContent'
import { Modal } from './Modal'
import { Badge, type BadgeColor } from './Badge'
import { WorkStreamFileList } from './WorkStreamFileCard'
import { GitHubIcon, PullRequestIcon } from './icons'
import { AttentionMenu } from './AttentionMenu'
import type { WorkStream, WorkStreamPriority, WorkStreamWait, Squad, Agent } from '@ficus/shared'
import { getAgentPrimaryLabel } from '../lib/agentDisplay'
import { computeWorkStreamElapsedMs } from '../lib/workStreamRuntime'
import { useTick } from '../hooks/useTick'
import { usePermissions } from '../hooks/usePermissions'
import { WorkStreamApprovalConfirmation } from './WorkStreamApprovalConfirmation'
import { WorkStreamQuestionWait } from './WorkStreamQuestionWait'
import { WorkStreamTrackedResources } from './WorkStreamTrackedResources'
import { actionErrorMessage } from '../lib/actionError'
import { LoadingSurface, SkeletonBlock, SkeletonRows } from './loading/Skeleton'

// --- Helpers (exported for use by WorkStreamListAll) ---

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

export function formatTokenBreakdown(tokens: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}): string {
  const parts = [`in: ${formatTokens(tokens.input)}`, `out: ${formatTokens(tokens.output)}`]
  if (tokens.cacheRead > 0) parts.push(`cache read: ${formatTokens(tokens.cacheRead)}`)
  if (tokens.cacheWrite > 0) parts.push(`cache write: ${formatTokens(tokens.cacheWrite)}`)
  return `(${parts.join(', ')})`
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatRelativeTime(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime()
  if (ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function getWorkStreamNextSteps(metadata: Record<string, unknown> | null | undefined): string | null {
  const nextSteps = metadata?.nextSteps
  if (typeof nextSteps !== 'string') return null
  const trimmed = nextSteps.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** A wait's badge: its display type, and for manual waits who must act. */
function WaitBadge({ wait, history }: { wait: WorkStreamWait; history?: boolean }) {
  const { label, color } = workStreamWaitBadge(wait, { history })
  return <Badge color={color}>{label}</Badge>
}

/** Friendly labels for a closed wait's resolution, shown in the audit history. */
const WAIT_RESOLUTION_LABELS: Record<string, string> = {
  approved: 'Approved',
  sent_back: 'Sent back',
  cleared: 'Cleared',
  satisfied: 'Satisfied',
  answered: 'Answered',
  canceled: 'Canceled',
}

export const WS_PRIORITY_BADGE_COLORS: Record<WorkStreamPriority, BadgeColor> = {
  critical: 'danger',
  high: 'externalWait',
  normal: 'neutral',
  low: 'neutral',
}

export const WS_COMPLETION_MODE_BADGE_COLORS: Record<WorkStream['completionMode'], BadgeColor> = {
  'pr-merge': 'accent-2',
  'pr-auto-merge': 'accent-3',
  'review-approval': 'accent-4',
  'direct-merge': 'accent-5',
  deliverable: 'neutral',
}

export const WS_COMPLETION_MODE_LABELS: Record<WorkStream['completionMode'], string> = {
  'pr-merge': 'pr-merge',
  'pr-auto-merge': 'PR (auto-merge)',
  'review-approval': 'review-approval',
  'direct-merge': 'direct-merge',
  deliverable: 'Deliverable',
}

// --- Modal component ---

export const WORKSTREAM_RESPONSE_CONTROL_CLASS =
  'w-full px-2 py-1 text-xs border border-th-border bg-surface text-primary placeholder:text-placeholder caret-accent rounded  focus:ring-1 focus:ring-accent focus:border-accent'

export function WorkStreamDetailModal({
  workStream: selectedWorkStream,
  squadMap,
  agentMap,
  workStreamMap = new Map(),
  onSelectWorkStream,
  focusWaitId,
  actionCanRespond,
  onClose,
}: {
  workStream: WorkStream
  squadMap: Map<string, Squad>
  agentMap: Map<string, Agent>
  workStreamMap?: Map<string, WorkStream>
  onSelectWorkStream?: (id: string) => void
  focusWaitId?: string
  /** Authoritative action capability when opened from Action Center. */
  actionCanRespond?: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // Callers may hold a selection snapshot. Subscribe centrally so every entry
  // point observes saved settings and authoritative lifecycle/cleanup updates.
  const { data: workStream = selectedWorkStream } = useQuery({
    ...queries.squads.workStreamDetail(selectedWorkStream.id),
    placeholderData: selectedWorkStream,
  })
  const { slugFor } = useSquadSlugs()
  const squad = squadMap.get(workStream.squadId)
  const metadata = workStream.metadata ?? {}
  const { can, isLoading: permissionsLoading } = usePermissions(workStream.squadId)
  const permissionCanRespond = !permissionsLoading && (can('workstreams:respond') || can('workstreams:update'))
  const canRespondToWait = actionCanRespond ?? permissionCanRespond

  // Fetch metrics separately (lazy load when modal opens)
  const { data: metrics, isLoading: metricsLoading } = useQuery(queries.squads.workStreamMetrics(workStream.id))

  const missingDependencyIds = Array.from(new Set(workStream.dependsOn)).filter(
    (dependencyId) => !workStreamMap.has(dependencyId)
  )
  const dependencyQueries = useQueries({
    queries: missingDependencyIds.map((id) => queries.squads.workStreamDetail(id)),
  })
  const resolvedWorkStreamMap = new Map(workStreamMap)
  for (const dependencyId of missingDependencyIds) {
    const cachedDependency = queryClient.getQueryData<WorkStream>(queryKeys.squads.workStreamDetail(dependencyId))
    if (cachedDependency) resolvedWorkStreamMap.set(cachedDependency.id, cachedDependency)
  }
  dependencyQueries.forEach((query) => {
    if (query.data) resolvedWorkStreamMap.set(query.data.id, query.data)
  })

  const knownAgentIds = Array.from(agentMap.keys())
  const missingAgentIds = Array.from(
    new Set(
      [
        workStream.assigneeAgentId,
        workStream.ownerAgentId,
        ...(workStream.agentIds ?? []),
        ...Object.keys(metrics?.byAgent ?? {}),
      ].filter(Boolean) as string[]
    )
  ).filter((agentId) => !agentMap.has(agentId) && !knownAgentIds.some((id) => id.startsWith(agentId)))
  const historicalAgentQueries = useQueries({ queries: missingAgentIds.map((id) => queries.agents.detail(id)) })
  const resolvedAgentMap = new Map(agentMap)
  if (typeof queryClient.getQueryData === 'function') {
    for (const agentId of missingAgentIds) {
      const cachedAgent = queryClient.getQueryData<Agent>(queryKeys.agents.detail(agentId))
      if (cachedAgent) resolvedAgentMap.set(cachedAgent.id, cachedAgent)
    }
  }
  historicalAgentQueries.forEach((query) => {
    if (query.data) resolvedAgentMap.set(query.data.id, query.data)
  })
  const assignee = workStream.assigneeAgentId ? resolvedAgentMap.get(workStream.assigneeAgentId) : null
  const owner = workStream.ownerAgentId ? resolvedAgentMap.get(workStream.ownerAgentId) : null
  const displayMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'nextSteps'))
  const hasMetadata = Object.keys(displayMetadata).length > 0

  // Open waits win over a running execution, sorted by display precedence (review > question >
  // dependency > manual) by the server. A review wait gets the Approve/Request-changes panel; a
  // manual wait gets a free-text respond panel. Dependency waits are read-only; a question wait
  // renders its agent question with the answer form above the usage metrics.
  const openWaits = workStream.openWaits ?? []
  const focusedWait = focusWaitId ? openWaits.find((wait) => wait.id === focusWaitId) : undefined
  const actionableFocusedWait =
    focusedWait?.type === 'review' || focusedWait?.type === 'manual' ? focusedWait : undefined
  const calloutWait = focusWaitId
    ? actionableFocusedWait
    : (openWaits.find((wait) => wait.type === 'review') ?? openWaits.find((wait) => wait.type === 'manual'))
  const reviewWait = calloutWait?.type === 'review' ? calloutWait : undefined
  const manualWait = calloutWait?.type === 'manual' ? calloutWait : undefined
  const needsResponse = !!calloutWait && calloutWait.resolutionHandler !== 'workflow'
  const missingFocusedWait = !!focusWaitId && !actionableFocusedWait && focusedWait?.type !== 'question'
  const questionWaits = openWaits.filter((wait) => wait.type === 'question')
  const remainingWaits = openWaits.filter((wait) => wait.id !== calloutWait?.id && wait.type !== 'question')

  const [isResponding, setIsResponding] = useState(false)
  const [response, setResponse] = useState('')
  const [showApprovalConfirmation, setShowApprovalConfirmation] = useState(false)

  const respondMutation = useMutation({
    mutationFn: ({
      waitId,
      resolution,
      note,
    }: {
      waitId: string
      resolution: 'approved' | 'sent_back' | 'cleared'
      note?: string
    }) => resolveWorkStreamWait(workStream.id, waitId, { resolution, note }),
    onSuccess: (_result, variables) => {
      const actionType = variables.resolution === 'cleared' ? 'workstream-blocked' : 'workstream-review'
      const actionId = `${actionType}:${workStream.id}:${variables.waitId}`
      queryClient.setQueryData<import('@ficus/shared').PendingAction[]>(queryKeys.actions.pending(), (current) =>
        current?.filter((action) => action.id !== actionId)
      )
      queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.allWorkStreams() })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.workStreams(workStream.squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreamsPrefix() })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreams(workStream.squadId) })
      queryClient.invalidateQueries({ queryKey: [...queryKeys.squads.all, 'doneWorkStreams'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.workStreamDetail(workStream.id) })
      setIsResponding(false)
      setShowApprovalConfirmation(false)
      setResponse('')
    },
  })

  // The respond box serves the top actionable wait: for a review wait it is
  // the Request Changes feedback (sent_back, note required); for a manual
  // wait it is the input the assignee asked for (cleared + note).
  function handleSubmit() {
    if (reviewWait) {
      respondMutation.mutate({ waitId: reviewWait.id, resolution: 'sent_back', note: response })
    } else if (manualWait) {
      respondMutation.mutate({ waitId: manualWait.id, resolution: 'cleared', note: response })
    }
  }

  const headerExtra = <WorkStreamStatusBadges workStream={workStream} showQueuePosition />

  const hasActiveRuntime = (workStream.runtime?.activeCount ?? 0) > 0
  const now = useTick(1000, hasActiveRuntime)
  const elapsed = computeWorkStreamElapsedMs(workStream, now)
  const githubRepository = workStreamGithubRepository(metadata)
  const pullRequests = workStreamPullRequests(metadata)
  const nextSteps = getWorkStreamNextSteps(metadata)

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={workStreamTitle(workStream)}
      headerExtra={headerExtra}
      headerActions={<AttentionMenu target={{ kind: 'workStream', id: workStream.id }} align="right" />}
      maxWidth="readable"
    >
      <div className="space-y-6 text-sm [&>details:not([open])+div:last-child]:!mt-3">
        {workStream.status !== 'done' && workStream.status !== 'canceled' && (
          <WorkStreamPauseControls stream={workStream} />
        )}

        {/* Review/manual wait respond panel */}
        {missingFocusedWait && (
          <p role="status" className="p-3 text-xs text-muted border border-th-border rounded">
            This focused action is no longer pending.
          </p>
        )}
        <WorkflowReviewCallout
          key={`review:${focusWaitId ?? workStream.id}`}
          stream={workStream}
          focusWaitId={focusWaitId}
          onOpenAgent={onClose}
        />
        <WorkStreamDeliverySetupCallout stream={workStream} />
        {needsResponse && (
          <div className="p-4 rounded-xl bg-surface-secondary">
            <div className="flex items-center gap-2 mb-1.5">
              {reviewWait ? <Badge color="review">Review</Badge> : manualWait && <WaitBadge wait={manualWait} />}
              {reviewWait && workStream.reviewRounds != null && (
                <span className="text-xs text-muted">Round {workStream.reviewRounds + 1}</span>
              )}
              {calloutWait?.flowAttemptId != null && (
                <span className="text-xs text-secondary">Attempt {calloutWait.flowAttemptId}</span>
              )}
              {calloutWait && (
                <span className="text-xs text-muted ml-auto shrink-0">
                  {new Date(calloutWait.openedAt).toLocaleString()}
                </span>
              )}
            </div>
            <div className="text-sm text-secondary max-h-64 overflow-y-auto">
              <MarkdownContent className="prose-xs">
                {(reviewWait ? (reviewWait.message ?? workStream.handoffMessage) : manualWait?.message) ?? ''}
              </MarkdownContent>
            </div>
            {manualWait && workStreamWaitActor(manualWait) !== 'human' && (
              <p className="mt-1.5 text-xs text-muted">
                The stream&apos;s owner agent clears this wait; no action is needed from you.
              </p>
            )}

            {respondMutation.isError && (
              <p role="alert" className="mt-2 text-xs text-status-danger-600 dark:text-status-danger-400">
                {actionErrorMessage(respondMutation.error)}
              </p>
            )}
            {isResponding ? (
              <div className="mt-2">
                <input
                  type="text"
                  value={response}
                  onChange={(e) => setResponse(e.target.value)}
                  placeholder="Your response..."
                  className={clsx('ficus-field', WORKSTREAM_RESPONSE_CONTROL_CLASS)}
                />
                <div className="flex gap-1 mt-2">
                  <button
                    onClick={handleSubmit}
                    disabled={respondMutation.isPending || !canRespondToWait || !response.trim()}
                    className="ficus-button ficus-button-primary px-2 py-1 text-xs font-medium text-on-accent bg-accent rounded hover:bg-accent-hover disabled:opacity-50"
                    title={
                      canRespondToWait ? 'Submit response' : 'You do not have permission to respond to this work stream'
                    }
                  >
                    {respondMutation.isPending ? 'Submitting...' : 'Submit'}
                  </button>
                  <button
                    onClick={() => setIsResponding(false)}
                    className="ficus-button px-2 py-1 text-xs font-medium text-secondary border border-th-border rounded hover:bg-surface-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : reviewWait ? (
              <div className="flex gap-1 mt-2">
                <button
                  onClick={() => setShowApprovalConfirmation(true)}
                  disabled={respondMutation.isPending || !canRespondToWait}
                  className="ficus-button px-2 py-1 text-xs font-medium text-on-accent bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50"
                  title={
                    canRespondToWait ? 'Approve review' : 'You do not have permission to respond to this work stream'
                  }
                >
                  {reviewWait.completesOnApproval ? 'Approve and complete' : 'Approve checkpoint'}
                </button>
                <button
                  onClick={() => {
                    setIsResponding(true)
                    setResponse('')
                  }}
                  disabled={!canRespondToWait}
                  className="ficus-button px-2 py-1 text-xs font-medium text-secondary bg-surface-hover rounded-lg hover:bg-surface disabled:opacity-50"
                  title={
                    canRespondToWait ? 'Request changes' : 'You do not have permission to respond to this work stream'
                  }
                >
                  {reviewWait.completesOnApproval ? 'Send back' : 'Send checkpoint back'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setIsResponding(true)}
                disabled={!canRespondToWait}
                className="ficus-button mt-2 px-2 py-1 text-xs font-medium text-on-accent bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50"
                title={canRespondToWait ? 'Respond' : 'You do not have permission to respond to this work stream'}
              >
                Respond
              </button>
            )}
          </div>
        )}

        {/* Metadata summary */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <div>
            <label className="text-xs font-medium text-secondary">Squad</label>
            {squad ? (
              <Link
                to={`/squads/${slugFor(squad.id)}`}
                className="block mt-0.5 text-accent-light hover:text-link-hover hover:underline"
                onClick={onClose}
              >
                {squad.name}
              </Link>
            ) : (
              <p className="text-muted mt-0.5 italic">Unknown squad</p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-secondary">Assignee</label>
            {assignee ? (
              <div className="mt-0.5">
                <Link
                  to={`/squads/${slugFor(workStream.squadId)}?agent=${assignee.id}`}
                  className="text-accent-light hover:text-link-hover hover:underline"
                  onClick={onClose}
                >
                  {getAgentPrimaryLabel(assignee)}
                </Link>
                <p className="text-xs text-muted">{assignee.agentTypeId}</p>
              </div>
            ) : squad?.managerAgentId ? (
              <div className="mt-0.5">
                <Link
                  to={`/squads/${slugFor(workStream.squadId)}?agent=${squad.managerAgentId}`}
                  className="text-accent-light hover:text-link-hover hover:underline"
                  onClick={onClose}
                >
                  Squad Manager
                </Link>
              </div>
            ) : (
              <p className="text-muted mt-0.5 italic">Unassigned</p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-secondary">Owner</label>
            {owner ? (
              <div className="mt-0.5">
                <Link
                  to={`/squads/${slugFor(owner.squadId ?? workStream.squadId)}?agent=${owner.id}`}
                  className="text-accent-light hover:text-link-hover hover:underline"
                  onClick={onClose}
                >
                  {getAgentPrimaryLabel(owner)}
                </Link>
                <p className="text-xs text-muted">{owner.agentTypeId}</p>
              </div>
            ) : workStream.ownerAgentId ? (
              <p className="font-mono text-xs text-secondary mt-0.5">{workStream.ownerAgentId.slice(0, 8)}</p>
            ) : (
              <p className="text-muted mt-0.5 italic">None</p>
            )}
          </div>
          {workStream.requestingUserId && (
            <div>
              <label className="text-xs font-medium text-secondary">Requested By</label>
              <p className="text-primary mt-0.5">
                {workStream.requestingUserName || 'Unknown user'}{' '}
                <span className="font-mono text-xs text-muted">[{workStream.requestingUserId.slice(0, 8)}]</span>
              </p>
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-secondary">Runtime</label>
            <p className="text-primary mt-0.5" title="Total agent execution runtime">
              {formatElapsed(elapsed)}
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-secondary">Priority</label>
            <p className="text-primary mt-0.5">
              {workStream.priority ?? 'normal'}
              {workStream.effectivePriority && workStream.effectivePriority !== (workStream.priority ?? 'normal') && (
                <>
                  {' '}
                  — effective {workStream.effectivePriority}
                  {workStream.effectivePriorityVia ? ` via ${workStream.effectivePriorityVia}` : ''}
                </>
              )}
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-secondary">Completion</label>
            <div className="mt-0.5">
              <Badge color={WS_COMPLETION_MODE_BADGE_COLORS[workStream.completionMode]}>
                {WS_COMPLETION_MODE_LABELS[workStream.completionMode]}
              </Badge>
            </div>
          </div>
          {githubRepository && (
            <div className="min-w-0">
              <label className="text-xs font-medium text-secondary">Repository</label>
              <div className="mt-0.5">
                <a
                  href={githubRepository.repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-start gap-1.5 text-accent hover:underline break-words"
                >
                  <GitHubIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{githubRepository.repository}</span>
                </a>
              </div>
            </div>
          )}
          {pullRequests.length > 0 && (
            <div className="min-w-0">
              <label className="text-xs font-medium text-secondary">Pull request</label>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {pullRequests.map((pullRequest) => {
                  const number = (
                    <span className="inline-flex items-center gap-1">
                      <PullRequestIcon className="w-3.5 h-3.5 shrink-0" />#{pullRequest.number}
                    </span>
                  )
                  return pullRequest.url ? (
                    <a
                      key={pullRequest.key}
                      href={pullRequest.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-accent hover:underline"
                    >
                      {number}
                    </a>
                  ) : (
                    <span key={pullRequest.key} className="inline-flex items-center gap-1.5 text-secondary">
                      {number}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
          {/* A full-width row inside the details grid: pending questions stay
              immediately after these details. */}
          <div className="col-span-2 min-w-0 sm:col-span-3">
            <WorkStreamTrackedResources
              workStreamId={workStream.id}
              canUpdate={!permissionsLoading && can('workstreams:update')}
            />
          </div>
        </div>

        {/* Question waits take priority over usage statistics, even while metrics load. */}
        {questionWaits.length > 0 && (
          <section aria-label="Pending questions">
            <h3 className="text-xs font-medium text-secondary">Pending Questions</h3>
            <ul className="mt-1 space-y-1.5">
              {questionWaits.map((wait) => (
                <li key={wait.id} className="text-xs rounded-lg p-3 bg-surface-secondary">
                  <div className="flex flex-wrap items-center gap-2">
                    <WaitBadge wait={wait} />
                    {wait.flowAttemptId != null && <span className="text-muted">Attempt {wait.flowAttemptId}</span>}
                    <span className="text-muted ml-auto">{new Date(wait.openedAt).toLocaleString()}</span>
                  </div>
                  {wait.message && (
                    <div className="mt-1 text-primary">
                      <MarkdownContent className="prose-xs">{wait.message}</MarkdownContent>
                    </div>
                  )}
                  <WorkStreamQuestionWait
                    wait={wait}
                    agentThreadHref={
                      wait.createdByAgentId
                        ? `/squads/${slugFor(workStream.squadId)}?agent=${wait.createdByAgentId}`
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Metrics */}
        {metrics && (
          <div className="border-t border-panel-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <div>
                  <span className="text-muted">Cost:</span>{' '}
                  <span className="font-medium text-primary">{formatCost(metrics.cost)}</span>
                </div>
                <div>
                  <span className="text-muted">Tokens:</span>{' '}
                  <span className="font-medium text-primary">{formatTokens(metrics.tokens.total)}</span>
                </div>
                <div>
                  <span className="text-muted">Executions:</span>{' '}
                  <span className="font-medium text-primary">
                    {metrics.executions.completed}/{metrics.executions.total}
                  </span>
                </div>
              </div>
            </div>
            <details className="mt-3 text-xs text-muted">
              <summary className="cursor-pointer py-1 text-accent-light">Usage breakdown</summary>
              <p className="mt-2">{formatTokenBreakdown(metrics.tokens)}</p>
              {/* Per-agent breakdown */}
              {Object.keys(metrics.byAgent).length > 0 && (
                <div className="mt-3 pt-3 border-t border-th-border">
                  <table className="ficus-table w-full text-xs">
                    <thead>
                      <tr className="text-muted">
                        <th className="text-left font-medium pb-1">Agent</th>
                        <th className="text-right font-medium pb-1">Tokens</th>
                        <th className="text-right font-medium pb-1">Cost</th>
                        <th className="text-right font-medium pb-1">Runs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(metrics.byAgent).map(([agentId, agentMetrics]) => {
                        const agent = resolvedAgentMap.get(agentId)
                        return (
                          <tr key={agentId} className="text-primary">
                            <td className="py-0.5">
                              {agent ? (
                                <Link
                                  to={`/squads/${slugFor(workStream.squadId)}?agent=${agentId}`}
                                  className="text-accent-light hover:text-link-hover hover:underline"
                                  onClick={onClose}
                                >
                                  {getAgentPrimaryLabel(agent)}
                                </Link>
                              ) : (
                                <span className="font-mono">{agentId.slice(0, 8)}</span>
                              )}
                            </td>
                            <td className="text-right py-0.5">{formatTokens(agentMetrics.tokens)}</td>
                            <td className="text-right py-0.5">{formatCost(agentMetrics.cost)}</td>
                            <td className="text-right py-0.5">{agentMetrics.executions}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          </div>
        )}
        {metricsLoading && (
          <LoadingSurface label="Loading work stream metrics" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SkeletonRows count={4}>
              {(index) => (
                <div key={index} className="space-y-2 rounded-md bg-surface-secondary p-2">
                  <SkeletonBlock className="h-2.5 w-12" />
                  <SkeletonBlock className={index % 2 ? 'h-4 w-16' : 'h-4 w-12'} />
                </div>
              )}
            </SkeletonRows>
          </LoadingSurface>
        )}

        <WorkflowRunPanel
          key={focusWaitId ?? workStream.id}
          stream={workStream}
          onOpenAgent={onClose}
          focusWaitId={focusWaitId}
        />

        {/* Next steps */}
        {nextSteps && (
          <div>
            <label className="text-xs font-medium text-secondary">Next Steps</label>
            <div className="mt-3 text-sm leading-relaxed text-secondary">
              <MarkdownContent className="prose-xs">{nextSteps}</MarkdownContent>
            </div>
          </div>
        )}

        {/* Description */}
        {workStream.description && (
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <label className="text-xs font-medium text-secondary">Description</label>
            <div className="mt-3 text-sm leading-relaxed text-secondary">
              <MarkdownContent className="prose-xs">{workStream.description}</MarkdownContent>
            </div>
          </div>
        )}

        {/* Files */}
        {workStream.files && workStream.files.length > 0 && (
          <div>
            <label className="text-xs font-medium text-secondary">Files</label>
            <WorkStreamFileList files={workStream.files} squadId={workStream.squadId} />
          </div>
        )}

        {/* Dependencies */}
        {workStream.dependsOn.length > 0 && (
          <div>
            <label className="text-xs font-medium text-secondary">Depends On</label>
            <ul className="mt-0.5 space-y-0.5">
              {workStream.dependsOn.map((depId) => {
                const dependency = resolvedWorkStreamMap.get(depId)
                const label = dependency?.title ?? depId.slice(0, 8)
                const dependencyState = dependency ? getWsDisplayState(dependency) : null
                const dependencyTreatment = dependencyState
                  ? webStatus(WORK_STREAM_STATUS_ROLE[dependencyState])
                  : webStatus('neutral')
                return (
                  <li key={depId} className="text-xs">
                    <button
                      type="button"
                      aria-label={`Open dependency ${label}`}
                      onClick={() => onSelectWorkStream?.(depId)}
                      disabled={!onSelectWorkStream}
                      className="ficus-button inline-flex items-center gap-1.5 text-accent-light hover:underline disabled:text-secondary disabled:no-underline"
                    >
                      <span
                        aria-label={dependency ? `${workStreamStatusLabel(dependency)} status` : 'Unknown status'}
                        className={clsx('h-2 w-2 rounded-full', dependencyTreatment.markerClass)}
                      />
                      {label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Assigned Agents */}
        {workStream.agentIds && workStream.agentIds.length > 0 && (
          <div>
            <label className="text-xs font-medium text-secondary">Assigned Agents</label>
            <ul className="mt-0.5 space-y-1">
              {workStream.agentIds.map((agentIdOrPrefix) => {
                // Try to find matching agent (supports prefix matching)
                const matchingAgent = Array.from(resolvedAgentMap.values()).find(
                  (a) => a.id === agentIdOrPrefix || a.id.startsWith(agentIdOrPrefix)
                )
                return (
                  <li key={agentIdOrPrefix} className="text-xs">
                    {matchingAgent ? (
                      <Link
                        to={`/squads/${slugFor(workStream.squadId)}?agent=${matchingAgent.id}`}
                        className="text-accent-light hover:text-link-hover hover:underline"
                        onClick={onClose}
                      >
                        {getAgentPrimaryLabel(matchingAgent)}
                        <span className="text-muted ml-1">({matchingAgent.agentTypeId})</span>
                      </Link>
                    ) : (
                      <span className="font-mono text-secondary">{agentIdOrPrefix.slice(0, 8)}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <WorktreeCleanupSettings stream={workStream} />

        {/* Metadata */}
        {(hasMetadata || workStream.branch || workStream.baseBranch) && (
          <details className="border-t border-panel-border pt-4">
            <summary className="cursor-pointer text-sm font-medium text-secondary hover:text-primary">
              Technical details
            </summary>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {' '}
              {workStream.branch && (
                <div>
                  <label className="text-xs font-medium text-secondary">Branch</label>
                  <p className="text-primary mt-0.5 break-all font-mono text-xs">{workStream.branch}</p>
                </div>
              )}
              {workStream.baseBranch && (
                <div>
                  <label className="text-xs font-medium text-secondary">Base Branch</label>
                  <p className="text-primary mt-0.5 break-all font-mono text-xs">{workStream.baseBranch}</p>
                </div>
              )}
            </div>
            {hasMetadata && <p className="mt-4 text-xs text-muted">Metadata</p>}
            <dl className="mt-1 space-y-1.5">
              {Object.entries(displayMetadata).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-muted">{key}</dt>
                  <dd className="text-xs font-mono text-secondary whitespace-pre-wrap break-words">
                    {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}

        {/* Open waits not already shown in the respond panel or question section above */}
        {remainingWaits.length > 0 && (
          <div>
            <label className="text-xs font-medium text-secondary">Open Waits</label>
            <ul className="mt-1 space-y-1.5">
              {remainingWaits.map((wait) => (
                <li key={wait.id} className={clsx('text-xs rounded-lg p-3 bg-surface-secondary')}>
                  <div className="flex items-center gap-2">
                    <WaitBadge wait={wait} />
                    {wait.flowAttemptId != null && <span className="text-muted">Attempt {wait.flowAttemptId}</span>}
                    {wait.type === 'review' && workStream.reviewRounds != null && (
                      <span className="text-muted">Round {workStream.reviewRounds + 1}</span>
                    )}
                    <span className="text-muted ml-auto shrink-0">{new Date(wait.openedAt).toLocaleString()}</span>
                  </div>
                  {wait.message && (
                    <div className="mt-1 text-primary">
                      <MarkdownContent className="prose-xs">{wait.message}</MarkdownContent>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Wait history — the full auditable trail of EVERY resolved wait (all
            types), default-collapsed. Resolving a wait never deletes it, so this
            is the durable record of what the stream waited on and how each was
            resolved (incl. manual waits, previously invisible in the UI). */}
        {(() => {
          const closed = (workStream.waitHistory ?? []).filter((wait) => wait.closedAt)
          if (closed.length === 0) return null
          return (
            <details className="group">
              <summary className="text-xs font-medium text-secondary cursor-pointer select-none">
                Wait history ({closed.length})
              </summary>
              <ul className="mt-1 space-y-1.5">
                {closed.map((wait) => (
                  <li key={wait.id} className="text-xs bg-surface-secondary rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <WaitBadge wait={wait} history />
                      {wait.flowAttemptId != null && <span className="text-muted">Attempt {wait.flowAttemptId}</span>}
                      {wait.resolution && (
                        <span className="text-muted">{WAIT_RESOLUTION_LABELS[wait.resolution] ?? wait.resolution}</span>
                      )}
                      <span className="text-muted ml-auto shrink-0">
                        {wait.closedAt ? new Date(wait.closedAt).toLocaleString() : ''}
                      </span>
                    </div>
                    {(wait.resolutionNote || wait.message) && (
                      <div className="mt-1 text-primary">
                        <MarkdownContent className="prose-xs">
                          {wait.resolutionNote || wait.message || ''}
                        </MarkdownContent>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )
        })()}

        {/* Footer: timestamps */}
        <div className="border-t border-th-border pt-3 flex items-center gap-4 text-xs text-muted">
          <span title={new Date(workStream.createdAt).toLocaleString()}>
            Created {formatRelativeTime(workStream.createdAt)}
          </span>
          <span title={new Date(workStream.updatedAt).toLocaleString()}>
            Updated {formatRelativeTime(workStream.updatedAt)}
          </span>
        </div>
      </div>
      <WorkStreamApprovalConfirmation
        isOpen={showApprovalConfirmation}
        completionMode={workStream.completionMode}
        completesOnApproval={reviewWait?.completesOnApproval ?? true}
        isPending={respondMutation.isPending}
        error={respondMutation.isError ? actionErrorMessage(respondMutation.error) : null}
        onCancel={() => setShowApprovalConfirmation(false)}
        onConfirm={() => reviewWait && respondMutation.mutate({ waitId: reviewWait.id, resolution: 'approved' })}
      />
    </Modal>
  )
}
