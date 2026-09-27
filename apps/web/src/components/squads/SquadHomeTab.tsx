import { SQUAD_RECENT_CHAT_LIMIT } from '../../lib/recentChats'
import { WorkStreamList } from './WorkStreamList'
import { SquadAgentThreads } from './SquadAgentThreads'
import { Link } from 'react-router-dom'
import { ChatIcon, ChevronRightIcon } from '../icons'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { getAgentName, getAgentPrimaryLabel } from '../../lib/agentDisplay'
import type { Agent, AgentStatus, Squad, WorkStream } from '@ficus/shared'
import { LoadingContent, LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { AgentActivityDot } from '../AgentActivityDot'
import type { ComponentProps, ComponentType } from 'react'

interface SquadHomeTabDependencies {
  WorkStreamList: ComponentType<ComponentProps<typeof WorkStreamList>>
  SquadAgentThreads: ComponentType<ComponentProps<typeof SquadAgentThreads>>
}

const defaultDependencies: SquadHomeTabDependencies = { WorkStreamList, SquadAgentThreads }

const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  'waiting-input': 'Waiting for input',
  compacting: 'Compacting',
  resetting: 'Resetting',
  dormant: 'Dormant',
  terminated: 'Terminated',
}

interface SquadHomeTabProps {
  squad?: Squad
  squadId?: string
  squadSlug?: string
  workStreams: WorkStream[]
  managerAgent?: Agent
  agents?: Agent[]
  recentlyTerminatedAgents?: Agent[]
  recentlyTerminatedTotalCount?: number
  hasMoreRecentlyTerminatedAgents?: boolean
  isFetchingMoreRecentlyTerminated?: boolean
  onLoadMoreRecentlyTerminated?: () => void
  workStreamsLoading?: boolean
  agentsLoading?: boolean
  /** Per-instance component overrides for isolated rendering and tests. */
  dependencies?: Partial<SquadHomeTabDependencies>
}

export function SquadHomeTab({
  squad,
  squadId,
  squadSlug,
  workStreams,
  managerAgent,
  agents = [],
  workStreamsLoading,
  agentsLoading = false,
  dependencies,
}: SquadHomeTabProps) {
  const WorkStreamListComponent = dependencies?.WorkStreamList ?? defaultDependencies.WorkStreamList
  const { slugFor } = useSquadSlugs()
  const resolvedId = squad?.id ?? squadId!
  const base = `/squads/${squadSlug ?? slugFor(resolvedId)}`
  const recentChats = agents
    .filter((agent) => agent.agentTypeId === 'consultant' && !['dormant', 'terminated'].includes(agent.status))
    .sort(
      (a, b) =>
        new Date(b.lastHumanMessageAt ?? b.createdAt).getTime() -
        new Date(a.lastHumanMessageAt ?? a.createdAt).getTime()
    )
    .slice(0, SQUAD_RECENT_CHAT_LIMIT)
  return (
    <div className="squad-home-layout flex h-full min-h-0 w-full flex-col gap-5 overflow-y-auto">
      <section className="shrink-0 px-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-primary">Start with a conversation</h2>
            <p className="mt-1 hidden text-sm text-secondary sm:block">
              Research, explore an idea, or plan the next piece of work.
            </p>
          </div>
          <Link
            to={`${base}/agents?newConsultant=1`}
            className="ficus-button ficus-button-primary inline-flex shrink-0 items-center gap-2 px-3 py-2 text-sm"
          >
            <ChatIcon className="h-4 w-4" />
            New chat
          </Link>
        </div>
      </section>
      <section className="squad-home-work-streams shrink-0 border-t border-panel-border pt-4">
        <WorkStreamListComponent
          workStreams={workStreams}
          squadId={resolvedId}
          squad={squad}
          activeOnly
          compact
          activeCollapsible
          expandable
          isLoading={workStreamsLoading}
        />
      </section>
      <section className="shrink-0 border-t border-panel-border pt-4">
        <div className="mb-2 flex items-center justify-between gap-3 px-3">
          <h2 className="pl-6 text-sm font-semibold text-secondary">Recent chats</h2>
          <Link
            to={`${base}/agents`}
            className="inline-flex items-center gap-1 py-2 text-xs text-accent-light hover:underline"
          >
            Browse chats
            <ChevronRightIcon className="h-3 w-3" />
          </Link>
        </div>
        <LoadingContent
          loading={agentsLoading && agents.length === 0}
          fallback={<HomeAgentRowsSkeleton count={SQUAD_RECENT_CHAT_LIMIT} />}
        >
          {recentChats.length === 0 && (
            <p className="px-2 py-3 text-sm text-secondary">Your conversations will appear here.</p>
          )}
          {recentChats.map((agent) => (
            <Link
              key={agent.id}
              to={`${base}/agents?agent=${encodeURIComponent(agent.id)}`}
              className="ficus-nav-item flex items-center justify-between gap-2 px-3 py-3 text-sm text-secondary"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                <AgentActivityDot status={agent.status} />
              </span>
              <span className="min-w-0 flex-1 truncate">{getAgentPrimaryLabel(agent)}</span>
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
            </Link>
          ))}
        </LoadingContent>
      </section>
      <section className="shrink-0 border-t border-panel-border pt-4 pb-4">
        <h2 className="px-3 pl-9 text-sm font-semibold text-secondary">Squad coordinator</h2>
        <LoadingContent
          loading={agentsLoading && !managerAgent}
          fallback={<HomeAgentRowsSkeleton count={1} coordinator />}
        >
          <Link
            to={managerAgent ? `${base}/agents?agent=${encodeURIComponent(managerAgent.id)}` : `${base}/manager`}
            className="ficus-nav-item mt-2 flex items-center gap-2 px-3 py-3 text-sm text-secondary"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {managerAgent && <AgentActivityDot status={managerAgent.status} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {managerAgent ? `Manager (${getAgentName(managerAgent)})` : 'Manager chat'}
              </span>
              <span className="mt-1 block text-xs text-muted">Coordinates the squad’s ongoing work.</span>
            </span>
            {managerAgent && <span className="text-xs text-muted">{AGENT_STATUS_LABELS[managerAgent.status]}</span>}
            <ChevronRightIcon className="h-4 w-4 shrink-0" />
          </Link>
        </LoadingContent>
      </section>
    </div>
  )
}

function HomeAgentRowsSkeleton({ count, coordinator = false }: { count: number; coordinator?: boolean }) {
  return (
    <LoadingSurface
      label={coordinator ? 'Loading squad coordinator' : 'Loading recent chats'}
      className={coordinator ? 'mt-2' : undefined}
    >
      <SkeletonRows count={count}>
        {(index) => (
          <div key={index} className="flex items-center gap-2 px-3 py-3 text-sm">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <SkeletonBlock className="h-2 w-2 !rounded-full" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex h-5 items-center">
                <SkeletonLine className={index % 2 ? 'w-44' : 'w-56 max-w-full'} />
              </span>
              {coordinator && (
                <span className="mt-1 block text-xs text-muted">Coordinates the squad’s ongoing work.</span>
              )}
            </span>
            <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
          </div>
        )}
      </SkeletonRows>
    </LoadingSurface>
  )
}
