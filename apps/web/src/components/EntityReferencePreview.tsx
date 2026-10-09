import { useQuery } from '@tanstack/react-query'
import { workStreamTitle, type Agent, type WorkStream } from '@ficus/shared'
import type { RefObject, MouseEvent } from 'react'
import { getAgentPrimaryLabel, getAgentSecondaryLabel, AGENT_STATUS_LABELS } from '../lib/agentDisplay'
import { agentChatPath, type EntityReference } from '../lib/entityReference'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { Link } from 'react-router-dom'
import { PullRequestIcon } from './icons'
import { queries } from '../queryOptions'
import { AgentActivityDot } from './AgentActivityDot'
import { Badge } from './Badge'
import { LoadingSurface, SkeletonLine } from './loading/Skeleton'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { HoverCard } from './popover/HoverCard'
import type { HoverCardState } from './popover/useHoverCard'

const staleTime = 30_000
const quickLinkClass =
  'flex min-w-0 items-center gap-1.5 rounded px-1 py-1 -mx-1 text-xs text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

/** The hover card for an `EntityReferenceLink`: a work stream or agent summary with quick links. */
export function EntityReferencePreview({
  reference,
  anchor,
  id,
  hover,
  open,
  onOpenAgent,
}: {
  reference: EntityReference
  anchor: RefObject<HTMLButtonElement | null>
  id: string
  hover: HoverCardState
  open: boolean
  onOpenAgent?: (agent: Agent) => void
}) {
  return (
    <HoverCard
      hover={hover}
      open={open}
      anchor={anchor}
      id={id}
      label={reference.kind === 'ws' ? 'Work stream preview' : 'Agent preview'}
      className="ficus-overlay w-64 p-3 text-[13px] leading-5 text-primary"
    >
      {reference.kind === 'ws' ? (
        <WorkPreview id={reference.id} onNavigate={hover.hide} onOpenAgent={onOpenAgent} />
      ) : (
        <AgentPreview id={reference.id} onNavigate={hover.hide} onOpenAgent={onOpenAgent} />
      )}
    </HoverCard>
  )
}

function PreviewLoading() {
  return (
    <LoadingSurface label="Loading preview" className="space-y-2">
      <SkeletonLine className="w-4/5" />
      <SkeletonLine className="w-2/3" />
      <SkeletonLine className="w-1/2" />
    </LoadingSurface>
  )
}

function Unavailable() {
  return <p className="text-muted">Preview unavailable. Open the reference to try again.</p>
}

function WorkPreview({ id, onNavigate, onOpenAgent }: { id: string } & AgentNavigationProps) {
  const { data, isError } = useQuery({ ...queries.squads.workStreamDetail(id), staleTime, retry: false })
  if (isError) return <Unavailable />
  return data ? <WorkSummary work={data} onNavigate={onNavigate} onOpenAgent={onOpenAgent} /> : <PreviewLoading />
}

function WorkSummary({ work, onNavigate, onOpenAgent }: { work: WorkStream } & AgentNavigationProps) {
  // Observe the canonical ID too, so live updates invalidate number/prefix previews.
  const { data = work, isError } = useQuery({
    ...queries.squads.workStreamDetail(work.id),
    initialData: work,
    staleTime,
    retry: false,
  })
  if (isError) return <Unavailable />
  const pullRequests = workStreamPullRequests(data.metadata ?? {})
  const priority = data.effectivePriority ?? data.priority ?? 'normal'
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <p className="line-clamp-2 break-words font-semibold">{workStreamTitle(data)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <WorkStreamStatusBadges workStream={data} />
        <span className="text-xs text-muted">{priority.charAt(0).toUpperCase() + priority.slice(1)} priority</span>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-th-border pt-1">
        {data.assigneeAgentId ? (
          <AssignedAgent id={data.assigneeAgentId} onNavigate={onNavigate} onOpenAgent={onOpenAgent} />
        ) : (
          <span className="text-xs text-muted">Unassigned</span>
        )}
        {pullRequests.some((pullRequest) => pullRequest.url) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {pullRequests.map((pullRequest) =>
              pullRequest.url ? (
                <a
                  key={pullRequest.key}
                  href={pullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${quickLinkClass} shrink-0`}
                >
                  <PullRequestIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>PR #{pullRequest.number}</span>
                  <span aria-hidden="true">↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function useAgentTypeName(id: string | undefined) {
  const types = useQuery({ ...queries.agentTypes.list(), staleTime, retry: false, enabled: !!id })
  return (
    types.data?.find((type) => type.id === id)?.name ??
    id?.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) ??
    ''
  )
}

function AssignedAgent({ id, onNavigate, onOpenAgent }: { id: string } & AgentNavigationProps) {
  const { data, isError } = useQuery({ ...queries.agents.detail(id), staleTime, retry: false })
  const type = useAgentTypeName(data?.agentTypeId)
  if (!data)
    return <span className="truncate text-xs text-muted">{isError ? 'Agent unavailable' : 'Loading agent…'}</span>
  return (
    <Link
      to={agentChatPath(data)}
      onClick={agentNavigation(data, onNavigate, onOpenAgent)}
      className={quickLinkClass}
      title={getAgentPrimaryLabel(data)}
      aria-label={`Assigned agent: ${type}`}
    >
      <AgentActivityDot status={data.status} />
      <span className="truncate">{type}</span>
    </Link>
  )
}

function AgentPreview({ id, onNavigate, onOpenAgent }: { id: string } & AgentNavigationProps) {
  const { data, isError } = useQuery({ ...queries.agents.detail(id), staleTime, retry: false })
  if (isError) return <Unavailable />
  return data ? <AgentSummary agent={data} onNavigate={onNavigate} onOpenAgent={onOpenAgent} /> : <PreviewLoading />
}

function AgentSummary({ agent, onNavigate, onOpenAgent }: { agent: Agent } & AgentNavigationProps) {
  const { data = agent, isError } = useQuery({
    ...queries.agents.detail(agent.id),
    initialData: agent,
    staleTime,
    retry: false,
  })
  const type = useAgentTypeName(data.agentTypeId)
  if (isError) return <Unavailable />
  const secondary = getAgentSecondaryLabel(data)
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {secondary && <p className="truncate text-xs text-muted">{secondary}</p>}
        <p className="line-clamp-2 break-words font-semibold">{getAgentPrimaryLabel(data)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge color="accent-1">{type}</Badge>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <AgentActivityDot status={data.status} />
          {AGENT_STATUS_LABELS[data.status]}
        </span>
        <Link
          to={agentChatPath(data)}
          onClick={agentNavigation(data, onNavigate, onOpenAgent)}
          className={`${quickLinkClass} ml-auto`}
        >
          Open chat{' '}
          <span aria-hidden="true" className="ml-auto">
            →
          </span>
        </Link>
      </div>
    </div>
  )
}

type AgentNavigationProps = { onNavigate: () => void; onOpenAgent?: (agent: Agent) => void }

/** Activity owns plain activation; modified clicks retain the canonical anchor behavior. */
function agentNavigation(agent: Agent, onNavigate: () => void, onOpenAgent?: (agent: Agent) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    onNavigate()
    if (!onOpenAgent || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onOpenAgent(agent)
  }
}
