import { SQUAD_TABS as TABS } from '../lib/squadNavigation'
import type { SquadWithRelationships } from '@ficus/shared'
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ComponentProps, type ComponentType, useCallback, useEffect, useState, useMemo } from 'react'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { DONE_WORK_STREAM_STATUSES_KEY, listSquadAgentsWithRecent } from '../api/squads'
import { useWebSocket } from '../hooks/useWebSocket'
import { useInfiniteDoneWorkStreams } from '../hooks/useInfiniteDoneWorkStreams'
import { usePermissions } from '../hooks/usePermissions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { BackLink } from './BackLink'
import { Badge, type BadgeColor } from './Badge'
import { AgentVisualization } from './squads/AgentVisualization'
import { SquadAgentThreads } from './squads/SquadAgentThreads'
import { SquadNavigation } from './squads/SquadNavigation'
import { SquadHomeTab } from './squads/SquadHomeTab'
import { SquadActivityTab } from './squads/SquadActivityTab'
import { SquadAvatar } from './squads/SquadAvatar'
import { WorkStreamList } from './squads/WorkStreamList'
import { RelationshipsList } from './squads/RelationshipsList'
import { SchedulesList } from './schedules'
import { SquadSettingsTab } from './squads/SquadSettingsTab'
import { DeleteSquadModal } from './squads/DeleteSquadModal'
import { SandboxStatusIndicator } from './squads/SandboxStatusIndicator'
import { AttentionMenu } from './AttentionMenu'
import { PullToRefresh } from './PullToRefresh'
import { WorkspaceTab } from './workspace/WorkspaceTab'
import { MemoryTab } from './memory'
import { AppsTab } from './squads/AppsTab'
import { SharingTab } from './squads/grants'
import { SquadMonitorsSection } from './monitors/SquadMonitorsSection'
import { ChevronDownIcon, ChevronRightIcon, MoreIcon } from './icons'
import { countableSquadAgents } from '../lib/agentDisplay'
import { LoadingContent, SkeletonBlock, SkeletonText } from './loading/Skeleton'
import { GitHubFeedbackReviewProvider } from './integrations/GitHubFeedbackReviewProvider'
import { PendingGitHubEventsSection } from './integrations/PendingGitHubEventsSection'

const STATUS_BADGE_COLORS: Record<string, BadgeColor> = {
  active: 'success',
  paused: 'review',
  archived: 'neutral',
}

const TAB_PATHS = TABS.map((t) => t.path)

interface SquadDetailPageDependencies {
  useWebSocket: typeof useWebSocket
  SandboxStatusIndicator: ComponentType<ComponentProps<typeof SandboxStatusIndicator>>
  SquadAgentThreads: ComponentType<ComponentProps<typeof SquadAgentThreads>>
  homeTabDependencies: ComponentProps<typeof SquadHomeTab>['dependencies']
}

interface SquadDetailPageProps {
  dependencies?: Partial<SquadDetailPageDependencies>
}

export function SquadDetailPage({ dependencies = {} }: SquadDetailPageProps) {
  const useWebSocketHook = dependencies.useWebSocket ?? useWebSocket
  const SandboxIndicator = dependencies.SandboxStatusIndicator ?? SandboxStatusIndicator
  const AgentThreads = dependencies.SquadAgentThreads ?? SquadAgentThreads
  const { squadId, tab: tabParam } = useParams<{ squadId: string; tab?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { subscribe } = useWebSocketHook()

  // Tabs live in the PATH (/squads/<slug>/<tab>), not a query param: an
  // explicit tab segment survives refresh and cannot be stomped by the
  // ?agent= routing effect below (which query-param tabs were — refreshing
  // /squads/x?agent=y&tab=activity landed on home/agents, 2026-08-27).
  const activeTab = (
    tabParam && (TAB_PATHS as readonly string[]).includes(tabParam) ? tabParam : 'home'
  ) as (typeof TAB_PATHS)[number]
  const setActiveTab = useCallback(
    (next: (typeof TAB_PATHS)[number]) => {
      if (!squadId) return
      navigate({
        pathname:
          next === 'home' && !new URLSearchParams(location.search).has('agent')
            ? `/squads/${squadId}`
            : `/squads/${squadId}/${next}`,
        search: location.search,
        hash: location.hash,
      })
    },
    [navigate, squadId, location.search, location.hash]
  )
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [headerExpanded, setHeaderExpanded] = useState(false)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)

  const [searchParams] = useSearchParams()
  const agentParam = searchParams.get('agent')
  // Resolve names before starting entity queries. A request under a slug and a
  // second request under its UUID are different cache entries, even for the same squad.
  const { idToSlug, slugToId, isPending: slugsPending } = useSquadSlugs()
  const cachedRouteSquad = queryClient.getQueryData<SquadWithRelationships>(queryKeys.squads.detail(squadId!))
  const knownId = (squadId && slugToId[squadId]) || cachedRouteSquad?.id
  const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(squadId ?? '')
  const waitingForSlug = slugsPending && !knownId && !fullUuid
  const resolvedParam = knownId || squadId
  const { data: squad, isLoading: detailLoading } = useQuery({
    ...queries.squads.detail(resolvedParam!),
    enabled: !!resolvedParam && !waitingForSlug,
    initialData: cachedRouteSquad?.id === resolvedParam ? cachedRouteSquad : undefined,
    initialDataUpdatedAt: () => queryClient.getQueryState(queryKeys.squads.detail(squadId!))?.dataUpdatedAt,
  })
  const squadLoading = waitingForSlug || detailLoading

  // Dependent queries only use a canonical ID, never the route's unresolved slug.
  const resolvedId = squad?.id ?? knownId ?? (fullUuid ? squadId! : '')
  const { can, isLoading: permissionsLoading } = usePermissions(resolvedId)
  const canDeleteSquad = !permissionsLoading && can('squads:delete')

  // Normalize the address bar to the squad's pretty slug once loaded
  // (UUID or UUID-prefix → slug; a renamed squad re-derives to its new slug).
  useEffect(() => {
    if (!squad || !squadId || slugsPending) return
    const slug = idToSlug[squad.id] ?? squad.id
    if (squadId !== slug) {
      const newPath = location.pathname.replace(`/squads/${squadId}`, `/squads/${slug}`)
      navigate(newPath + location.search + location.hash, { replace: true })
    }
  }, [squad, squadId, idToSlug, slugsPending, navigate, location])

  // Legacy deep links: ?tab=<x> predates path-based tabs. Rewrite to the
  // subpath form (replace, so history stays clean) and drop the param.
  useEffect(() => {
    const legacyTab = searchParams.get('tab')
    if (legacyTab === null || !squadId) return
    const next = new URLSearchParams(searchParams)
    next.delete('tab')
    const known = (TAB_PATHS as readonly string[]).includes(legacyTab)
    // Preserve explicit legacy tabs, including Home with an agent selection.
    const bare = legacyTab === 'home' && !next.has('agent')
    navigate(
      {
        pathname: known && !bare ? `/squads/${squadId}/${legacyTab}` : `/squads/${squadId}`,
        search: next.toString() ? `?${next.toString()}` : '',
        hash: location.hash,
      },
      { replace: true }
    )
  }, [searchParams, squadId, navigate, location.hash])

  // Bare agent links normalize to Chats without adding a second history entry.
  // Explicit tab paths always win, including Home while an agent remains selected.
  useEffect(() => {
    if (!agentParam || tabParam !== undefined || searchParams.has('tab') || !squad || !squadId) return
    const slug = idToSlug[squad.id] ?? squad.id
    if (squadId !== slug) return
    navigate({ pathname: `/squads/${slug}/agents`, search: location.search, hash: location.hash }, { replace: true })
  }, [agentParam, tabParam, searchParams, squad, squadId, idToSlug, navigate, location.search, location.hash])

  useEffect(() => {
    if (!agentParam || activeTab !== 'agents') return
    const focusPanel = () =>
      document.querySelector<HTMLElement>('[data-squad-agent-panel]')?.focus({ preventScroll: true })
    focusPanel()
    const frame = requestAnimationFrame(focusPanel)
    return () => cancelAnimationFrame(frame)
  }, [agentParam, activeTab])

  const { data: agentsData, isLoading: agentsQueryLoading } = useQuery({
    ...queries.squads.agentsWithRecent(resolvedId),
    enabled: !!resolvedId,
  })

  const agentsLoading = !resolvedId || agentsQueryLoading

  // Extract active and recently terminated agents from the response
  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData?.agents])
  const recentlyTerminatedAgents = useMemo(() => agentsData?.recentlyTerminated ?? [], [agentsData?.recentlyTerminated])
  const activityAgents = useMemo(() => {
    const byId = new Map([...agents, ...recentlyTerminatedAgents].map((agent) => [agent.id, agent]))
    return [...byId.values()]
  }, [agents, recentlyTerminatedAgents])
  const recentlyTerminatedTotalCount = agentsData?.recentlyTerminatedTotalCount ?? recentlyTerminatedAgents.length
  const hasMoreRecentlyTerminatedAgents = agentsData?.recentlyTerminatedHasMore ?? false
  const [isFetchingMoreRecentlyTerminated, setIsFetchingMoreRecentlyTerminated] = useState(false)

  const fetchMoreRecentlyTerminatedAgents = async () => {
    if (!squad || isFetchingMoreRecentlyTerminated || !hasMoreRecentlyTerminatedAgents) return
    setIsFetchingMoreRecentlyTerminated(true)
    try {
      const nextPage = await listSquadAgentsWithRecent(resolvedId, {
        terminatedLimit: 20,
        terminatedOffset: recentlyTerminatedAgents.length,
      })
      queryClient.setQueryData(queryKeys.squads.agentsWithRecent(resolvedId), {
        agents: agentsData?.agents ?? [],
        recentlyTerminated: [...recentlyTerminatedAgents, ...nextPage.recentlyTerminated],
        recentlyTerminatedHasMore: nextPage.recentlyTerminatedHasMore ?? false,
        recentlyTerminatedTotalCount: nextPage.recentlyTerminatedTotalCount ?? agentsData?.recentlyTerminatedTotalCount,
      })
    } finally {
      setIsFetchingMoreRecentlyTerminated(false)
    }
  }

  const { data: activeWorkStreamRows = [], isLoading: workStreamsQueryLoading } = useQuery({
    ...queries.squads.activeWorkStreams(resolvedId),
    enabled: !!resolvedId,
  })
  const workStreamsLoading = !resolvedId || workStreamsQueryLoading
  const { doneStreams, doneTotalCount, hasMoreDone, isFetchingMoreDone, isLoadingDone, fetchMoreDone } =
    useInfiniteDoneWorkStreams({
      squadId: resolvedId,
      enabled: !!squad,
    })

  const refreshSquadHome = useCallback(async () => {
    await Promise.all([
      // A short prefix route can resolve to a full UUID, so invalidate both possible detail keys.
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(resolvedId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreams(resolvedId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agentsWithRecent(resolvedId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(resolvedId) }),
    ])
  }, [queryClient, resolvedId, squadId])

  const refreshSquadWork = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreams(resolvedId) }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.squads.doneWorkStreamsInfinite(resolvedId, DONE_WORK_STREAM_STATUSES_KEY),
      }),
    ])
  }, [queryClient, resolvedId])

  // Find the manager agent for the Home tab
  const managerAgent = useMemo(() => agents.find((a) => a.agentTypeId === 'manager'), [agents])

  // Subscribe to real-time updates — use resolvedId so invalidation keys match queries
  useEffect(() => {
    if (!resolvedId) return

    const unsubSquads = subscribe(`squads:${resolvedId}`, (entry) => {
      if (entry.event === 'squad.updated') {
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId!) })
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(resolvedId) })
      }
      // Spawn only — unspawning terminates the agent, which arrives as `agent.terminated`
      // on the `agents` topic and is invalidated globally by QueryInvalidator.
      if (entry.event === 'squad.agentSpawned') {
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(resolvedId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.agentsWithRecent(resolvedId) })
      }
    })

    const unsubWorkstreams = subscribe('workstreams', (entry) => {
      const data = entry.data as { squadId?: string }
      if (data.squadId === resolvedId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreams(resolvedId) })
        queryClient.invalidateQueries({ queryKey: [...queryKeys.squads.all, 'doneWorkStreams'] })
      }
    })

    const unsubAgents = subscribe('agents', () => {
      // Refresh agents when any agent updates
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(resolvedId) })
    })

    return () => {
      unsubSquads()
      unsubWorkstreams()
      unsubAgents()
    }
  }, [squadId, resolvedId, subscribe, queryClient])

  if (!squad && !squadLoading) {
    return <div className="text-muted p-4">Squad not found</div>
  }

  const activeWorkStreams = activeWorkStreamRows.length
  const countableAgents = countableSquadAgents(agents)
  const activeAgents = countableAgents.filter((a) => a.status === 'active').length
  const statPills = (
    <>
      <span className="px-2 py-0.5 rounded-md bg-surface-secondary text-xs text-secondary">
        <LoadingContent loading={workStreamsLoading} fallback={<SkeletonText className="inline-block w-4" />}>
          {activeWorkStreams}
        </LoadingContent>{' '}
        active work {activeWorkStreams === 1 ? 'stream' : 'streams'}
      </span>
      <span className="px-2 py-0.5 rounded-md bg-surface-secondary text-xs text-secondary">
        <LoadingContent loading={agentsLoading} fallback={<SkeletonText className="inline-block w-8" />}>
          {activeAgents}
        </LoadingContent>{' '}
        active {activeAgents === 1 ? 'agent' : 'agents'}
      </span>
      {/* No wrapper: the indicator owns its own pill so the header keeps no
          empty padded box when it renders nothing (host runtime). */}
      {squad && <SandboxIndicator squadId={squad.id} />}
      {squad && <AttentionMenu target={{ kind: 'squad', id: squad.id }} />}
    </>
  )

  return (
    <div className="squad-detail-page flex flex-col flex-1 min-h-0" data-active-tab={activeTab}>
      {/* Header */}
      <div className="md:hidden shrink-0 mb-3">
        <div data-testid="mobile-squad-header-back-row" className="mb-2">
          <BackLink to="/squads">Squads</BackLink>
        </div>
        <div data-testid="mobile-squad-header-title-row" className="flex items-start gap-3">
          <LoadingContent loading={!squad} fallback={<SkeletonBlock className="h-12 w-12 shrink-0 !rounded-full" />}>
            {squad && <SquadAvatar name={squad.name} avatarUrl={squad.avatarUrl} size={48} />}
          </LoadingContent>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="text-lg font-semibold text-primary truncate">
                <LoadingContent loading={!squad} fallback={<SkeletonText className="inline-block w-32 align-middle" />}>
                  {squad?.name}
                </LoadingContent>
              </h1>
              {squad && squad.status !== 'active' && (
                <Badge color={STATUS_BADGE_COLORS[squad.status] || 'success'}>{squad.status}</Badge>
              )}
            </div>
            {(!squad || squad.purpose) && (
              <p className={`text-xs text-secondary ${headerExpanded ? '' : 'truncate'}`}>
                <LoadingContent
                  loading={!squad}
                  fallback={<SkeletonText className="inline-block w-64 max-w-full align-middle" />}
                >
                  {squad?.purpose}
                </LoadingContent>
              </p>
            )}
          </div>
          <button
            onClick={() => setHeaderExpanded((expanded) => !expanded)}
            aria-label={headerExpanded ? 'Collapse details' : 'Expand details'}
            className="ficus-button p-1 text-muted hover:text-primary rounded-md hover:bg-surface-hover transition-colors"
          >
            {headerExpanded ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
          </button>
          {canDeleteSquad && (
            <div className="relative">
              <button
                onClick={() => setHeaderMenuOpen((open) => !open)}
                aria-label="Squad actions"
                aria-expanded={headerMenuOpen}
                className="ficus-button p-1 text-muted hover:text-primary rounded-md hover:bg-surface-hover transition-colors"
              >
                <MoreIcon className="w-4 h-4" />
              </button>
              {headerMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 min-w-28 rounded-md border border-th-border bg-surface overflow-hidden">
                  <button
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      setShowDeleteModal(true)
                    }}
                    className="ficus-button w-full px-3 py-2 text-left text-xs font-medium text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/20"
                  >
                    Archive
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {headerExpanded && <div className="mt-2 flex flex-wrap items-center gap-2">{statPills}</div>}
      </div>

      <div className="squad-detail-desktop-header hidden md:block shrink-0 mb-4">
        <BackLink to="/squads">Squads</BackLink>

        <div className="squad-detail-header-main mt-3 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 flex items-start gap-3">
            <LoadingContent
              loading={!squad}
              fallback={<SkeletonBlock className="squad-detail-header-avatar h-14 w-14 shrink-0 !rounded-full" />}
            >
              {squad && (
                <SquadAvatar
                  name={squad.name}
                  avatarUrl={squad.avatarUrl}
                  size={56}
                  className="squad-detail-header-avatar"
                />
              )}
            </LoadingContent>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-primary">
                  <LoadingContent
                    loading={!squad}
                    fallback={<SkeletonText className="inline-block w-32 align-middle" />}
                  >
                    {squad?.name}
                  </LoadingContent>
                </h1>
                {squad && squad.status !== 'active' && (
                  <Badge color={STATUS_BADGE_COLORS[squad.status] || 'success'}>{squad.status}</Badge>
                )}
              </div>
              {(!squad || squad.purpose) && (
                <p className="squad-detail-header-purpose text-sm text-secondary mt-1">
                  <LoadingContent
                    loading={!squad}
                    fallback={<SkeletonText className="inline-block w-64 max-w-full align-middle" />}
                  >
                    {squad?.purpose}
                  </LoadingContent>
                </p>
              )}
            </div>
          </div>
          {canDeleteSquad && (
            <button
              onClick={() => setShowDeleteModal(true)}
              className="ficus-button shrink-0 px-2.5 py-1 text-xs font-medium text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/20 rounded-md transition-colors"
            >
              Archive
            </button>
          )}
        </div>

        <div className="squad-detail-header-stats flex flex-wrap items-center gap-2 mt-3">{statPills}</div>
      </div>

      <SquadNavigation tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      {/* Tab content. One GitHub review modal serves Home, Work and settings for this squad. */}
      <GitHubFeedbackReviewProvider squadId={resolvedId}>
        <div className="squad-detail-tab-content flex-1 min-h-0 overflow-hidden">
          {activeTab === 'home' && (
            <PullToRefresh
              onRefresh={refreshSquadHome}
              label="squad home"
              data-testid="squad-home-pull-to-refresh"
              className="squad-home-pull-to-refresh h-full"
            >
              <SquadHomeTab
                squadId={resolvedId}
                squadSlug={squadId}
                dependencies={dependencies.homeTabDependencies}
                squad={squad}
                workStreams={activeWorkStreamRows}
                managerAgent={managerAgent}
                agents={agents}
                recentlyTerminatedAgents={recentlyTerminatedAgents}
                recentlyTerminatedTotalCount={recentlyTerminatedTotalCount}
                hasMoreRecentlyTerminatedAgents={hasMoreRecentlyTerminatedAgents}
                isFetchingMoreRecentlyTerminated={isFetchingMoreRecentlyTerminated}
                onLoadMoreRecentlyTerminated={fetchMoreRecentlyTerminatedAgents}
                workStreamsLoading={workStreamsLoading}
                agentsLoading={agentsLoading}
              />
            </PullToRefresh>
          )}
          {activeTab === 'activity' && (
            <SquadActivityTab
              squadId={resolvedId}
              squadSlug={squadId ?? resolvedId}
              agents={activityAgents}
              agentsLoading={agentsLoading}
            />
          )}
          {activeTab === 'agents' && (
            <AgentThreads
              agents={agents}
              recentlyTerminatedAgents={recentlyTerminatedAgents}
              recentlyTerminatedTotalCount={recentlyTerminatedTotalCount}
              hasMoreRecentlyTerminatedAgents={hasMoreRecentlyTerminatedAgents}
              isFetchingMoreRecentlyTerminated={isFetchingMoreRecentlyTerminated}
              onLoadMoreRecentlyTerminated={fetchMoreRecentlyTerminatedAgents}
              squadId={resolvedId}
              isLoading={agentsLoading}
            />
          )}
          {activeTab === 'work' && (
            <PullToRefresh
              onRefresh={refreshSquadWork}
              label="squad work"
              data-testid="squad-work-pull-to-refresh"
              className="h-full"
            >
              <div className="flex h-full min-h-0 flex-col gap-3">
                <PendingGitHubEventsSection squadId={resolvedId} className="shrink-0" />
                <div className="min-h-0 flex-1">
                  <WorkStreamList
                    workStreams={activeWorkStreamRows}
                    squadId={resolvedId}
                    squad={squad}
                    isLoading={workStreamsLoading}
                    isLoadingDone={!squad || isLoadingDone}
                    doneStreams={doneStreams}
                    doneTotalCount={doneTotalCount}
                    hasMoreDone={hasMoreDone}
                    isFetchingMoreDone={isFetchingMoreDone}
                    onLoadMoreDone={fetchMoreDone}
                  />
                </div>
              </div>
            </PullToRefresh>
          )}
          {activeTab === 'apps' && <AppsTab squadId={resolvedId} />}
          {activeTab === 'schedules' && (
            <div className="h-full overflow-y-auto">
              <SchedulesList scopeType="squad" scopeId={resolvedId} agents={agents} />
            </div>
          )}
          {activeTab === 'monitors' && (
            <div className="h-full overflow-y-auto">
              <SquadMonitorsSection squadId={resolvedId} />
            </div>
          )}
          {activeTab === 'workspace' && (
            <div className="h-full">
              <WorkspaceTab squadId={resolvedId} />
            </div>
          )}
          {activeTab === 'memory' && (
            <div className="h-full">
              <MemoryTab squadId={resolvedId} />
            </div>
          )}
          {activeTab === 'relationships' && squad?.relationships && (
            <div className="h-full overflow-y-auto">
              <RelationshipsList squadId={resolvedId} relationships={squad.relationships} />
            </div>
          )}
          {activeTab === 'sharing' && (
            <div className="h-full overflow-y-auto">
              <SharingTab squadId={resolvedId} />
            </div>
          )}
          {activeTab === 'graph' && (
            <div className="h-full overflow-y-auto">
              <AgentVisualization agents={agents} squadId={resolvedId} isLoading={agentsLoading} />
            </div>
          )}
          {activeTab === 'settings' && squad && (
            <SquadSettingsTab
              squadId={resolvedId}
              name={squad.name}
              purpose={squad.purpose}
              context={squad.context}
              typeContext={squad.typeContext}
              globalCollaborationEnabled={squad.globalCollaborationEnabled}
              maxConcurrentWorkStreams={squad.maxConcurrentWorkStreams}
              blockedGraceMinutes={squad.blockedGraceMinutes}
              hostWorkspacePath={squad.hostWorkspacePath}
            />
          )}
        </div>
      </GitHubFeedbackReviewProvider>

      {canDeleteSquad && squad && (
        <DeleteSquadModal
          isOpen={showDeleteModal}
          onClose={() => setShowDeleteModal(false)}
          squadId={resolvedId}
          squadName={squad.name}
        />
      )}
    </div>
  )
}
