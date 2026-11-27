import { workStreamRef } from '@ficus/shared'
import { workStreamTitle } from '@ficus/shared'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { WorkStreamStatusMarker } from './WorkStreamStatusMarker'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useSearchParams } from 'react-router'
import { useURLStringState, useURLStringArrayState, useURLBooleanState } from '../hooks/useURLState'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { useTick } from '../hooks/useTick'
import { usePermissions } from '../hooks/usePermissions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { workStreamTimeDisplay, workStreamTimeTickMs, type WorkStreamTimeDisplay } from '../lib/workStreamRuntime'
import { webStatus } from '../lib/statusPresentation'
import { queries } from '../queryOptions'
import { WorkStreamDetailModal, getWsDisplayState } from './WorkStreamDetailModal'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { deliveryTagPullRequestKey, workStreamDeliveryTag } from '../lib/workStreamStatusPresentation'
import { AgentActivityDot } from './AgentActivityDot'
import { LiveListMotion } from './LiveListMotion'
import { liveRowProps } from '../lib/liveListMotion'
import { WorkStreamFilterGroup, WorkStreamFiltersPopover } from './WorkStreamFiltersPopover'
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
import type { WorkStream, WorkStreamStatus, Squad, Agent, AgentSummary } from '@ficus/shared'
import { FEED_DISCLOSURE_CHEVRON_CLASS, FEED_DISCLOSURE_HEADER_CLASS, FEED_ROW_INSET_CLASS } from './feedSectionLayout'
import {
  ShowSummariesSwitch,
  useShowWorkStreamSummaries,
  useWorkStreamPeek,
  WorkStreamPeekCard,
  WorkStreamSummaryLine,
  type WorkStreamSummarySurface,
} from './WorkStreamSummary'
import { useAgentTypeNames } from '../hooks/useAgentTypeNames'
import { agentThreadLinkTitle, agentTypeDisplayName } from '../lib/agentDisplay'

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
  'waiting_on_manager',
  'waiting_for_slot',
  'blocked',
]

// Keep metadata links above the feed row's stretched work-stream button.
// inline-flex + items-center keep the link text on the row's centerline, beside the separators and
// elapsed time, even if the link box ends up taller than the 16px text row.
const FEED_METADATA_LINK_CLASS =
  'relative z-10 inline-flex items-center rounded-xs text-muted hover:text-link hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent'

// Plain row metadata with a tooltip (runtime, queue position) sits above the stretched button too, or the
// button would take the hover and the tooltip would never show. A click on it still opens the stream.
const ROW_TOOLTIP_TARGET_CLASS = 'relative z-10 cursor-pointer'

// --- Filter types ---

export type WsStatusFilterValue =
  'active' | 'in_progress' | 'in_review' | 'paused' | 'waiting' | 'idle' | 'monitoring' | 'queued' | 'done' | 'canceled'

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
  { label: 'Monitoring', value: 'monitoring' },
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

// --- Helper components ---

/** A row's time: time worked, or "Waiting on you 7d" while a person is waited on. */
function WorkStreamTime({
  time,
  className,
  onClick,
}: {
  time: WorkStreamTimeDisplay
  className?: string
  onClick?: () => void
}) {
  return (
    <span
      className={clsx('tabular-nums', className)}
      title={time.title}
      data-testid="work-stream-time"
      onClick={onClick}
    >
      {time.kind === 'worked' && <span className="sr-only">Time worked </span>}
      {time.text}
    </span>
  )
}

function SectionHeader({
  title,
  count,
  collapsible,
  collapsed,
  onToggle,
  actions,
  feedLayout,
}: {
  title: string
  count?: ReactNode
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
  actions?: ReactNode
  /** Put the title on the Feed's shared text column and hang the chevron left of it (see feedSectionLayout). */
  feedLayout?: boolean
}) {
  const content = (
    <div className="flex items-center gap-2">
      {/* From sm up, reserve the chevron's width so the title lines up with collapsible headers. Below sm the
          title column is the header padding itself, so there is nothing to reserve. */}
      {feedLayout && !collapsible && <span aria-hidden="true" className="hidden h-4 w-4 shrink-0 sm:block" />}
      {collapsible &&
        (collapsed ? (
          <ChevronRightIcon
            className={clsx('w-4 h-4 shrink-0 text-placeholder', feedLayout && FEED_DISCLOSURE_CHEVRON_CLASS)}
          />
        ) : (
          <ChevronDownIcon
            className={clsx('w-4 h-4 shrink-0 text-placeholder', feedLayout && FEED_DISCLOSURE_CHEVRON_CLASS)}
          />
        ))}
      <span className="text-sm font-semibold text-secondary">{title}</span>
      {count !== undefined && <span className="text-xs text-muted tabular-nums">{count}</span>}
    </div>
  )

  if (collapsible && onToggle) {
    // One header row: the hover fill covers the whole row, view controls included, so they never
    // make the disclosure look narrower than the list below it.
    return (
      <div className="flex flex-wrap items-center rounded-lg has-[[data-section-toggle]:hover]:bg-surface-hover">
        <button
          onClick={onToggle}
          aria-expanded={!collapsed}
          data-section-toggle=""
          className={clsx(
            'ficus-button ficus-button-ghost min-w-fit flex-1 py-2 text-left hover:bg-transparent',
            feedLayout ? FEED_DISCLOSURE_HEADER_CLASS : 'px-3'
          )}
        >
          {content}
        </button>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2 px-2">{actions}</div>}
      </div>
    )
  }

  return (
    // Narrow widths wrap the view controls under the title rather than squeezing it.
    <div className="flex flex-wrap items-center">
      <div className="min-w-fit flex-1 px-3 py-2">{content}</div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2 px-2">{actions}</div>}
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

const NO_LOADED_AGENTS = new Map<string, Agent>()

function SquadManagerChatMenu({ squads, agentMap }: { squads: Squad[]; agentMap: Map<string, AgentSummary> }) {
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
            className="ficus-button ficus-button-ghost -mr-2 rounded px-2 py-2 text-xs text-muted"
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
                      className="ficus-button ficus-button-secondary mr-3 min-h-11 min-w-14 shrink-0 rounded px-2 py-1 text-xs"
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

/** Filter chips in the Filters panel: an even grid, so labels never wrap into ragged rows. */
const FILTER_CHIP_CLASS =
  'ficus-button ficus-button-ghost min-w-0 truncate rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors'
const FILTER_CHIP_ON_CLASS = 'bg-selection hover:bg-selection text-accent-light hover:text-accent-light'

function StatusFilters({
  values,
  onChange,
}: {
  values: WsStatusFilterValue[]
  onChange: (values: WsStatusFilterValue[]) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-1">
      <button
        type="button"
        onClick={() => onChange([])}
        className={clsx(FILTER_CHIP_CLASS, values.length === 0 && FILTER_CHIP_ON_CLASS)}
        aria-pressed={values.length === 0}
      >
        All
      </button>
      {WS_STATUS_FILTER_OPTIONS.map((option) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onChange(toggleFilter(values, option.value))}
          className={clsx(FILTER_CHIP_CLASS, values.includes(option.value) && FILTER_CHIP_ON_CLASS)}
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
}: {
  values: string[]
  onChange: (values: string[]) => void
  squads: Squad[]
  isLoading?: boolean
  loadingCount?: number
}) {
  if (!squads.length && !isLoading) return null

  return (
    <div className="grid grid-cols-2 gap-1">
      <button
        type="button"
        onClick={() => onChange([])}
        disabled={isLoading}
        className={clsx(FILTER_CHIP_CLASS, values.length === 0 && FILTER_CHIP_ON_CLASS)}
        aria-pressed={values.length === 0}
      >
        All squads
      </button>
      {squads.map((squad) => (
        <button
          type="button"
          key={squad.id}
          onClick={() => onChange(toggleFilter(values, squad.id))}
          className={clsx(FILTER_CHIP_CLASS, values.includes(squad.id) && FILTER_CHIP_ON_CLASS)}
          title={squad.name}
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
  showSummary = false,
  onClick,
}: {
  workStream: WorkStream
  squadMap: Map<string, Squad>
  agentMap: Map<string, AgentSummary>
  agentTypeNameMap: Map<string, string>
  showSquadBadge: boolean
  feedLayout?: boolean
  /** "Summaries" is on: active rows add one muted summary line. */
  showSummary?: boolean
  onClick: () => void
}) {
  const { slugFor } = useSquadSlugs()
  const location = useLocation()
  const pendingAssigneeTargetRef = useRef<string | null>(null)
  const rowRef = useRef<HTMLLIElement>(null)
  const peek = useWorkStreamPeek()
  const isDone = isWsDone(workStream.status)
  // Finished rows stay as they are: no peek card and never a summary.
  const peekProps = isDone ? {} : peek.pointerHandlers
  const peekFocusProps = isDone ? {} : peek.focusHandlers
  const open = () => {
    peek.hover.hide()
    onClick()
  }
  // "Waiting on you" only when this viewer can act on the wait; anyone else reads what it waits on.
  const viewerPermissions = usePermissions(workStream.squadId)
  const viewer = viewerPermissions.isLoading ? undefined : viewerPermissions
  const peekCard = !isDone && (
    <WorkStreamPeekCard
      peek={peek}
      workStream={workStream}
      anchor={rowRef}
      agentMap={agentMap}
      agentTypeNames={agentTypeNameMap}
      squadSlug={slugFor(workStream.squadId)}
      viewer={viewer}
    />
  )
  const summaryLine = showSummary && !isDone && <WorkStreamSummaryLine workStream={workStream} />
  const squad = squadMap.get(workStream.squadId)
  // Time worked, or how long a person has been waited on (which replaces it while they are).
  const timeTickMs = workStreamTimeTickMs(workStream)
  const now = useTick(timeTickMs ?? 60_000, timeTickMs !== null)
  const time = workStreamTimeDisplay(workStream, now, viewer)
  const pullRequests = workStreamPullRequests(workStream.metadata ?? {})
  // Desktop and feed rows attach the in-progress delivery state to one pull request: the
  // primary delivery PR. Without a PR link it falls back to a colored pill beside the status.
  const deliveryTag = workStreamDeliveryTag(workStream)
  const deliveryTagKey = deliveryTag ? deliveryTagPullRequestKey(workStream.delivery, pullRequests) : null
  const deliveryLabelMode = deliveryTagKey ? 'none' : 'pill'
  // What the status badges show (the state, and the delivery pill when there is no pull request
  // link to carry it): a change while the list is on screen briefly emphasizes them (LiveListMotion).
  const liveStatus = `${wsFilterState(workStream)}|${deliveryTag && deliveryLabelMode === 'pill' ? (workStream.delivery?.kind ?? '') : ''}`
  const assignee = workStream.assigneeAgentId ? agentMap.get(workStream.assigneeAgentId) : null
  const sharedTypeNames = useAgentTypeNames()
  // The type as every other surface names it: the configured name, else the title-cased id, never the raw id.
  const assigneeTypeName = assignee
    ? agentTypeDisplayName(assignee.agentTypeId, (id) => agentTypeNameMap.get(id) || sharedTypeNames(id))
    : null
  const assigneeTarget = assignee ? `/squads/${slugFor(workStream.squadId)}/agents?agent=${assignee.id}` : null

  const queuePositionText =
    workStream.status === 'queued' && workStream.queuePosition != null ? `#${workStream.queuePosition} in queue` : null

  const completedAt = new Date(workStream.completedAt ?? workStream.updatedAt)
  // On the squad pages the assignee link selects the agent in the side panel; a second press on
  // the agent already selected moves focus to that panel instead of re-navigating.
  const onAssigneeClick = (event: MouseEvent) => {
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
  }

  // One line of context under the title, in a fixed order. Lists only add to it.
  const context: Array<{ key: string; node: ReactNode }> = []
  if (showSquadBadge && squad) {
    context.push({
      key: 'squad',
      node: (
        <Link
          to={`/squads/${slugFor(squad.id)}`}
          className={FEED_METADATA_LINK_CLASS}
          title={`Open ${squad.name} squad`}
        >
          {squad.name}
        </Link>
      ),
    })
  }
  if (assignee && assigneeTypeName && assigneeTarget) {
    context.push({
      key: 'assignee',
      node: (
        <Link
          to={assigneeTarget}
          onClick={onAssigneeClick}
          className={clsx(FEED_METADATA_LINK_CLASS, 'gap-1')}
          title={agentThreadLinkTitle(assigneeTypeName)}
        >
          {!isDone && <AgentActivityDot status={assignee.status} />}
          {assigneeTypeName}
        </Link>
      ),
    })
  }
  if (queuePositionText) {
    context.push({
      key: 'queue',
      node: (
        <span title="Position in the squad's admission queue" className={ROW_TOOLTIP_TARGET_CLASS} onClick={open}>
          {queuePositionText}
        </span>
      ),
    })
  }
  if (isDone && Number.isFinite(completedAt.getTime())) {
    context.push({
      key: 'completed',
      node: (
        <time dateTime={completedAt.toISOString()}>
          {completedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </time>
      ),
    })
  }
  // Time worked, or how long a person has been waited on, which replaces it while they are.
  if (time)
    context.push({
      key: 'time',
      node: <WorkStreamTime time={time} className={ROW_TOOLTIP_TARGET_CLASS} onClick={open} />,
    })
  for (const pullRequest of pullRequests) {
    if (!pullRequest.url) continue
    const tag = pullRequest.key === deliveryTagKey ? deliveryTag : null
    context.push({
      key: `pr:${pullRequest.key}`,
      node: (
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className={clsx(FEED_METADATA_LINK_CLASS, 'gap-1')}
          aria-label={tag ? `Open PR #${pullRequest.number}, delivery: ${tag.label}` : `Open PR #${pullRequest.number}`}
          title={tag ? `Delivery: ${tag.label}` : undefined}
        >
          <PullRequestIcon className="h-3.5 w-3.5" /> #{pullRequest.number}
          {tag && (
            <>
              <span aria-hidden="true">·</span>
              <span className={tag.textClass} data-testid="pull-request-delivery-label">
                {tag.label}
              </span>
            </>
          )}
        </a>
      ),
    })
  }

  // The one work stream row every list draws: status marker, "#number · title", the status badge
  // at the right, and one line of context beneath (squad, agent type, queue, runtime, pull requests).
  return (
    <li
      ref={rowRef}
      className={clsx(
        'relative rounded-lg pr-3 py-2.5 hover:bg-surface-hover',
        feedLayout ? FEED_ROW_INSET_CLASS : 'pl-3'
      )}
      data-testid="work-stream-row"
      {...liveRowProps(workStream.id, liveStatus)}
      {...peekProps}
    >
      {/* The row's keyboard stop: Enter opens the stream; focus opens the peek. */}
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left rounded-lg after:absolute after:inset-0 after:rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        onClick={open}
        {...peekFocusProps}
      >
        <WorkStreamStatusMarker workStream={workStream} className="mt-1.5" />
        <span className="min-w-0 flex-1 text-sm font-medium text-primary line-clamp-2 wrap-break-word">
          {workStreamTitle(workStream)}
        </span>
        <WorkStreamStatusBadges
          workStream={workStream}
          deliveryLabel={deliveryLabelMode}
          showQueuedReview="touch"
          // Above the stretched button so the badges' tooltips show; a click still reaches the button.
          className="relative z-10 max-w-[50%] sm:max-w-none"
          liveEmphasis
        />
      </button>
      {summaryLine && <div className="ml-4 mt-0.5 min-w-0">{summaryLine}</div>}
      {context.length > 0 && (
        <div
          data-testid="work-stream-row-context"
          className="ml-4 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
        >
          {/* Each separator stays with the item before it, so a wrapped line never starts with "·". */}
          {context.map((item, index) => (
            <span key={item.key} className="inline-flex min-w-0 items-center gap-x-2">
              {item.node}
              {index < context.length - 1 && <span aria-hidden="true">·</span>}
            </span>
          ))}
        </div>
      )}
      {peekCard}
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
  agentMap: Map<string, AgentSummary>
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
  /**
   * Which list this is, for the "Summaries" switch (remembered per surface). It sits in the Active
   * section header beside the list's other view controls on every list.
   */
  summarySurface?: WorkStreamSummarySurface
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
  summarySurface,
}: WorkStreamListProps) {
  const [selectedWsId, setSelectedWsId] = useURLStringState<string>('ws', '')
  const [summariesOn] = useShowWorkStreamSummaries(summarySurface ?? 'feed')
  const showSummaries = !!summarySurface && summariesOn
  const filtersInHeader = filterContainer !== undefined && !hideFilters
  const feedSummarySwitch = filtersInHeader && summarySurface && (
    <ShowSummariesSwitch surface={summarySurface} variant="row" />
  )
  const summarySwitch = !filtersInHeader && summarySurface && <ShowSummariesSwitch surface={summarySurface} />
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

  const filterCount = statusFilters.length + (showSquadFilter ? squadFilters.length : 0)
  const activeFilterLabel =
    filterCount !== 1
      ? undefined
      : statusFilters.length === 1
        ? WS_STATUS_FILTER_OPTIONS.find((option) => option.value === statusFilters[0])?.label
        : squads.find((squad) => squad.id === squadFilters[0])?.name
  // One URL update for both groups: two setters in one handler would each start from the same
  // search params, and the second would restore what the first removed.
  const [, setSearchParams] = useSearchParams()
  const clearFilters = () =>
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        next.delete('status')
        if (showSquadFilter) next.delete('squad')
        return next
      },
      { replace: true }
    )
  // One Filters dropdown for the Feed (portaled into its header) and the Work tab (inline, beside
  // the page action).
  const filtersPopover = !hideFilters && (
    <WorkStreamFiltersPopover
      count={filterCount}
      activeLabel={activeFilterLabel}
      onClear={clearFilters}
      label={filterContainer === undefined ? 'Work filters' : 'Feed filters'}
      align={filterContainer === undefined ? 'start' : undefined}
    >
      <div className="space-y-3" aria-label="Work stream filters">
        <WorkStreamFilterGroup title="Status">
          <StatusFilters values={statusFilters} onChange={setStatusFilters} />
        </WorkStreamFilterGroup>
        {showSquadFilter && (squads.length > 0 || squadsLoading) && (
          <WorkStreamFilterGroup title="Squads">
            <SquadFilters
              values={squadFilters}
              onChange={setSquadFilters}
              squads={squads}
              isLoading={squadsLoading}
              loadingCount={squadLoadingCount}
            />
          </WorkStreamFilterGroup>
        )}
        {feedSummarySwitch && (
          <div className="border-t border-th-border pt-3">
            <WorkStreamFilterGroup title="View">{feedSummarySwitch}</WorkStreamFilterGroup>
          </div>
        )}
      </div>
    </WorkStreamFiltersPopover>
  )
  // "Summaries" sits with the list's other view controls in the Active header, except on the Feed
  // (filters in its page header), where it is the View row of the Filters panel (owner review).
  const activeActions =
    summarySwitch && activeHeaderActions ? (
      <>
        {summarySwitch}
        {activeHeaderActions}
      </>
    ) : (
      (summarySwitch ?? activeHeaderActions)
    )

  const activePending = isLoading && activeStreams.length === 0
  const donePending = isLoadingDone && doneStreams.length === 0
  const hasActiveSection = activePending || activeStreams.length > 0
  const hasDoneSection = doneStreams.length > 0 || (pagedDone && (doneTotalCount ?? 0) > 0)
  const isEmpty = !hasActiveSection && !hasDoneSection && !donePending
  // Rows move, arrive and change status with motion only for live data: any change of scope,
  // filters, view, loading or paging state is a fresh list (LiveListMotion).
  const liveMotionResetKey = JSON.stringify([
    loadingShapeScope,
    statusFilters,
    showSquadFilter ? squadFilters : [],
    activeOnly,
    bareActiveSection,
    activeCollapsible && activeCollapsed,
    doneCollapsed,
    showSummaries,
    activePending,
    donePending,
    isLoading,
    isLoadingDone,
    isFetchingMoreDone,
  ])

  return (
    <div className={clsx('flex flex-col', feedLayout ? 'gap-4' : 'gap-6')}>
      {/* Filters */}
      {filterContainer === undefined
        ? (filtersPopover || filterActions) && (
            <div className="flex items-center gap-3 px-1">
              <div className="min-w-0 flex-1">{filtersPopover}</div>
              {filterActions && <div className="flex shrink-0 items-center gap-3">{filterActions}</div>}
            </div>
          )
        : filterContainer && filtersPopover && createPortal(filtersPopover, filterContainer)}

      {loadingError && (
        <p role="alert" className="px-3 text-sm text-muted">
          {loadingError}
        </p>
      )}
      <LiveListMotion resetKey={liveMotionResetKey}>
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
                      showSummary={showSummaries}
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
                  feedLayout={feedLayout}
                  count={activePending ? <SkeletonText className="w-5" /> : activeStreams.length}
                  collapsible={activeCollapsible}
                  collapsed={activeCollapsed}
                  onToggle={() => setActiveCollapsed(!activeCollapsed)}
                  actions={activeActions}
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
                          showSummary={showSummaries}
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
                  feedLayout={feedLayout}
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
                          showSummary={showSummaries}
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
      </LiveListMotion>

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
          // The rows have summary rows only. The detail view names agents, so it loads the
          // full record of each agent this one stream involves.
          agentMap={NO_LOADED_AGENTS}
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
            <div key={index} className={clsx('pr-3 py-2.5', feedLayout ? FEED_ROW_INSET_CLASS : 'pl-3')}>
              {/* The row's shape: marker, title and status badge, then one line of context. */}
              <div className="flex h-5 items-center gap-2">
                <SkeletonBlock className="h-2 w-2 shrink-0 rounded-full" />
                <SkeletonLine className={index % 3 === 0 ? 'w-2/3' : 'w-1/2'} />
                <SkeletonBlock className="ml-auto h-5 w-20 shrink-0 rounded-full" />
              </div>
              <div className="ml-4 mt-1 flex gap-2">
                <SkeletonLine className="w-20" />
                <SkeletonLine className="w-14" />
              </div>
            </div>
          )}
        </SkeletonRows>
      </div>
    </LoadingSurface>
  )
}
