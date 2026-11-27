import { workStreamTitle } from './work-stream-reference'
import {
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  type WorkStreamPresentationFacts,
} from './status-presentation'
import type { WorkStream, WorkStreamDerivedState, WorkStreamStatus, WorkStreamWaitType } from './types'
import { workStreamWaitsOnViewer, type WorkStreamViewer } from './work-stream-time'

/** Explicit reduced vocabulary used by WidgetKit and ActivityKit. */
export type WorkBucket = 'needsYou' | 'running' | 'blocked' | 'queued' | 'paused' | 'externalWait'

export type WorkBucketFacts = WorkStreamPresentationFacts

/** Project precise work semantics into the intentionally reduced native buckets. */
export function workBucket(stream: WorkBucketFacts): WorkBucket {
  const state = selectWorkStreamPresentationState(stream)
  if (state === 'paused') return 'paused'
  // Owner-actor manual waits are waits on someone other than
  // the user: the existing non-alarming bucket, never Needs you. No new bucket
  // value is introduced, so older native binaries keep rendering them.
  if (
    state === 'waiting_for_slot' ||
    state === 'monitoring' ||
    state === 'waiting_on_dependency' ||
    state === 'delivery_external' ||
    state === 'waiting_on_owner' ||
    state === 'waiting_on_manager'
  )
    return 'externalWait'
  if (state === 'active' || state === 'in_progress') return 'running'
  if (workStreamNeedsHumanAttention(stream)) return 'needsYou'
  if (['blocked', 'idle', 'execution_failed', 'delivery_setup', 'delivery_failure'].includes(state)) return 'blocked'
  return 'queued'
}

/** One row in the activity's short list. Mirrors `StreamLite` in FicusWorkAttributes.swift. */
export interface StreamLite {
  /** Assigned by the trusted aggregator, never accepted from a relay source. */
  origin?: string
  number?: number
  id: string
  title: string
  bucket: WorkBucket
  squadId: string
  agentId?: string
  /** Whether this row waits on the snapshot's user; see {@link WidgetWorkStreamSummary.needsYou}. */
  needsYou?: boolean
}

export interface LiveActivityState {
  activeCount: number
  needsYouCount: number
  top: StreamLite[]
}

export const LIVE_ACTIVITY_TOP_LIMIT = 3
export const WIDGET_TOP_LIMIT = 8

/** Safe server-owned row consumed by the native widget. */
export interface WidgetWorkStreamSummary {
  /** Authoritative projection, including legacy omitted-wait compatibility. Older servers omit it. */
  bucket?: WorkBucket
  number?: number
  id: string
  squadId: string
  title: string
  status: WorkStreamStatus
  pause?: boolean
  delivery?: WorkStream['delivery']
  /** Detailed row presentation only; never exposes slot pool details. */
  hasActiveSlotWait?: boolean
  /** Detailed row presentation only; never exposes monitor details. */
  hasActiveMonitor?: boolean
  derivedState?: WorkStreamDerivedState
  assigneeAgentId?: string
  /** An explicit empty array is authoritative and must survive serialization. */
  openWaitTypes: WorkStreamWaitType[]
  updatedAt: string
  /**
   * Whether the stream waits on the user the snapshot belongs to (`workStreamWaitsOnViewer`, the
   * rule behind `needsYouCount` and Activity's "N waiting on you"). Viewer-specific, unlike
   * `bucket`: a `needsYou` bucket row reads false when only someone else can act (a gate this user
   * may not decide), and a delivery waiting on the code host reads true for every viewer. Sent as
   * an explicit boolean whenever the snapshot is built for a user; older servers omit it, and
   * clients then fall back to `bucket`.
   */
  needsYou?: boolean
}

export interface WorkInterestSnapshot {
  asOf: string
  totalCount: number
  bucketCounts: Record<Exclude<WorkBucket, 'paused' | 'externalWait'>, number> & {
    paused?: number
    externalWait?: number
  }
  top: WidgetWorkStreamSummary[]
  liveActivity: LiveActivityState
}

type SnapshotSource = Pick<
  WorkStream,
  | 'pause'
  | 'delivery'
  | 'number'
  | 'id'
  | 'squadId'
  | 'title'
  | 'status'
  | 'derivedState'
  | 'hasActiveSlotWait'
  | 'hasActiveMonitor'
  | 'assigneeAgentId'
  | 'openWaits'
  | 'updatedAt'
> &
  Partial<Pick<WorkStream, 'assignedReviewerIds'>>

/**
 * Who the snapshot belongs to, for its "waiting on you" count. The Live Activity and widget are
 * built for one user, so they count by the same viewer rule as Activity (`workStreamWaitsOnViewer`).
 */
export interface WorkInterestViewerOptions {
  /**
   * The user as a viewer of this stream (their permissions in its squad), or undefined when the
   * stream must not count as waiting on them (permissions unknown, or decisions muted). Without
   * it, nothing counts as waiting on the user.
   */
  viewerFor?: (stream: SnapshotSource) => WorkStreamViewer | undefined
}

function updatedAtMs(stream: Pick<SnapshotSource, 'updatedAt'>): number {
  return new Date(stream.updatedAt).getTime()
}

/**
 * Canonical attention-first ordering shared by widget and Live Activity projections. With
 * `waitsOnViewer` (a snapshot built for one user), streams waiting on that user rank first, so
 * someone else's gate never takes a row from work this user can act on; within each group the
 * viewer-independent order follows: the `needsYou` bucket, then the most recently updated.
 */
export function compareWorkInterest(
  left: SnapshotSource,
  right: SnapshotSource,
  waitsOnViewer?: (stream: SnapshotSource) => boolean
): number {
  if (waitsOnViewer) {
    const leftWaitsOnYou = waitsOnViewer(left)
    const rightWaitsOnYou = waitsOnViewer(right)
    if (leftWaitsOnYou !== rightWaitsOnYou) return leftWaitsOnYou ? -1 : 1
  }
  const leftNeedsYou = workBucket(left) === 'needsYou'
  const rightNeedsYou = workBucket(right) === 'needsYou'
  if (leftNeedsYou !== rightNeedsYou) return leftNeedsYou ? -1 : 1
  const recency = updatedAtMs(right) - updatedAtMs(left)
  return recency || left.id.localeCompare(right.id)
}

function toStreamLite(stream: SnapshotSource, needsYou: boolean | undefined): StreamLite {
  const row: StreamLite = {
    id: stream.id,
    title: workStreamTitle(stream),
    ...(stream.number ? { number: stream.number } : {}),
    bucket: workBucket(stream),
    squadId: stream.squadId,
  }
  if (stream.assigneeAgentId) row.agentId = stream.assigneeAgentId
  if (needsYou !== undefined) row.needsYou = needsYou
  return row
}

function toWidgetSummary(stream: SnapshotSource, needsYou: boolean | undefined): WidgetWorkStreamSummary {
  const row: WidgetWorkStreamSummary = {
    bucket: workBucket(stream),
    id: stream.id,
    squadId: stream.squadId,
    title: workStreamTitle(stream),
    ...(stream.number ? { number: stream.number } : {}),
    status: stream.status,
    openWaitTypes: stream.openWaits?.map(({ type }) => type) ?? [],
    updatedAt: new Date(stream.updatedAt).toISOString(),
  }
  if (stream.hasActiveSlotWait !== undefined) row.hasActiveSlotWait = stream.hasActiveSlotWait
  if (stream.hasActiveMonitor !== undefined) row.hasActiveMonitor = stream.hasActiveMonitor
  if (stream.pause) row.pause = true
  if (stream.delivery) row.delivery = stream.delivery
  if (stream.derivedState) row.derivedState = stream.derivedState
  if (stream.assigneeAgentId) row.assigneeAgentId = stream.assigneeAgentId
  if (needsYou !== undefined) row.needsYou = needsYou
  return row
}

export function buildWorkInterestSnapshot(
  streams: SnapshotSource[],
  { now = new Date(), viewerFor }: WorkInterestViewerOptions & { now?: Date } = {}
): WorkInterestSnapshot {
  // Human actions remain available even when running is the primary bucket. Only streams this user
  // can act on wait on them, by the same rule as Activity's "N waiting on you".
  const waitsOnYou = new Map(streams.map((stream) => [stream, workStreamWaitsOnViewer(stream, viewerFor?.(stream))]))
  const waitsOnViewer = (stream: SnapshotSource) => waitsOnYou.get(stream) === true
  const ordered = [...streams].sort((left, right) => compareWorkInterest(left, right, waitsOnViewer))
  const bucketCounts: Record<WorkBucket, number> = {
    needsYou: 0,
    running: 0,
    blocked: 0,
    queued: 0,
    paused: 0,
    externalWait: 0,
  }
  for (const stream of ordered) bucketCounts[workBucket(stream)] += 1
  // Rows say so only in a snapshot built for a user; without one they keep today's shape.
  const rowNeedsYou = (stream: SnapshotSource) => (viewerFor ? waitsOnYou.get(stream) : undefined)

  return {
    asOf: now.toISOString(),
    totalCount: ordered.length,
    bucketCounts,
    top: ordered.slice(0, WIDGET_TOP_LIMIT).map((stream) => toWidgetSummary(stream, rowNeedsYou(stream))),
    liveActivity: {
      activeCount: bucketCounts.running,
      needsYouCount: ordered.filter(waitsOnViewer).length,
      top: ordered.slice(0, LIVE_ACTIVITY_TOP_LIMIT).map((stream) => toStreamLite(stream, rowNeedsYou(stream))),
    },
  }
}

export function buildLiveActivityState(
  streams: SnapshotSource[],
  options: WorkInterestViewerOptions = {}
): LiveActivityState {
  return buildWorkInterestSnapshot(streams, options).liveActivity
}

export function shouldShowLiveActivity(state: LiveActivityState): boolean {
  return state.activeCount > 0 || state.needsYouCount > 0
}

export function serializeLiveActivityState(streams: SnapshotSource[], options: WorkInterestViewerOptions = {}): string {
  return JSON.stringify(buildLiveActivityState(streams, options))
}
