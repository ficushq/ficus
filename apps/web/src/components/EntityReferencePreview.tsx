import { useQuery } from '@tanstack/react-query'
import { workStreamTitle, type Agent, type WorkStream } from '@ficus/shared'
import { useLayoutEffect, useRef, useState, type RefObject, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { useStableRef } from '../hooks/useStableRef'
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

const staleTime = 30_000
const quickLinkClass =
  'flex min-w-0 items-center gap-1.5 rounded px-1 py-1 -mx-1 text-xs text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

export function EntityReferencePreview({
  reference,
  anchor,
  id,
  onEnter,
  onLeave,
  onDismiss,
  onFocus,
  onBlur,
  onOpenAgent,
}: {
  reference: EntityReference
  anchor: RefObject<HTMLButtonElement | null>
  id: string
  onEnter: () => void
  onLeave: () => void
  onFocus: () => void
  onBlur: () => void
  onDismiss: () => void
  onOpenAgent?: (agent: Agent) => void
}) {
  const card = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const dismiss = useStableRef(onDismiss)
  useLayoutEffect(() => {
    const update = () => {
      if (!anchor.current || !card.current) return
      const rect = anchor.current.getBoundingClientRect()
      const { width, height } = card.current.getBoundingClientRect()
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const right = left + (viewport?.width ?? window.innerWidth)
      const bottom = top + (viewport?.height ?? window.innerHeight)
      if (rect.bottom < top || rect.top > bottom || rect.right < left || rect.left > right) {
        dismiss.current()
        return
      }
      setPosition({
        left: Math.max(left + 8, Math.min(rect.left, right - width - 8)),
        top: Math.max(
          top + 8,
          Math.min(rect.bottom + height + 8 <= bottom ? rect.bottom + 8 : rect.top - height - 8, bottom - height - 8)
        ),
      })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    if (card.current) observer?.observe(card.current)
    if (anchor.current) observer?.observe(anchor.current)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [anchor, dismiss])
  // A hover/focus preview: Escape dismisses it (the caller restores focus only when it was inside);
  // focus or a press leaving it just releases its focus hold, so hover can still keep it open.
  usePopupDismiss({
    open: true,
    popup: card,
    trigger: anchor,
    restoreFocus: false,
    onDismiss: (reason) => (reason === 'escape' ? onDismiss() : onBlur()),
  })

  return createPortal(
    <div
      ref={card}
      id={id}
      role="dialog"
      aria-label={reference.kind === 'ws' ? 'Work stream preview' : 'Agent preview'}
      onFocusCapture={onFocus}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[href]')]
        if (event.shiftKey && event.target === links[0]) {
          event.preventDefault()
          anchor.current?.focus()
        } else if (!event.shiftKey && event.target === links.at(-1)) {
          // Continue from the reference's place in the document, not the end of the portal.
          anchor.current?.focus()
          onDismiss()
        }
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="ficus-overlay fixed z-[80] w-64 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto p-3 text-[13px] leading-5 text-primary"
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
    >
      {reference.kind === 'ws' ? (
        <WorkPreview id={reference.id} onNavigate={onDismiss} onOpenAgent={onOpenAgent} />
      ) : (
        <AgentPreview id={reference.id} onNavigate={onDismiss} onOpenAgent={onOpenAgent} />
      )}
    </div>,
    document.body
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
