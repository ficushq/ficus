import { workStreamRef } from '@ficus/shared'
import { workStreamTitle } from '@ficus/shared'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { useURLStringState, useURLStringArrayState, useURLBooleanState } from '../hooks/useURLState'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { useTick } from '../hooks/useTick'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { computeWorkStreamElapsedMs } from '../lib/workStreamRuntime'
import { webStatus } from '../lib/statusPresentation'
import { queries } from '../queryOptions'
import { WorkStreamDetailModal, WS_PRIORITY_BADGE_COLORS, getWsDisplayState } from './WorkStreamDetailModal'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { workStreamStatusLabel } from '../lib/workStreamStatusPresentation'
import { Badge, type BadgeColor } from './Badge'
import { AgentActivityDot } from './AgentActivityDot'
import { WorkStreamFiltersPopover } from './WorkStreamFiltersPopover'
import { ChevronDownIcon, ChevronRightIcon, PullRequestIcon } from './icons'
import {
  LoadingContent,
  LoadingSurface,
  SkeletonBlock,
  SkeletonLine,
  SkeletonText,
  SkeletonRows,
} from './loading/Skeleton'
import { WORK_STREAM_STATUS_ROLE, type WorkStreamPresentationState } from '@ficus/shared'
import type { WorkStream, WorkStreamStatus, Squad, Agent } from '@ficus/shared'

// --- Status constants ---

export const WS_ACTIVE_STATUSES: WorkStreamStatus[] = ['queued', 'active']
export const WS_DONE_STATUSES: WorkStreamStatus[] = ['done', 'canceled']

function isWsActive(status: WorkStreamStatus) {
  return WS_ACTIVE_STATUSES.includes(status)
}
function isWsDone(status: WorkStreamStatus) {
  return WS_DONE_STATUSES.includes(status)
}

function focusVisibleSquadAgentPanel() {
  const panel = document.querySelector<HTMLElement>('[data-squad-agent-panel]')
  panel?.focus({ preventScroll: true })
  panel?.scrollIntoView({ block: 'nearest' })
}

// Derived display states considered "waiting" for filtering/grouping purposes.
const WS_WAITING_DERIVED_STATES: WorkStreamPresentationState[] = [
  'waiting_on_answer',
  'waiting_on_dependency',
  'waiting_on_owner',
  'blocked',
]

// Keep metadata links above the feed row's stretched work-stream button.
// inline-flex + items-center keep the link text on the row's centerline: the mobile touch-target
// rule (`a { min-height: 1.5rem }` under 768px) makes each link box taller than the 16px text row,
// and a plain block would pin its text to the top of that box, above the separators.
const FEED_METADATA_LINK_CLASS =
  'relative z-10 inline-flex items-center rounded-sm text-muted hover:text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

const WS_STATUS_ICONS: Record<WorkStreamPresentationState, string> = {
  delivery_approval: '◎',
  delivery_review: '◎',
  delivery_merge: '◎',
  delivery_external: '⧗',
  delivery_setup: '⊘',
  delivery_failure: '✖',
  active: '●',
  in_progress: '●',
  in_review: '◎',
  waiting_on_answer: '?',
  waiting_on_dependency: '⧗',
  waiting_on_owner: '⧗',
  blocked: '⊘',
  idle: '○',
  execution_failed: '✖',
  paused: 'Ⅱ',
  queued: '○',
  done: '✓',
  canceled: '×',
}

// --- Priority constants ---

interface PriorityBadgeInfo {
  text: string
  color: BadgeColor
  className?: string
  title?: string
}

/** Guards for older cached objects where `priority` may be undefined — treat as 'normal'. */
function getPriorityBadgeInfo(workStream: WorkStream): PriorityBadgeInfo {
  const stored = workStream.priority ?? 'normal'
  const effective = workStream.effectivePriority ?? stored
  const isBoosted = effective !== stored
  return {
    text: isBoosted ? `↑ ${effective}` : effective,
    color: WS_PRIORITY_BADGE_COLORS[effective],
    className: effective === 'low' ? 'opacity-60' : undefined,
    title: isBoosted
      ? `${stored} (effective ${effective}${workStream.effectivePriorityVia ? ` via ${workStream.effectivePriorityVia}` : ''})`
      : `${stored} priority`,
  }
}

// --- Filter types ---

export type WsStatusFilterValue =
  | 'active'
  | 'in_progress'
  | 'in_review'
  | 'paused'
  | 'waiting'
  | 'idle'
  | 'queued'
  | 'done'
  | 'canceled'

interface WsStatusFilterOption {
  label: string
  value: WsStatusFilterValue
}

const WS_STATUS_FILTER_OPTIONS: WsStatusFilterOption[] = [
  { label: 'Active', value: 'active' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'In Review', value: 'in_review' },
  { label: 'Paused', value: 'paused' },
  { label: 'Waiting', value: 'waiting' },
  { label: 'Idle', value: 'idle' },
  { label: 'Queued', value: 'queued' },
  { label: 'Done', value: 'done' },
  { label: 'Canceled', value: 'canceled' },
]

export const VALID_WS_STATUS_FILTERS: readonly WsStatusFilterValue[] = WS_STATUS_FILTER_OPTIONS.map((o) => o.value)

function toggleFilter<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]
}

/** Display state used for filtering/rendering: prefer the server-derived state, fall back to stored status. */
function wsFilterState(ws: WorkStream): WorkStreamPresentationState {
  return getWsDisplayState(ws)
}

// --- Helper functions ---

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

// --- Helper components ---

function SectionHeader({
  title,
  count,
  collapsible,
  collapsed,
  onToggle,
  actions,
  alignDisclosure,
  flush,
}: {
  title: string
  count?: ReactNode
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
  actions?: ReactNode
  alignDisclosure?: boolean
  flush?: boolean
}) {
  const content = (
    <div className="flex items-center gap-2">
      {alignDisclosure && !collapsible && <span aria-hidden="true" className="h-4 w-4 shrink-0" />}
      {collapsible &&
        (collapsed ? (
          <ChevronRightIcon className="w-4 h-4 text-placeholder" />
        ) : (
          <ChevronDownIcon className="w-4 h-4 text-placeholder" />
        ))}
      <span className="text-sm font-semibold text-secondary">{title}</span>
      {count !== undefined && <span className="text-xs text-muted tabular-nums">{count}</span>}
    </div>
  )

  if (collapsible && onToggle) {
    return (
      <div className="flex items-center">
        <button
          onClick={onToggle}
          className={clsx('ficus-button min-w-0 flex-1 py-2 text-left hover:bg-surface-hover', !flush && 'px-3')}
        >
          {content}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1 px-2">{actions}</div>}
      </div>
    )
  }

  return (
    <div className="flex items-center">
      <div className={clsx('min-w-0 flex-1 py-2', !flush && 'px-3')}>{content}</div>
      {actions && <div className="flex shrink-0 items-center gap-1 px-2">{actions}</div>}
    </div>
  )
}

const MANAGER_CHAT_HIDDEN_SQUADS_KEY = 'feed-manager-chat-hidden-squad-ids'

function readHiddenManagerChatSquadIds(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const value = localStorage.getItem(MANAGER_CHAT_HIDDEN_SQUADS_KEY)
    if (!value) return []
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeHiddenManagerChatSquadIds(ids: string[]) {
  if (typeof localStorage === 'undefined') return
  if (ids.length === 0) {
    localStorage.removeItem(MANAGER_CHAT_HIDDEN_SQUADS_KEY)
    return
  }
  localStorage.setItem(MANAGER_CHAT_HIDDEN_SQUADS_KEY, JSON.stringify(ids))
}

function compareSquadsByCustomOrder(a: Squad, b: Squad) {
  const orderDelta = (a.order ?? 0) - (b.order ?? 0)
  if (orderDelta !== 0) return orderDelta
  return a.name.localeCompare(b.name)
}

function SquadManagerChatMenu({ squads, agentMap }: { squads: Squad[]; agentMap: Map<string, Agent> }) {
  const { slugFor } = useSquadSlugs()
  const sortedSquads = useMemo(() => [...squads].sort(compareSquadsByCustomOrder), [squads])
  const [hiddenSquadIds, setHiddenSquadIds] = useState(() => new Set(readHiddenManagerChatSquadIds()))
  const visibleSquads = sortedSquads.filter((squad) => !hiddenSquadIds.has(squad.id))
  const [customizing, setCustomizing] = useState(false)
  const displayedSquads = customizing ? sortedSquads : visibleSquads
  const activeSquadIds = useMemo(
    () => new Set([...agentMap.values()].filter((agent) => agent.status === 'active').map((agent) => agent.squadId)),
    [agentMap]
  )

  const setSquadHidden = (squadId: string, hidden: boolean) => {
    setHiddenSquadIds((current) => {
      const next = new Set(current)
      if (hidden) next.add(squadId)
      else next.delete(squadId)
      writeHiddenManagerChatSquadIds([...next])
      return next
    })
  }

  return (
    <section aria-label="Squad quick links" className="space-y-2">
      <SectionHeader
        title="Squads"
        actions={
          <button
            type="button"
            onClick={() => setCustomizing((current) => !current)}
            aria-pressed={customizing}
            aria-label={customizing ? 'Finish customizing squad quick links' : 'Customize squad quick links'}
            className="ficus-button px-2 py-2 text-xs text-muted hover:bg-surface-hover hover:text-primary"
          >
            {customizing ? 'Done' : 'Customize'}
          </button>
        }
      />
      <div>
        {displayedSquads.length > 0 ? (
          <ul className="space-y-1">
            {displayedSquads.map((squad) => (
              <li key={squad.id}>
                <div className="flex min-h-12 items-center gap-2 rounded-lg hover:bg-surface-hover">
                  <Link to={`/squads/${slugFor(squad.id)}`} className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2">
                    <span className="flex h-5 w-3 shrink-0 items-center justify-center md:w-4">
                      <span
                        role="img"
                        aria-label={`${squad.name}: ${activeSquadIds.has(squad.id) ? 'Agents working' : 'No active agents'}`}
                        title={activeSquadIds.has(squad.id) ? 'Agents working' : 'No active agents'}
                        className={clsx(
                          'h-2 w-2 rounded-full',
                          webStatus(activeSquadIds.has(squad.id) ? 'progress' : 'neutral').markerClass
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={clsx(
                          'block truncate text-sm font-medium',
                          hiddenSquadIds.has(squad.id) ? 'text-muted' : 'text-primary'
                        )}
                      >
                        {squad.name}
                      </span>
                      {squad.purpose && <span className="block truncate text-xs text-secondary">{squad.purpose}</span>}
                    </span>
                  </Link>
                  {customizing && (
                    <button
                      type="button"
                      onClick={() => setSquadHidden(squad.id, !hiddenSquadIds.has(squad.id))}
                      className="ficus-button mr-3 min-h-11 min-w-14 shrink-0 rounded px-2 py-1 text-xs text-muted hover:bg-surface-secondary hover:text-primary"
                      aria-label={`${hiddenSquadIds.has(squad.id) ? 'Unhide' : 'Hide'} ${squad.name} ${hiddenSquadIds.has(squad.id) ? 'in' : 'from'} quick links`}
                    >
                      {hiddenSquadIds.has(squad.id) ? 'Unhide' : 'Hide'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pl-8 pr-3 py-3 text-sm text-muted md:pl-9">
            All squad quick links are hidden. Choose Customize to unhide them.
          </p>
        )}
      </div>
    </section>
  )
}

function SquadManagerChatMenuSkeleton({ count }: { count: number }) {
  return (
    <LoadingSurface label="Loading squad quick links" className="space-y-2">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-semibold text-secondary">Squads</span>
        <SkeletonLine className="ml-auto w-16" />
      </div>
      <div className="space-y-1">
        <SkeletonRows count={Math.max(1, count)}>
          {(index) => (
            <div key={index} className="flex min-h-12 items-start gap-2 px-3 py-2">
              <span className="flex h-5 w-3 shrink-0 items-center justify-center md:w-4">
                <SkeletonBlock className="h-2 w-2 rounded-full" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <SkeletonLine className={index % 3 === 0 ? 'w-36' : 'w-28'} />
                <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-3/5'} />
              </div>
            </div>
          )}
        </SkeletonRows>
      </div>
    </LoadingSurface>
  )
}

function StatusFilters({
  values,
  onChange,
  wrap = false,
}: {
  values: WsStatusFilterValue[]
  onChange: (values: WsStatusFilterValue[]) => void
  wrap?: boolean
}) {
  return (
    <div className={clsx('flex gap-1.5 pb-1', wrap ? 'flex-wrap' : 'overflow-x-auto')}>
      <button
        type="button"
        onClick={() => onChange([])}
        className={clsx(
          'ficus-button',
          'px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors',
          values.length === 0 ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover'
        )}
        aria-pressed={values.length === 0}
      >
        All
      </button>
      {WS_STATUS_FILTER_OPTIONS.map((option) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onChange(toggleFilter(values, option.value))}
          className={clsx(
            'ficus-button',
            'px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors',
            values.includes(option.value) ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover'
          )}
          aria-pressed={values.includes(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function SquadFilters({
  values,
  onChange,
  squads,
  isLoading = false,
  loadingCount = 0,
  wrap = false,
}: {
  values: string[]
  onChange: (values: string[]) => void
  squads: Squad[]
  isLoading?: boolean
  loadingCount?: number
  wrap?: boolean
}) {
  if (!squads.length && !isLoading) return null

  return (
    <div className={clsx('flex gap-1.5 pb-1', wrap ? 'flex-wrap' : 'overflow-x-auto')}>
      <button
        type="button"
        onClick={() => onChange([])}
        disabled={isLoading}
        className={clsx(
          'ficus-button',
          'px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors',
          values.length === 0 ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover'
        )}
        aria-pressed={values.length === 0}
      >
        All squads
      </button>
      {squads.map((squad) => (
        <button
          type="button"
          key={squad.id}
          onClick={() => onChange(toggleFilter(values, squad.id))}
          className={clsx(
            'ficus-button',
            'px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors',
            values.includes(squad.id) ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover'
          )}
          aria-pressed={values.includes(squad.id)}
        >
          {squad.name}
        </button>
      ))}
      {isLoading &&
        !squads.length &&
        Array.from({ length: Math.max(1, loadingCount) }, (_, index) => (
          <SkeletonBlock
            key={index}
            className={clsx('h-5 shrink-0 rounded-full', index % 3 === 0 ? 'w-20' : index % 2 ? 'w-16' : 'w-24')}
          />
        ))}
    </div>
  )
}

// --- Row component ---

function WorkStreamRow({
  workStream,
  squadMap,
  agentMap,
  agentTypeNameMap,
  showSquadBadge,
  feedLayout,
  onClick,
}: {
  workStream: WorkStream
  squadMap: Map<string, Squad>
  agentMap: Map<string, Agent>
  agentTypeNameMap: Map<string, string>
  showSquadBadge: boolean
  feedLayout?: boolean
  onClick: () => void
}) {
  const { slugFor } = useSquadSlugs()
  const location = useLocation()
  const pendingAssigneeTargetRef = useRef<string | null>(null)
  const isDone = isWsDone(workStream.status)
  const squad = squadMap.get(workStream.squadId)
  const hasActiveRuntime = (workStream.runtime?.activeCount ?? 0) > 0
  const now = useTick(1000, hasActiveRuntime)
  const elapsed = computeWorkStreamElapsedMs(workStream, now)
  const pullRequests = workStreamPullRequests(workStream.metadata ?? {})
  const assignee = workStream.assigneeAgentId ? agentMap.get(workStream.assigneeAgentId) : null
  const assigneeTypeName = assignee ? (agentTypeNameMap.get(assignee.agentTypeId) ?? assignee.agentTypeId) : null
  const assigneeTarget = assignee ? `/squads/${slugFor(workStream.squadId)}/agents?agent=${assignee.id}` : null

  // Display state: prefer the server-derived state, fall back to stored status. 'idle' (active with
  // no execution and no wait) is the one alarming display — treated the same as 'blocked' visually.
  const state = wsFilterState(workStream)
  const statusTreatment = webStatus(WORK_STREAM_STATUS_ROLE[state] ?? 'neutral')
  const isInProgress = WORK_STREAM_STATUS_ROLE[state] === 'progress'
  const statusColorClass = statusTreatment.textClass
  const statusDotClass = statusTreatment.markerClass

  const priorityBadge = getPriorityBadgeInfo(workStream)
  const queuePositionText =
    workStream.status === 'queued' && workStream.queuePosition != null ? `#${workStream.queuePosition} in queue` : null
  // Tooltips use the same derived label as the pill (e.g. "Awaiting CI" rather than the generic external wait).
  const statusBadgeText = workStreamStatusLabel(workStream)

  if (feedLayout) {
    const completedAt = new Date(workStream.completedAt ?? workStream.updatedAt)
    return (
      <li className="relative rounded-lg pl-6 pr-3 py-2.5 hover:bg-surface-hover" data-testid="feed-work-row">
        <button
          className="flex w-full items-start gap-2 text-left after:absolute after:inset-0 after:rounded-lg"
          onClick={onClick}
        >
          <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', statusDotClass)} aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm font-medium text-primary line-clamp-2 break-words">
            {workStreamTitle(workStream)}
          </span>
          <WorkStreamStatusBadges workStream={workStream} />
        </button>
        <div className="ml-4 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {squad && (
            <Link
              to={`/squads/${slugFor(squad.id)}`}
              className={FEED_METADATA_LINK_CLASS}
              title={`Open ${squad.name} squad`}
            >
              {squad.name}
            </Link>
          )}
          {!isDone && assigneeTypeName && assigneeTarget && (
            <>
              <span aria-hidden="true">·</span>
              <Link
                to={assigneeTarget}
                className={FEED_METADATA_LINK_CLASS}
                title={`Open ${assigneeTypeName} agent thread`}
              >
                {assigneeTypeName}
              </Link>
            </>
          )}
          {isDone && Number.isFinite(completedAt.getTime()) && (
            <time dateTime={completedAt.toISOString()}>
              · {completedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </time>
          )}
          {!isDone && elapsed > 1000 && <span>· {formatDuration(elapsed)}</span>}
          {pullRequests.map((pullRequest) =>
            pullRequest.url ? (
              <Fragment key={pullRequest.key}>
                <span aria-hidden="true">·</span>
                <a
                  href={pullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={clsx(FEED_METADATA_LINK_CLASS, 'gap-1')}
                  aria-label={`Open PR #${pullRequest.number}`}
                >
                  <PullRequestIcon className="h-3.5 w-3.5" /> #{pullRequest.number}
                </a>
              </Fragment>
            ) : null
          )}
        </div>
      </li>
    )
  }

  return (
    <li
      className={clsx('rounded-lg px-3 py-3.5 hover:bg-surface-hover cursor-pointer', isDone && 'opacity-75')}
      onClick={onClick}
    >
      <div className="hidden md:flex items-center gap-2">
        <span
          className={clsx('w-4 text-center text-sm shrink-0', isInProgress && 'animate-pulse', statusColorClass)}
          title={statusBadgeText}
        >
          {WS_STATUS_ICONS[state] ?? '○'}
        </span>
        <span className="font-medium text-sm text-primary truncate flex-1 min-w-0">{workStreamTitle(workStream)}</span>
        {elapsed > 1000 && (
          <span className="text-xs text-placeholder tabular-nums shrink-0" title="Total agent execution runtime">
            {formatDuration(elapsed)}
          </span>
        )}
        {pullRequests.map((pullRequest) =>
          pullRequest.url ? (
            <a
              key={pullRequest.key}
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0"
              title={`Open PR #${pullRequest.number}`}
            >
              <Badge color="accent-2" className="gap-1">
                <PullRequestIcon className="w-3.5 h-3.5" />#{pullRequest.number}
              </Badge>
            </a>
          ) : null
        )}
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge color={priorityBadge.color} className={priorityBadge.className} title={priorityBadge.title}>
            {priorityBadge.text}
          </Badge>
          {assignee && (
            <Badge
              color="accent-1"
              className="gap-1"
              to={assigneeTarget!}
              onClick={(event) => {
                event.stopPropagation()
                const alreadySelected = `${location.pathname}${location.search}` === assigneeTarget
                if (alreadySelected || pendingAssigneeTargetRef.current === assigneeTarget) {
                  event.preventDefault()
                  focusVisibleSquadAgentPanel()
                  return
                }
                pendingAssigneeTargetRef.current = assigneeTarget
                queueMicrotask(() => {
                  pendingAssigneeTargetRef.current = null
                })
              }}
              title={`Open ${assigneeTypeName} agent thread`}
            >
              <AgentActivityDot status={assignee.status} />
              {assigneeTypeName}
            </Badge>
          )}
          {queuePositionText && (
            <Badge color="neutral" title="Position in the squad's admission queue">
              {queuePositionText}
            </Badge>
          )}
          {state !== 'done' && <WorkStreamStatusBadges workStream={workStream} />}
          {showSquadBadge && squad && (
            <Badge
              color="accent-1"
              to={`/squads/${slugFor(squad.id)}`}
              onClick={(e) => e.stopPropagation()}
              title={`Open ${squad.name} squad`}
            >
              {squad.name}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex md:hidden flex-col gap-1">
        <div className="flex items-start gap-2">
          <span
            className={clsx('text-sm shrink-0 pt-0.5', isInProgress && 'animate-pulse', statusColorClass)}
            title={statusBadgeText}
          >
            {WS_STATUS_ICONS[state] ?? '○'}
          </span>
          <span className="line-clamp-2 break-words text-sm font-medium text-primary flex-1 min-w-0">
            {workStreamTitle(workStream)}
          </span>
          {pullRequests.map((pullRequest) =>
            pullRequest.url ? (
              <a
                key={pullRequest.key}
                href={pullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="shrink-0"
                title={`Open PR #${pullRequest.number}`}
              >
                <Badge color="accent-2" className="gap-1">
                  <PullRequestIcon className="w-3.5 h-3.5" />#{pullRequest.number}
                </Badge>
              </a>
            ) : null
          )}
        </div>
        <div
          data-testid="work-stream-mobile-metadata"
          className="flex flex-wrap items-center gap-2 text-xs text-muted pl-6 min-w-0"
        >
          <span className={clsx('inline-block w-1.5 h-1.5 rounded-full shrink-0', statusDotClass)} />
          {assigneeTypeName && <span className="truncate">{assigneeTypeName}</span>}
          <span aria-hidden="true">·</span>
          <WorkStreamStatusBadges workStream={workStream} />
          {priorityBadge && (
            <>
              <span aria-hidden="true">·</span>
              <span className={clsx('shrink-0', priorityBadge.className)} title={priorityBadge.title}>
                {priorityBadge.text}
              </span>
            </>
          )}
          {queuePositionText && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{queuePositionText}</span>
            </>
          )}
          {elapsed > 1000 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums shrink-0" title="Total agent execution runtime">
                {formatDuration(elapsed)}
              </span>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

// --- Main component ---

interface WorkStreamListProps {
  feedLayout?: boolean
  doneCountLabel?: ReactNode
  doneTitle?: string
  doneFooter?: ReactNode
  loadingError?: string
  /** Work streams to display */
  workStreams: WorkStream[]
  /** Map of squad ID to Squad for displaying squad badges */
  squadMap: Map<string, Squad>
  /** Map of agent ID to Agent for the detail modal */
  agentMap: Map<string, Agent>
  /** Whether to show squad filter and squad badges (default: true) */
  showSquadFilter?: boolean
  /** All squads for the squad filter (required if showSquadFilter is true) */
  squads?: Squad[]
  /** Whether the independently loaded squads collection is still pending. */
  squadsLoading?: boolean
  /** Loading state */
  isLoading?: boolean
  /** Loading state for the independently paged Done section. */
  isLoadingDone?: boolean
  /** Empty state message */
  emptyMessage?: string
  /** Hide all filters (status and squad) - useful for embedded views (default: false) */
  hideFilters?: boolean
  /** Render filters in a popup at this header slot instead of above the lists. */
  filterContainer?: HTMLElement | null
  /** The page's primary action (e.g. New work stream), at the trailing end of the filter row. */
  filterActions?: ReactNode
  /** Only render active work streams and hide the Done section (default: false) */
  activeOnly?: boolean
  /** Make the Active section header collapsible (default: false) */
  activeCollapsible?: boolean
  /** Controls rendered in the Active section header. */
  activeHeaderActions?: ReactNode
  /** Render active rows directly, without the normal disclosure/card header. */
  bareActiveSection?: boolean
  /** Stable persistence key when maps are intentionally empty during initial loading. */
  loadingShapeKey?: string
  /** Show persistent squad Home quick links below the work sections (default: false) */
  showManagerChatMenu?: boolean
  /** When provided, Done section is rendered from these externally-paged items. */
  doneStreams?: WorkStream[]
  doneTotalCount?: number
  hasMoreDone?: boolean
  isFetchingMoreDone?: boolean
  onLoadMoreDone?: () => void
}

export function WorkStreamList({
  feedLayout = false,
  doneTitle = 'Done',
  doneCountLabel,
  doneFooter,
  loadingError,
  workStreams,
  squadMap,
  agentMap,
  showSquadFilter = true,
  squads = [],
  squadsLoading = false,
  isLoading = false,
  isLoadingDone = false,
  emptyMessage = 'No work streams yet',
  hideFilters = false,
  filterContainer,
  filterActions,
  activeOnly = false,
  activeCollapsible = false,
  activeHeaderActions,
  bareActiveSection = false,
  loadingShapeKey,
  showManagerChatMenu = false,
  doneStreams: pagedDoneStreams,
  doneTotalCount,
  hasMoreDone = false,
  isFetchingMoreDone = false,
  onLoadMoreDone,
}: WorkStreamListProps) {
  const [selectedWsId, setSelectedWsId] = useURLStringState<string>('ws', '')
  const { data: agentTypes = [] } = useQuery(queries.agentTypes.list())
  const agentTypeNameMap = useMemo(
    () => new Map(agentTypes.map((agentType) => [agentType.id, agentType.name])),
    [agentTypes]
  )

  // URL-synced filter state
  const [statusFilters, setStatusFilters] = useURLStringArrayState<WsStatusFilterValue>(
    'status',
    VALID_WS_STATUS_FILTERS
  )
  const [squadFilters, setSquadFilters] = useURLStringArrayState<string>('squad')
  const [doneCollapsed, setDoneCollapsed] = useURLBooleanState('collapsed', true)
  const [activeCollapsed, setActiveCollapsed] = useURLBooleanState('activeCollapsed', false)
  const doneLoadMoreRef = useRef<HTMLLIElement | null>(null)
  const pagedDone = pagedDoneStreams !== undefined
  const loadingShapeScope =
    loadingShapeKey ??
    (showSquadFilter
      ? 'work-streams:global'
      : `work-streams:squad:${squads[0]?.id ?? squadMap.keys().next().value ?? 'current'}`)
  const activeLoadingRowCount = useLoadingShapeCount(
    `${loadingShapeScope}:active`,
    isLoading ? undefined : workStreams.length,
    { fallbackCount: 5, maxCount: 12 }
  )
  const doneLoadingRowCount = useLoadingShapeCount(
    `${loadingShapeScope}:done`,
    isLoadingDone ? undefined : (pagedDoneStreams?.length ?? 0),
    { fallbackCount: 3, maxCount: 8 }
  )
  const squadLoadingCount = useLoadingShapeCount('feed:squads', squadsLoading ? undefined : squads.length, {
    fallbackCount: 4,
    maxCount: 12,
  })

  // Filter work streams
  const filteredWorkStreams = useMemo(() => {
    return workStreams.filter((ws) => {
      if (activeOnly && !isWsActive(ws.status)) return false

      // Status filter
      if (!activeOnly) {
        const matchesStatus = statusFilters.some((statusFilter) => {
          if (statusFilter === 'active') return WS_ACTIVE_STATUSES.includes(ws.status)
          if (statusFilter === 'in_review') return WORK_STREAM_STATUS_ROLE[wsFilterState(ws)] === 'review'
          if (statusFilter === 'waiting')
            return (
              WS_WAITING_DERIVED_STATES.includes(wsFilterState(ws)) ||
              ['delivery_external', 'delivery_setup', 'delivery_failure'].includes(wsFilterState(ws))
            )
          return wsFilterState(ws) === statusFilter
        })
        if (statusFilters.length > 0 && !matchesStatus) return false
      }

      // Squad filter (only applies when showSquadFilter is true)
      if (showSquadFilter && squadFilters.length > 0 && !squadFilters.includes(ws.squadId)) return false

      return true
    })
  }, [workStreams, statusFilters, squadFilters, showSquadFilter, activeOnly])

  const filteredPagedDoneStreams = useMemo(() => {
    return (pagedDoneStreams ?? []).filter((ws) => {
      if (statusFilters.length > 0 && !statusFilters.includes(ws.status as WsStatusFilterValue)) return false
      if (showSquadFilter && squadFilters.length > 0 && !squadFilters.includes(ws.squadId)) return false
      return true
    })
  }, [pagedDoneStreams, statusFilters, squadFilters, showSquadFilter])

  // Split into active and done. The server canonical order (GET /workstreams)
  // is the single ordering authority: every input here arrives pre-sorted and
  // the filters above preserve relative order, so no client re-sort is needed.
  const { activeStreams, doneStreams } = useMemo(() => {
    const activeStreams = filteredWorkStreams.filter((ws) => isWsActive(ws.status))
    const doneStreams = pagedDone ? filteredPagedDoneStreams : filteredWorkStreams.filter((ws) => isWsDone(ws.status))
    return { activeStreams, doneStreams }
  }, [filteredWorkStreams, filteredPagedDoneStreams, pagedDone])

  useEffect(() => {
    const node = doneLoadMoreRef.current
    if (!node || !pagedDone || !hasMoreDone || isFetchingMoreDone || !onLoadMoreDone) return
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && hasMoreDone && !isFetchingMoreDone) {
        onLoadMoreDone()
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [pagedDone, hasMoreDone, isFetchingMoreDone, onLoadMoreDone])

  const selectableWorkStreams = pagedDone
    ? [...activeStreams, ...doneStreams]
    : activeOnly
      ? filteredWorkStreams
      : workStreams
  const loadedSelectedWorkStream = selectedWsId
    ? (selectableWorkStreams.find((ws) => ws.id === selectedWsId || workStreamRef(ws) === selectedWsId) ?? null)
    : null
  const { data: fetchedSelectedWorkStream } = useQuery({
    ...queries.squads.workStreamDetail(selectedWsId),
    enabled: !!selectedWsId && !loadedSelectedWorkStream,
  })
  const selectedWorkStream = loadedSelectedWorkStream ?? fetchedSelectedWorkStream ?? null

  const filters = !hideFilters && (
    <div className="space-y-2 px-1" aria-label="Work stream filters">
      {filterContainer && <p className="text-xs font-medium text-secondary">Status</p>}
      <StatusFilters values={statusFilters} onChange={setStatusFilters} wrap={!!filterContainer} />
      {filterContainer && showSquadFilter && <p className="pt-2 text-xs font-medium text-secondary">Squads</p>}
      {showSquadFilter && (
        <SquadFilters
          values={squadFilters}
          onChange={setSquadFilters}
          squads={squads}
          isLoading={squadsLoading}
          loadingCount={squadLoadingCount}
          wrap={!!filterContainer}
        />
      )}
    </div>
  )

  const activePending = isLoading && activeStreams.length === 0
  const donePending = isLoadingDone && doneStreams.length === 0
  const hasActiveSection = activePending || activeStreams.length > 0
  const hasDoneSection = doneStreams.length > 0 || (pagedDone && (doneTotalCount ?? 0) > 0)
  const isEmpty = !hasActiveSection && !hasDoneSection && !donePending

  return (
    <div className={clsx('flex flex-col', feedLayout ? 'gap-4' : 'gap-6')}>
      {/* Filters */}
      {filterContainer === undefined
        ? (filters || filterActions) && (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">{filters}</div>
              {filterActions && <div className="shrink-0">{filterActions}</div>}
            </div>
          )
        : filterContainer &&
          !hideFilters &&
          createPortal(
            <WorkStreamFiltersPopover count={statusFilters.length + (showSquadFilter ? squadFilters.length : 0)}>
              {filters}
            </WorkStreamFiltersPopover>,
            filterContainer
          )}

      {loadingError && (
        <p role="alert" className="px-3 text-sm text-muted">
          {loadingError}
        </p>
      )}
      {isEmpty ? (
        <div className="text-muted py-6 text-center">
          {workStreams.length === 0 || activeOnly ? emptyMessage : 'No work streams match the current filters'}
        </div>
      ) : (
        <div className={clsx('flex flex-col', feedLayout ? 'gap-4' : 'gap-6')}>
          {/* Active Section */}
          {hasActiveSection && bareActiveSection && (
            <LoadingContent
              loading={activePending}
              fallback={
                <WorkStreamRowsSkeleton
                  feedLayout={feedLayout}
                  count={activeLoadingRowCount}
                  label="Loading active work streams"
                />
              }
            >
              <ul className="space-y-1">
                {activeStreams.map((ws) => (
                  <WorkStreamRow
                    key={ws.id}
                    feedLayout={feedLayout}
                    workStream={ws}
                    squadMap={squadMap}
                    agentMap={agentMap}
                    agentTypeNameMap={agentTypeNameMap}
                    showSquadBadge={showSquadFilter}
                    onClick={() => setSelectedWsId(workStreamRef(ws))}
                  />
                ))}
              </ul>
            </LoadingContent>
          )}
          {hasActiveSection && !bareActiveSection && (
            <section className="space-y-2">
              <SectionHeader
                title={feedLayout ? 'Active work' : 'Active'}
                alignDisclosure={feedLayout}
                flush={feedLayout}
                count={activePending ? <SkeletonText className="w-5" /> : activeStreams.length}
                collapsible={activeCollapsible}
                collapsed={activeCollapsed}
                onToggle={() => setActiveCollapsed(!activeCollapsed)}
                actions={activeHeaderActions}
              />
              {!activeCollapsed && (
                <LoadingContent
                  loading={activePending}
                  fallback={
                    <WorkStreamRowsSkeleton
                      feedLayout={feedLayout}
                      count={activeLoadingRowCount}
                      label="Loading active work streams"
                    />
                  }
                >
                  <ul className="space-y-1">
                    {activeStreams.map((ws) => (
                      <WorkStreamRow
                        key={ws.id}
                        feedLayout={feedLayout}
                        workStream={ws}
                        squadMap={squadMap}
                        agentMap={agentMap}
                        agentTypeNameMap={agentTypeNameMap}
                        showSquadBadge={showSquadFilter}
                        onClick={() => setSelectedWsId(workStreamRef(ws))}
                      />
                    ))}
                  </ul>
                </LoadingContent>
              )}
            </section>
          )}

          {/* Done Section */}
          {!activeOnly && (hasDoneSection || donePending) && (
            <section className="space-y-2">
              <SectionHeader
                title={doneTitle}
                flush={feedLayout}
                count={
                  donePending ? (
                    <SkeletonText className="w-5" />
                  ) : doneCountLabel !== undefined ? (
                    doneCountLabel
                  ) : pagedDone ? (
                    (doneTotalCount ?? doneStreams.length)
                  ) : (
                    doneStreams.length
                  )
                }
                collapsible
                collapsed={doneCollapsed}
                onToggle={() => setDoneCollapsed(!doneCollapsed)}
              />
              {donePending && !doneCollapsed && (
                <WorkStreamRowsSkeleton
                  feedLayout={feedLayout}
                  count={doneLoadingRowCount}
                  label="Loading completed work stream rows"
                />
              )}
              {!donePending && !doneCollapsed && (
                <>
                  <ul className="space-y-1">
                    {doneStreams.map((ws) => (
                      <WorkStreamRow
                        key={ws.id}
                        feedLayout={feedLayout}
                        workStream={ws}
                        squadMap={squadMap}
                        agentMap={agentMap}
                        agentTypeNameMap={agentTypeNameMap}
                        showSquadBadge={showSquadFilter}
                        onClick={() => setSelectedWsId(workStreamRef(ws))}
                      />
                    ))}
                    {pagedDone && hasMoreDone && (
                      <li
                        ref={doneLoadMoreRef}
                        data-testid="done-load-more-sentinel"
                        className="px-3 py-3 text-center text-sm text-muted"
                      >
                        {isFetchingMoreDone ? 'Loading more done work streams…' : 'Scroll to load more'}
                      </li>
                    )}
                  </ul>
                  {doneFooter}
                </>
              )}
            </section>
          )}
        </div>
      )}

      {!activeOnly &&
        showManagerChatMenu &&
        (squadsLoading ? (
          <SquadManagerChatMenuSkeleton count={squadLoadingCount} />
        ) : squads.length > 0 ? (
          <SquadManagerChatMenu squads={squads} agentMap={agentMap} />
        ) : null)}

      {/* Detail modal */}
      {selectedWorkStream && (
        <WorkStreamDetailModal
          workStream={selectedWorkStream}
          squadMap={squadMap}
          agentMap={agentMap}
          workStreamMap={
            new Map(
              [
                ...workStreams,
                ...(pagedDoneStreams ?? []),
                ...(fetchedSelectedWorkStream ? [fetchedSelectedWorkStream] : []),
              ].map((stream) => [stream.id, stream])
            )
          }
          onSelectWorkStream={setSelectedWsId}
          onClose={() => setSelectedWsId('')}
        />
      )}
    </div>
  )
}

function WorkStreamRowsSkeleton({ count, label, feedLayout }: { count: number; label: string; feedLayout?: boolean }) {
  return (
    <LoadingSurface label={label}>
      {' '}
      <div className="space-y-1">
        <SkeletonRows count={Math.max(1, count)}>
          {(index) => (
            <div key={index} className={clsx('pr-3 py-3.5', feedLayout ? 'pl-6' : 'pl-3')}>
              <div className="hidden h-5 items-center gap-2 md:flex">
                <SkeletonBlock className="h-3 w-3 shrink-0 rounded-full" />
                <SkeletonLine className={index % 3 === 0 ? 'w-2/3' : 'w-1/2'} />
                <SkeletonLine className="ml-auto w-10" />
                <SkeletonBlock className="h-5 w-14 rounded-full" />
                <SkeletonBlock className="h-5 w-20 rounded-full" />
                <SkeletonBlock className="h-5 w-16 rounded-full" />
              </div>
              <div className="space-y-2 py-1 md:hidden">
                <div className="flex items-center gap-2">
                  <SkeletonBlock className="h-3 w-3 shrink-0 rounded-full" />
                  <SkeletonLine className={index % 3 === 0 ? 'w-2/3' : 'w-1/2'} />
                </div>
                <div className="ml-5 flex gap-2">
                  <SkeletonLine className="w-20" />
                  <SkeletonLine className="w-14" />
                </div>
              </div>
            </div>
          )}
        </SkeletonRows>
      </div>
    </LoadingSurface>
  )
}
