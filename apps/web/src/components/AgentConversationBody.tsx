import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '../reactQueryHooks'
import { queries } from '../queryOptions'
import { useChatApi } from '../api/ChatApiProvider'
import { AgentChat, type AgentChatHeaderState } from './AgentChat'
import type { ExecutionStatus } from '@ficus/shared'
import { AgentComposerStatus } from './AgentComposerStatus'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'

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

  const isTerminated = agent?.status === 'terminated'

  const { can, isLoading: permissionsLoading } = usePermissions(agent?.squadId ?? undefined)
  const canRunAgent = !permissionsLoading && can('agents:run')

  const invalidateAgentStatus = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.activeExecution(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() })
  }

  const compactMutation = useMutation({
    mutationFn: () => api.compactAgent(agentId),
    onSuccess: invalidateAgentStatus,
  })

  const resetMutation = useMutation({
    mutationFn: () => api.resetAgent(agentId),
    onSuccess: invalidateAgentStatus,
  })

  const [showRawText, setShowRawText] = useState(false)

  const executionStatus = activeExecution?.status as ExecutionStatus | undefined
  const usage = agent?.sessionUsage

  // A render function so the status can use AgentChat's LIVE stream state:
  // during a normal turn the sandbox is (re-)ensured inside the run while the
  // DB row is 'running' (only the reactive recovery path sets
  // 'waiting-sandbox'), so a cold ensure would otherwise read "running" for its
  // whole duration. The runner streams execution_phase:waiting_sandbox only
  // while debounced backend-reported blocking setup/reconciliation is active;
  // label it the same as the DB waiting-sandbox case, and fall back once
  // successful batch completion emits sandbox_ready. Cost and the rest of the
  // usage live in the Info tab.
  const composerStatus = agent
    ? ({ waitingForSandbox }: AgentChatHeaderState) => {
        const displayStatus: ExecutionStatus | undefined =
          executionStatus === 'running' && waitingForSandbox ? 'waiting-sandbox' : executionStatus
        const idle = agent.status === 'idle' && !activeExecution?.active && !isTerminated
        return (
          <AgentComposerStatus
            agentId={agentId}
            squadId={agent.squadId}
            status={
              agent.status === 'compacting' ? 'compacting' : agent.status === 'resetting' ? 'resetting' : displayStatus
            }
            context={usage?.context ? { percent: usage.context.percent, tokens: usage.stats.tokens.total } : undefined}
            canManageSession={idle && canRunAgent && !compactMutation.isPending && !resetMutation.isPending}
            onCompact={() => compactMutation.mutate()}
            onReset={() => resetMutation.mutate()}
          />
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
      composerStatus={composerStatus}
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
