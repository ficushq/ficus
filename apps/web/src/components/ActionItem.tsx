import { StructuredInputActions, AgentRecoveryActions } from './StructuredInputActions'
import { AttemptLimitActions } from './AttemptLimitActions'
import clsx from 'clsx'
import { assistantConversationSearch } from '../lib/assistantConversationSearch'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { QuestionInput } from './QuestionInput'
import { AgentQuestionCard } from './AgentQuestionCard'
import { RejectionModal } from './RejectionModal'
import { ChevronDownIcon, ChevronRightIcon } from './icons'
import { useActionCenter } from './ActionCenterContext'
import { MarkdownContent } from './MarkdownContent'
import { MultilineResponseField } from './MultilineResponseField'
import { WorkStreamFileList } from './WorkStreamFileCard'
import { WorkStreamViewModal } from './WorkStreamViewModal'
import { WorkflowReviewLauncher } from './WorkflowReviewModal'
import { WorkStreamApprovalConfirmation } from './WorkStreamApprovalConfirmation'
import { sendAgentMessage, continueHaltedAgents } from '../api/agents'
import { resolveWorkStreamWait } from '../api/squads'
import { retryAgentQuestionAnswerDelivery, dismissAgentQuestionDeliveryFailure } from '../api/agentQuestions'
import { actionErrorMessage } from '../lib/actionError'
import type {
  PendingAction,
  SquadQuestionActionData,
  AgentQuestionActionData,
  AgentErrorActionData,
  AssistantTaskActionData,
  WorkStreamActionData,
  WorkStreamDeliveryActionData,
} from '@ficus/shared'
import { WORK_STREAM_STATUS_ROLE, type StatusRole } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
import {
  workStreamActionPresentationState,
  WS_STATUS_ICONS,
  WS_STATUS_LABELS,
} from '../lib/workStreamStatusPresentation'

/** Icon/role/label for actions that are not about a work stream. */
const NON_WORK_STREAM_ACTION_STATUS: Record<
  Exclude<PendingAction['type'], 'workstream-review' | 'workstream-blocked' | 'workstream-delivery'>,
  ActionStatusPresentation
> = {
  'agent-error': { icon: '!', role: 'danger', label: 'Agent halted' },
  'squad-question': { icon: '?', role: 'humanWait', label: 'Needs your input' },
  'agent-question': { icon: '?', role: 'humanWait', label: 'Needs your answer' },
  'assistant-needs-input': { icon: '?', role: 'humanWait', label: 'Needs your answer' },
}

interface ActionStatusPresentation {
  icon: string
  role: StatusRole
  label: string
}

/**
 * The status glyph, color role and accessible label for an action. Work-stream
 * actions use the same state, glyph, role and label as the stream's row in the
 * work list, so a review gate reads as a review (◎) and only a manual wait a
 * person must clear reads as blocked (⊘). Errors keep the danger treatment.
 */
function actionStatusPresentation(action: PendingAction): ActionStatusPresentation {
  const state = workStreamActionPresentationState(action)
  if (state)
    return { icon: WS_STATUS_ICONS[state], role: WORK_STREAM_STATUS_ROLE[state], label: WS_STATUS_LABELS[state] }
  return (
    NON_WORK_STREAM_ACTION_STATUS[action.type as keyof typeof NON_WORK_STREAM_ACTION_STATUS] ?? {
      icon: '•',
      role: 'neutral',
      label: 'Pending action',
    }
  )
}

// Link to an agent's conversation thread (squad agents open in the squad view; personal agents in chat).
function agentThreadPath(agentId: string, squadId: string | null): string {
  return squadId ? `/squads/${squadId}?agent=${agentId}` : `/chat/${agentId}`
}

interface ActionItemProps {
  action: PendingAction
  continueHaltedActions?: typeof continueHaltedAgents
  focused?: boolean
  defaultExpanded?: boolean
  embedded?: boolean
}

export function ActionItem({
  action,
  continueHaltedActions = continueHaltedAgents,
  focused = false,
  defaultExpanded = false,
  embedded = false,
}: ActionItemProps) {
  const [isExpanded, setExpanded] = useState(defaultExpanded)
  const expanded = embedded || isExpanded
  const itemRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focused) return
    setExpanded(true)
    const frame = requestAnimationFrame(() => {
      itemRef.current?.scrollIntoView({ block: 'nearest' })
      itemRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focused])
  const [showWsModal, setShowWsModal] = useState(false)
  const queryClient = useQueryClient()
  const { closeActionCenter } = useActionCenter()

  const isWorkStreamAction = action.type === 'workstream-review' || action.type === 'workstream-blocked'
  const deliveryGate = action.type === 'workstream-delivery' ? (action.data as WorkStreamDeliveryActionData) : null
  const linkedPullRequests = deliveryGate ? deliveryGate.pullRequests.filter((pullRequest) => pullRequest.url) : []
  const status = actionStatusPresentation(action)
  // A workflow review gate's only action is the header's Review, and the review screen's decision
  // brief carries its instructions, so the card has nothing to expand. Embedded previews keep the
  // gate message; typed inputs keep their controls.
  const blockedWait = action.type === 'workstream-blocked' ? (action.data as WorkStreamActionData).wait : null
  const workflowReviewGate =
    blockedWait?.resolutionHandler === 'workflow' && !blockedWait.structured && status.role === 'review'
  // A delivery gate's only actions are its pull request links. One link sits inline on the header,
  // so the card has nothing to expand; several stay in the expandable list.
  const expandable = deliveryGate ? linkedPullRequests.length > 1 : embedded || !workflowReviewGate

  // Remove the successful action immediately, then refetch only authoritative affected domains.
  const completeAction = async () => {
    queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), (current) =>
      current?.filter((candidate) => candidate.id !== action.id)
    )

    const invalidations = [queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })]
    if (action.type === 'workstream-review' || action.type === 'workstream-blocked') {
      const data = action.data as WorkStreamActionData
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.workStreamDetail(data.workStreamId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.workStreams(data.squadId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.allWorkStreams() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreamsPrefix() }),
        queryClient.invalidateQueries({ queryKey: [...queryKeys.squads.all, 'doneWorkStreams'] })
      )
    } else if (action.type === 'agent-question' || action.type === 'agent-error') {
      const data = action.data as AgentQuestionActionData | AgentErrorActionData
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(data.agentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.activeExecution(data.agentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.listPrefix() })
      )
      if (data.squadId) {
        invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(data.squadId) }))
      }
      if (action.type === 'agent-question') {
        invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.agentQuestions.all }))
      }
    }
    await Promise.all(invalidations)
  }

  // A halted agent's Continue sits on the header, so the mutation lives with the card, not its body.
  const continueMutation = useMutation({
    mutationFn: () => continueHaltedActions([action.id]),
    onSuccess: completeAction,
  })

  // Determine link and title
  const wsData = isWorkStreamAction ? (action.data as WorkStreamActionData) : null
  const agentItem =
    action.type === 'agent-question' || action.type === 'agent-error'
      ? (action.data as { agentId: string; agentName: string | null; agentTypeId: string; squadId: string | null })
      : null
  const assistantTask = action.type === 'assistant-needs-input' ? (action.data as AssistantTaskActionData) : null
  const headerLocation = useLocation()
  const linkTo = assistantTask
    ? {
        pathname: headerLocation.pathname,
        search: assistantConversationSearch(headerLocation.search, assistantTask.conversationId, assistantTask.taskId),
      }
    : agentItem
      ? agentThreadPath(agentItem.agentId, agentItem.squadId)
      : `/squads/${action.squadId}`
  const title = isWorkStreamAction
    ? wsData!.workStreamTitle
    : deliveryGate
      ? deliveryGate.workStreamTitle
      : assistantTask
        ? assistantTask.taskLabel
        : agentItem
          ? agentItem.agentName || agentItem.agentTypeId
          : action.squadName

  return (
    <>
      <div
        ref={itemRef}
        tabIndex={-1}
        aria-current={focused ? 'true' : undefined}
        className={clsx('rounded-xl bg-surface overflow-hidden', focused && 'ring-2 ring-accent')}
      >
        {/* Header row - always visible */}
        <div
          className={clsx(
            'flex items-start gap-3 py-3 min-w-0',
            !embedded && 'px-4',
            !embedded && expandable && 'cursor-pointer hover:bg-surface-hover transition-colors'
          )}
          onClick={embedded || !expandable ? undefined : () => setExpanded(!expanded)}
        >
          {/* Status icon: glyph + color + label, matching the stream's row in the work list */}
          <span
            role="img"
            aria-label={status.label}
            title={status.label}
            className={clsx('text-sm leading-5 shrink-0 w-4 text-center', webStatus(status.role).textClass)}
          >
            {status.icon}
          </span>

          {/* Title and subtitle */}
          <div className="flex-1 min-w-0">
            {embedded ? (
              <h3 className="font-medium text-sm text-primary">{title}</h3>
            ) : isWorkStreamAction || deliveryGate ? (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowWsModal(true)
                }}
                className="font-medium text-sm text-primary hover:text-accent-light line-clamp-2 text-left w-fit max-w-full"
              >
                {title}
              </button>
            ) : (
              <Link
                to={linkTo}
                onClick={(e) => {
                  e.stopPropagation()
                  closeActionCenter()
                }}
                className="font-medium text-sm text-primary hover:text-accent-light line-clamp-2 w-fit max-w-full"
              >
                {title}
              </Link>
            )}
            <ActionSubtitle action={action} />
            {continueMutation.isError && (
              <p role="alert" className="mt-1 text-xs text-status-danger-600">
                {actionErrorMessage(continueMutation.error)}
              </p>
            )}
          </div>

          <ActionInlineControl
            action={action}
            title={title}
            linkedPullRequests={linkedPullRequests}
            continueAgent={continueMutation}
          />

          {/* Expand/collapse chevron */}
          {!embedded && expandable && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(!expanded)
              }}
              className="ficus-button ficus-button-ghost self-center -my-1 -mr-1 p-2 shrink-0"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
            </button>
          )}
        </div>

        {/* Expanded content: pt-2 on top of the header's py-3 keeps the body off the header row */}
        {expanded && expandable && (
          <div className={clsx('pt-2 pb-4 space-y-4', !embedded && 'px-4 sm:pl-11')}>
            {/* Action controls */}
            {deliveryGate ? (
              <div className="flex flex-wrap items-center gap-2">
                {linkedPullRequests.map((pullRequest) => (
                  <PullRequestLink
                    key={`${pullRequest.repository}#${pullRequest.number}`}
                    pullRequest={pullRequest}
                    deliveryKind={deliveryGate.deliveryKind}
                  />
                ))}
              </div>
            ) : action.canRespond ||
              (action.type === 'agent-question' &&
                (action.data as AgentQuestionActionData).answerDelivery?.status === 'failed') ? (
              <ActionContent action={action} onComplete={completeAction} />
            ) : (
              <p className="text-xs text-muted">You can view this action but do not have permission to respond.</p>
            )}
          </div>
        )}
      </div>

      {/* Work stream detail modal (from title click) */}
      {showWsModal && deliveryGate && (
        <WorkStreamViewModal
          workStreamId={deliveryGate.workStreamId}
          squadId={deliveryGate.squadId}
          squadName={deliveryGate.squadName}
          actionCanRespond={false}
          onClose={() => setShowWsModal(false)}
        />
      )}
      {showWsModal && wsData && (
        <WorkStreamViewModal
          workStreamId={wsData.workStreamId}
          squadId={wsData.squadId}
          squadName={wsData.squadName}
          focusWaitId={wsData.focus.waitId}
          actionCanRespond={action.canRespond}
          onClose={() => setShowWsModal(false)}
        />
      )}
    </>
  )
}

function ActionSubtitle({ action }: { action: PendingAction }) {
  switch (action.type) {
    case 'squad-question': {
      const data = action.data as SquadQuestionActionData
      const name = data.agentName || data.agentTypeId
      return <p className="text-xs text-muted truncate">{name} · needs your input</p>
    }
    case 'agent-question': {
      const data = action.data as AgentQuestionActionData
      return (
        <p className="text-xs text-muted truncate">
          {data.squadName ? `${data.squadName} · ` : ''}
          {data.answerDelivery?.status === 'failed' ? 'Answer delivery unconfirmed' : 'Needs your answer'}
        </p>
      )
    }
    case 'agent-error': {
      const data = action.data as AgentErrorActionData
      return <p className="text-xs text-muted truncate">{data.squadName ? `${data.squadName} · ` : ''}Agent halted</p>
    }
    case 'assistant-needs-input': {
      const data = action.data as AssistantTaskActionData
      return (
        <p className="text-xs text-muted truncate">
          Assistant task{data.squadName ? ` · ${data.squadName}` : ''} · needs your answer
        </p>
      )
    }
    case 'workstream-review': {
      const data = action.data as WorkStreamActionData
      const assignee = data.assigneeName || (data.assigneeAgentId ? data.assigneeAgentId.slice(0, 8) : null)
      return (
        <p className="text-xs text-muted truncate">
          {data.squadName}
          {assignee ? ` · ${assignee} requests review` : ' · ready for review'}
        </p>
      )
    }
    case 'workstream-blocked': {
      const data = action.data as WorkStreamActionData
      const assignee = data.assigneeName || (data.assigneeAgentId ? data.assigneeAgentId.slice(0, 8) : null)
      return (
        <p className="text-xs text-muted truncate">
          {data.squadName}
          {workStreamActionPresentationState(action) === 'in_review'
            ? ' · review needed'
            : data.deliveryApproval
              ? ' · approve delivery'
              : data.attemptLimit
                ? ' · attempt limit reached'
                : data.wait.resolutionHandler === 'workflow'
                  ? ' · workflow decision'
                  : assignee
                    ? ` · ${assignee} needs input`
                    : ' · needs input'}
        </p>
      )
    }
    case 'workstream-delivery': {
      const data = action.data as WorkStreamDeliveryActionData
      return (
        <p className="text-xs text-muted truncate">
          {data.squadName} · {deliveryGateLabel(data)}
        </p>
      )
    }
    default:
      return null
  }
}

function deliveryGateLabel(data: WorkStreamDeliveryActionData): string {
  return data.deliveryKind === 'merge' ? 'Merge pull request' : 'Review pull request'
}

type DeliveryPullRequest = WorkStreamDeliveryActionData['pullRequests'][number]

/**
 * A pull request needs a person on the code host. Ficus cannot approve or merge it here, so the
 * card links out to it; the card title already opens the work stream.
 */
function PullRequestLink({
  pullRequest,
  deliveryKind,
  compact = false,
}: {
  pullRequest: DeliveryPullRequest
  deliveryKind: WorkStreamDeliveryActionData['deliveryKind']
  compact?: boolean
}) {
  // The link only opens the pull request; "Merge" would read as if clicking merges it.
  const verb = deliveryKind === 'merge' ? 'Open' : 'Review'
  const reference = `${pullRequest.repository}#${pullRequest.number}`
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      // The compact header label drops the repository; the accessible name and tooltip keep it.
      aria-label={compact ? `${verb} #${pullRequest.number}, pull request ${reference}` : undefined}
      title={compact ? `${verb} ${reference}` : undefined}
      className={clsx(
        'ficus-button ficus-button-primary inline-flex items-center',
        compact ? INLINE_ACTION_SIZE : 'min-h-10 px-3 py-2 text-sm'
      )}
    >
      {compact ? `${verb} #${pullRequest.number}` : `${verb} ${reference}`}
    </a>
  )
}

/** Compact sizing for a primary action on the collapsed header row: fits beside a two-line title on phones. */
const INLINE_ACTION_SIZE = 'min-h-8 whitespace-nowrap px-3 py-1.5 text-xs'

/**
 * The card's single primary action, on the header row so it takes one click from the collapsed
 * card. Only cards whose action needs no input get one: a delivery gate with one pull request, a
 * halted agent's Continue, an Assistant task's Answer and a workflow gate's review surface. Cards
 * that take an answer, a choice or review feedback keep their controls in the expandable body.
 */
function ActionInlineControl({
  action,
  title,
  linkedPullRequests,
  continueAgent,
}: {
  action: PendingAction
  title: string | undefined
  linkedPullRequests: DeliveryPullRequest[]
  continueAgent: { mutate: () => void; isPending: boolean }
}) {
  const location = useLocation()
  const { closeActionCenter } = useActionCenter()
  const [showDecision, setShowDecision] = useState(false)

  let control: ReactNode = null
  if (action.type === 'workstream-delivery') {
    const pullRequest = linkedPullRequests.length === 1 ? linkedPullRequests[0] : null
    if (pullRequest)
      control = (
        <PullRequestLink
          pullRequest={pullRequest}
          deliveryKind={(action.data as WorkStreamDeliveryActionData).deliveryKind}
          compact
        />
      )
  } else if (!action.canRespond) {
    control = null
  } else if (action.type === 'agent-error' && !(action.data as AgentErrorActionData).recovery) {
    control = (
      <button
        type="button"
        onClick={() => continueAgent.mutate()}
        disabled={continueAgent.isPending}
        aria-label={title ? `${continueAgent.isPending ? 'Continuing' : 'Continue'} ${title}` : undefined}
        className={clsx('ficus-button ficus-button-primary disabled:opacity-50', INLINE_ACTION_SIZE)}
      >
        {continueAgent.isPending ? 'Continuing…' : 'Continue'}
      </button>
    )
  } else if (action.type === 'assistant-needs-input') {
    const data = action.data as AssistantTaskActionData
    control = (
      <Link
        to={{
          pathname: location.pathname,
          search: assistantConversationSearch(location.search, data.conversationId, data.taskId),
        }}
        onClick={closeActionCenter}
        aria-label={`Answer ${data.taskLabel} in Assistant`}
        className={clsx('ficus-button ficus-button-primary inline-flex items-center', INLINE_ACTION_SIZE)}
      >
        Answer
      </Link>
    )
  } else if (
    action.type === 'workstream-blocked' &&
    (action.data as WorkStreamActionData).wait.resolutionHandler === 'workflow' &&
    // An attempt-limit pause is decided in the card body (Raise limit), not on a review surface.
    !(action.data as WorkStreamActionData).attemptLimit
  ) {
    const data = action.data as WorkStreamActionData
    control = (
      <>
        <button
          type="button"
          onClick={() => setShowDecision(true)}
          aria-label={title ? `Review and decide on ${title}` : 'Review and decide'}
          title="Review and decide"
          className={clsx('ficus-button ficus-button-primary', INLINE_ACTION_SIZE)}
        >
          Review
        </button>
        {/* A flow-owned wait is a workflow gate: open its review surface (the work stream when it is not a gate). */}
        {showDecision && (
          <WorkflowReviewLauncher
            workStreamId={data.workStreamId}
            squadId={data.squadId}
            squadName={data.squadName}
            focusWaitId={data.focus.waitId}
            actionCanRespond={action.canRespond}
            onClose={() => setShowDecision(false)}
          />
        )}
      </>
    )
  }

  if (!control) return null
  // Clicks inside (including from the review modal rendered in a portal) must not toggle the card.
  return (
    <div className="flex shrink-0 items-center self-center -my-1" onClick={(event) => event.stopPropagation()}>
      {control}
    </div>
  )
}

function ActionContent({ action, onComplete }: { action: PendingAction; onComplete: () => void | Promise<void> }) {
  switch (action.type) {
    case 'squad-question':
      return <SquadQuestionActionContent action={action} onComplete={onComplete} />
    case 'agent-question':
      return <AgentQuestionActionContent action={action} onComplete={onComplete} />
    case 'agent-error': {
      const data = action.data as AgentErrorActionData
      if (data.recovery)
        return (
          <AgentRecoveryActions
            agentId={data.agentId}
            recovery={data.recovery}
            onComplete={onComplete}
            disabled={!action.canRespond}
          />
        )
      // Continue sits on the header; the body explains why the agent halted.
      return (
        <p className="text-sm leading-relaxed text-secondary whitespace-pre-wrap">
          {(action.data as AgentErrorActionData).reason}
        </p>
      )
    }
    case 'assistant-needs-input':
      return <AssistantTaskActionContent action={action} />
    case 'workstream-review':
      return <WorkStreamReviewActionContent action={action} onComplete={onComplete} />
    case 'workstream-blocked':
      return <WorkStreamBlockedActionContent action={action} onComplete={onComplete} />
    default:
      return null
  }
}

function SquadQuestionActionContent({
  action,
  onComplete,
}: {
  action: PendingAction
  onComplete: () => void | Promise<void>
}) {
  const data = action.data as SquadQuestionActionData
  const { closeActionCenter } = useActionCenter()

  const mutation = useMutation({
    mutationFn: (answer: string) => sendAgentMessage(data.agentId, answer),
    onSuccess: onComplete,
  })

  return (
    <div className="space-y-3">
      {mutation.isError && (
        <p role="alert" className="text-xs text-status-danger-600">
          {actionErrorMessage(mutation.error)}
        </p>
      )}
      <QuestionInput
        questionData={data.questionData}
        onSubmit={(answer) => mutation.mutate(answer)}
        disabled={mutation.isPending}
      />
      <Link
        to={`/squads/${data.squadId}?agent=${data.agentId}`}
        onClick={closeActionCenter}
        className="ficus-button ficus-button-secondary inline-flex min-h-10 items-center px-3 py-2 text-sm"
      >
        View Thread
      </Link>
    </div>
  )
}

function AgentQuestionActionContent({
  action,
  onComplete,
}: {
  action: PendingAction
  onComplete: () => void | Promise<void>
}) {
  const data = action.data as AgentQuestionActionData
  const navigate = useNavigate()
  const { closeActionCenter } = useActionCenter()
  const retryMutation = useMutation({
    mutationFn: () => retryAgentQuestionAnswerDelivery(data.questionId),
    onSuccess: onComplete,
  })

  const dismissMutation = useMutation({
    mutationFn: () => dismissAgentQuestionDeliveryFailure(data.questionId, data.answerDelivery!.generation),
    onSuccess: onComplete,
  })

  if (data.answerDelivery?.status === 'failed') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-secondary">
          Your answer was saved, but confirmation that the agent accepted it was not recorded. The agent may already
          have received it. Check the agent conversation before retrying; dismissing only hides this notice for you.
        </p>
        {retryMutation.isError && (
          <p role="alert" className="text-xs text-status-danger-600">
            {actionErrorMessage(retryMutation.error)}
          </p>
        )}
        {dismissMutation.isError && (
          <p role="alert" className="text-xs text-status-danger-600">
            {actionErrorMessage(dismissMutation.error)}
          </p>
        )}
        {action.canRespond && data.answerDelivery.canRetry && (
          <button
            type="button"
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
            className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {retryMutation.isPending ? 'Retrying…' : 'Retry delivery'}
          </button>
        )}
        <button
          type="button"
          onClick={() => dismissMutation.mutate()}
          disabled={dismissMutation.isPending || retryMutation.isPending}
          className="min-h-10 px-3 py-2 text-sm disabled:opacity-50"
        >
          {dismissMutation.isPending ? 'Dismissing…' : 'Dismiss notice'}
        </button>
      </div>
    )
  }

  const question = {
    id: data.questionId,
    agentId: data.agentId,
    squadId: data.squadId,
    ownerUserId: data.ownerUserId,
    questionData: data.questionData,
    status: 'open' as const,
    answer: null,
    answeredByUserId: null,
    createdAt: '',
    answeredAt: null,
  }

  const goToAgent = () => {
    closeActionCenter()
    navigate(agentThreadPath(data.agentId, data.squadId))
  }

  return (
    <AgentQuestionCard
      question={question}
      embedded
      onAnswered={onComplete}
      secondaryAction={{
        label: 'Confirm + go to agent',
        onAnswered: async () => {
          await onComplete()
          goToAgent()
        },
      }}
    />
  )
}

function WorkStreamReviewActionContent({
  action,
  onComplete,
}: {
  action: PendingAction
  onComplete: () => void | Promise<void>
}) {
  const data = action.data as WorkStreamActionData
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [showApprovalConfirmation, setShowApprovalConfirmation] = useState(false)

  const approveMutation = useMutation({
    mutationFn: () => resolveWorkStreamWait(data.workStreamId, data.wait.id, { resolution: 'approved' }),
    onSuccess: () => {
      setShowApprovalConfirmation(false)
      return onComplete()
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (reason: string) =>
      resolveWorkStreamWait(data.workStreamId, data.wait.id, { resolution: 'sent_back', note: reason }),
    onSuccess: () => {
      setShowRejectModal(false)
      return onComplete()
    },
  })

  const isLoading = approveMutation.isPending || rejectMutation.isPending
  const completesOnApproval = data.wait.completesOnApproval
  const approveLabel = completesOnApproval ? 'Approve and complete' : 'Approve checkpoint'
  const sendBackLabel = completesOnApproval ? 'Send back' : 'Send checkpoint back'

  return (
    <>
      <div className="space-y-3">
        <div className="min-w-0 text-sm text-secondary">
          <MarkdownContent
            compactPullRequestLinks
            className="text-sm leading-relaxed text-secondary prose-p:my-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0 prose-a:text-accent-light prose-a:font-medium prose-a:no-underline hover:prose-a:underline"
          >
            {data.wait.message ?? data.prompt.message}
          </MarkdownContent>
        </div>
        {data.prompt.files && data.prompt.files.length > 0 && (
          <WorkStreamFileList files={data.prompt.files} squadId={data.squadId} />
        )}
        {(approveMutation.isError || rejectMutation.isError) && (
          <p role="alert" className="text-xs text-status-danger-600">
            {actionErrorMessage(approveMutation.error ?? rejectMutation.error)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowApprovalConfirmation(true)}
            disabled={isLoading}
            className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {approveMutation.isPending ? 'Approving…' : approveLabel}
          </button>
          <button
            onClick={() => setShowRejectModal(true)}
            disabled={isLoading}
            className="ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {sendBackLabel}
          </button>
        </div>
      </div>

      <WorkStreamApprovalConfirmation
        isOpen={showApprovalConfirmation}
        completionMode={data.completionMode}
        completesOnApproval={completesOnApproval}
        isPending={approveMutation.isPending}
        error={approveMutation.isError ? actionErrorMessage(approveMutation.error) : null}
        onCancel={() => setShowApprovalConfirmation(false)}
        onConfirm={() => approveMutation.mutate()}
      />
      <RejectionModal
        isOpen={showRejectModal}
        onClose={() => setShowRejectModal(false)}
        onConfirm={(reason) => rejectMutation.mutate(reason)}
        isLoading={rejectMutation.isPending}
        title={sendBackLabel}
        confirmLabel={sendBackLabel}
        loadingLabel="Sending..."
        placeholder="Describe what needs to be changed..."
      />
    </>
  )
}

function WorkStreamBlockedActionContent({
  action,
  onComplete,
}: {
  action: PendingAction
  onComplete: () => void | Promise<void>
}) {
  const data = action.data as WorkStreamActionData
  // A workflow gate's review surface opens from the header (ActionInlineControl); the body shows its message.
  const flowControlled = data.wait.resolutionHandler === 'workflow'
  const [response, setResponse] = useState('')

  const respondMutation = useMutation({
    mutationFn: (resp: string) =>
      resolveWorkStreamWait(data.workStreamId, data.wait.id, { resolution: 'cleared', note: resp }),
    onSuccess: onComplete,
  })

  if (data.wait.structured)
    return (
      <StructuredInputActions
        workStreamId={data.workStreamId}
        wait={data.wait}
        onComplete={onComplete}
        disabled={!action.canRespond}
      />
    )
  if (data.attemptLimit)
    return (
      <AttemptLimitActions
        workStreamId={data.workStreamId}
        pause={data.attemptLimit}
        flowVersion={data.attemptLimit.flowVersion}
        onComplete={onComplete}
        disabled={!action.canRespond}
      />
    )

  return (
    <div className="space-y-3">
      <div className="min-w-0 text-sm text-secondary">
        <MarkdownContent
          compactPullRequestLinks
          className="text-sm leading-relaxed text-secondary prose-p:my-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0 prose-a:text-accent-light prose-a:font-medium prose-a:no-underline hover:prose-a:underline"
        >
          {data.wait.message ?? data.prompt.message}
        </MarkdownContent>
      </div>
      {data.prompt.files && data.prompt.files.length > 0 && (
        <WorkStreamFileList files={data.prompt.files} squadId={data.squadId} />
      )}

      {respondMutation.isError && (
        <p role="alert" className="text-xs text-status-danger-600">
          {actionErrorMessage(respondMutation.error)}
        </p>
      )}
      {!flowControlled && data.prompt.type === 'text' && (
        <MultilineResponseField
          value={response}
          onChange={setResponse}
          onSubmit={() => respondMutation.mutate(response)}
          canSubmit={!respondMutation.isPending}
          actions={
            <button
              onClick={() => respondMutation.mutate(response)}
              disabled={respondMutation.isPending || !response.trim()}
              className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
            >
              {respondMutation.isPending ? 'Sending…' : 'Send'}
            </button>
          }
        />
      )}

      {!flowControlled && data.prompt.type === 'select' && data.prompt.options && (
        <div className="flex flex-wrap items-center gap-2">
          {data.prompt.options.map((opt) => (
            <button
              key={opt}
              onClick={() => respondMutation.mutate(opt)}
              disabled={respondMutation.isPending}
              className="ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A delegated Assistant task waiting on the owner's answer. The answer is given inside the
 * conversation so it stays correlated to the task (`inReplyTo`); this card only presents the
 * question; the header's Answer (like the title) takes the user there. Opening it marks nothing seen.
 */
function AssistantTaskActionContent({ action }: { action: PendingAction }) {
  const data = action.data as AssistantTaskActionData
  return (
    <div className="space-y-3">
      <MarkdownContent className="text-sm">{data.question}</MarkdownContent>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="truncate">{data.conversationTitle}</span>
        {data.updateCreatedAt && (
          <time dateTime={data.updateCreatedAt}>
            {new Date(data.updateCreatedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        )}
      </div>
    </div>
  )
}
