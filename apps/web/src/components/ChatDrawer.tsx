export { UnifiedAssistant as ChatDrawer } from './UnifiedAssistant'
import { useAssistantPosition } from '../hooks/useAssistantPosition'
import { AssistantPositionControl } from './AssistantPositionControl'
import { useStableRef } from '../hooks/useStableRef'
import { AssistantConversationSwitcher } from './AssistantConversations'
import { VoiceCompanionButton } from '../voice/VoiceCompanionWidget'
import { useRealtimeEnabled } from '../hooks/useVoiceEnabled'
import { FicusAssistantStart } from './FicusAssistantStart'
import { usePermissions } from '../hooks/usePermissions'
import { useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import { queries } from '../queryOptions'
import { SparklesIcon, CloseIcon, MoreIcon } from './icons'
import { Chat } from './Chat'
import { ConfirmButton } from './ConfirmButton'
import { Panel, usePopover } from './popover'
import { SegmentedControl } from './SegmentedControl'
import { defaultChatApi, useChatApi } from '../api/ChatApiProvider'
import { formatTokens } from '../lib/format'
import { useChatSession } from '../hooks/useChatSession'
import { useURLStringState } from '../hooks/useURLState'
import { MinimizeIcon, MaximizeIcon } from './icons'
import { OPEN_ASSISTANT_EVENT } from '@ficus/shared/browser-keys'

type ChatDrawerState = 'closed' | 'open' | 'expanded'
const CHAT_STATES = ['closed', 'open', 'expanded'] as const

export async function runDeleteAgent(
  agentId: string,
  deleteFn: (id: string) => Promise<unknown> = defaultChatApi.deleteAgent
) {
  return deleteFn(agentId)
}

export function applyPostDeleteDrawerState({
  setSelection,
  startNewChat,
  setAgentActionsOpen,
}: {
  setSelection: (selection: string) => void
  startNewChat: () => void
  setAgentActionsOpen: (open: boolean) => void
}) {
  setSelection('new')
  startNewChat()
  setAgentActionsOpen(false)
}

interface ChatDrawerProps {
  dependencies?: { ChatComponent?: typeof Chat; VoiceComponent?: typeof VoiceCompanionButton }
}

export function LegacyChatDrawer({ dependencies }: ChatDrawerProps = {}) {
  const ChatComponent = dependencies?.ChatComponent ?? Chat
  const VoiceComponent = dependencies?.VoiceComponent ?? VoiceCompanionButton
  const api = useChatApi()
  const [drawerState, setDrawerState] = useURLStringState<ChatDrawerState>('chat', 'closed', CHAT_STATES)
  const { can } = usePermissions()
  const voiceConfigured = useRealtimeEnabled()
  const voiceAvailable = voiceConfigured && can('ai:voice')
  const voiceUnavailableReason = !can('ai:voice')
    ? 'Your account does not have permission to use voice.'
    : !voiceConfigured
      ? 'Enable realtime and configure OpenAI API services in Settings → Assistant & Memory.'
      : typeof window !== 'undefined' && !window.isSecureContext
        ? 'Voice needs HTTPS or localhost.'
        : undefined
  const location = useLocation()
  const navigate = useNavigate()
  const linkedChatId = new URLSearchParams(location.search).get('assistantChat')
  const [mode, setMode] = useState<'text' | 'voice'>('text')
  const [historyRequest, setHistoryRequest] = useState(0)
  const [voiceCompact, setVoiceCompact] = useState(false)
  const compactVoiceOnConnect = useCallback(() => setVoiceCompact(true), [])
  const [voiceActive, setVoiceActive] = useState(false)
  const [conversation, setConversation] = useState(drawerState === 'expanded' || Boolean(linkedChatId))
  const [chatMounted, setChatMounted] = useState(drawerState === 'expanded' || Boolean(linkedChatId))
  const [initialMessage, setInitialMessage] = useState<{ content: string } | undefined>()
  const isOpen = drawerState !== 'closed'
  const isExpanded = drawerState === 'expanded'
  const compactVoice = voiceActive && (!isOpen || (mode === 'voice' && voiceCompact))
  // undefined = auto-select most recent, "new" = new chat, string = agent id
  const [selection, setSelection] = useState<string | undefined>(linkedChatId ?? undefined)
  const selectionRef = useStableRef(selection)
  const [agentActionsOpen, setAgentActionsOpen] = useState(false)
  // A small disclosure of two-tap (ConfirmButton) agent actions, so a Panel rather than a Menu.
  const agentActions = usePopover({ kind: 'disclosure', open: agentActionsOpen, onOpenChange: setAgentActionsOpen })
  const queryClient = useQueryClient()
  const { sessionKey, selectAgent, startNewChat } = useChatSession(linkedChatId ?? undefined)
  const chatRef = useRef<HTMLDivElement>(null)
  const {
    corner,
    setCorner,
    style: positionStyle,
    ...dragHandlers
  } = useAssistantPosition(chatRef, isOpen || voiceActive)
  const positionControl = <AssistantPositionControl corner={corner} onChange={setCorner} />

  const { data: agents } = useQuery({
    ...queries.agents.list({ agentTypeId: 'system-manager', scopeType: 'system-manager' }),
    queryFn: () => api.listAgents({ agentTypeId: 'system-manager', scopeType: 'system-manager' }),
    enabled: isOpen,
  })

  // Resolve effective agent id: undefined selection means most recent
  const effectiveAgentId =
    selection === 'new' ? undefined : (selection ?? (agents && agents.length > 0 ? agents[0].id : undefined))

  const selectedAgent = effectiveAgentId ? agents?.find((agent) => agent.id === effectiveAgentId) : undefined
  const showAgentActions = Boolean(effectiveAgentId && selectedAgent?.status === 'idle')
  const usage = selectedAgent?.sessionUsage

  const compactMutation = useMutation({
    mutationFn: () => api.compactAgent(effectiveAgentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.all }),
  })

  const resetMutation = useMutation({
    mutationFn: () => api.resetAgent(effectiveAgentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.all }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => runDeleteAgent(effectiveAgentId!, api.deleteAgent),
    onSuccess: async () => {
      applyPostDeleteDrawerState({ setSelection, startNewChat, setAgentActionsOpen })
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.all })
    },
  })

  // Sync sessionKey when auto-selecting most recent agent on open
  useEffect(() => {
    if (selection === undefined && agents?.length) {
      selectAgent(agents[0].id)
    }
  }, [selection, agents, selectAgent])

  // Toggle drawer on "M" key, close on Escape — when no input is focused
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!isOpen) {
          setMode('text')
          setConversation(false)
        }
        setDrawerState(isOpen ? 'closed' : 'open')
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement).tagName
      const inputFocused =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable

      if (e.key === 'Escape') {
        if (isExpanded) {
          setDrawerState('open')
        } else {
          setDrawerState('closed')
        }
        return
      }
      if (e.key === 'm' || e.key === 'M') {
        if (inputFocused) return
        e.preventDefault()
        setDrawerState(isOpen ? 'closed' : 'open')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isExpanded, setDrawerState])

  useEffect(() => {
    const open = () => {
      setMode('text')
      setConversation(false)
      setDrawerState('open')
    }
    window.addEventListener(OPEN_ASSISTANT_EVENT, open)
    return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, open)
  }, [setDrawerState])

  useLayoutEffect(() => {
    if (!isOpen) return
    const previous = document.activeElement as HTMLElement | null
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !chatRef.current?.contains(event.target as Node)) return
      const controls = [
        ...chatRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]'
        ),
      ].filter((item) => item.getClientRects().length > 0)
      const first = controls[0],
        last = controls.at(-1)
      if (event.shiftKey && event.target === first && last) {
        event.preventDefault()
        last.focus()
      }
      if (!event.shiftKey && event.target === last && first) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      previous?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const viewport = window.visualViewport
    const update = () => {
      chatRef.current?.style.setProperty('--chat-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
      chatRef.current?.style.setProperty('--chat-viewport-top', `${viewport?.offsetTop ?? 0}px`)
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [isOpen])

  const ask = (content: string) => {
    clearConversationLink()
    setSelection('new')
    startNewChat()
    setInitialMessage({ content })
    setChatMounted(true)
    setConversation(true)
  }

  const handleAgentCreated = useCallback(
    (agentId: string) => {
      setInitialMessage(undefined)
      setSelection(agentId) // Update dropdown display
      // NOTE: Don't call selectAgent here - would remount Chat mid-stream
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list({ agentTypeId: 'system-manager', scopeType: 'system-manager' }),
      })
    },
    [queryClient]
  )

  const openConversation = (id: string) => {
    setSelection(id)
    selectAgent(id)
    setInitialMessage(undefined)
    setChatMounted(true)
    setConversation(true)
    setMode('text')
    setAgentActionsOpen(false)
  }

  useEffect(() => {
    if (linkedChatId && linkedChatId !== selectionRef.current) {
      setSelection(linkedChatId)
      selectAgent(linkedChatId)
      setInitialMessage(undefined)
      setChatMounted(true)
      setConversation(true)
      setMode('text')
    }
  }, [linkedChatId, selectAgent, selectionRef])

  const clearConversationLink = () => {
    const params = new URLSearchParams(location.search)
    params.delete('assistantChat')
    params.set('chat', 'open')
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
  }
  const backToAssistant = () => {
    setConversation(false)
    clearConversationLink()
  }
  const newConversation = () => {
    setSelection('new')
    startNewChat()
    setInitialMessage(undefined)
    setChatMounted(true)
    setConversation(true)
    setAgentActionsOpen(false)
    clearConversationLink()
  }

  return (
    <>
      {/* One persistent surface preserves separate text and voice sessions. */}
      {
        <div
          hidden={!isOpen && !voiceActive}
          style={{ ...positionStyle, display: !isOpen && !voiceActive ? 'none' : undefined }}
          {...dragHandlers}
          data-assistant-drag-handle={compactVoice || undefined}
          ref={chatRef}
          role="dialog"
          aria-label="Assistant"
          data-voice-current-agent-source="system-manager-chat-drawer"
          data-voice-current-agent-id={isOpen && mode === 'text' && conversation ? effectiveAgentId : undefined}
          className={clsx(
            'ficus-assistant-panel fixed z-[60] flex flex-col ficus-glass shadow-theme-lg rounded-2xl overflow-hidden transition-all duration-200 motion-reduce:transition-none',
            compactVoice && 'touch-none select-none cursor-grab active:cursor-grabbing',
            compactVoice
              ? 'top-20 right-4 w-64 max-sm:top-[calc(var(--chat-viewport-top,0px)+0.5rem)] max-sm:right-2 max-w-[calc(100vw-1rem)]'
              : conversation && mode === 'text' && isExpanded
                ? 'bottom-4 right-4 left-4 top-16 md:left-auto md:top-4 md:w-[48rem]'
                : clsx(
                    'top-20 right-4 w-[calc(100vw-2rem)] max-h-[calc(100dvh-7rem)] max-sm:top-[calc(var(--chat-viewport-top,0px)+0.5rem)] max-sm:right-2 max-sm:w-[calc(100vw-1rem)] max-sm:max-h-[calc(var(--chat-viewport-height,100dvh)-1rem)]',
                    mode === 'voice' ? 'md:w-[28rem]' : 'md:w-[36rem]'
                  ),
            isOpen &&
              conversation &&
              mode === 'text' &&
              !isExpanded &&
              'h-[min(42rem,calc(100dvh-7rem))] max-sm:h-[calc(var(--chat-viewport-height,100dvh)-1rem)]'
          )}
        >
          {/* Header bar */}
          <div
            hidden={compactVoice}
            data-assistant-drag-handle
            title="Drag to move assistant"
            style={{ display: compactVoice ? 'none' : undefined }}
            className="touch-none select-none cursor-grab active:cursor-grabbing flex items-center justify-between gap-3 px-3 py-2 border-b border-th-border shrink-0"
          >
            <div className="flex items-center gap-2 shrink-0">
              <SparklesIcon className="w-4 h-4 text-accent-light shrink-0" />
              <span className="font-medium text-primary text-sm truncate">Assistant</span>
            </div>
            <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
              {positionControl}
              {isOpen && conversation && mode === 'text' && usage?.context && (
                <div
                  aria-label="Context used"
                  title={`Context used · ${formatTokens(usage?.stats.tokens.total ?? 0)} tokens · $${usage?.stats.cost.toFixed(2) ?? 0}`}
                  className="hidden sm:flex items-center gap-1.5 flex-1 min-w-0 max-w-44"
                >
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
                    {Math.round(usage.context.percent)}%
                  </span>
                  <span className="text-[10px] text-placeholder tabular-nums shrink-0 sm:hidden">
                    {Math.round(usage.context.percent)}%
                  </span>
                </div>
              )}
              {isOpen && conversation && mode === 'text' && showAgentActions && (
                <>
                  <div className="relative shrink-0">
                    <button
                      {...agentActions.triggerProps}
                      type="button"
                      aria-label="Agent actions"
                      onClick={agentActions.toggle}
                      className="ficus-button p-1 text-muted hover:text-primary hover:bg-surface-hover rounded transition-colors"
                    >
                      <MoreIcon className="w-4 h-4" />
                    </button>
                    <Panel
                      {...agentActions.popoverProps}
                      role="group"
                      label="Agent actions"
                      gap={4}
                      className="min-w-28 rounded-md border border-th-border bg-surface p-1 space-y-1"
                    >
                      <ConfirmButton
                        onConfirm={() => {
                          compactMutation.mutate()
                          setAgentActionsOpen(false)
                        }}
                        disabled={compactMutation.isPending}
                        label="Compact"
                        className="ficus-button w-full text-left px-2 py-1 text-[11px] font-medium text-accent-light hover:bg-accent/10 rounded transition-colors"
                        confirmClassName="w-full text-left px-2 py-1 text-[11px] font-medium text-accent-light bg-accent/10 hover:bg-accent/20 rounded transition-colors"
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
                      <ConfirmButton
                        onConfirm={() => {
                          deleteMutation.mutate()
                          setAgentActionsOpen(false)
                        }}
                        disabled={deleteMutation.isPending}
                        label="Delete"
                        className="ficus-button w-full text-left px-2 py-1 text-[11px] font-medium text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/30 rounded transition-colors"
                        confirmClassName="w-full text-left px-2 py-1 text-[11px] font-medium text-status-danger-700 dark:text-status-danger-300 bg-status-danger-50 dark:bg-status-danger-900/30 hover:bg-status-danger-100 dark:hover:bg-status-danger-900/50 rounded transition-colors"
                      />
                    </Panel>
                  </div>
                </>
              )}
              {isOpen && conversation && mode === 'text' && (
                <button
                  onClick={() => setDrawerState(isExpanded ? 'open' : 'expanded')}
                  className="ficus-button text-placeholder hover:text-secondary p-1.5 rounded-md hover:bg-surface-hover transition-colors hidden sm:flex shrink-0"
                  title={isExpanded ? 'Compact' : 'Expand'}
                >
                  {isExpanded ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
                </button>
              )}
              <button
                onClick={() => {
                  if (compactVoice) {
                    setVoiceCompact(false)
                    setMode('voice')
                    setDrawerState('open')
                  } else setDrawerState(isOpen ? 'closed' : 'open')
                }}
                className="ficus-button text-placeholder hover:text-secondary p-1.5 rounded-md hover:bg-surface-hover transition-colors shrink-0"
                title={
                  compactVoice || !isOpen ? 'Expand assistant' : voiceActive ? 'Collapse assistant' : 'Close (Esc)'
                }
              >
                {compactVoice || !isOpen ? (
                  <MaximizeIcon className="w-4 h-4" />
                ) : voiceActive ? (
                  <MinimizeIcon className="w-4 h-4" />
                ) : (
                  <CloseIcon className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {isOpen && !compactVoice && (
            <div className="flex items-center gap-1 px-3 pt-3 pb-1">
              <SegmentedControl
                size="compact"
                ariaLabel="Assistant modes"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'text', label: 'Text' },
                  {
                    value: 'voice',
                    label: voiceActive ? 'Voice · Live' : 'Voice',
                    disabled: Boolean(voiceUnavailableReason),
                    title:
                      voiceUnavailableReason ??
                      'Live tools for navigation, status, and messaging. A separate conversation from Text.',
                  },
                ]}
              />
              {conversation && mode === 'text' && (
                <button
                  onClick={backToAssistant}
                  className="ficus-button ml-auto text-xs text-muted hover:text-primary px-2 py-1.5"
                >
                  ← Back to search
                </button>
              )}
            </div>
          )}
          <div hidden={!isOpen || mode !== 'text' || conversation} className="min-h-0 overflow-y-auto">
            <FicusAssistantStart
              active={isOpen && mode === 'text' && !conversation}
              onAsk={ask}
              recentChats={agents ?? []}
              onSelectChat={openConversation}
              onViewAllChats={() => {
                setChatMounted(true)
                setConversation(true)
                setHistoryRequest((value) => value + 1)
              }}
              canAsk={can('chat:send')}
            />
          </div>
          {voiceAvailable && (
            <div hidden={isOpen && mode !== 'voice'} className="min-h-0 overflow-y-auto">
              <VoiceComponent
                embedded
                hideTrigger
                compactOverride={compactVoice}
                onActivityChange={setVoiceActive}
                onConnected={compactVoiceOnConnect}
                positionControl={positionControl}
                onExpand={() => {
                  setVoiceCompact(false)
                  setMode('voice')
                  setDrawerState('open')
                }}
              />
            </div>
          )}
          <div
            hidden={!isOpen || mode !== 'text' || !conversation}
            style={{ display: !isOpen || mode !== 'text' || !conversation ? 'none' : undefined }}
            className="flex flex-1 min-h-0 flex-col"
          >
            <AssistantConversationSwitcher
              openRequest={historyRequest}
              agents={agents ?? []}
              selectedId={effectiveAgentId}
              onSelect={openConversation}
              onNew={newConversation}
              canCreate={can('chat:send')}
            />
            {chatMounted && (
              <ChatComponent
                key={sessionKey}
                agentId={effectiveAgentId}
                initialMessage={initialMessage}
                pagePath={location.pathname}
                headerLayout="controls"
                hideHeaderActions
                scope={{ type: 'system-manager' }}
                onAgentCreated={handleAgentCreated}
                className="flex-1 min-h-0 rounded-none shadow-none border-none"
                enableFullscreen={false}
              />
            )}
          </div>
        </div>
      }
    </>
  )
}
