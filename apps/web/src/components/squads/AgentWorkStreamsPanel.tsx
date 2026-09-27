import { workStreamTitle } from '@ficus/shared'
import { WorkStreamStatusBadges } from '../WorkStreamStatusBadges'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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

  // Fetch work streams for the squad
  const {
    data: workStreams = [],
    isLoading,
    isSuccess,
  } = useQuery({
    ...queries.squads.workStreams(squadId),
    refetchInterval: 10000,
  })

  // Fetch squads and agents for the modal
  const { data: squads = [] } = useQuery(queries.squads.list())

  const { data: agents = [] } = useQuery(queries.squads.agents(squadId))

  const squadMap = useMemo(() => new Map(squads.map((s) => [s.id, s])), [squads])
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  // Filter work streams where this agent is attached, assigned, owns, or created the stream.
  const relevantWorkStreams = useMemo(() => {
    return workStreams.filter((ws) => isAgentAttachedToWorkStream(ws, agent.id))
  }, [workStreams, agent.id])

  // The server canonical order (GET /workstreams) is the single ordering
  // authority: the squad list arrives pre-sorted and the agent filter above
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

  if (sortedWorkStreams.length === 0) {
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
              className="ficus-button w-full text-left p-4 rounded-xl border-0 bg-transparent hover:bg-surface-hover transition-colors cursor-pointer"
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
