import { AgentSlotWaitStatus } from './AgentSlotWaitStatus'
import clsx from 'clsx'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '../reactQueryHooks'
import { queries } from '../queryOptions'
import { useChatApi } from '../api/ChatApiProvider'
import { AgentChat, type AgentChatHeaderState } from './AgentChat'
import { ConfirmButton } from './ConfirmButton'
import { executionStatusBadgeColors } from '../lib/execution-status'
import { Badge } from './Badge'
import { MoreIcon } from './icons'
import { AGENT_STATUS_ROLE, type ExecutionStatus } from '@ficus/shared'
import { formatTokens } from '../lib/format'
import { isCodexModelSpec } from '../lib/modelSpec'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { webStatus } from '../lib/statusPresentation'

const agentAttentionStatus = webStatus(AGENT_STATUS_ROLE.compacting)

interface AgentConversationDependencies {
  AgentChatComponent?: typeof AgentChat
}

interface AgentConversationProps {
  dependencies?: AgentConversationDependencies
  agentId: string
  /** When set, the chat input stays visible during review so the user can send feedback */
  onReviewFeedback?: (message: string) => Promise<void>
  /** Whether the parent task is in review status */
  isReview?: boolean
  /** Enable fullscreen button in chat header (default: true) */
  enableFullscreen?: boolean
  /** Embedded transcript mode hides top-level-only controls to avoid recursive subagent UX. */
  embedded?: boolean
  /** Powers group-chat sender label on the agent-view path */
  viewingUserId?: string
  /** Server message id to scroll to and highlight on mount (e.g. deep-linking from Activity). */
  focusMessageId?: string
  /** Inbox message id: focuses the transcript message that delivered it. */
  focusInboxMessageId?: string
}

export function AgentConversation({
  agentId,
  onReviewFeedback,
  isReview,
  enableFullscreen = true,
  embedded = false,
  viewingUserId,
  focusMessageId,
  focusInboxMessageId,
  dependencies,
}: AgentConversationProps) {
  const AgentChatComponent = dependencies?.AgentChatComponent ?? AgentChat
  const api = useChatApi()
  const queryClient = useQueryClient()

  const { data: agent } = useQuery({
    ...queries.agents.detail(agentId),
    queryFn: () => api.getAgent(agentId),
    enabled: !!agentId,
  })

  const { data: activeExecution } = useQuery({
    ...queries.agents.activeExecution(agentId),
    queryFn: () => api.getActiveExecution(agentId),
    enabled: !!agentId,
  })

  const { data: agentType } = useQuery({
    ...queries.agentTypes.detail(agent?.agentTypeId ?? ''),
    enabled: !!agent?.agentTypeId,
  })

  const isTerminated = agent?.status === 'terminated'

  const { can, isLoading: permissionsLoading } = usePermissions(agent?.squadId ?? undefined)
  const canRunAgent = !permissionsLoading && can('agents:run')

  const invalidateAgentStatus = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.activeExecution(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() })
  }

  const stopMutation = useMutation({
    mutationFn: () => api.stopAgent(agentId),
    onSuccess: invalidateAgentStatus,
  })

  const compactMutation = useMutation({
    mutationFn: () => api.compactAgent(agentId),
    onSuccess: invalidateAgentStatus,
  })

  const resetMutation = useMutation({
    mutationFn: () => api.resetAgent(agentId),
    onSuccess: invalidateAgentStatus,
  })

  const [agentActionsOpen, setAgentActionsOpen] = useState(false)
  const [showRawText, setShowRawText] = useState(false)

  const executionStatus = activeExecution?.status as ExecutionStatus | undefined
  const canStopExecution =
    executionStatus === 'queued' ||
    executionStatus === 'waiting-sandbox' ||
    executionStatus === 'running' ||
    executionStatus === 'stopping'

  const usage = agent?.sessionUsage
  const showUsageCost = !isCodexModelSpec(agentType?.model)

  // The header is a render function so the badge can consume AgentChat's LIVE
  // stream state: during a normal turn the sandbox is (re-)ensured inside the
  // run while the DB row is 'running' (only the reactive recovery path sets
  // 'waiting-sandbox'), so a cold ensure would otherwise read "running" for its
  // whole duration. The runner streams execution_phase:waiting_sandbox only while
  // debounced backend-reported blocking setup/reconciliation is active; label it the same as the DB
  // waiting-sandbox case, and fall back once successful batch completion emits sandbox_ready.
  const header = agent
    ? ({ waitingForSandbox }: AgentChatHeaderState) => {
        const displayStatus: ExecutionStatus | undefined =
          executionStatus === 'running' && waitingForSandbox ? 'waiting-sandbox' : executionStatus
        const executionStatusLabel = displayStatus === 'waiting-sandbox' ? 'Waiting for sandbox' : displayStatus
        return (
          <div className="min-w-0">
            <div className="flex items-center justify-end md:justify-start gap-2">
              {displayStatus && (
                <Badge color={executionStatusBadgeColors[displayStatus]} className="text-[11px] py-px">
                  {executionStatusLabel}
                </Badge>
              )}
              {usage?.context && (
                <div
                  aria-label="Context used"
                  title="Context used"
                  className="hidden md:flex items-center gap-1.5 flex-1 min-w-0"
                >
                  <span className="text-[10px] text-placeholder shrink-0 hidden sm:inline">Context</span>
                  <div className="flex-1 h-1 bg-surface-secondary rounded-full overflow-hidden min-w-[40px]">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-all',
                        usage.context.percent > 80
                          ? 'bg-status-danger-400'
                          : usage.context.percent > 50
                            ? 'bg-status-review-400'
                            : 'bg-status-progress-400'
                      )}
                      style={{ width: `${Math.min(usage.context.percent, 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-placeholder tabular-nums shrink-0 hidden sm:inline">
                    {Math.round(usage.context.percent)}% · {formatTokens(usage.stats.tokens.total)}
                    {showUsageCost && <> · ${usage.stats.cost.toFixed(2)}</>}
                  </span>
                  <span className="text-[10px] text-placeholder tabular-nums shrink-0 sm:hidden">
                    {Math.round(usage.context.percent)}%
                  </span>
                </div>
              )}
              {usage?.context && (
                <details className="relative md:hidden">
                  <summary
                    aria-label={`Context used: ${Math.round(usage.context.percent)}%`}
                    className="cursor-pointer list-none rounded px-2 py-1.5 text-xs text-muted hover:bg-surface-hover [&::-webkit-details-marker]:hidden"
                  >
                    {Math.round(usage.context.percent)}%
                  </summary>
                  <div className="ficus-overlay absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-th-border bg-surface p-3 text-xs text-secondary shadow-theme-lg">
                    <p className="font-medium text-primary">Context used: {Math.round(usage.context.percent)}%</p>
                    <p className="mt-1">
                      {formatTokens(usage.stats.tokens.total)} tokens
                      {showUsageCost && <> · ${usage.stats.cost.toFixed(2)}</>}
                    </p>
                  </div>
                </details>
              )}
              {canStopExecution && (
                <div className="flex items-center gap-0.5 shrink-0">
                  <ConfirmButton
                    onConfirm={() => stopMutation.mutate()}
                    disabled={stopMutation.isPending || !canRunAgent}
                    label="Stop"
                    className="ficus-button px-1.5 py-0.5 text-[11px] font-medium text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/30 rounded transition-colors"
                    confirmClassName="px-1.5 py-0.5 text-[11px] font-medium text-status-danger-700 dark:text-status-danger-300 bg-status-danger-50 dark:bg-status-danger-900/30 hover:bg-status-danger-100 dark:hover:bg-status-danger-900/50 rounded transition-colors"
                  />
                </div>
              )}
              {agent.status === 'idle' && !activeExecution?.active && !isTerminated && (
                <>
                  <div className="hidden md:flex items-center gap-0.5 shrink-0">
                    <ConfirmButton
                      onConfirm={() => compactMutation.mutate()}
                      disabled={compactMutation.isPending}
                      label="Compact"
                      className="ficus-button px-1.5 py-0.5 text-[11px] font-medium text-status-progress-600 dark:text-status-progress-400 hover:bg-status-progress-50 dark:hover:bg-status-progress-900/30 rounded transition-colors"
                      confirmClassName="px-1.5 py-0.5 text-[11px] font-medium text-status-progress-700 dark:text-status-progress-300 bg-status-progress-50 dark:bg-status-progress-900/30 hover:bg-status-progress-100 dark:hover:bg-status-progress-900/50 rounded transition-colors"
                    />
                    <ConfirmButton
                      onConfirm={() => resetMutation.mutate()}
                      disabled={resetMutation.isPending}
                      label="Reset"
                      className="ficus-button px-1.5 py-0.5 text-[11px] font-medium text-status-external-wait-600 dark:text-status-external-wait-400 hover:bg-status-external-wait-50 dark:hover:bg-status-external-wait-900/30 rounded transition-colors"
                      confirmClassName="px-1.5 py-0.5 text-[11px] font-medium text-status-external-wait-700 dark:text-status-external-wait-300 bg-status-external-wait-50 dark:bg-status-external-wait-900/30 hover:bg-status-external-wait-100 dark:hover:bg-status-external-wait-900/50 rounded transition-colors"
                    />
                  </div>
                  <div className="md:hidden relative shrink-0">
                    <button
                      type="button"
                      aria-label="Agent actions"
                      aria-expanded={agentActionsOpen}
                      onClick={() => setAgentActionsOpen((open) => !open)}
                      className="ficus-button p-1 text-muted hover:text-primary hover:bg-surface-hover rounded transition-colors"
                    >
                      <MoreIcon className="w-4 h-4" />
                    </button>
                    {agentActionsOpen && (
                      <div className="absolute right-0 top-full mt-1 z-20 min-w-28 rounded-md border border-th-border bg-surface p-1 space-y-1">
                        <ConfirmButton
                          onConfirm={() => {
                            compactMutation.mutate()
                            setAgentActionsOpen(false)
                          }}
                          disabled={compactMutation.isPending}
                          label="Compact"
                          className="ficus-button w-full text-left px-2 py-1 text-[11px] font-medium text-status-progress-600 dark:text-status-progress-400 hover:bg-status-progress-50 dark:hover:bg-status-progress-900/30 rounded transition-colors"
                          confirmClassName="w-full text-left px-2 py-1 text-[11px] font-medium text-status-progress-700 dark:text-status-progress-300 bg-status-progress-50 dark:bg-status-progress-900/30 hover:bg-status-progress-100 dark:hover:bg-status-progress-900/50 rounded transition-colors"
                        />
                        <ConfirmButton
                          onConfirm={() => {
                            resetMutation.mutate()
                            setAgentActionsOpen(false)
                          }}
                          disabled={resetMutation.isPending}
                          label="Reset"
                          className="ficus-button w-full text-left px-2 py-1 text-[11px] font-medium text-status-external-wait-600 dark:text-status-external-wait-400 hover:bg-status-external-wait-50 dark:hover:bg-status-external-wait-900/30 rounded transition-colors"
                          confirmClassName="w-full text-left px-2 py-1 text-[11px] font-medium text-status-external-wait-700 dark:text-status-external-wait-300 bg-status-external-wait-50 dark:bg-status-external-wait-900/30 hover:bg-status-external-wait-100 dark:hover:bg-status-external-wait-900/50 rounded transition-colors"
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
              {agent.status === 'compacting' && (
                <span className={clsx('px-1.5 py-0.5 text-[11px] font-medium', agentAttentionStatus.textClass)}>
                  Compacting...
                </span>
              )}
              {agent.status === 'resetting' && (
                <span className={clsx('px-1.5 py-0.5 text-[11px] font-medium', agentAttentionStatus.textClass)}>
                  Resetting...
                </span>
              )}
            </div>
            {agent.squadId && <AgentSlotWaitStatus agentId={agentId} squadId={agent.squadId} />}
          </div>
        )
      }
    : undefined

  return (
    <AgentChatComponent
      agentId={agentId}
      embedded={embedded}
      enableFullscreen={!embedded && enableFullscreen}
      isReview={isReview}
      onReviewFeedback={onReviewFeedback}
      header={header}
      inputStorageKey={`agent:${agentId}`}
      squadId={agent?.squadId ?? undefined}
      viewingUserId={viewingUserId}
      focusMessageId={focusMessageId}
      focusInboxMessageId={focusInboxMessageId}
      inputDisabled={!canRunAgent}
      showRawText={showRawText}
      onToggleRawText={() => setShowRawText((showRaw) => !showRaw)}
    />
  )
}
