import { workStreamRef } from '@ficus/shared'
import { workStreamTitle } from '@ficus/shared'
import { WorkStreamStatusBadges } from '../WorkStreamStatusBadges'
import { workStreamStatusLabel, WS_STATUS_LABELS } from '../../lib/workStreamStatusPresentation'
import { CreateFlowWorkStream } from './CreateFlowWorkStream'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { useURLStringState } from '../../hooks/useURLState'
import { useFullscreen } from '../../hooks/useFullscreen'
import { MarkdownContent } from '../MarkdownContent'
import { WorkStreamDetailModal, getWsDisplayState } from '../WorkStreamDetailModal'
import { WorkStreamGraph } from '../WorkStreamGraph'
import { WorkStreamViewToggle, useWorkStreamViewMode } from '../WorkStreamViewToggle'
import { WorkStreamList as GenericWorkStreamList, WS_ACTIVE_STATUSES } from '../WorkStreamList'
import { GraphIcon } from '../icons'
import { Modal } from '../Modal'
import {
  CanvasSkeleton,
  LoadingSurface,
  SkeletonBlock,
  SkeletonCard,
  SkeletonLine,
  SkeletonRows,
} from '../loading/Skeleton'
import {
  WORK_STREAM_STATUS_ROLE,
  type WorkStream,
  type WorkStreamPresentationState,
  type Agent,
  type Squad,
} from '@ficus/shared'
import { getAgentPrimaryLabel } from '../../lib/agentDisplay'
import { webStatus } from '../../lib/statusPresentation'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'

const KANBAN_CALLOUT: Partial<
  Record<WorkStreamPresentationState, { label?: string; suffix?: string; pulse: boolean }>
> = {
  delivery_approval: { suffix: ' — click to open', pulse: true },
  delivery_review: { suffix: ' — click to open', pulse: true },
  delivery_merge: { suffix: ' — click to open', pulse: true },
  delivery_external: { pulse: false },
  delivery_setup: { suffix: ' — click to inspect', pulse: true },
  delivery_failure: { suffix: ' — click to inspect', pulse: true },
  in_review: { label: 'Needs review — click to open', pulse: true },
  waiting_on_answer: { label: 'Waiting on answer — click to respond', pulse: true },
  waiting_on_dependency: { label: 'Waiting on dependency — click to inspect', pulse: false },
  waiting_on_owner: { label: 'Waiting on owner — click to inspect', pulse: false },
  blocked: { label: 'Blocked — click to respond', pulse: true },
  execution_failed: { label: 'Execution failed — click to inspect', pulse: true },
  paused: { label: 'Paused until resumed', pulse: false },
}

interface Props {
  workStreams: WorkStream[]
  squadId: string
  squad?: Squad
  /** Only show active work streams (stored status queued or active) */
  activeOnly?: boolean
  /** Hide filters and view toggle - useful for embedded/compact views */
  compact?: boolean
  /** Make the list Active section collapsible */
  activeCollapsible?: boolean
  /** Give the compact Home explorer a button that opens the dependency graph in a dialog. */
  expandable?: boolean
  /** Show loading state instead of empty state when true */
  isLoading?: boolean
  isLoadingDone?: boolean
  doneStreams?: WorkStream[]
  doneTotalCount?: number
  hasMoreDone?: boolean
  isFetchingMoreDone?: boolean
  onLoadMoreDone?: () => void
}

const KANBAN_COLUMNS: WorkStreamPresentationState[] = [
  'paused',
  'delivery_approval',
  'delivery_review',
  'delivery_merge',
  'delivery_external',
  'delivery_setup',
  'delivery_failure',
  'queued',
  'idle',
  'in_progress',
  'in_review',
  'waiting_on_answer',
  'waiting_on_dependency',
  'waiting_on_owner',
  'waiting_for_slot',
  'blocked',
  'execution_failed',
  'done',
  'canceled',
]
const KANBAN_ALWAYS_SHOW: WorkStreamPresentationState[] = ['queued', 'in_progress', 'in_review', 'done']

/** Raw active is a compatibility fallback; precise derived waits retain their own columns. */
function kanbanColumnFor(workStream: WorkStream): WorkStreamPresentationState {
  const state = getWsDisplayState(workStream)
  return state === 'active' ? 'in_progress' : state
}

const WORK_VIEW_MODES = ['list', 'kanban', 'graph'] as const

export function WorkStreamList({
  workStreams,
  squadId,
  squad,
  activeOnly = false,
  compact = false,
  activeCollapsible = false,
  expandable = false,
  isLoading,
  isLoadingDone,
  doneStreams = [],
  doneTotalCount,
  hasMoreDone,
  isFetchingMoreDone,
  onLoadMoreDone,
}: Props) {
  const surface = compact ? 'home' : 'work'
  const modes = WORK_VIEW_MODES
  // The compact Home explorer has no view toggle: it is always a list inline
  // and always the dependency graph in its dialog. Only the Work tab persists a
  // chosen view.
  const [workViewMode] = useWorkStreamViewMode(squadId, surface, modes)
  const viewMode = compact ? 'list' : workViewMode
  const [selectedWs, setSelectedWsParam] = useURLStringState<string>('ws', '')
  const setSelectedWs = useCallback(
    (ref: string) => {
      const work = [...workStreams, ...doneStreams].find((item) => item.id === ref || workStreamRef(item) === ref)
      setSelectedWsParam(work ? workStreamRef(work) : ref)
    },
    [workStreams, doneStreams, setSelectedWsParam]
  )
  const fullscreenContentRef = useRef<HTMLDivElement>(null)
  const hadSelectedWsRef = useRef(false)
  const shouldExitFullscreenOnEscape = useCallback(() => {
    if (!selectedWs) return true
    setSelectedWs('')
    return false
  }, [selectedWs, setSelectedWs])
  const { isFullscreen, enterFullscreen, exitFullscreen } = useFullscreen({
    shouldExitOnEscape: shouldExitFullscreenOnEscape,
  })
  const expandTriggerRef = useRef<HTMLButtonElement>(null)
  const wasFullscreenRef = useRef(false)

  useEffect(() => {
    if (wasFullscreenRef.current && !isFullscreen) expandTriggerRef.current?.focus()
    wasFullscreenRef.current = isFullscreen
  }, [isFullscreen])

  useEffect(() => {
    if (isFullscreen && hadSelectedWsRef.current && !selectedWs) fullscreenContentRef.current?.focus()
    hadSelectedWsRef.current = Boolean(selectedWs)
  }, [isFullscreen, selectedWs])

  // The server canonical order (GET /workstreams) is the single ordering
  // authority: both lists arrive pre-sorted, so no client re-sort is needed.
  const orderedActiveWorkStreams = workStreams
  const orderedDoneStreams = doneStreams

  // Filter to active-only if requested
  const loadedWorkStreams = activeOnly ? orderedActiveWorkStreams : [...orderedActiveWorkStreams, ...orderedDoneStreams]
  const filteredWorkStreams = activeOnly
    ? orderedActiveWorkStreams.filter((ws) => (WS_ACTIVE_STATUSES as readonly string[]).includes(ws.status))
    : loadedWorkStreams
  const loadingItemCount = useLoadingShapeCount(
    `work-streams:squad:${squadId}:${surface}:${compact ? 'list' : viewMode}`,
    isLoading ? undefined : filteredWorkStreams.length,
    { fallbackCount: compact ? 3 : 5, maxCount: compact ? 6 : 12 }
  )
  const graphWorkStreams = useMemo(
    () =>
      orderedActiveWorkStreams.filter((stream) => (WS_ACTIVE_STATUSES as readonly string[]).includes(stream.status)),
    [orderedActiveWorkStreams]
  )

  const { data: agents = [] } = useQuery({
    ...queries.squads.agents(squadId),
    enabled: !!squadId,
  })

  const agentMap = useMemo(() => new Map(agents.map((a: Agent) => [a.id, a])), [agents])
  const squadMap = useMemo(() => (squad ? new Map([[squad.id, squad]]) : new Map<string, Squad>()), [squad])

  const grouped = KANBAN_COLUMNS.reduce(
    (acc, status) => {
      acc[status] = filteredWorkStreams.filter((ws) => kanbanColumnFor(ws) === status)
      return acc
    },
    {} as Record<WorkStreamPresentationState, WorkStream[]>
  )

  const loadedSelectedWorkStream = selectedWs
    ? loadedWorkStreams.find((ws) => ws.id === selectedWs || workStreamRef(ws) === selectedWs)
    : null
  const { data: fetchedSelectedWorkStream } = useQuery({
    ...queries.squads.workStreamDetail(selectedWs),
    enabled: !!selectedWs && !loadedSelectedWorkStream,
  })
  const selectedWorkStream = loadedSelectedWorkStream ?? fetchedSelectedWorkStream ?? null

  const isInitialLoading = Boolean((isLoading || (!activeOnly && isLoadingDone)) && filteredWorkStreams.length === 0)

  const renderExplorerActions = (showExpand: boolean, inFullscreen: boolean) => (
    <>
      {!inFullscreen && !compact && <WorkStreamViewToggle squadId={squadId} surface={surface} modes={modes} />}
      {showExpand && (
        <button
          ref={expandTriggerRef}
          type="button"
          onClick={enterFullscreen}
          className="ficus-button rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          aria-label="Show work stream graph"
          title="Show work stream graph"
        >
          <GraphIcon className="h-4 w-4" />
        </button>
      )}
    </>
  )

  const renderLoadingState = (showExpand: boolean, inFullscreen: boolean) => {
    const visibleViewMode = compact && inFullscreen ? 'graph' : viewMode
    if (visibleViewMode === 'graph') {
      return (
        <div className="flex h-full flex-col gap-2">
          {!inFullscreen && (
            <div className="flex shrink-0 items-center justify-end gap-1">
              {renderExplorerActions(showExpand, inFullscreen)}
            </div>
          )}
          <CanvasSkeleton
            label="Loading work stream graph"
            className={clsx(inFullscreen ? 'h-72' : 'min-h-0 flex-1')}
          />
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col gap-2">
        {!inFullscreen && (
          <div className="flex shrink-0 items-center justify-end gap-1">
            {renderExplorerActions(showExpand, inFullscreen)}
          </div>
        )}
        <LoadingSurface label="Loading work streams" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SkeletonRows count={Math.max(1, loadingItemCount)}>
            {(index) => (
              <SkeletonCard key={index} className="min-h-24 space-y-3">
                <SkeletonLine className={index % 2 ? 'w-3/5' : 'w-4/5'} />
                <SkeletonLine className="w-full" />
                <div className="flex justify-between pt-2">
                  <SkeletonBlock className="h-5 w-16 rounded-full" />
                  <SkeletonLine className="w-12" />
                </div>
              </SkeletonCard>
            )}
          </SkeletonRows>
        </LoadingSurface>
      </div>
    )
  }

  const renderExplorer = (showExpand: boolean, inFullscreen: boolean) => {
    const visibleViewMode = compact && inFullscreen ? 'graph' : viewMode
    return (
      <div className="flex flex-col h-full">
        {visibleViewMode !== 'list' && !isInitialLoading && !inFullscreen && (
          <div className="mb-2 flex shrink-0 items-center justify-end gap-3">
            {renderExplorerActions(showExpand, inFullscreen)}
            {!compact && <CreateFlowWorkStream squadId={squadId} />}
          </div>
        )}

        {isInitialLoading && visibleViewMode !== 'list' ? (
          renderLoadingState(showExpand, inFullscreen)
        ) : filteredWorkStreams.length === 0 && visibleViewMode !== 'graph' && visibleViewMode !== 'list' ? (
          compact ? (
            <p className="text-sm text-muted py-2">No active work streams</p>
          ) : (
            <div className="text-center py-12 text-muted">
              <p className="text-lg">{activeOnly ? 'No active work streams' : 'No work streams yet'}</p>
              <p className="text-sm mt-1">
                {activeOnly
                  ? 'Active work streams will appear here.'
                  : 'Work streams will appear when the squad manager creates them.'}
              </p>
            </div>
          )
        ) : (
          <>
            {visibleViewMode === 'graph' && (
              <div className={clsx('flex-1 min-h-0 overflow-y-auto', inFullscreen && 'p-4')}>
                <WorkStreamGraph
                  workStreams={graphWorkStreams}
                  agentMap={agentMap}
                  onSelectWorkStream={setSelectedWs}
                />
                {selectedWorkStream && (
                  <WorkStreamDetailModal
                    workStream={selectedWorkStream}
                    squadMap={squadMap}
                    agentMap={agentMap}
                    workStreamMap={new Map(loadedWorkStreams.map((stream) => [stream.id, stream]))}
                    onSelectWorkStream={setSelectedWs}
                    onClose={() => setSelectedWs('')}
                  />
                )}
              </div>
            )}

            {visibleViewMode === 'list' && (
              <div
                className={clsx(
                  'flex-1 min-h-0',
                  compact ? 'squad-home-work-stream-rows md:overflow-y-auto' : 'overflow-y-auto'
                )}
              >
                <GenericWorkStreamList
                  workStreams={filteredWorkStreams}
                  squadMap={squadMap}
                  agentMap={agentMap}
                  showSquadFilter={false}
                  hideFilters={compact}
                  filterActions={!compact && !inFullscreen ? <CreateFlowWorkStream squadId={squadId} /> : undefined}
                  activeOnly={activeOnly}
                  activeCollapsible={activeCollapsible}
                  activeHeaderActions={renderExplorerActions(showExpand, inFullscreen)}
                  bareActiveSection={inFullscreen}
                  loadingShapeKey={`work-streams:squad:${squadId}`}
                  isLoading={isLoading}
                  isLoadingDone={!activeOnly && isLoadingDone}
                  doneStreams={activeOnly ? undefined : orderedDoneStreams}
                  doneTotalCount={doneTotalCount}
                  hasMoreDone={hasMoreDone}
                  isFetchingMoreDone={isFetchingMoreDone}
                  onLoadMoreDone={onLoadMoreDone}
                  emptyMessage={activeOnly ? 'No active work streams' : 'No work streams yet'}
                />
              </div>
            )}

            {visibleViewMode === 'kanban' && (
              <div className="flex h-full min-h-0">
                <div className="flex gap-4 overflow-x-auto flex-1 pb-4">
                  {KANBAN_COLUMNS.filter(
                    (status) => grouped[status].length > 0 || KANBAN_ALWAYS_SHOW.includes(status)
                  ).map((status) => (
                    <StatusColumn
                      key={status}
                      status={status}
                      workStreams={grouped[status]}
                      agentMap={agentMap}
                      selectedId={selectedWs}
                      onSelect={setSelectedWs}
                      hasMore={status === 'done' ? hasMoreDone : false}
                      isFetchingMore={status === 'done' ? isFetchingMoreDone : false}
                      onLoadMore={status === 'done' ? onLoadMoreDone : undefined}
                    />
                  ))}
                </div>

                {selectedWorkStream && (
                  <WorkStreamDetailModal
                    workStream={selectedWorkStream}
                    squadMap={squadMap}
                    agentMap={agentMap}
                    workStreamMap={new Map(loadedWorkStreams.map((stream) => [stream.id, stream]))}
                    onSelectWorkStream={setSelectedWs}
                    onClose={() => setSelectedWs('')}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  if (!expandable || !isFullscreen) return renderExplorer(expandable, false)

  return (
    <>
      {renderExplorer(true, false)}
      <Modal isOpen onClose={exitFullscreen} title="Work Stream Graph" size="default" maxWidth="wide" noChildPadding>
        <div ref={fullscreenContentRef} tabIndex={-1} className="min-h-0 outline-none">
          {renderExplorer(false, true)}
        </div>
      </Modal>
    </>
  )
}

function StatusColumn({
  status,
  workStreams,
  agentMap,
  selectedId,
  onSelect,
  hasMore,
  isFetchingMore,
  onLoadMore,
}: {
  status: WorkStreamPresentationState
  workStreams: WorkStream[]
  agentMap: Map<string, Agent>
  selectedId: string | null
  onSelect: (id: string) => void
  hasMore?: boolean
  isFetchingMore?: boolean
  onLoadMore?: () => void
}) {
  return (
    <div className="flex-shrink-0 w-64 flex flex-col min-h-0 h-full">
      <div
        className={clsx(
          'rounded-lg p-3 flex flex-col min-h-0 h-full',
          webStatus(WORK_STREAM_STATUS_ROLE[status]).surfaceClass
        )}
      >
        <h3 className="font-medium text-sm text-primary mb-3 shrink-0">
          {WS_STATUS_LABELS[status]} ({workStreams.length})
        </h3>
        <div className="space-y-2 overflow-y-auto min-h-0 flex-1">
          {workStreams.map((ws) => (
            <WorkStreamCard
              key={ws.id}
              workStream={ws}
              agentMap={agentMap}
              isSelected={ws.id === selectedId || workStreamRef(ws) === selectedId}
              onSelect={() =>
                onSelect(ws.id === selectedId || workStreamRef(ws) === selectedId ? '' : workStreamRef(ws))
              }
            />
          ))}
          {hasMore && onLoadMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={isFetchingMore}
              className="ficus-button w-full rounded-md border border-th-border bg-surface px-3 py-2 text-sm text-secondary hover:bg-surface-hover disabled:opacity-60"
            >
              {isFetchingMore ? 'Loading…' : 'Load more done'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkStreamCard({
  workStream,
  agentMap,
  isSelected,
  onSelect,
}: {
  workStream: WorkStream
  agentMap: Map<string, Agent>
  isSelected: boolean
  onSelect: () => void
}) {
  const assignee = workStream.assigneeAgentId ? agentMap.get(workStream.assigneeAgentId) : null
  const displayState = getWsDisplayState(workStream)
  const callout = KANBAN_CALLOUT[displayState]
  const treatment = webStatus(WORK_STREAM_STATUS_ROLE[displayState])

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open work stream ${workStreamTitle(workStream)}`}
      aria-pressed={isSelected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect()
      }}
      className={clsx(
        'bg-surface p-3 rounded-md border cursor-pointer transition-colors',
        isSelected ? 'border-accent ring-1 ring-accent/50' : 'border-th-border hover:border-accent/50'
      )}
    >
      <h4 className="font-medium text-sm text-primary">{workStreamTitle(workStream)}</h4>
      {workStream.description && (
        <div className="mt-1 line-clamp-2 text-xs text-muted">
          <MarkdownContent className="prose-xs">{workStream.description}</MarkdownContent>
        </div>
      )}

      {callout && (
        <div className={clsx('mt-2 flex items-center gap-1.5 text-xs', treatment.textClass)}>
          <span
            className={clsx(
              'inline-block w-2 h-2 rounded-full',
              treatment.markerClass,
              callout.pulse && 'animate-pulse'
            )}
          />
          {callout.label ?? `${workStreamStatusLabel(workStream)}${callout.suffix ?? ''}`}
        </div>
      )}

      <div className="mt-2">
        <WorkStreamStatusBadges workStream={workStream} showPrimary={false} />
      </div>

      {/* Assignee */}
      {assignee && (
        <p className="text-xs text-muted mt-2">
          → {getAgentPrimaryLabel(assignee)} ({assignee.agentTypeId})
        </p>
      )}
    </div>
  )
}
