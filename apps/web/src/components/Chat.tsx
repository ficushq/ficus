import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '../reactQueryHooks'
import { compactAgent, resetAgent, stopAgent } from '../api/agents'
import { useNotificationSound } from '../hooks/useNotificationSound'
import { useTextToSpeech } from '../hooks/useTextToSpeech'
import { usePermissions } from '../hooks/usePermissions'
import { queryKeys } from '../queryKeys'
import { queries } from '../queryOptions'
import { AgentChat } from './AgentChat'
import { ConfirmButton } from './ConfirmButton'
import { SANDBOX_STATUS_POLL_MS } from './sandbox/sandboxStatusStyles'
import type { ChatScope, MessageMetadata } from '@ficus/shared'

interface ChatDependencies {
  AgentChatComponent?: typeof AgentChat
  useNotificationSoundHook?: typeof useNotificationSound
  useTextToSpeechHook?: typeof useTextToSpeech
  usePermissionsHook?: typeof usePermissions
}

interface ChatProps {
  dependencies?: ChatDependencies
  agentId?: string
  pagePath?: string
  initialMessage?: { content: string }
  agentName?: string
  /** The agent's short name, shown gray/secondary beside the purpose-led title. */
  agentSecondaryName?: string
  scope?: ChatScope
  className?: string
  focusTrigger?: number
  onAgentCreated?: (agentId: string) => void
  headerExtra?: React.ReactNode
  enableFullscreen?: boolean
  /** When controls, omit the title row so a parent container can own it. */
  headerLayout?: 'default' | 'controls'
  hideHeaderActions?: boolean
}

const SCOPE_LABELS: Record<string, string> = {
  system: 'System',
  manager: 'Manager',
  'squad-manager': 'Squad Manager',
  'squad-worker': 'Squad Worker',
  task: 'Task',
  heartbeat: 'Heartbeat',
  consultant: 'Consultant',
}

export function Chat({
  agentId,
  initialMessage,
  pagePath,
  agentName,
  agentSecondaryName,
  scope,
  className,
  focusTrigger,
  onAgentCreated,
  headerExtra,
  enableFullscreen = true,
  headerLayout = 'default',
  hideHeaderActions = false,
  dependencies,
}: ChatProps) {
  const AgentChatComponent = dependencies?.AgentChatComponent ?? AgentChat
  const useNotificationSoundHook = dependencies?.useNotificationSoundHook ?? useNotificationSound
  const useTextToSpeechHook = dependencies?.useTextToSpeechHook ?? useTextToSpeech
  const usePermissionsHook = dependencies?.usePermissionsHook ?? usePermissions
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const tts = useTextToSpeechHook()
  const notificationSound = useNotificationSoundHook()

  const handleDone = useCallback(
    (_response: string, _metadata: MessageMetadata | null, messageId?: string) => {
      notificationSound.playSound()
      if (!tts.enabled || !messageId) return
      tts.speak(messageId)
    },
    [tts, notificationSound]
  )

  const showHeaderActions = !hideHeaderActions && headerLayout === 'controls' && !!agentId

  const { data: agent } = useQuery({
    ...queries.agents.detail(agentId!),
    enabled: showHeaderActions,
  })

  const { data: activeExecution } = useQuery({
    ...queries.agents.activeExecution(agentId!),
    enabled: showHeaderActions,
  })

  const { can, isLoading: permissionsLoading } = usePermissionsHook(agent?.squadId ?? undefined)
  const canSendChat = !permissionsLoading && can('chat:send')

  const invalidateAgentStatus = useCallback(() => {
    if (!agentId) return
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.activeExecution(agentId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() })
  }, [agentId, queryClient])

  const stopMutation = useMutation({
    mutationFn: () => stopAgent(agentId!),
    onSuccess: invalidateAgentStatus,
  })

  const compactMutation = useMutation({
    mutationFn: () => compactAgent(agentId!),
    onSuccess: invalidateAgentStatus,
  })

  const resetMutation = useMutation({
    mutationFn: () => resetAgent(agentId!),
    onSuccess: invalidateAgentStatus,
  })

  // Determine which controls to show based on query data only (no useChat dependency)
  const isRunningOrQueued =
    activeExecution?.status === 'running' ||
    activeExecution?.status === 'queued' ||
    activeExecution?.status === 'waiting-sandbox' ||
    activeExecution?.status === 'stopping'
  const isIdle = agent?.status === 'idle' && !activeExecution?.active

  // Sandbox status polling — detect "sandbox starting" / "installing packages" states
  const isRunningExecution = activeExecution?.status === 'running'
  const { data: sandboxStatus } = useQuery({
    ...queries.agents.sandboxStatus(agentId!),
    enabled: !!agentId && isRunningExecution,
    refetchInterval: isRunningExecution ? SANDBOX_STATUS_POLL_MS : false,
  })
  // Host runtime: there is no sandbox to start, and `status` is meaningless
  // here anyway — HostSandboxManager tracks its sandboxes in a per-process Map,
  // so the api (a different process from the worker actually running the turn)
  // reports `not_found` for virtually every one of them. Gate on the
  // server-driven `runtime` field, never on `status`.
  const hostRuntime = sandboxStatus?.runtime === 'host'
  const sandboxStarting =
    !hostRuntime && isRunningExecution && sandboxStatus?.status !== undefined && sandboxStatus.status !== 'running'
  const devboxInstalling =
    !hostRuntime && isRunningExecution && sandboxStatus?.status === 'running' && sandboxStatus?.devboxReady === false
  const thinkingLabel =
    activeExecution?.status === 'waiting-sandbox'
      ? 'Sandbox capacity is temporarily unavailable; retrying automatically'
      : sandboxStarting || devboxInstalling
        ? 'Sandbox is starting...'
        : 'Agent is working...'

  const headerActions = showHeaderActions ? (
    <div className="flex items-center gap-0.5 shrink-0">
      {isRunningOrQueued && (
        <ConfirmButton
          onConfirm={() => stopMutation.mutate()}
          disabled={stopMutation.isPending}
          label="Stop"
          className="ficus-button px-1.5 py-0.5 text-[11px] font-medium text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/30 rounded transition-colors"
          confirmClassName="px-1.5 py-0.5 text-[11px] font-medium text-status-danger-700 dark:text-status-danger-300 bg-status-danger-50 dark:bg-status-danger-900/30 hover:bg-status-danger-100 dark:hover:bg-status-danger-900/50 rounded transition-colors"
        />
      )}
      {isIdle && (
        <>
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
        </>
      )}
    </div>
  ) : null

  const scopeLabel = scope ? SCOPE_LABELS[scope.type] || scope.type : 'Chat'

  const header =
    headerLayout === 'controls' ? (
      headerExtra || headerActions ? (
        <>
          {headerExtra}
          {headerActions}
        </>
      ) : undefined
    ) : (
      <>
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-primary">
            {agentName ? (
              <>
                {agentName}
                {agentSecondaryName ? (
                  <span className="text-muted font-normal text-sm"> {agentSecondaryName}</span>
                ) : null}{' '}
                <span className="text-muted font-normal">· {scopeLabel}</span>
              </>
            ) : (
              scopeLabel
            )}
          </h3>
          {headerExtra ?? (scope?.id && <span className="text-xs text-muted font-mono">{scope.id.slice(0, 8)}</span>)}
        </div>
        {headerActions}
      </>
    )

  const handleAgentCreated = useCallback(
    (newAgentId: string) => {
      onAgentCreated?.(newAgentId)
    },
    [onAgentCreated]
  )

  const handleNavigate = useCallback((path: string) => navigate(path), [navigate])

  return (
    <AgentChatComponent
      agentId={agentId}
      initialMessage={initialMessage}
      pagePath={pagePath}
      scope={scope}
      onAgentCreated={handleAgentCreated}
      onDone={handleDone}
      onNavigate={handleNavigate}
      thinkingLabel={thinkingLabel}
      header={header}
      className={className}
      focusTrigger={focusTrigger}
      enableFullscreen={enableFullscreen}
      inputDisabled={!canSendChat}
      placeholder={!canSendChat ? 'You do not have permission to send chat messages' : undefined}
      squadId={agent?.squadId ?? (scope?.type === 'consultant' ? scope.id : undefined)}
      inputStorageKey={agentId ? `manager:${agentId}` : undefined}
    />
  )
}
