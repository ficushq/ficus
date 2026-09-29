import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { QuestionInput } from './QuestionInput'
import { AgentQuestionCard } from './AgentQuestionCard'
import { RejectionModal } from './RejectionModal'
import { ChevronDownIcon, ChevronRightIcon } from './icons'
import { useActionCenter } from './ActionCenterContext'
import { MarkdownContent } from './MarkdownContent'
import { WorkStreamFileList } from './WorkStreamFileCard'
import { WorkStreamViewModal } from './WorkStreamViewModal'
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
} from '@ficus/shared'
import type { StatusRole } from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'

// Icons for each action type
const actionIcons: Record<string, string> = {
  'agent-error': '!',
  'squad-question': '?',
  'agent-question': '?',
  'assistant-needs-input': '?',
  'workstream-review': '◎',
  'workstream-blocked': '⊘',
}

const actionRoles: Record<PendingAction['type'], StatusRole> = {
  'agent-error': 'danger',
  'squad-question': 'humanWait',
  'agent-question': 'humanWait',
  'assistant-needs-input': 'humanWait',
  'workstream-review': 'review',
  'workstream-blocked': 'danger',
}

/** Opens the saved Assistant conversation on the current page; the navigation reader picks it up. */
function assistantConversationSearch(search: string, conversationId: string, taskId?: string): string {
  const params = new URLSearchParams(search)
  for (const key of ['commandStack', 'commandQuery', 'assistantChat']) params.delete(key)
  params.set('chat', 'open')
  params.set('assistantConversation', conversationId)
  if (taskId) params.set('assistantTask', taskId)
  else params.delete('assistantTask')
  return params.toString()
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
            !embedded && 'px-4 cursor-pointer hover:bg-surface-hover transition-colors'
          )}
          onClick={embedded ? undefined : () => setExpanded(!expanded)}
        >
          {/* Type icon */}
          <span
            className={clsx(
              'text-sm leading-5 shrink-0 w-4 text-center',
              webStatus(
                isWorkStreamAction && (action.data as WorkStreamActionData).wait.resolutionHandler === 'workflow'
                  ? 'humanWait'
                  : actionRoles[action.type]
              ).textClass
            )}
          >
            {actionIcons[action.type]}
          </span>

          {/* Title and subtitle */}
          <div className="flex-1 min-w-0">
            {embedded ? (
              <h3 className="font-medium text-sm text-primary">{title}</h3>
            ) : isWorkStreamAction ? (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowWsModal(true)
                }}
                className="ficus-button font-medium text-sm text-primary hover:text-accent-light line-clamp-2 block text-left w-fit max-w-full"
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
                className="font-medium text-sm text-primary hover:text-accent-light line-clamp-2 block w-fit max-w-full"
              >
                {title}
              </Link>
            )}
            <ActionSubtitle action={action} />
          </div>

          {/* Expand/collapse chevron */}
          {!embedded && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(!expanded)
              }}
              className="ficus-button self-center -my-1 -mr-1 p-2 text-muted hover:text-primary hover:bg-surface-hover shrink-0"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
            </button>
          )}
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className={clsx('pb-4 space-y-4', !embedded && 'px-4 sm:pl-11')}>
            {/* Action controls */}
            {action.canRespond ||
            (action.type === 'agent-question' &&
              (action.data as AgentQuestionActionData).answerDelivery?.status === 'failed') ? (
              <ActionContent
                action={action}
                onComplete={completeAction}
                continueHaltedActions={continueHaltedActions}
                hideWorkStreamLink={embedded}
              />
            ) : (
              <p className="text-xs text-muted">You can view this action but do not have permission to respond.</p>
            )}
          </div>
        )}
      </div>

      {/* Work stream detail modal (from title click) */}
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
          {data.wait.resolutionHandler === 'workflow'
            ? data.wait.flowAttemptId != null
              ? ' · review needed'
              : ' · workflow decision'
            : assignee
              ? ` · ${assignee} needs input`
              : ' · needs input'}
        </p>
      )
    }
    default:
      return null
  }
}

function ActionContent({
  action,
  onComplete,
  continueHaltedActions,
  hideWorkStreamLink,
}: {
  action: PendingAction
  onComplete: () => void | Promise<void>
  continueHaltedActions: typeof continueHaltedAgents
  hideWorkStreamLink: boolean
}) {
  switch (action.type) {
    case 'squad-question':
      return <SquadQuestionActionContent action={action} onComplete={onComplete} />
    case 'agent-question':
      return <AgentQuestionActionContent action={action} onComplete={onComplete} />
    case 'agent-error':
      return (
        <AgentErrorActionContent
          action={action}
          onComplete={onComplete}
          continueHaltedActions={continueHaltedActions}
        />
      )
    case 'assistant-needs-input':
      return <AssistantTaskActionContent action={action} />
    case 'workstream-review':
      return (
        <WorkStreamReviewActionContent
          action={action}
          onComplete={onComplete}
          hideWorkStreamLink={hideWorkStreamLink}
        />
      )
    case 'workstream-blocked':
      return (
        <WorkStreamBlockedActionContent
          action={action}
          onComplete={onComplete}
          hideWorkStreamLink={hideWorkStreamLink}
        />
      )
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
        className="inline-flex min-h-10 items-center px-2 py-2 text-sm text-muted hover:text-primary"
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

function AgentErrorActionContent({
  action,
  onComplete,
  continueHaltedActions,
}: {
  action: PendingAction
  onComplete: () => void | Promise<void>
  continueHaltedActions: typeof continueHaltedAgents
}) {
  const data = action.data as AgentErrorActionData
  const navigate = useNavigate()
  const { closeActionCenter } = useActionCenter()

  const mutation = useMutation({
    mutationFn: () => continueHaltedActions([action.id]),
    onSuccess: onComplete,
  })

  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-secondary whitespace-pre-wrap">{data.reason}</p>
      {mutation.isError && (
        <p role="alert" className="text-xs text-status-danger-600">
          {actionErrorMessage(mutation.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
        >
          {mutation.isPending ? 'Continuing…' : 'Continue'}
        </button>
        <button
          onClick={() => {
            closeActionCenter()
            navigate(agentThreadPath(data.agentId, data.squadId))
          }}
          className="ficus-button min-h-10 px-3 py-2 text-sm text-muted hover:text-primary hover:bg-surface-hover"
        >
          View agent
        </button>
      </div>
    </div>
  )
}

function WorkStreamReviewActionContent({
  action,
  onComplete,
  hideWorkStreamLink,
}: {
  action: PendingAction
  hideWorkStreamLink: boolean
  onComplete: () => void | Promise<void>
}) {
  const data = action.data as WorkStreamActionData
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [showWsModal, setShowWsModal] = useState(false)
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
            className="text-sm leading-relaxed text-secondary prose-p:my-2 prose-a:text-accent-light prose-a:font-medium prose-a:no-underline hover:prose-a:underline"
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
            className="ficus-button min-h-10 border border-th-border px-3 py-2 text-sm text-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            {sendBackLabel}
          </button>
          {!hideWorkStreamLink && (
            <button
              onClick={() => setShowWsModal(true)}
              className="ficus-button min-h-10 px-3 py-2 text-sm text-muted hover:text-primary hover:bg-surface-hover"
            >
              View
            </button>
          )}
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

      {showWsModal && (
        <WorkStreamViewModal
          workStreamId={data.workStreamId}
          squadId={data.squadId}
          squadName={data.squadName}
          focusWaitId={data.focus.waitId}
          actionCanRespond={action.canRespond}
          onClose={() => setShowWsModal(false)}
        />
      )}
    </>
  )
}

function WorkStreamBlockedActionContent({
  action,
  onComplete,
  hideWorkStreamLink,
}: {
  action: PendingAction
  hideWorkStreamLink: boolean
  onComplete: () => void | Promise<void>
}) {
  const data = action.data as WorkStreamActionData
  const flowControlled = data.wait.resolutionHandler === 'workflow'
  const [response, setResponse] = useState('')
  const [showWsModal, setShowWsModal] = useState(false)

  const respondMutation = useMutation({
    mutationFn: (resp: string) =>
      resolveWorkStreamWait(data.workStreamId, data.wait.id, { resolution: 'cleared', note: resp }),
    onSuccess: onComplete,
  })

  return (
    <div className="space-y-3">
      <div className="min-w-0 text-sm text-secondary">
        <MarkdownContent
          compactPullRequestLinks
          className="text-sm leading-relaxed text-secondary prose-p:my-2 prose-a:text-accent-light prose-a:font-medium prose-a:no-underline hover:prose-a:underline"
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
        <div className="flex items-start gap-2">
          <input
            type="text"
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder="Your response..."
            className="ficus-field min-w-0 flex-1 px-3 py-2 text-base sm:text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && response.trim()) {
                respondMutation.mutate(response)
              }
            }}
          />
          <button
            onClick={() => respondMutation.mutate(response)}
            disabled={respondMutation.isPending || !response.trim()}
            className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {respondMutation.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}

      {!flowControlled && data.prompt.type === 'select' && data.prompt.options && (
        <div className="flex flex-wrap items-center gap-2">
          {data.prompt.options.map((opt) => (
            <button
              key={opt}
              onClick={() => respondMutation.mutate(opt)}
              disabled={respondMutation.isPending}
              className="ficus-button min-h-10 px-3 py-2 text-sm text-secondary border border-th-border hover:bg-surface-hover disabled:opacity-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {(!hideWorkStreamLink || flowControlled) && (
        <button
          onClick={() => setShowWsModal(true)}
          className="ficus-button min-h-10 px-3 py-2 text-sm text-muted hover:text-primary hover:bg-surface-hover"
        >
          {flowControlled ? 'Review and decide' : 'View'}
        </button>
      )}

      {showWsModal && (
        <WorkStreamViewModal
          workStreamId={data.workStreamId}
          squadId={data.squadId}
          squadName={data.squadName}
          focusWaitId={data.focus.waitId}
          actionCanRespond={action.canRespond}
          onClose={() => setShowWsModal(false)}
        />
      )}
    </div>
  )
}

/** Fetches a work stream and renders the detail modal */

/**
 * A delegated Assistant task waiting on the owner's answer. The answer is given inside the
 * conversation so it stays correlated to the task (`inReplyTo`); this card only presents the
 * question and takes the user there. Opening it marks nothing seen.
 */
function AssistantTaskActionContent({ action }: { action: PendingAction }) {
  const data = action.data as AssistantTaskActionData
  const location = useLocation()
  const { closeActionCenter } = useActionCenter()
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
      <Link
        to={{
          pathname: location.pathname,
          search: assistantConversationSearch(location.search, data.conversationId, data.taskId),
        }}
        onClick={closeActionCenter}
        className="ficus-button ficus-button-primary inline-flex min-h-10 items-center px-3 py-2 text-sm"
      >
        Answer in Assistant
      </Link>
    </div>
  )
}
