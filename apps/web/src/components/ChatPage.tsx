import clsx from 'clsx'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '../reactQueryHooks'
import { queryKeys } from '../queryKeys'
import { queries } from '../queryOptions'
import { useURLStringState } from '../hooks/useURLState'
import { useFullscreen } from '../hooks/useFullscreen'
import { useIsDesktop } from '../hooks/useIsDesktop'

import { Chat } from './Chat'
import { SubagentsInlinePanel } from './AgentConversation'
import { BackLink } from './BackLink'
import { ExpandableChatPanel } from './ExpandableChatPanel'
import { AgentViewTabs } from './AgentViewTabs'
import { useChatSession } from '../hooks/useChatSession'
import { AgentInboxPanel } from './squads/AgentInboxPanel'
import { AgentContextPanel } from './squads/AgentContextPanel'
import { AgentWorkStreamsPanel } from './squads/AgentWorkStreamsPanel'
import { AgentMonitorsPanel } from './monitors/AgentMonitorsPanel'
import { AgentInfoPanel } from './AgentInfoPanel'
import { ChatIcon, ExpandIcon, InboxIcon, MemoryIcon, MonitorIcon, WorkStreamIcon } from './icons'
import type { Agent, ChatScopeType } from '@ficus/shared'
import { useChatApi } from '../api/ChatApiProvider'
import { getAgentName, getAgentPrimaryLabel, getAgentSecondaryLabel } from '../lib/agentDisplay'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from './loading/Skeleton'

const SCOPE_FILTERS: { label: string; value: ChatScopeType | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'System', value: 'system-manager' },
  { label: 'Artifact', value: 'artifact-builder' },
  { label: 'Squad Manager', value: 'squad-manager' },
  { label: 'Squad Worker', value: 'squad-worker' },
  // { label: 'Task', value: 'task' },
]

const RECOGNIZED_AGENT_SCOPES = new Set<ChatScopeType>(
  SCOPE_FILTERS.flatMap(({ value }) => (value === 'all' ? [] : [value]))
)

const SCOPE_LABELS: Partial<Record<ChatScopeType, string>> = {
  'system-manager': 'System',
  'artifact-builder': 'Artifact Builder',
  'squad-manager': 'Squad Manager',
  'squad-worker': 'Squad Worker',
  task: 'Task',
}

function getAgentScopeType(agent: Agent): ChatScopeType | null {
  let scope: unknown
  if (agent.agentTypeId === 'artifact-builder-default') {
    // Artifact builders are non-squad agents with a dedicated type.
    scope = 'artifact-builder'
  } else if (agent.squadId) {
    // Squad agents are identified by having a squadId
    scope = agent.agentTypeId === 'manager' ? 'squad-manager' : 'squad-worker'
  } else {
    const ctx = agent.context as { scope?: { type?: unknown } } | null
    scope = ctx?.scope?.type
  }

  return typeof scope === 'string' && RECOGNIZED_AGENT_SCOPES.has(scope as ChatScopeType)
    ? (scope as ChatScopeType)
    : null
}

const canCreateChat = (scope: ChatScopeType | 'all') => scope === 'all' || scope === 'system-manager'

type TabView = 'chat' | 'work' | 'monitors' | 'inbox' | 'context' | 'subagents' | 'info'
const VALID_TABS = ['chat', 'work', 'monitors', 'inbox', 'context', 'subagents', 'info'] as const

const SCOPE_COLORS: Record<string, string> = {
  'system-manager':
    'bg-status-progress-100 dark:bg-status-progress-900/50 text-status-progress-700 dark:text-status-progress-300',
  'artifact-builder':
    'bg-status-attention-100 dark:bg-status-attention-900/50 text-status-attention-700 dark:text-status-attention-300',
  'squad-manager':
    'bg-status-human-wait-100 dark:bg-status-human-wait-900/50 text-status-human-wait-700 dark:text-status-human-wait-300',
  'squad-worker': 'bg-decoration-8-100 dark:bg-decoration-8-900/50 text-decoration-8-700 dark:text-decoration-8-300',
  task: 'bg-status-success-100 dark:bg-status-success-900/50 text-status-success-700 dark:text-status-success-300',
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface ChatPageDependencies {
  ChatComponent?: typeof Chat
  SubagentsInlinePanelComponent?: typeof SubagentsInlinePanel
  AgentWorkStreamsPanelComponent?: typeof AgentWorkStreamsPanel
}

interface ChatPageProps {
  dependencies?: ChatPageDependencies
}

export function ChatPage({ dependencies }: ChatPageProps = {}) {
  const ChatComponent = dependencies?.ChatComponent ?? Chat
  const SubagentsInlinePanelComponent = dependencies?.SubagentsInlinePanelComponent ?? SubagentsInlinePanel
  const AgentWorkStreamsPanelComponent = dependencies?.AgentWorkStreamsPanelComponent ?? AgentWorkStreamsPanel
  const api = useChatApi()
  const { agentId } = useParams<{ agentId?: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { sessionKey, selectAgent, startNewChat } = useChatSession(agentId ?? undefined)
  const [scopeFilter, setScopeFilter] = useURLStringState<ChatScopeType | 'all'>('scope', 'all', [
    'all',
    'system-manager',
    'artifact-builder',
    'squad-manager',
    'squad-worker',
  ])
  // Track if filter was changed by user (not auto-switched)
  const userChangedFilterRef = useRef(false)
  const chatScopeLocation = (value: ChatScopeType | 'all') => {
    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.set('scope', value)
    return { pathname: '/chat', search: nextSearchParams.toString() }
  }
  const handleUserFilterChange = (value: ChatScopeType | 'all') => {
    userChangedFilterRef.current = true
    // Clear agent selection while changing only the scope URL field.
    navigate(chatScopeLocation(value), { replace: true })
  }
  const [newChatMode, setNewChatMode] = useState(searchParams.has('new'))
  const [focusTrigger, setFocusTrigger] = useState(0)
  const [browsingAgents, setBrowsingAgents] = useState(false)
  const [activeTab, setActiveTab] = useURLStringState<TabView>('view', 'chat', VALID_TABS)
  const { isFullscreen, toggleFullscreen } = useFullscreen({ queryParam: 'fullscreen' })
  const isDesktop = useIsDesktop()

  // Fetch all agents and filter client-side by scope
  const { data: allAgents, isLoading: agentsLoading } = useQuery({
    ...queries.agents.list(),
    queryFn: () => api.listAgents(),
  })

  // Filter to only show conversational agents (those with a recognized scope type)
  const agents = useMemo(() => {
    if (!allAgents) return undefined
    return allAgents.filter((a) => {
      const scope = getAgentScopeType(a)
      if (!scope) return false
      if (scopeFilter === 'all') return true
      return scope === scopeFilter
    })
  }, [allAgents, scopeFilter])
  const conversationSkeletonCount = useLoadingShapeCount(
    `chat:conversations:${scopeFilter}`,
    agentsLoading ? undefined : (agents?.length ?? 0),
    { fallbackCount: 6, maxCount: 12 }
  )

  const selectedAgent = agents?.find((a) => a.id === sessionKey)
  const selectedScope = selectedAgent ? getAgentScopeType(selectedAgent) : null
  const { data: agentType } = useQuery({
    ...queries.agentTypes.detail(selectedAgent?.agentTypeId ?? ''),
    enabled: !!selectedAgent?.agentTypeId,
  })

  // Sync session key when URL agentId changes (e.g. auto-select or direct link)
  useEffect(() => {
    if (agentId && !newChatMode) {
      selectAgent(agentId)
    }
  }, [agentId, newChatMode, selectAgent])

  // Exit new chat mode when switching to a scope that doesn't support it
  useEffect(() => {
    if (newChatMode && !canCreateChat(scopeFilter)) {
      setNewChatMode(false)
    }
  }, [scopeFilter, newChatMode])

  // Auto-select first agent if none selected (skip if user clicked back to browse)
  // Don't navigate away if viewing a specific agent that's not in the current filter
  useEffect(() => {
    // Skip during loading/refetching to avoid race conditions
    if (!agents || agentsLoading || newChatMode || browsingAgents) return

    // Mobile is single-pane: stay on the Chats list unless the user explicitly selects a chat.
    if (!isDesktop) {
      if (userChangedFilterRef.current) userChangedFilterRef.current = false
      return
    }

    // A manual filter change may replace the current agent; otherwise only auto-select when none is specified.
    if (userChangedFilterRef.current) {
      userChangedFilterRef.current = false
    } else if (agentId) {
      return
    }

    if (agents.length) {
      navigate(`/chat/${agents[0].id}?scope=${scopeFilter}`, { replace: true })
    }
  }, [
    agents,
    allAgents,
    agentId,
    navigate,
    newChatMode,
    browsingAgents,
    scopeFilter,
    setScopeFilter,
    agentsLoading,
    isDesktop,
  ])

  // Handle ?new search param from header button
  useEffect(() => {
    if (searchParams.has('new')) {
      setSearchParams({}, { replace: true })
      if (!canCreateChat(scopeFilter)) setScopeFilter('system-manager')
      setNewChatMode(true)
      startNewChat()
      setFocusTrigger((n) => n + 1)
    }
  }, [searchParams, setSearchParams, scopeFilter, startNewChat, setScopeFilter])

  const handleNewChat = () => {
    const newChatScope = canCreateChat(scopeFilter) ? scopeFilter : 'system-manager'
    setNewChatMode(true)
    startNewChat()
    setFocusTrigger((n) => n + 1)
    navigate(chatScopeLocation(newChatScope))
  }

  const handleSelectAgent = (id: string) => {
    setNewChatMode(false)
    selectAgent(id)
    // Preserve current scope filter
    navigate(`/chat/${id}?scope=${scopeFilter}`)
  }

  const handleAgentCreated = (id: string) => {
    // Don't change newChatMode or sessionKey here — the Chat component is
    // mid-stream and any prop change would remount/reset it. Just update
    // the URL and refresh the agent list.
    navigate(`/chat/${id}?scope=${scopeFilter}`, { replace: true })
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() })
  }

  // Include searchParams check so ?new is instant (useState initializer only runs on mount)
  const showChat = newChatMode || searchParams.has('new') || agentId

  // On mobile, /chat is the conversation list. Only hide the list once a chat
  // is explicitly selected or new-chat mode is active.
  const showAgentListOnMobile = !showChat && !isDesktop

  const showWorkTab = !!selectedAgent?.squadId
  const { data: selectedSubagents = [] } = useQuery({
    ...queries.agents.children(selectedAgent?.id ?? ''),
    enabled: !!selectedAgent?.id && !newChatMode,
  })
  const hasSelectedSubagents = selectedSubagents.length > 0
  const activeSelectedSubagentCount = selectedSubagents.filter((child) => child.status === 'active').length
  const effectiveActiveTab =
    (!showWorkTab && (activeTab === 'work' || activeTab === 'monitors')) ||
    (activeTab === 'subagents' && !hasSelectedSubagents)
      ? 'chat'
      : activeTab
  const tabToggle = !newChatMode && selectedAgent && (
    <AgentViewTabs
      activeTab={effectiveActiveTab}
      onChange={setActiveTab}
      tabs={[
        { value: 'chat', label: 'Chat', icon: ChatIcon },
        ...(showWorkTab
          ? ([
              { value: 'work', label: 'Work', icon: WorkStreamIcon },
              { value: 'monitors', label: 'Monitors', icon: MonitorIcon, secondary: true },
            ] as const)
          : []),
        { value: 'inbox', label: 'Inbox', icon: InboxIcon },
        ...(hasSelectedSubagents
          ? ([
              {
                value: 'subagents',
                label: 'Subagents',
                icon: ChatIcon,
                secondary: true,
                activeCount: activeSelectedSubagentCount,
              },
            ] as const)
          : []),
        { value: 'context', label: 'Context', icon: MemoryIcon },
        { value: 'info', label: 'Info', icon: MemoryIcon },
      ]}
    />
  )

  const chatContent =
    !newChatMode && selectedAgent && showWorkTab && effectiveActiveTab === 'work' ? (
      <AgentWorkStreamsPanelComponent agent={selectedAgent} squadId={selectedAgent.squadId!} />
    ) : !newChatMode && selectedAgent && showWorkTab && effectiveActiveTab === 'monitors' ? (
      <AgentMonitorsPanel agent={selectedAgent} />
    ) : !newChatMode && selectedAgent && effectiveActiveTab === 'inbox' ? (
      <AgentInboxPanel agent={selectedAgent} onClose={() => setActiveTab('chat')} fullWidth />
    ) : !newChatMode && selectedAgent && effectiveActiveTab === 'context' ? (
      <AgentContextPanel agentId={selectedAgent.id} />
    ) : !newChatMode && selectedAgent && effectiveActiveTab === 'subagents' ? (
      <SubagentsInlinePanelComponent parentAgentId={selectedAgent.id} />
    ) : !newChatMode && selectedAgent && effectiveActiveTab === 'info' ? (
      <AgentInfoPanel agent={selectedAgent} agentType={agentType} />
    ) : (
      <ChatComponent
        key={sessionKey}
        agentId={newChatMode ? undefined : agentId}
        agentName={newChatMode ? undefined : selectedAgent ? getAgentPrimaryLabel(selectedAgent) : undefined}
        agentSecondaryName={newChatMode || !selectedAgent ? undefined : getAgentSecondaryLabel(selectedAgent)}
        scope={{ type: newChatMode ? 'system-manager' : (selectedScope ?? 'system-manager') }}
        className="h-full rounded-none shadow-none"
        focusTrigger={focusTrigger}
        onAgentCreated={handleAgentCreated}
        enableFullscreen={false}
        headerLayout="controls"
      />
    )

  const chatTitle = newChatMode ? 'New Chat' : selectedAgent ? getAgentPrimaryLabel(selectedAgent) : 'Chat'
  const chatSubtitle = newChatMode ? 'System' : selectedScope ? SCOPE_LABELS[selectedScope] || selectedScope : undefined

  return (
    <div className="flex flex-col md:flex-row md:gap-4 flex-1 min-h-0">
      {/* Mobile title */}
      {showAgentListOnMobile && <h2 className="md:hidden text-lg font-semibold text-primary mb-2">Chats</h2>}

      {/* Sidebar - hidden on mobile when viewing a chat */}
      <div
        className={clsx(
          showAgentListOnMobile ? 'flex' : 'hidden md:flex',
          'flex-1 min-h-0 md:flex-none md:w-72 flex-col bg-surface rounded-lg'
        )}
      >
        {/* Mobile scope filter pills */}
        <div className="md:hidden flex items-center px-3 py-1.5 border-b border-th-border">
          <div className="flex gap-1.5 overflow-x-auto pt-1 pb-3 -mb-2">
            {SCOPE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => handleUserFilterChange(f.value)}
                className={clsx(
                  'ficus-button',
                  'px-2.5 py-0.5 rounded-full text-xs whitespace-nowrap',
                  scopeFilter === f.value
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface-secondary text-secondary hover:bg-surface-hover'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop header */}
        <div className="hidden md:block p-3 border-b border-th-border space-y-3">
          <button
            onClick={handleNewChat}
            className="ficus-button ficus-button-primary w-full bg-accent text-on-accent px-4 py-2 rounded-md hover:bg-accent-hover text-sm font-medium"
          >
            New System Chat
          </button>
          <div className="flex flex-wrap gap-1">
            {SCOPE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => handleUserFilterChange(f.value)}
                className={clsx(
                  'ficus-button',
                  'px-2 py-0.5 rounded-full text-xs',
                  scopeFilter === f.value
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface-secondary text-secondary hover:bg-surface-hover'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto">
          {agentsLoading && !agents?.length ? (
            <LoadingSurface label="Loading conversations">
              <SkeletonRows count={Math.max(1, conversationSkeletonCount)}>
                {(index) => (
                  <div key={index} className="space-y-2 border-b border-th-border px-3 py-3 md:py-2.5">
                    <div className="flex items-center gap-2">
                      <SkeletonLine className={index % 2 ? 'w-28' : 'w-36'} />
                      <SkeletonBlock className="ml-auto h-5 w-16 rounded-full" />
                    </div>
                    <SkeletonLine className="w-3/5" />
                  </div>
                )}
              </SkeletonRows>
            </LoadingSurface>
          ) : !agents?.length ? (
            <p className="text-placeholder text-sm text-center my-6">No conversations yet</p>
          ) : null}
          {agents?.map((agent: Agent) => {
            const scope = getAgentScopeType(agent)
            const primaryLabel = getAgentPrimaryLabel(agent)
            const secondaryLabel = getAgentSecondaryLabel(agent)
            const stableName = getAgentName(agent)
            return (
              <button
                key={agent.id}
                onClick={() => handleSelectAgent(agent.id)}
                className={clsx(
                  'ficus-button',
                  'w-full text-left px-3 py-3 md:py-2.5 border-b border-th-border hover:bg-surface-hover group',
                  agentId === agent.id && 'bg-status-progress-50 dark:bg-status-progress-900/20'
                )}
                title={`${stableName} · ${agent.agentTypeId} · ${agent.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-primary truncate">{primaryLabel}</span>
                  {secondaryLabel ? <span className="text-xs text-muted truncate">{secondaryLabel}</span> : null}
                  <span className="text-xs text-placeholder ml-auto md:hidden">
                    {timeAgo(new Date(agent.lastMessageAt ?? agent.createdAt))}
                  </span>
                  <span
                    className={clsx(
                      'text-xs px-1.5 py-0.5 rounded font-medium ml-auto hidden md:inline-block',
                      scope
                        ? (SCOPE_COLORS[scope] ??
                            'bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-700 dark:text-status-neutral-300')
                        : 'bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-700 dark:text-status-neutral-300'
                    )}
                  >
                    {scope ? SCOPE_LABELS[scope] || scope : agent.agentTypeId}
                  </span>
                </div>
                <div className="text-xs text-muted mt-1 hidden md:block">
                  {new Date(agent.lastMessageAt ?? agent.createdAt).toLocaleString()}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Chat area - full width on mobile when viewing a chat */}
      <div className={clsx(showChat ? 'flex' : 'hidden md:flex', 'flex-1 flex-col min-w-0 min-h-0')}>
        {showChat ? (
          <ExpandableChatPanel
            isFullscreen={isFullscreen}
            onExitFullscreen={toggleFullscreen}
            title={chatSubtitle ? `${chatTitle} (${chatSubtitle})` : chatTitle}
            headerExtra={tabToggle}
            className="ficus-panel flex flex-col grow min-h-0 bg-surface md:rounded-lg overflow-hidden"
            inlineHeader={
              <>
                <div className="md:hidden shrink-0 px-3 py-2 border-b border-th-border">
                  <BackLink
                    to="/chat"
                    onClick={() => {
                      setNewChatMode(false)
                      setBrowsingAgents(true)
                    }}
                  >
                    Chats
                  </BackLink>
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-th-border shrink-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium text-primary truncate">{chatTitle}</span>
                    {chatSubtitle && <span className="text-xs text-secondary shrink-0">({chatSubtitle})</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {tabToggle}
                    <button
                      onClick={toggleFullscreen}
                      className="ficus-button p-1.5 rounded-md text-muted hover:text-primary hover:bg-surface-hover transition-colors"
                      aria-label="Fullscreen"
                      title="Fullscreen"
                    >
                      <ExpandIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </>
            }
          >
            {chatContent}
          </ExpandableChatPanel>
        ) : (
          <div className="ficus-panel grow flex items-center justify-center bg-surface rounded-lg px-4 text-center">
            <p className="text-placeholder text-sm">
              {scopeFilter === 'task'
                ? 'Task chats are created from the task detail page'
                : scopeFilter === 'squad-manager' || scopeFilter === 'squad-worker'
                  ? 'Squad agents are created when you initialize a squad'
                  : 'Select a conversation to view'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
