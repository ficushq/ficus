import { workStreamTitle } from '@ficus/shared'
import { WorkStreamStatusBadges } from '../WorkStreamStatusBadges'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { WorkStreamDetailModal, formatRelativeTime } from '../WorkStreamDetailModal'
import { workStreamPullRequests } from '../../lib/workStreamGithub'
import { PullRequestIcon, WorkStreamIcon } from '../icons'
import { type Agent, type WorkStream } from '@ficus/shared'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

interface Props {
  agent: Agent
  squadId: string
}

function agentIdMatches(agentId: string, candidateId: string | null | undefined): boolean {
  return !!candidateId && (agentId === candidateId || agentId.startsWith(candidateId))
}

function isAgentAttachedToWorkStream(workStream: WorkStream, agentId: string): boolean {
  if (agentIdMatches(agentId, workStream.assigneeAgentId)) return true
  if (agentIdMatches(agentId, workStream.ownerAgentId)) return true
  if (agentIdMatches(agentId, workStream.creatorAgentId)) return true
  return !!workStream.agentIds?.some((allowedId) => agentIdMatches(agentId, allowedId))
}

export function AgentWorkStreamsPanel({ agent, squadId }: Props) {
  const [selectedWorkStream, setSelectedWorkStream] = useState<WorkStream | null>(null)

  // Open work is the squad's active list (small, polled); finished work is this agent's own history,
  // paged on demand. The squad's unfiltered list is every stream it ever had, so it is never read here.
  const active = useQuery({
    ...queries.squads.activeWorkStreams(squadId),
    refetchInterval: 10000,
  })
  const history = useInfiniteQuery(queries.squads.agentDoneWorkStreams(agent.id, squadId))
  const isLoading = active.isLoading || history.isLoading
  const isSuccess = active.isSuccess && history.isSuccess
  // A list that never loaded is an error, not an empty panel; one that loaded keeps its rows on a failed refetch.
  const activeFailed = active.isError && active.data === undefined
  const historyFailed = history.isError && history.data === undefined
  const activeWorkStreams = active.data
  const finishedWorkStreams = useMemo(() => history.data?.pages.flatMap((page) => page.items) ?? [], [history.data])

  // History is not polled. A stream that finishes without a live event (a dropped socket) leaves the
  // polled open list, so when an open stream of this agent disappears from it and is not already in
  // the history, the loaded history pages are refetched (newest first). A fetch already running (a
  // live event's invalidation) is joined rather than restarted.
  const refetchHistory = history.refetch
  const previousOpen = useRef<{ agentId: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!activeWorkStreams) return
    const openIds = new Set(
      activeWorkStreams.filter((ws) => isAgentAttachedToWorkStream(ws, agent.id)).map((ws) => ws.id)
    )
    const previous = previousOpen.current?.agentId === agent.id ? previousOpen.current.ids : null
    previousOpen.current = { agentId: agent.id, ids: openIds }
    if (!previous) return
    const finishedIds = new Set(finishedWorkStreams.map((ws) => ws.id))
    if ([...previous].some((id) => !openIds.has(id) && !finishedIds.has(id)))
      void refetchHistory({ cancelRefetch: false })
    // Only a change in the open list triggers this; a history refresh alone must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkStreams, agent.id, refetchHistory])

  // Fetch squads and agents for the modal
  const { data: squads = [] } = useQuery(queries.squads.list())

  const { data: agents = [] } = useQuery(queries.squads.agents(squadId))

  const squadMap = useMemo(() => new Map(squads.map((s) => [s.id, s])), [squads])
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  // Filter work streams where this agent is attached, assigned, owns, or created the stream.
  // The server already narrowed the history to this agent (checked again here, so a Core that
  // ignores agentId cannot show other agents' work); the squad's open list is narrowed here.
  const relevantWorkStreams = useMemo(() => {
    const finished = finishedWorkStreams.filter((ws) => isAgentAttachedToWorkStream(ws, agent.id))
    // A stream that finished between the two reads appears once, in its finished place.
    const finishedIds = new Set(finished.map((ws) => ws.id))
    const open = (activeWorkStreams ?? []).filter(
      (ws) => !finishedIds.has(ws.id) && isAgentAttachedToWorkStream(ws, agent.id)
    )
    return [...open, ...finished]
  }, [activeWorkStreams, finishedWorkStreams, agent.id])

  // The server canonical order (GET /workstreams) is the single ordering
  // authority: open work arrives pre-sorted, then finished work newest
  // completion first, as the unpaginated list orders them. The agent filter
  // preserves relative order, so no client re-sort is needed.
  const sortedWorkStreams = relevantWorkStreams
  const workStreamSkeletonCount = useLoadingShapeCount(
    `agents:${agent.id}:work-streams`,
    isSuccess ? sortedWorkStreams.length : undefined,
    { fallbackCount: 4, maxCount: 10 }
  )

  if (isLoading) {
    return (
      <div className="flex-1 p-4">
        <CollectionSkeleton label="Loading agent work streams" count={workStreamSkeletonCount} />
      </div>
    )
  }

  if (activeFailed || historyFailed) {
    const retrying = active.isFetching || history.isFetching
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted px-6 py-12 text-center">
        <WorkStreamIcon className="w-8 h-8 mb-3 text-placeholder" />
        <p role="alert" className="text-lg">
          Could not load work streams
        </p>
        <p className="max-w-sm text-sm leading-relaxed mt-2">
          This agent's work streams did not load. Try again in a moment.
        </p>
        <button
          type="button"
          className="ficus-button ficus-button-secondary mt-4 px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={retrying}
          onClick={() => {
            if (activeFailed) void active.refetch()
            if (historyFailed) void history.refetch()
          }}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    )
  }

  // A first page that filters to nothing (an older Core that ignores agentId) may still have older pages.
  if (sortedWorkStreams.length === 0 && !history.hasNextPage) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted px-6 py-12 text-center">
        <WorkStreamIcon className="w-8 h-8 mb-3 text-placeholder" />
        <p className="text-lg">No work streams</p>
        <p className="max-w-sm text-sm leading-relaxed mt-2">
          Work streams assigned to, attached to, owned by, or created by this agent will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-3">
      {sortedWorkStreams.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-muted">No recent work streams for this agent.</p>
      )}
      <div className="space-y-2">
        {sortedWorkStreams.map((ws) => {
          const pullRequests = workStreamPullRequests(ws.metadata ?? {})
          const isAssigned = ws.assigneeAgentId === agent.id
          const isOwner = ws.ownerAgentId === agent.id
          const isCreator = agentIdMatches(agent.id, ws.creatorAgentId)

          return (
            <button
              key={ws.id}
              onClick={() => setSelectedWorkStream(ws)}
              className="ficus-button ficus-button-ghost w-full text-left p-4 rounded-xl transition-colors cursor-pointer"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <WorkStreamStatusBadges workStream={ws} />
                    {isAssigned && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/20 text-accent-light shrink-0">
                        Assigned
                      </span>
                    )}
                    {isOwner && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-decoration-4-500/15 text-decoration-4-600 dark:text-decoration-4-300 shrink-0">
                        Owner
                      </span>
                    )}
                    {isCreator && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-decoration-11-500/15 text-decoration-11-600 dark:text-decoration-11-300 shrink-0">
                        Creator
                      </span>
                    )}
                  </div>
                  <h4 className="text-sm font-medium text-primary mt-1 truncate">{workStreamTitle(ws)}</h4>
                  {ws.description && <p className="text-xs text-muted mt-0.5 line-clamp-2">{ws.description}</p>}
                </div>
                {pullRequests.length > 0 && (
                  <div className="flex items-center gap-1 text-xs text-muted shrink-0">
                    <PullRequestIcon className="w-3.5 h-3.5" />
                    {pullRequests.map((pullRequest) => (
                      <span key={pullRequest.key}>#{pullRequest.number}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                <span title={new Date(ws.updatedAt).toLocaleString()}>Updated {formatRelativeTime(ws.updatedAt)}</span>
                {ws.dependsOn.length > 0 && (
                  <span>
                    {ws.dependsOn.length} dep{ws.dependsOn.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>
      {history.hasNextPage && (
        <button
          type="button"
          className="ficus-button ficus-button-ghost mt-2 w-full rounded-xl px-4 py-2 text-xs text-muted"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Show older work streams'}
        </button>
      )}
      {history.isFetchNextPageError && (
        <p role="alert" className="mt-2 px-4 text-xs text-status-danger-600 dark:text-status-danger-400">
          Could not load older work streams. Try again.
        </p>
      )}

      {/* Work Stream Detail Modal */}
      {selectedWorkStream && (
        <WorkStreamDetailModal
          workStream={selectedWorkStream}
          squadMap={squadMap}
          agentMap={agentMap}
          onClose={() => setSelectedWorkStream(null)}
        />
      )}
    </div>
  )
}
