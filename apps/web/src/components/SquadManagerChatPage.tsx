import { type ComponentType, useMemo } from 'react'
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
 * Standalone manager page: the shared agents panel in single-pane "page" mode,
 * locked to the squad's manager agent (no picker).
 */
interface SquadManagerChatPageProps {
  threadsComponent?: ComponentType<SquadAgentThreadsProps>
  threadsDependencies?: Partial<SquadAgentThreadsDependencies>
}

export function SquadManagerChatPage({
  threadsComponent: Threads = SquadAgentThreads,
  threadsDependencies,
}: SquadManagerChatPageProps) {
  const { squadId } = useParams<{ squadId: string }>()
  const { slugToId, slugFor } = useSquadSlugs()
  const resolvedParam = (squadId && slugToId[squadId]) || squadId
  const { data: squad } = useQuery({ ...queries.squads.detail(resolvedParam!), enabled: !!resolvedParam })
  const resolvedId = squad?.id ?? resolvedParam
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    ...queries.squads.agentsWithRecent(resolvedId!),
    enabled: !!resolvedId,
  })

  const agents = agentsData?.agents ?? []
  const manager = useMemo(() => agents.find((a) => a.agentTypeId === 'manager'), [agents])

  if (!squad) {
    return <ChatSkeleton label="Loading manager chat" />
  }
  if (agentsLoading && !manager) {
    return <ChatSkeleton label="Loading manager chat" />
  }
  if (!manager) {
    return (
      <div className="p-4 text-muted space-y-2">
        <BackLink to={`/squads/${slugFor(squad.id)}`}>{`Back to ${squad.name}`}</BackLink>
        <p>No manager agent found.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Threads
        layout="page"
        dependencies={threadsDependencies}
        lockedAgentId={manager.id}
        headerLeading={<BackLink to={`/squads/${slugFor(squad.id)}`}>{squad.name}</BackLink>}
        agents={agents}
        recentlyTerminatedAgents={agentsData?.recentlyTerminated ?? []}
        squadId={squad.id}
        isLoading={agentsLoading}
      />
    </div>
  )
}
