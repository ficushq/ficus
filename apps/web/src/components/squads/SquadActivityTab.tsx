import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  compareSquadActivityItems,
  workStreamNeedsHumanAttention,
  type Agent,
  type NormalizedSquadActivityFilters,
  type SquadActivityItem,
  type SquadActivityKind,
} from '@ficus/shared'
import { queries } from '../../queryOptions'
import { listSquadActivity } from '../../api/squads'
import { useWebSocket } from '../../hooks/useWebSocket'
import { useStableRef } from '../../hooks/useStableRef'
import { WorkStreamViewModal } from '../WorkStreamViewModal'
import { Modal } from '../Modal'
import { AgentConversation } from '../AgentConversation'
import { AgentViewModal } from './AgentViewModal'
import { usePermissions } from '../../hooks/usePermissions'
import { ActivityFeedView } from './ActivityFeedView'
import { activityAccessSignature, activityAgentLabel, squadActivityItemHref } from './squadActivityView'

/** Hover detail for the label column: the purpose/name the label no longer shows. */
function activityAgentDetail(agent: Agent | undefined): string | undefined {
  return agent?.metadata?.purpose || agent?.metadata?.name || undefined
}

interface SquadActivityTabProps {
  squadId: string
  squadSlug: string
  agents: Agent[]
  agentsLoading?: boolean
  /** Test seams: replace the heavy modal internals (conversation/provider stacks). */
  dependencies?: {
    AgentConversationComponent?: typeof AgentConversation
    WorkStreamViewModalComponent?: typeof WorkStreamViewModal
    AgentViewModalComponent?: typeof AgentViewModal
  }
}

export function SquadActivityTab({
  squadId,
  squadSlug,
  agents,
  agentsLoading = false,
  dependencies,
}: SquadActivityTabProps) {
  const AgentConversationBody = dependencies?.AgentConversationComponent ?? AgentConversation
  const WorkStreamModal = dependencies?.WorkStreamViewModalComponent ?? WorkStreamViewModal
  const AgentViewModalBody = dependencies?.AgentViewModalComponent ?? AgentViewModal
  // Verbose toggle retired (2026-08-27 operator audit): the ONLY rows it
  // gated were non-first chat messages within an execution — near-invisible
  // in practice, and full transcripts are one click away in the agent modal.
  const [kinds, setKinds] = useState<SquadActivityKind[]>([])
  const filters = useMemo<NormalizedSquadActivityFilters>(
    // agentIds stays in the wire filter shape (server capability kept); the
    // pill UI for it was removed 2026-08-27 — always unfiltered now.
    () => ({ verbose: false, agentIds: [], kinds: [...kinds].sort() }),
    [kinds]
  )
  const queryClient = useQueryClient()
  const { subscribe, isConnected } = useWebSocket()
  const { can, identity, isLoading: permissionsLoading, isError: permissionsError } = usePermissions(squadId)
  const canReadSquad = can('squads:read')
  const accessResolved = !permissionsLoading && !permissionsError && identity !== undefined
  const activityEnabled = !!squadId && accessResolved && canReadSquad
  const accessSignature = activityAccessSignature(identity, squadId, accessResolved, can)
  const query = useInfiniteQuery(queries.squads.activity(squadId, filters, accessSignature, activityEnabled))
  // Presence strip data (operator request 2026-08-27): the page-level cache
  // already holds this query, so this is free on the happy path; gated on
  // workstreams:read so viewers without it never fire a 403.
  const canReadWorkStreams = can('workstreams:read')
  const { data: presenceStreams = [], isLoading: presenceLoading } = useQuery({
    ...queries.squads.activeWorkStreams(squadId),
    enabled: activityEnabled && canReadWorkStreams,
  })
  const workingAgentIds = useMemo(
    () => new Set(agents.filter((candidate) => candidate.status === 'active').map((candidate) => candidate.id)),
    [agents]
  )
  const needsYouCount = useMemo(() => presenceStreams.filter(workStreamNeedsHumanAttention).length, [presenceStreams])
  const previousAccessSignatureRef = useRef(accessSignature)
  const expiredRestartRef = useRef<string | null>(null)
  const [liveHead, setLiveHead] = useState<{ contextKey: string; items: SquadActivityItem[] }>({
    contextKey: '',
    items: [],
  })
  const [liveOverlay, setLiveOverlay] = useState<{
    contextKey: string
    items: Map<string, SquadActivityItem | null>
    overflowed: boolean
  }>({ contextKey: '', items: new Map(), overflowed: false })
  const contextRef = useStableRef({ squadId, filters, accessSignature, accessResolved })
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overflowRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousConnectedRef = useRef(isConnected)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const overflowReconcileRef = useRef(false)
  const overflowDirtyRef = useRef(false)
  const overflowPendingRef = useRef(false)
  const filterKey = JSON.stringify(filters)

  const fetchHead = useCallback(async () => {
    if (inFlightRef.current) {
      dirtyRef.current = true
      return
    }
    inFlightRef.current = true
    const generation = generationRef.current
    try {
      const current = contextRef.current
      if (!current.accessResolved) return false
      const contextKey = `${current.squadId}:${JSON.stringify(current.filters)}:${current.accessSignature}`
      const controller = new AbortController()
      abortRef.current = controller
      const head = await listSquadActivity(current.squadId, {
        ...current.filters,
        limit: 50,
        signal: controller.signal,
      })
      if (generation !== generationRef.current) return false
      setLiveHead({ contextKey, items: head.items.slice(0, 50) })
      return true
    } catch {
      // WebSocket frames are hints; the cursor query remains the error surface.
      return false
    } finally {
      abortRef.current = null
      inFlightRef.current = false
      if (dirtyRef.current && mountedRef.current) {
        dirtyRef.current = false
        void fetchHead()
      }
    }
  }, [contextRef])

  const reconcileSoon = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void fetchHead(), 50)
  }, [fetchHead])

  const purgeActivityState = useCallback(async () => {
    generationRef.current += 1
    dirtyRef.current = false
    overflowPendingRef.current = false
    abortRef.current?.abort()
    if (timerRef.current) clearTimeout(timerRef.current)
    if (overflowRetryTimerRef.current) clearTimeout(overflowRetryTimerRef.current)
    await queryClient.cancelQueries({ queryKey: ['squads', 'activity', 'infinite', squadId] })
    queryClient.removeQueries({ queryKey: ['squads', 'activity', 'infinite', squadId] })
    setKinds([])
    setLiveOverlay({ contextKey: '', items: new Map(), overflowed: false })
    setLiveHead({ contextKey: '', items: [] })
  }, [queryClient, squadId])

  const refreshActivityAccess = useCallback(
    async (refreshPermissions: boolean) => {
      await purgeActivityState()
      if (refreshPermissions)
        await queryClient.invalidateQueries({ queryKey: ['auth', 'permissions', squadId], refetchType: 'active' })
      await queryClient.invalidateQueries({
        queryKey: ['squads', 'activity', 'infinite', squadId],
        refetchType: 'active',
      })
    },
    [purgeActivityState, queryClient, squadId]
  )

  const { error: queryError, isError: queryIsError, refetch: refetchActivity } = query
  const reconcileOverlayOverflow = useCallback(async () => {
    if (overflowReconcileRef.current) {
      overflowPendingRef.current = true
      return
    }
    overflowReconcileRef.current = true
    overflowDirtyRef.current = false
    const current = contextRef.current
    const startContextKey = `${current.squadId}:${JSON.stringify(current.filters)}:${current.accessSignature}`
    const reconcileGeneration = ++generationRef.current
    dirtyRef.current = false
    abortRef.current?.abort()
    if (timerRef.current) clearTimeout(timerRef.current)
    if (overflowRetryTimerRef.current) clearTimeout(overflowRetryTimerRef.current)
    let refreshed = false
    try {
      await queryClient.cancelQueries({ queryKey: ['squads', 'activity', 'infinite', squadId] })
      queryClient.removeQueries({ queryKey: ['squads', 'activity', 'infinite', squadId] })
      setLiveHead({ contextKey: '', items: [] })
      const [queryResult, headResult] = await Promise.allSettled([refetchActivity(), fetchHead()])
      refreshed =
        (queryResult.status === 'fulfilled' && queryResult.value.isSuccess) ||
        (headResult.status === 'fulfilled' && headResult.value === true)
    } finally {
      const dirty = overflowDirtyRef.current
      const pending = overflowPendingRef.current
      overflowPendingRef.current = false
      overflowReconcileRef.current = false
      if (reconcileGeneration !== generationRef.current) {
        if (pending) setLiveOverlay((overlay) => (overlay.overflowed ? { ...overlay } : overlay))
      } else if (refreshed && !dirty)
        setLiveOverlay((overlay) =>
          overlay.contextKey === startContextKey
            ? { contextKey: startContextKey, items: new Map(), overflowed: false }
            : overlay
        )
      else if (reconcileGeneration === generationRef.current && refreshed)
        setLiveOverlay((overlay) =>
          overlay.contextKey === startContextKey ? { ...overlay, overflowed: true } : overlay
        )
      else if (reconcileGeneration === generationRef.current)
        overflowRetryTimerRef.current = setTimeout(() => {
          if (reconcileGeneration !== generationRef.current) return
          setLiveOverlay((overlay) =>
            overlay.contextKey === startContextKey ? { ...overlay, overflowed: true } : overlay
          )
        }, 250)
    }
  }, [contextRef, fetchHead, queryClient, refetchActivity, squadId])
  useEffect(() => {
    const contextKey = `${squadId}:${filterKey}:${accessSignature}`
    if (!(queryError instanceof Error) || !queryError.message.includes('Activity cursor expired')) {
      if (!queryIsError) expiredRestartRef.current = null
      return
    }
    if (expiredRestartRef.current === contextKey) return
    expiredRestartRef.current = contextKey
    void (async () => {
      await queryClient.cancelQueries({ queryKey: ['squads', 'activity', 'infinite', squadId] })
      queryClient.removeQueries({ queryKey: ['squads', 'activity', 'infinite', squadId] })
      setLiveHead({ contextKey: '', items: [] })
      setLiveOverlay({ contextKey: '', items: new Map(), overflowed: false })
      await refetchActivity()
    })()
  }, [accessSignature, filterKey, queryError, queryIsError, refetchActivity, queryClient, squadId])

  useEffect(() => {
    if (previousAccessSignatureRef.current !== accessSignature) {
      previousAccessSignatureRef.current = accessSignature
      void refreshActivityAccess(false)
    }
  }, [accessSignature, refreshActivityAccess])

  useEffect(() => {
    generationRef.current += 1
    dirtyRef.current = false
    overflowPendingRef.current = false
    abortRef.current?.abort()
    if (timerRef.current) clearTimeout(timerRef.current)
    if (overflowRetryTimerRef.current) clearTimeout(overflowRetryTimerRef.current)
    setLiveOverlay({ contextKey: '', items: new Map(), overflowed: false })
    setLiveHead({ contextKey: '', items: [] })
  }, [squadId, filterKey, accessSignature])

  useEffect(() => {
    if (!activityEnabled) return
    return subscribe(`squadActivity:${squadId}`, ({ event, data }) => {
      if (event === 'squadActivity.accessRevoked') {
        void refreshActivityAccess(true)
        return
      }
      if (event !== 'squadActivity.projected') return
      if (overflowReconcileRef.current) overflowDirtyRef.current = true
      const contextKey = `${squadId}:${filterKey}:${accessSignature}`
      setLiveOverlay((current) => {
        const next =
          current.contextKey === contextKey ? new Map(current.items) : new Map<string, SquadActivityItem | null>()
        const item = data.item
        const matches =
          data.operation === 'upsert' && data.quietEligible && (kinds.length === 0 || kinds.includes(item.kind))
        next.set(item.id, matches ? item : null)
        if (next.size > 200) return { contextKey, items: new Map(), overflowed: true }
        return { contextKey, items: next, overflowed: current.contextKey === contextKey && current.overflowed }
      })
    })
  }, [activityEnabled, accessSignature, filterKey, kinds, refreshActivityAccess, queryClient, squadId, subscribe])

  useEffect(() => {
    const contextKey = `${squadId}:${filterKey}:${accessSignature}`
    if (liveOverlay.contextKey === contextKey && liveOverlay.overflowed) void reconcileOverlayOverflow()
  }, [accessSignature, filterKey, liveOverlay, reconcileOverlayOverflow, squadId])

  useEffect(() => {
    if (activityEnabled && isConnected && !previousConnectedRef.current) reconcileSoon()
    previousConnectedRef.current = isConnected
  }, [activityEnabled, isConnected, reconcileSoon])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      dirtyRef.current = false
      overflowPendingRef.current = false
      generationRef.current += 1
      abortRef.current?.abort()
      if (timerRef.current) clearTimeout(timerRef.current)
      if (overflowRetryTimerRef.current) clearTimeout(overflowRetryTimerRef.current)
    }
  }, [])

  const items = useMemo(() => {
    if (!accessResolved) return []
    const contextKey = `${squadId}:${filterKey}:${accessSignature}`
    const overlayIsCurrent = liveOverlay.contextKey === contextKey
    const overflowed = overlayIsCurrent && liveOverlay.overflowed
    const liveItems = !overflowed && liveHead.contextKey === contextKey ? liveHead.items : []
    const overlay = overlayIsCurrent ? liveOverlay.items : new Map<string, SquadActivityItem | null>()
    const byId = new Map<string, SquadActivityItem>()
    if (!overflowed) for (const item of query.data?.pages.flatMap((page) => page.items) ?? []) byId.set(item.id, item)
    for (const item of liveItems) byId.set(item.id, item)
    for (const [id, item] of overlay) {
      if (item) byId.set(id, item)
      else byId.delete(id)
    }
    return [...byId.values()].sort(compareSquadActivityItems)
  }, [accessResolved, accessSignature, filterKey, liveHead, liveOverlay, query.data, squadId])
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])

  // In-place viewing (2026-08-27): rows open modals instead of navigating, so
  // Activity works as a stay-put dashboard. Modified clicks (cmd/ctrl/shift,
  // middle) keep the original navigation for open-in-new-tab.
  const [openItem, setOpenItem] = useState<
    | { type: 'workstream'; workStreamId: string }
    | {
        type: 'agent'
        agentId: string
        label: string
        view: 'chat' | 'inbox'
        messageId?: string
        resolvedAgent?: Agent
      }
    | null
  >(null)
  const openActivityItem = useCallback((item: SquadActivityItem) => {
    if (item.ref.type === 'workstream') {
      setOpenItem({ type: 'workstream', workStreamId: item.ref.workStreamId })
    } else if (item.ref.type === 'agent') {
      setOpenItem({
        type: 'agent',
        agentId: item.ref.agentId,
        label: activityAgentLabel(item.agentTypeId, item.kind),
        view: item.ref.view,
        messageId: item.ref.messageId,
      })
    }
  }, [])

  const openAgentReference = useCallback((agent: Agent) => {
    setOpenItem({
      type: 'agent',
      agentId: agent.id,
      label: activityAgentLabel(agent.agentTypeId),
      view: 'chat',
      resolvedAgent: agent,
    })
  }, [])

  const hrefFor = useCallback((item: SquadActivityItem) => squadActivityItemHref(item, squadSlug), [squadSlug])
  const agentDetailFor = useCallback(
    (item: SquadActivityItem) => activityAgentDetail(item.agentId ? agentById.get(item.agentId) : undefined),
    [agentById]
  )

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Squad activity">
      <ActivityFeedView
        kinds={kinds}
        onKindsChange={setKinds}
        presence={{ workingCount: workingAgentIds.size, needsYouCount, streamCount: presenceStreams.length }}
        isLoading={!squadId || permissionsLoading || (activityEnabled && query.isPending)}
        presenceLoading={agentsLoading || permissionsLoading || presenceLoading}
        filtersPending={query.isPlaceholderData && query.isFetching}
        isError={query.isError || permissionsError}
        items={items}
        loadingShapeKey={`activity:squad:${squadId}`}
        workingAgentIds={workingAgentIds}
        agentDetailFor={agentDetailFor}
        hrefFor={hrefFor}
        onOpen={openActivityItem}
        onOpenAgentReference={openAgentReference}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
      {openItem?.type === 'workstream' && (
        <WorkStreamModal workStreamId={openItem.workStreamId} squadId={squadId} onClose={() => setOpenItem(null)} />
      )}
      {openItem?.type === 'agent' &&
        (() => {
          const targetAgent = openItem.resolvedAgent ?? agentById.get(openItem.agentId)
          const targetSquadId = openItem.resolvedAgent ? openItem.resolvedAgent.squadId : squadId
          if (targetAgent && targetSquadId) {
            return (
              <AgentViewModalBody
                agent={targetAgent}
                squadId={targetSquadId}
                onClose={() => setOpenItem(null)}
                // Inbox rows open the CHAT tab too, focused on the transcript
                // message that delivered the inbox message (operator decision
                // 2026-08-27) — the Inbox tab stays a click away.
                initialTab="chat"
                focusMessageId={openItem.view === 'chat' ? openItem.messageId : undefined}
                focusInboxMessageId={openItem.view === 'inbox' ? openItem.messageId : undefined}
              />
            )
          }
          // Historical/terminated agents that fell out of the roster keep the
          // plain viewport fallback — AgentViewModal's tabs need roster data.
          return (
            <Modal isOpen onClose={() => setOpenItem(null)} title={openItem.label} size="viewport" noChildPadding>
              <AgentConversationBody agentId={openItem.agentId} embedded enableFullscreen={false} />
            </Modal>
          )
        })()}
    </section>
  )
}
