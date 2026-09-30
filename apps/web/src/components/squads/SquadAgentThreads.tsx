import clsx from 'clsx'
import {
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { SQUAD_RECENT_CHAT_LIMIT } from '../../lib/recentChats'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { useFullscreen } from '../../hooks/useFullscreen'
import { useSidebarWidth } from '../../hooks/useSidebarWidth'
import {
  SQUAD_CHAT_CONSULTANTS_COLLAPSED_STORAGE_KEY,
  SQUAD_CHAT_SIDEBAR_WIDTH_STORAGE_KEY,
} from '@ficus/shared/browser-keys'
import { useURLStringState, useURLBooleanState } from '../../hooks/useURLState'
import { usePermissions } from '../../hooks/usePermissions'
import { useSquadAgentThreadsApi } from './squadAgentThreadsApi'
import { Chat } from '../Chat'
import { AgentConversation, SubagentsInlinePanel } from '../AgentConversation'
import { AgentInboxPanel } from './AgentInboxPanel'
import { AgentWorkStreamsPanel } from './AgentWorkStreamsPanel'
import { AgentContextPanel } from './AgentContextPanel'
import { AgentViewTabs } from '../AgentViewTabs'
import { AgentInfoPanel } from '../AgentInfoPanel'
import { getAgentHeaderTitleParts, AgentHeaderTitle } from './AgentViewModal'
import { SpawnAgentModal } from './SpawnAgentModal'
import { SquadChatActions } from './SquadChatActions'
import './SquadAgentThreads.css'
import { Modal } from '../Modal'
import { ExpandableChatPanel } from '../ExpandableChatPanel'
import { AgentActivityDot } from '../AgentActivityDot'
import {
  ChatIcon,
  InboxIcon,
  ExpandIcon,
  ActivityIcon,
  WorkStreamIcon,
  SpinnerIcon,
  MemoryIcon,
  TrashIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../icons'
import type { Agent, WorkStream } from '@ficus/shared'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { ChatSkeleton, LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { getAgentName, getAgentPrimaryLabel, agentMatchesQuery } from '../../lib/agentDisplay'

export interface SquadAgentThreadsDependencies {
  Chat: ComponentType<ComponentProps<typeof Chat>>
  AgentConversation: ComponentType<ComponentProps<typeof AgentConversation>>
  SubagentsInlinePanel: ComponentType<ComponentProps<typeof SubagentsInlinePanel>>
  AgentWorkStreamsPanel: ComponentType<ComponentProps<typeof AgentWorkStreamsPanel>>
  AgentInboxPanel: ComponentType<ComponentProps<typeof AgentInboxPanel>>
  AgentContextPanel: ComponentType<ComponentProps<typeof AgentContextPanel>>
}

export interface SquadAgentThreadsProps {
  agents: Agent[]
  recentlyTerminatedAgents?: Agent[]
  recentlyTerminatedTotalCount?: number
  hasMoreRecentlyTerminatedAgents?: boolean
  isFetchingMoreRecentlyTerminated?: boolean
  onLoadMoreRecentlyTerminated?: () => void
  squadId: string
  isLoading?: boolean
  /** Restrict the picker/list to a single agentTypeId (e.g. 'consultant'). */
  agentTypeFilter?: string
  /** Freeze the view to one agent and hide the picker entirely (e.g. the manager). */
  lockedAgentId?: string
  /** 'page' = single-pane responsive: no desktop sidebar, header dropdown picker at all widths. */
  layout?: 'panel' | 'page'
  /** When nothing is selected, default to the new-consultant compose view. */
  defaultCompose?: boolean
  /** Leading slot in the page header (e.g. a back link). */
  headerLeading?: ReactNode
  /** Per-instance UI dependencies for isolated rendering. Production uses the real implementations. */
  dependencies?: Partial<SquadAgentThreadsDependencies>
}

type TabView = 'chat' | 'work' | 'inbox' | 'context' | 'subagents' | 'info'
const VALID_TABS = ['chat', 'work', 'inbox', 'context', 'subagents', 'info'] as const
const STATUS_LABELS: Record<Agent['status'], string> = {
  active: 'Working',
  idle: 'Idle',
  'waiting-input': 'Waiting for input',
  compacting: 'Compacting',
  resetting: 'Resetting',
  dormant: 'Completed',
  terminated: 'Completed',
}

/**
 * Format a relative time string (e.g., "2 hours ago", "3 days ago")
 */
function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffDay > 0) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  if (diffHour > 0) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`
  if (diffMin > 0) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  return 'Just now'
}

const CHAT_SIDEBAR_MIN_WIDTH = 200
const CHAT_SIDEBAR_MAX_WIDTH = 520
/** Tailwind md:w-64: the chat list's width until the user resizes it. */
const CHAT_SIDEBAR_DEFAULT_WIDTH = 256

export function SquadAgentThreads({
  agents,
  recentlyTerminatedAgents = [],
  recentlyTerminatedTotalCount,
  hasMoreRecentlyTerminatedAgents = false,
  isFetchingMoreRecentlyTerminated = false,
  onLoadMoreRecentlyTerminated,
  squadId,
  isLoading,
  agentTypeFilter,
  lockedAgentId,
  layout = 'panel',
  defaultCompose = false,
  headerLeading,
  dependencies = {},
}: SquadAgentThreadsProps) {
  const {
    Chat: ChatComponent = Chat,
    AgentConversation: AgentConversationComponent = AgentConversation,
    SubagentsInlinePanel: SubagentsInlinePanelComponent = SubagentsInlinePanel,
    AgentWorkStreamsPanel: AgentWorkStreamsPanelComponent = AgentWorkStreamsPanel,
    AgentInboxPanel: AgentInboxPanelComponent = AgentInboxPanel,
    AgentContextPanel: AgentContextPanelComponent = AgentContextPanel,
  } = dependencies
  const isPage = layout === 'page'
  // Standalone chat pages retain their existing picker density and non-collapsible list.
  const recentConsultantLimit = isPage ? 10 : SQUAD_RECENT_CHAT_LIMIT
  const consultantSectionId = useId()
  const agentSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:agent-conversations:${agentTypeFilter ?? 'all'}`,
    isLoading ? undefined : agents.length,
    { fallbackCount: 5, maxCount: 10 }
  )
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canRunAgents = !permissionsLoading && can('agents:run')
  const canTerminateAgents = !permissionsLoading && can('agents:terminate')
  const canCreateConsultant = canRunAgents && !lockedAgentId && (!agentTypeFilter || agentTypeFilter === 'consultant')
  const queryClient = useQueryClient()
  const { terminateSquadAgent, terminateSquadAgentsBulk } = useSquadAgentThreadsApi()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedAgentId = searchParams.get('agent')
  const [activeTab, setActiveTab] = useURLStringState<TabView>('view', 'chat', VALID_TABS)
  const { isFullscreen, toggleFullscreen } = useFullscreen({ queryParam: 'fullscreen' })

  // Spawn modal state
  const [showSpawnModal, setShowSpawnModal] = useState(false)
  const [showMobilePicker, setShowMobilePicker] = useState(false)

  // Compose consultant chat state. Backed by the URL (?newConsultant=1) so the
  // view is deep-linkable and survives refreshes.
  const [composingConsultant, setComposingConsultant] = useURLBooleanState('newConsultant')
  const [handoffConsultantAgentId, setHandoffConsultantAgentId] = useState<string | null>(null)

  // Track which agent or agent type is being terminated (for confirmation state)
  const [confirmingTerminate, setConfirmingTerminate] = useState<string | null>(null)
  const [confirmingTerminateAll, setConfirmingTerminateAll] = useState<string | null>(null)
  const terminateTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const terminateAllTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const panelRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  // The chat list keeps at least CHAT_SIDEBAR_MIN_WIDTH and leaves the open chat at least half the row.
  const sidebarBounds = () => ({
    min: CHAT_SIDEBAR_MIN_WIDTH,
    max: Math.min(CHAT_SIDEBAR_MAX_WIDTH, (panelRef.current?.clientWidth ?? 2 * CHAT_SIDEBAR_MAX_WIDTH) / 2),
  })
  const sidebar = useSidebarWidth(sidebarRef, SQUAD_CHAT_SIDEBAR_WIDTH_STORAGE_KEY, sidebarBounds)

  // Cleanup terminate confirmation timeouts on unmount
  useEffect(() => {
    return () => {
      if (terminateTimeoutRef.current) clearTimeout(terminateTimeoutRef.current)
      if (terminateAllTimeoutRef.current) clearTimeout(terminateAllTimeoutRef.current)
    }
  }, [])

  // Fetch agent types for display names
  const { data: agentTypes = [] } = useQuery(queries.agentTypes.list())
  const agentTypeMap = useMemo(() => new Map(agentTypes.map((at) => [at.id, at])), [agentTypes])

  // Fetch work streams to check if agents have active ones
  const { data: workStreams = [] } = useQuery(queries.squads.workStreams(squadId))

  // Build a set of agent IDs that have active work streams
  const agentsWithActiveWorkStreams = useMemo(() => {
    const activeWs = workStreams.filter((ws: WorkStream) => ws.status !== 'done' && ws.status !== 'canceled')
    const agentIds = new Set<string>()
    activeWs.forEach((ws: WorkStream) => {
      if (ws.assigneeAgentId) agentIds.add(ws.assigneeAgentId)
      ws.agentIds?.forEach((id: string) => {
        // Find matching agent (supports prefix)
        const matchingAgent = agents.find((a) => a.id === id || a.id.startsWith(id))
        if (matchingAgent) agentIds.add(matchingAgent.id)
      })
    })
    return agentIds
  }, [workStreams, agents])

  // Terminate agent mutation
  const terminateMutation = useMutation({
    mutationFn: (agentId: string) => terminateSquadAgent(squadId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agentsWithRecent(squadId) })
      setConfirmingTerminate(null)
    },
    onError: () => {
      setConfirmingTerminate(null)
    },
  })

  // Bulk-terminate agents of a type. The UI only exposes this for consultants.
  const terminateAllMutation = useMutation({
    mutationFn: (agentTypeId: string) => terminateSquadAgentsBulk(squadId, agentTypeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agentsWithRecent(squadId) })
      setConfirmingTerminateAll(null)
    },
    onError: () => {
      setConfirmingTerminateAll(null)
    },
  })

  // Check if an agent can be terminated
  const canTerminateAgent = (agent: Agent): { canTerminate: boolean; reason?: string } => {
    if (agent.status === 'terminated') {
      return { canTerminate: false, reason: 'Agent is already terminated' }
    }
    if (agent.status === 'dormant') {
      return { canTerminate: false, reason: 'Agent is already dormant' }
    }
    if (agent.agentTypeId === 'manager') {
      return { canTerminate: false, reason: 'Cannot terminate manager agents' }
    }
    if (agent.persist) {
      return { canTerminate: false, reason: 'Cannot terminate persistent agent' }
    }
    if (agent.status !== 'idle') {
      return { canTerminate: false, reason: 'Agent must be idle to terminate' }
    }
    if (agentsWithActiveWorkStreams.has(agent.id)) {
      return { canTerminate: false, reason: 'Agent has active work streams' }
    }
    return { canTerminate: true }
  }

  const [agentSearch, setAgentSearch] = useState('')
  const [managingChats, setManagingChats] = useState(false)
  const [showAllConsultants, setShowAllConsultants] = useURLBooleanState('allConsultantChats')
  const [activeAgentsOnly, setActiveAgentsOnly] = useURLBooleanState('activeAgentsOnly')

  const visibleAgents = useMemo(() => {
    let list = agents
    if (lockedAgentId) list = list.filter((a) => a.id === lockedAgentId)
    else if (agentTypeFilter) list = list.filter((a) => a.agentTypeId === agentTypeFilter)
    return list.filter(
      (a) =>
        a.status !== 'dormant' &&
        a.status !== 'terminated' &&
        (a.agentTypeId === 'manager' || agentMatchesQuery(a, agentSearch))
    )
  }, [agents, agentSearch, agentTypeFilter, lockedAgentId])
  const isSearching = agentSearch.trim().length > 0
  const filteredDormantAgents = useMemo(() => {
    let list = agents.filter((agent) => agent.status === 'dormant')
    if (lockedAgentId) list = list.filter((agent) => agent.id === lockedAgentId)
    else if (agentTypeFilter) list = list.filter((agent) => agent.agentTypeId === agentTypeFilter)
    return list.filter((agent) => agentMatchesQuery(agent, agentSearch))
  }, [agents, agentSearch, agentTypeFilter, lockedAgentId])
  const filteredTerminatedAgents = useMemo(
    () => recentlyTerminatedAgents.filter((agent) => agentMatchesQuery(agent, agentSearch)),
    [recentlyTerminatedAgents, agentSearch]
  )

  /**
   * Dormant and terminated are one thing to a reader: work that has finished.
   * The distinction is a lifecycle detail (a dormant agent wakes on the next
   * message, a terminated one does not) that no one operating the panel acts
   * on, so both land in "Recently Completed" and neither state is labelled.
   * Newest completion first, whichever timestamp the agent carries.
   */
  const completedAt = (agent: Agent) => agent.dormantAt ?? agent.terminatedAt ?? null
  const filteredCompletedAgents = useMemo(() => {
    const merged = [...filteredDormantAgents, ...filteredTerminatedAgents]
    return merged.sort((a, b) => {
      const left = completedAt(a)
      const right = completedAt(b)
      if (!left && !right) return 0
      if (!left) return 1
      if (!right) return -1
      return new Date(right).getTime() - new Date(left).getTime()
    })
  }, [filteredDormantAgents, filteredTerminatedAgents])

  // Sort agents: manager first, then group by agentTypeId, within each group sort by stable status/activity.
  // Use the latest human-authored prompt/message instead of lastMessageAt or updatedAt, which can change
  // whenever an agent emits a message and cause active rows to jump around.
  const sortedAgents = useMemo(() => {
    const statusOrder: Record<string, number> = { active: 0, 'waiting-input': 1, idle: 2 }

    return [...visibleAgents].sort((a, b) => {
      // Manager always first
      const aIsManager = a.agentTypeId === 'manager'
      const bIsManager = b.agentTypeId === 'manager'
      if (aIsManager && !bIsManager) return -1
      if (!aIsManager && bIsManager) return 1

      // Group by agentTypeId
      if (a.agentTypeId !== b.agentTypeId) {
        return a.agentTypeId.localeCompare(b.agentTypeId)
      }

      // Consultant chats follow human recency only; workers prioritize status, then recency.
      const aOrder = a.agentTypeId === 'consultant' ? 0 : (statusOrder[a.status] ?? 3)
      const bOrder = b.agentTypeId === 'consultant' ? 0 : (statusOrder[b.status] ?? 3)
      if (aOrder !== bOrder) return aOrder - bOrder

      const aTime = new Date(a.lastHumanMessageAt ?? a.createdAt).getTime()
      const bTime = new Date(b.lastHumanMessageAt ?? b.createdAt).getTime()
      if (aTime !== bTime) return bTime - aTime

      const nameCompare = getAgentName(a).localeCompare(getAgentName(b))
      if (nameCompare !== 0) return nameCompare

      return a.id.localeCompare(b.id)
    })
  }, [visibleAgents])

  // Recent chats (consultants) remembers whether you keep it closed, in this browser.
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(() =>
    readConsultantsCollapsed() ? new Set(['consultant']) : new Set()
  )
  const consultantsCollapsed = !isPage && !isSearching && collapsedTypes.has('consultant')
  const [terminatedCollapsed, setTerminatedCollapsed] = useState(true)
  const effectiveTerminatedCollapsed = isSearching ? false : terminatedCollapsed
  const terminatedLoadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (
      activeAgentsOnly ||
      effectiveTerminatedCollapsed ||
      !hasMoreRecentlyTerminatedAgents ||
      isFetchingMoreRecentlyTerminated
    )
      return
    if (!onLoadMoreRecentlyTerminated || typeof IntersectionObserver === 'undefined') return
    const target = terminatedLoadMoreRef.current
    if (!target) return

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRecentlyTerminated()
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [
    activeAgentsOnly,
    effectiveTerminatedCollapsed,
    hasMoreRecentlyTerminatedAgents,
    isFetchingMoreRecentlyTerminated,
    onLoadMoreRecentlyTerminated,
  ])

  const toggleType = (agentTypeId: string) =>
    setCollapsedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(agentTypeId)) next.delete(agentTypeId)
      else next.add(agentTypeId)
      if (agentTypeId === 'consultant') writeConsultantsCollapsed(next.has('consultant'))
      return next
    })

  // Auto-select the first agent on initial load — but NOT on the dedicated pages: the
  // consultant page defaults to compose, the manager page locks to one agent.
  const initialAgentRef = useRef<string | null>(null)
  if (!lockedAgentId && !defaultCompose && !initialAgentRef.current && sortedAgents.length > 0) {
    initialAgentRef.current =
      sortedAgents.find(
        (agent) =>
          !activeAgentsOnly ||
          agent.agentTypeId === 'manager' ||
          agent.agentTypeId === 'consultant' ||
          agent.status !== 'idle'
      )?.id ?? null
  }
  const effectiveAgentId = lockedAgentId ?? (selectedAgentId || initialAgentRef.current)

  // Support ID prefix matching - look in both active and recently terminated agents
  // Terminated agents page in, so the server total is authoritative for them;
  // dormant agents are always fully loaded and counted directly.
  const recentlyCompletedCount = isSearching
    ? filteredCompletedAgents.length
    : filteredDormantAgents.length + (recentlyTerminatedTotalCount ?? recentlyTerminatedAgents.length)
  // Picker filters never clear an open conversation, including when an agent becomes idle.
  const allAgents = [...agents, ...recentlyTerminatedAgents].filter((agent) =>
    lockedAgentId ? agent.id === lockedAgentId : !agentTypeFilter || agent.agentTypeId === agentTypeFilter
  )
  const potentialAgents = allAgents.filter(
    (agent) => effectiveAgentId && (agent.id === effectiveAgentId || agent.id.startsWith(effectiveAgentId))
  )
  // Only mark selected if exactly one match
  const selectedAgent = potentialAgents.length === 1 ? potentialAgents[0] : null
  const { data: agentType } = useQuery({
    ...queries.agentTypes.detail(selectedAgent?.agentTypeId ?? ''),
    enabled: !!selectedAgent?.agentTypeId,
  })
  const { data: selectedSubagents = [] } = useQuery({
    ...queries.agents.children(selectedAgent?.id ?? ''),
    enabled: !!selectedAgent?.id,
  })
  const hasSelectedSubagents = selectedSubagents.length > 0
  const activeSelectedSubagentCount = selectedSubagents.filter((child) => child.status === 'active').length
  const effectiveActiveTab = activeTab === 'subagents' && !hasSelectedSubagents ? 'chat' : activeTab

  // True once the freshly-created consultant's message history is cached. The scope-Chat composer
  // warms messagesInfinite(<newId>) after creating the agent. We observe the cache via
  // useSyncExternalStore (NOT a manual subscribe+setState, which can fire during render and loop).
  const subscribeHandoffMessages = useCallback(
    (onChange: () => void) => (handoffConsultantAgentId ? queryClient.getQueryCache().subscribe(onChange) : () => {}),
    [handoffConsultantAgentId, queryClient]
  )
  const getHandoffMessagesReady = useCallback(
    () =>
      !!handoffConsultantAgentId &&
      queryClient.getQueryData(queryKeys.agents.messagesInfinite(handoffConsultantAgentId)) != null,
    [handoffConsultantAgentId, queryClient]
  )
  const handoffMessagesReady = useSyncExternalStore(
    subscribeHandoffMessages,
    getHandoffMessagesReady,
    getHandoffMessagesReady
  )

  // Hold the compose view until the new agent is BOTH in the refetched list AND its messages are
  // cached — otherwise the pane flashes the empty "choose an agent" state and the just-sent user
  // message disappears/reappears when we swap to the real conversation.
  const handoffPending = !!handoffConsultantAgentId && (!selectedAgent || !handoffMessagesReady)
  // A locked view never composes; the consultant page composes by default until an agent is picked.
  const composing = !lockedAgentId && (composingConsultant || handoffPending || (defaultCompose && !selectedAgentId))
  // The agent highlighted in the list. While composing a new consultant chat, no
  // row is selected so the last-viewed agent is visually deselected.
  const listSelectedAgentId = composing ? null : (selectedAgent?.id ?? null)

  // Apply activity filtering after resolving the open conversation, so its row
  // and category survive status changes (including an unambiguous ID prefix).
  const filteredAgents = useMemo(
    () =>
      sortedAgents.filter(
        (agent) =>
          !activeAgentsOnly ||
          agent.id === listSelectedAgentId ||
          agent.agentTypeId === 'manager' ||
          agent.agentTypeId === 'consultant' ||
          agent.status !== 'idle'
      ),
    [sortedAgents, activeAgentsOnly, listSelectedAgentId]
  )
  const visibleCompletedAgents = activeAgentsOnly
    ? filteredCompletedAgents.filter((agent) => agent.id === listSelectedAgentId)
    : filteredCompletedAgents

  const agentTypeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const agent of filteredAgents) counts.set(agent.agentTypeId, (counts.get(agent.agentTypeId) ?? 0) + 1)
    return counts
  }, [filteredAgents])

  const agentTypeGroups = useMemo(() => {
    const groups: Array<{ agentTypeId: string; agents: Agent[] }> = []
    for (const agent of filteredAgents) {
      const current = groups.at(-1)
      if (current?.agentTypeId === agent.agentTypeId) current.agents.push(agent)
      else groups.push({ agentTypeId: agent.agentTypeId, agents: [agent] })
    }
    return groups
  }, [filteredAgents])

  // A lone worker category stays expanded; consultant chats have their own disclosure below.
  const onlyOneCategory = agentTypeGroups.length === 1

  const managerAgentTypeGroups = agentTypeGroups.filter((group) => group.agentTypeId === 'manager')
  const consultantAgents = filteredAgents.filter((agent) => agent.agentTypeId === 'consultant')
  const visibleConsultants =
    showAllConsultants || isSearching ? consultantAgents : consultantAgents.slice(0, recentConsultantLimit)
  const otherAgentTypeGroups = agentTypeGroups.filter(
    (group) => group.agentTypeId !== 'manager' && group.agentTypeId !== 'consultant'
  )

  useEffect(() => {
    if (handoffConsultantAgentId && selectedAgent?.id === handoffConsultantAgentId && handoffMessagesReady) {
      setComposingConsultant(false)
      setHandoffConsultantAgentId(null)
    }
  }, [handoffConsultantAgentId, selectedAgent?.id, handoffMessagesReady])

  const handleSelectAgent = (agentId: string) => {
    setHandoffConsultantAgentId(null)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('agent', agentId)
      next.delete('subagent')
      next.delete('newConsultant') // exit the new-consultant compose view
      if (next.get('view') === 'subagents') next.set('view', 'chat')
      return next
    })
  }

  const closeMobilePicker = () => {
    setShowMobilePicker(false)
    setAgentSearch('')
  }

  const selectFromMobilePicker = (agentId: string) => {
    handleSelectAgent(agentId)
    closeMobilePicker()
  }

  const handleAgentRowSelect = (agentId: string) => {
    if (showMobilePicker) {
      selectFromMobilePicker(agentId)
      return
    }

    handleSelectAgent(agentId)
  }

  const renderTerminateAllButton = (agentTypeId: string, agents: Agent[]) => {
    if (agentTypeId !== 'consultant' || !canTerminateAgents || !managingChats) return null

    const terminatableAgents = agents.filter((agent) => canTerminateAgent(agent).canTerminate)
    if (terminatableAgents.length === 0) return null

    const isConfirming = confirmingTerminateAll === agentTypeId
    const isTerminating = terminateAllMutation.isPending && terminateAllMutation.variables === agentTypeId

    return (
      <button
        type="button"
        data-testid="terminate-all-consultant"
        aria-label={`Archive all ${terminatableAgents.length} consultant agents`}
        onClick={(e) => {
          e.stopPropagation()
          if (isConfirming) {
            terminateAllMutation.mutate(agentTypeId)
          } else {
            setConfirmingTerminateAll(agentTypeId)
            if (terminateAllTimeoutRef.current) clearTimeout(terminateAllTimeoutRef.current)
            terminateAllTimeoutRef.current = setTimeout(
              () => setConfirmingTerminateAll((prev) => (prev === agentTypeId ? null : prev)),
              3000
            )
          }
        }}
        disabled={isTerminating}
        className={clsx(
          'ficus-button',
          'ml-2 shrink-0 rounded p-1 transition-colors',
          isConfirming
            ? 'bg-status-danger-100 text-status-danger-600 hover:bg-status-danger-200 dark:bg-status-danger-900/40 dark:text-status-danger-400 dark:hover:bg-status-danger-900/60'
            : 'text-muted hover:bg-status-danger-50 hover:text-status-danger-600 dark:hover:bg-status-danger-900/30'
        )}
        title={isConfirming ? 'Click again to confirm' : 'Archive all'}
      >
        {isTerminating ? <SpinnerIcon className="w-3.5 h-3.5 animate-spin" /> : <TrashIcon className="w-3.5 h-3.5" />}
      </button>
    )
  }

  const renderAgentRow = (agent: Agent, compact = false) => {
    const isSelected = listSelectedAgentId === agent.id
    const stableName = getAgentName(agent)
    const agentName = agent.agentTypeId === 'manager' ? `Manager (${stableName})` : getAgentPrimaryLabel(agent)
    const activityAt = agent.lastHumanMessageAt ?? agent.createdAt
    const lastMessageTime = activityAt ? formatRelativeTime(activityAt) : null
    const terminateCheck = canTerminateAgent(agent)
    const mayTerminateAgent = managingChats && canTerminateAgents && terminateCheck.canTerminate
    const quietConsultant = agent.agentTypeId === 'consultant' && agent.status === 'idle'
    const isConfirmingThis = confirmingTerminate === agent.id

    return (
      <div key={agent.id} className={clsx('squad-chat-agent group relative', isSelected && 'is-selected')}>
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={() => handleAgentRowSelect(agent.id)}
          title={`${stableName} · ${agent.agentTypeId} · ${agent.id}`}
          className={clsx(
            'ficus-button',
            'block w-full rounded-lg px-2 text-left',
            compact ? 'py-1.5 md:py-2' : 'py-2',
            mayTerminateAgent && 'pr-10'
          )}
        >
          <span className="flex items-center gap-2">
            <AgentActivityDot status={agent.status} />
            <span className="truncate text-sm font-medium text-primary">{agentName}</span>
          </span>
          {!compact && (
            <span className="ml-4 mt-1 flex items-center justify-between gap-2 text-[11px] text-secondary">
              <span className="truncate">{!quietConsultant && STATUS_LABELS[agent.status]}</span>
              {lastMessageTime && <span className="shrink-0">{lastMessageTime}</span>}
            </span>
          )}
        </button>
        {mayTerminateAgent && (
          <button
            type="button"
            aria-label={isConfirmingThis ? 'Confirm archive conversation' : 'Archive conversation'}
            onClick={() => {
              if (isConfirmingThis) {
                terminateMutation.mutate(agent.id)
              } else {
                setConfirmingTerminate(agent.id)
                if (terminateTimeoutRef.current) clearTimeout(terminateTimeoutRef.current)
                terminateTimeoutRef.current = setTimeout(
                  () => setConfirmingTerminate((prev) => (prev === agent.id ? null : prev)),
                  3000
                )
              }
            }}
            disabled={terminateMutation.isPending}
            className={clsx(
              'ficus-button',
              'absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-2 text-secondary transition-opacity hover:bg-surface-hover hover:text-primary focus-visible:opacity-100',
              isConfirmingThis &&
                'bg-status-danger-100 text-status-danger-600 dark:bg-status-danger-900/40 dark:text-status-danger-400'
            )}
            title={isConfirmingThis ? 'Click again to archive' : 'Archive conversation'}
          >
            {terminateMutation.isPending && terminateMutation.variables === agent.id ? (
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TrashIcon className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    )
  }

  const renderAgentTypeGroups = (groups: Array<{ agentTypeId: string; agents: Agent[] }>) =>
    groups.map((group) => {
      const agentType = agentTypeMap.get(group.agentTypeId)
      const sectionName =
        agentType?.name || group.agentTypeId.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
      const isManager = group.agentTypeId === 'manager'
      const collapsible = !isManager && !isSearching && !onlyOneCategory
      const isCollapsed = collapsible && collapsedTypes.has(group.agentTypeId)
      const visibleAgents = isCollapsed
        ? group.agents.filter((agent) => agent.id === listSelectedAgentId)
        : group.agents
      return (
        <section key={group.agentTypeId} data-agent-type-section={group.agentTypeId} className="space-y-1">
          {!isManager && (
            <button
              type="button"
              onClick={() => collapsible && toggleType(group.agentTypeId)}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${sectionName}`}
              aria-expanded={!isCollapsed}
              disabled={!collapsible}
              className="ficus-button squad-chat-category flex w-full items-center gap-1 rounded-md px-2 py-2 text-left enabled:hover:bg-surface-hover"
            >
              {collapsible &&
                (isCollapsed ? (
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                ))}
              <span>{sectionName}</span>
              <span className="ml-auto">{agentTypeCounts.get(group.agentTypeId) ?? 0}</span>
            </button>
          )}
          {visibleAgents.map((agent) => renderAgentRow(agent, isManager))}
        </section>
      )
    })

  const renderChatActions = (inPicker = false) => (
    <SquadChatActions
      canManageChats={canTerminateAgents}
      managingChats={managingChats}
      onManageChats={() => {
        setManagingChats((value) => !value)
        setConfirmingTerminate(null)
        setConfirmingTerminateAll(null)
      }}
      canCreateConsultant={canCreateConsultant}
      canSpawnAgent={canRunAgents && !lockedAgentId}
      onNewChat={() => {
        if (inPicker) closeMobilePicker()
        setHandoffConsultantAgentId(null)
        setComposingConsultant(true)
      }}
      onSpawnAgent={() => {
        if (inPicker) closeMobilePicker()
        setShowSpawnModal(true)
      }}
    />
  )

  // Shared agent-list body rendered in both the desktop sidebar and the mobile picker modal.
  const renderAgentListBody = (inPicker = false) => (
    <div className="flex min-h-0 flex-1 flex-col w-full">
      <div className="squad-chat-toolbar shrink-0 border-b border-th-border pb-1 md:pb-2">
        <div className="mx-3 my-2 flex items-center gap-1.5">
          <input
            type="search"
            value={agentSearch}
            onInput={(e) => setAgentSearch(e.currentTarget.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="ficus-field h-9 md:h-[26px] min-w-0 flex-1 px-2 py-1 text-base md:text-xs rounded border border-th-border bg-surface text-primary placeholder:text-placeholder"
          />
          <button
            type="button"
            aria-label="Active workers only"
            aria-pressed={activeAgentsOnly}
            title={
              activeAgentsOnly
                ? 'Hiding idle and completed workers — click to show all'
                : 'Hide idle and completed workers'
            }
            onClick={() => setActiveAgentsOnly(!activeAgentsOnly)}
            className={clsx(
              'ficus-button',
              'squad-chat-filter flex h-9 w-9 md:h-[26px] md:w-[26px] shrink-0 items-center justify-center rounded border transition-colors',
              activeAgentsOnly
                ? 'border-accent'
                : 'border-th-border text-muted hover:bg-surface-hover hover:text-primary'
            )}
          >
            <ActivityIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        {managerAgentTypeGroups.length > 0 && (
          <div className="px-2 md:pt-1">{renderAgentTypeGroups(managerAgentTypeGroups)}</div>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-2">
        {consultantAgents.length > 0 && (
          <section data-agent-type-section="consultant" className="space-y-1">
            <div className={clsx('squad-chat-category flex items-center justify-between', isPage && 'px-2 py-1')}>
              {isPage ? (
                <span>{showAllConsultants || isSearching ? 'Consultant chats' : 'Recent chats'}</span>
              ) : (
                <button
                  type="button"
                  aria-label={`${consultantsCollapsed ? 'Expand' : 'Collapse'} ${showAllConsultants || isSearching ? 'Consultant chats' : 'Recent chats'}`}
                  aria-expanded={!consultantsCollapsed}
                  aria-controls={`${consultantSectionId}-${inPicker ? 'picker' : 'sidebar'}`}
                  disabled={isSearching}
                  onClick={(event) => {
                    // Pointer activation does not focus buttons in every browser. Move focus
                    // out of the rows before hiding them, just as keyboard activation does.
                    event.currentTarget.focus()
                    toggleType('consultant')
                  }}
                  className="ficus-button squad-chat-category flex w-full items-center gap-1 rounded-md px-2 py-2 text-left enabled:hover:bg-surface-hover"
                >
                  {consultantsCollapsed ? (
                    <ChevronRightIcon className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  )}
                  <span>{showAllConsultants || isSearching ? 'Consultant chats' : 'Recent chats'}</span>
                </button>
              )}
              {!isSearching && !consultantsCollapsed && renderTerminateAllButton('consultant', consultantAgents)}
            </div>
            <div
              id={`${consultantSectionId}-${inPicker ? 'picker' : 'sidebar'}`}
              hidden={consultantsCollapsed}
              className="space-y-1"
            >
              {visibleConsultants.map((agent) => renderAgentRow(agent))}
              {!isSearching && consultantAgents.length > recentConsultantLimit && (
                <button
                  type="button"
                  onClick={() => setShowAllConsultants(!showAllConsultants)}
                  className="ficus-button px-2 py-1.5 text-xs text-secondary hover:text-primary"
                >
                  {showAllConsultants ? 'Show recent' : `View all (${consultantAgents.length})`}
                </button>
              )}
            </div>
          </section>
        )}
        {consultantAgents.length === 0 &&
          otherAgentTypeGroups.length === 0 &&
          visibleCompletedAgents.length === 0 &&
          (activeAgentsOnly || isSearching) && (
            <p role="status" className="px-3 py-6 text-center text-sm text-secondary">
              {isSearching ? 'No conversations match your search' : 'No active agents'}
            </p>
          )}
        {renderAgentTypeGroups(otherAgentTypeGroups)}

        {/*
        Finished work, in one place. Dormant and terminated agents are shown
        identically: the panel never advertises which one an agent is, because
        the difference is not something the reader acts on here.
      */}
        {visibleCompletedAgents.length > 0 && (
          <section data-agent-type-section="recently-completed" className="space-y-1">
            <button
              type="button"
              aria-expanded={!effectiveTerminatedCollapsed}
              onClick={() => setTerminatedCollapsed((collapsed) => !collapsed)}
              className="ficus-button w-full rounded-md px-2 py-2 flex items-center justify-between text-left hover:bg-surface-hover"
            >
              <span className="squad-chat-category">
                Recently Completed ({activeAgentsOnly ? visibleCompletedAgents.length : recentlyCompletedCount})
              </span>
              {effectiveTerminatedCollapsed ? (
                <ChevronRightIcon className="w-4 h-4 shrink-0 text-muted" aria-hidden />
              ) : (
                <ChevronDownIcon className="w-4 h-4 shrink-0 text-muted" aria-hidden />
              )}
            </button>
            {(effectiveTerminatedCollapsed
              ? visibleCompletedAgents.filter((agent) => agent.id === listSelectedAgentId)
              : visibleCompletedAgents
            ).map((agent) => {
              const isSelected = listSelectedAgentId === agent.id
              const agentName = getAgentPrimaryLabel(agent)
              const stableName = getAgentName(agent)
              const finishedAt = completedAt(agent)
              const finishedTime = finishedAt ? formatRelativeTime(finishedAt) : null

              return (
                <button
                  type="button"
                  key={agent.id}
                  className={clsx(
                    'ficus-button',
                    'squad-chat-agent block w-full rounded-lg px-2 py-2 text-left',
                    isSelected && 'is-selected'
                  )}
                  onClick={() => handleAgentRowSelect(agent.id)}
                  title={`${stableName} · ${agent.agentTypeId} · ${agent.id}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0 bg-status-neutral-300 dark:bg-status-neutral-600"
                      aria-hidden
                    />
                    <span className="text-sm font-medium truncate text-secondary">{agentName}</span>
                  </div>
                  <div className="ml-4 mt-1 flex items-center justify-between gap-2 text-[11px] text-secondary">
                    <span className="truncate">Completed</span>
                    {finishedTime && <span className="shrink-0">{finishedTime}</span>}
                  </div>
                </button>
              )
            })}
            {!activeAgentsOnly && !effectiveTerminatedCollapsed && hasMoreRecentlyTerminatedAgents && (
              <div ref={terminatedLoadMoreRef} className="border-t border-th-border p-2">
                <button
                  type="button"
                  onClick={onLoadMoreRecentlyTerminated}
                  disabled={isFetchingMoreRecentlyTerminated}
                  className="ficus-button w-full rounded-md px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover disabled:opacity-60"
                >
                  {isFetchingMoreRecentlyTerminated ? 'Loading more completed agents…' : 'Load more completed agents'}
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )

  // Header agent picker — a dropdown trigger (mobile-only in panel mode, shown at all widths in
  // page mode) plus a static title on panel desktop, where the sidebar is the picker.
  const renderPickerTrigger = (label: ReactNode, ariaLabel: string) => (
    <>
      <button
        type="button"
        data-testid="agent-picker-trigger"
        onClick={() => setShowMobilePicker(true)}
        className={clsx('ficus-button', 'flex items-center gap-1 min-w-0 text-left', !isPage && 'md:hidden')}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={showMobilePicker}
      >
        {label}
        <ChevronDownIcon className="w-4 h-4 shrink-0 text-muted" />
      </button>
      {!isPage && (
        <span data-testid="agent-picker-static" className="hidden md:flex items-baseline min-w-0">
          {label}
        </span>
      )}
    </>
  )

  if (isLoading && agents.length === 0) {
    return (
      <div className={clsx('flex h-full w-full min-w-0', !isPage && 'md:flex-row')}>
        {!isPage && (
          <LoadingSurface
            label="Loading agent conversations"
            className="hidden w-72 shrink-0 border-r border-th-border md:block"
          >
            <SkeletonRows count={Math.max(1, agentSkeletonCount)}>
              {(index) => (
                <div key={index} className="space-y-2 border-b border-th-border p-3">
                  <div className="flex items-center gap-2">
                    <SkeletonBlock className="h-8 w-8 rounded-full" />
                    <SkeletonLine className={index % 2 ? 'w-24' : 'w-32'} />
                  </div>
                  <SkeletonLine className="ml-10 w-3/5" />
                </div>
              )}
            </SkeletonRows>
          </LoadingSurface>
        )}
        <ChatSkeleton label="Loading agent conversation" className="min-w-0" />
      </div>
    )
  }

  if (agents.length === 0) {
    return (
      <div className="text-center py-12 text-muted">
        <ChatIcon className="w-12 h-12 mx-auto mb-3 text-placeholder" />
        <p className="text-lg">No agents in this squad yet</p>
        <p className="text-sm mt-1">Agent conversations will appear here when work begins.</p>
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className={clsx('flex', isPage ? 'flex-col' : 'flex-col md:flex-row gap-3 md:gap-0', 'h-full w-full min-w-0')}
      data-squad-agent-panel
      tabIndex={-1}
      aria-label="Agent conversations"
    >
      {/* Agent list sidebar - panel mode only (page mode uses the header dropdown) */}
      {!isPage && (
        <>
          <div
            ref={sidebarRef}
            style={sidebar.width === undefined ? undefined : { width: sidebar.width, maxWidth: '50%' }}
            className="squad-chat-sidebar hidden md:flex md:w-64 shrink-0 border border-th-border rounded-lg overflow-hidden flex-col min-h-0"
          >
            <div className="squad-chat-toolbar relative z-20 shrink-0 flex items-center justify-between gap-2 px-3 pt-3 pb-1">
              <h3 className="text-sm font-semibold text-primary">Chats</h3>
              {renderChatActions()}
            </div>
            {renderAgentListBody()}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat list"
            aria-valuenow={Math.round(sidebar.width ?? CHAT_SIDEBAR_DEFAULT_WIDTH)}
            aria-valuemin={CHAT_SIDEBAR_MIN_WIDTH}
            aria-valuemax={CHAT_SIDEBAR_MAX_WIDTH}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            className="group hidden md:flex w-4 shrink-0 cursor-col-resize touch-none select-none items-center justify-center rounded-md focus-visible:outline-none"
            {...sidebar.handle}
          >
            <span
              aria-hidden
              className={clsx(
                'h-10 w-1 rounded-full transition-colors',
                sidebar.resizing ? 'bg-accent' : 'bg-th-border group-hover:bg-placeholder group-focus-visible:bg-accent'
              )}
            />
          </div>
        </>
      )}

      {/* Conversation area */}
      {(() => {
        // Tab toggle component (reused in both views)
        const tabToggle = !composing && selectedAgent && (
          <AgentViewTabs
            activeTab={effectiveActiveTab}
            onChange={setActiveTab}
            tabs={[
              { value: 'chat', label: 'Chat', icon: ChatIcon },
              { value: 'work', label: 'Work', icon: WorkStreamIcon },
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

        // Content area (chat, work, inbox, or context)
        const contentArea = composing ? (
          <div className="flex flex-col grow min-h-0">
            <ChatComponent
              scope={{ type: 'consultant', id: squadId }}
              onAgentCreated={(id) => {
                setHandoffConsultantAgentId(id)
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev)
                  next.set('agent', id)
                  next.delete('subagent')
                  if (next.get('view') === 'subagents') next.set('view', 'chat')
                  return next
                })
                queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(squadId) })
                queryClient.invalidateQueries({ queryKey: queryKeys.squads.agentsWithRecent(squadId) })
              }}
              enableFullscreen={false}
              headerLayout="controls"
            />
          </div>
        ) : selectedAgent ? (
          <div className="flex flex-col grow min-h-0">
            {effectiveActiveTab === 'work' ? (
              <AgentWorkStreamsPanelComponent agent={selectedAgent} squadId={squadId} />
            ) : effectiveActiveTab === 'inbox' ? (
              <AgentInboxPanelComponent agent={selectedAgent} onClose={() => setActiveTab('chat')} fullWidth />
            ) : effectiveActiveTab === 'context' ? (
              <AgentContextPanelComponent agentId={selectedAgent.id} />
            ) : effectiveActiveTab === 'subagents' ? (
              <SubagentsInlinePanelComponent parentAgentId={selectedAgent.id} />
            ) : effectiveActiveTab === 'info' ? (
              <AgentInfoPanel agent={selectedAgent} agentType={agentType} />
            ) : (
              <AgentConversationComponent key={selectedAgent.id} agentId={selectedAgent.id} enableFullscreen={false} />
            )}
          </div>
        ) : null

        const titleParts = selectedAgent && getAgentHeaderTitleParts(selectedAgent)
        return (
          <ExpandableChatPanel
            isFullscreen={isFullscreen}
            onExitFullscreen={toggleFullscreen}
            title={composing ? 'New consultant' : titleParts ? `${titleParts.title} ${titleParts.suffix}` : 'Chats'}
            titleContent={!composing && selectedAgent ? <AgentHeaderTitle agent={selectedAgent} /> : undefined}
            headerExtra={tabToggle}
            className="flex-1 min-w-0 min-h-0 border border-th-border rounded-lg bg-surface overflow-hidden flex flex-col"
            inlineHeader={
              composing || selectedAgent ? (
                <div className="px-3 py-2 border-b border-th-border flex items-center justify-between gap-4 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {headerLeading && <div className="shrink-0">{headerLeading}</div>}
                    {composing ? (
                      // "New consultant" title doubles as a picker so you can switch to an
                      // existing agent (escape compose) — when there's anything to switch to.
                      !lockedAgentId && allAgents.length > 0 ? (
                        renderPickerTrigger(
                          <span className="text-sm font-medium truncate text-primary">New consultant</span>,
                          'Choose agent'
                        )
                      ) : (
                        <span className="text-sm font-medium truncate text-primary">New consultant</span>
                      )
                    ) : (
                      selectedAgent && (
                        <>
                          <AgentActivityDot status={selectedAgent.status} />
                          {(() => {
                            const nameNode = (
                              <span className="min-w-0 text-sm font-medium text-primary">
                                <AgentHeaderTitle agent={selectedAgent} />
                              </span>
                            )

                            // Locked → a plain title, no picker. Otherwise a dropdown trigger.
                            if (lockedAgentId) {
                              return (
                                <span data-testid="agent-picker-static" className="flex items-baseline min-w-0">
                                  {nameNode}
                                </span>
                              )
                            }

                            return renderPickerTrigger(nameNode, 'Choose agent')
                          })()}
                        </>
                      )
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {tabToggle}
                    {!composing && (
                      <button
                        onClick={toggleFullscreen}
                        className="ficus-button p-1.5 rounded-md text-muted hover:text-primary hover:bg-surface-hover transition-colors"
                        aria-label="Fullscreen"
                        title="Fullscreen"
                      >
                        <ExpandIcon className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ) : null
            }
          >
            {composing || selectedAgent ? (
              contentArea
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted gap-2">
                <p>Select an agent to view their conversation</p>
                <button
                  type="button"
                  onClick={() => setShowMobilePicker(true)}
                  className="ficus-button ficus-button-primary md:hidden mt-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
                >
                  Choose agent
                </button>
              </div>
            )}
          </ExpandableChatPanel>
        )
      })()}

      {/* Spawn Agent Modal */}
      {showSpawnModal && canRunAgents && (
        <SpawnAgentModal
          squadId={squadId}
          onClose={() => setShowSpawnModal(false)}
          onSpawned={(agentId) => handleSelectAgent(agentId)}
        />
      )}

      {showMobilePicker && (
        <Modal
          isOpen={showMobilePicker}
          onClose={closeMobilePicker}
          title="Chats"
          headerExtra={renderChatActions(true)}
          maxWidth="default"
          noChildPadding
        >
          <div className="flex flex-col h-[80vh]">{renderAgentListBody(true)}</div>
        </Modal>
      )}
    </div>
  )
}

function readConsultantsCollapsed(): boolean {
  try {
    return (
      typeof window !== 'undefined' && window.localStorage.getItem(SQUAD_CHAT_CONSULTANTS_COLLAPSED_STORAGE_KEY) === '1'
    )
  } catch {
    return false
  }
}

function writeConsultantsCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(SQUAD_CHAT_CONSULTANTS_COLLAPSED_STORAGE_KEY, '1')
    else window.localStorage.removeItem(SQUAD_CHAT_CONSULTANTS_COLLAPSED_STORAGE_KEY)
  } catch {
    // Storage can be unavailable (private or locked-down browsers); the choice just isn't remembered.
  }
}
