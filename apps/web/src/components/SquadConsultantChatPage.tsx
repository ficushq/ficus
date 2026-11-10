import type { ComponentType } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import {
  SquadAgentThreads,
  type SquadAgentThreadsDependencies,
  type SquadAgentThreadsProps,
} from './squads/SquadAgentThreads'
import { BackLink } from './BackLink'
import { ChatSkeleton } from './loading/Skeleton'

/**
 * Standalone consultant page: the shared agents panel in single-pane "page" mode,
 * filtered to consultants, defaulting to the new-consultant compose. A header
 * dropdown lets you switch between existing consultants.
 */
interface SquadConsultantChatPageProps {
  threadsComponent?: ComponentType<SquadAgentThreadsProps>
  threadsDependencies?: Partial<SquadAgentThreadsDependencies>
}

export function SquadConsultantChatPage({
  threadsComponent: Threads = SquadAgentThreads,
  threadsDependencies,
}: SquadConsultantChatPageProps) {
  const { squadId } = useParams<{ squadId: string }>()
  const { slugToId, slugFor } = useSquadSlugs()
  const resolvedParam = (squadId && slugToId[squadId]) || squadId
  const { data: squad } = useQuery({ ...queries.squads.detail(resolvedParam!), enabled: !!resolvedParam })
  const resolvedId = squad?.id ?? resolvedParam
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    ...queries.squads.agentsWithRecent(resolvedId!),
    enabled: !!resolvedId,
  })

  if (!squadId) {
    return <div className="p-4 text-muted">No squad specified.</div>
  }
  if (!squad) {
    return <ChatSkeleton label="Loading consultant chat" />
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Threads
        layout="page"
        dependencies={threadsDependencies}
        agentTypeFilter="consultant"
        defaultCompose
        headerLeading={<BackLink to={`/squads/${slugFor(squad.id)}`}>{squad.name}</BackLink>}
        agents={agentsData?.agents ?? []}
        recentlyTerminatedAgents={agentsData?.recentlyTerminated ?? []}
        squadId={squad.id}
        isLoading={agentsLoading}
      />
    </div>
  )
}
