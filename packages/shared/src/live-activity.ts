import { workStreamTitle } from './work-stream-reference'
import {
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  type WorkStreamPresentationFacts,
} from './status-presentation'
import type { WorkStream, WorkStreamDerivedState, WorkStreamStatus, WorkStreamWaitType } from './types'

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
    state === 'waiting_on_dependency' ||
    state === 'delivery_external' ||
    state === 'waiting_on_owner'
  )
    return 'externalWait'
  if (workStreamNeedsHumanAttention(stream)) return 'needsYou'
  if (['blocked', 'idle', 'execution_failed', 'delivery_setup', 'delivery_failure'].includes(state)) return 'blocked'
  if (state === 'active' || state === 'in_progress') return 'running'
  return 'queued'
}

/** One row in the activity's short list. Mirrors `StreamLite` in FicusWorkAttributes.swift. */
export interface StreamLite {
  number?: number
  id: string
  title: string
  bucket: WorkBucket
  squadId: string
  agentId?: string
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
  derivedState?: WorkStreamDerivedState
  assigneeAgentId?: string
  /** An explicit empty array is authoritative and must survive serialization. */
  openWaitTypes: WorkStreamWaitType[]
  updatedAt: string
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
  | 'assigneeAgentId'
  | 'openWaits'
  | 'updatedAt'
>

function updatedAtMs(stream: Pick<SnapshotSource, 'updatedAt'>): number {
  return new Date(stream.updatedAt).getTime()
}

/** Canonical attention-first ordering shared by widget and Live Activity projections. */
export function compareWorkInterest(left: SnapshotSource, right: SnapshotSource): number {
  const leftNeedsYou = workBucket(left) === 'needsYou'
  const rightNeedsYou = workBucket(right) === 'needsYou'
  if (leftNeedsYou !== rightNeedsYou) return leftNeedsYou ? -1 : 1
  const recency = updatedAtMs(right) - updatedAtMs(left)
  return recency || left.id.localeCompare(right.id)
}

function toStreamLite(stream: SnapshotSource): StreamLite {
  const row: StreamLite = {
    id: stream.id,
    title: workStreamTitle(stream),
    ...(stream.number ? { number: stream.number } : {}),
    bucket: workBucket(stream),
    squadId: stream.squadId,
  }
  if (stream.assigneeAgentId) row.agentId = stream.assigneeAgentId
  return row
}

function toWidgetSummary(stream: SnapshotSource): WidgetWorkStreamSummary {
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
  if (stream.pause) row.pause = true
  if (stream.delivery) row.delivery = stream.delivery
  if (stream.derivedState) row.derivedState = stream.derivedState
  if (stream.assigneeAgentId) row.assigneeAgentId = stream.assigneeAgentId
  return row
}

export function buildWorkInterestSnapshot(streams: SnapshotSource[], now: Date = new Date()): WorkInterestSnapshot {
  const ordered = [...streams].sort(compareWorkInterest)
  const bucketCounts: Record<WorkBucket, number> = {
    needsYou: 0,
    running: 0,
    blocked: 0,
    queued: 0,
    paused: 0,
    externalWait: 0,
  }
  for (const stream of ordered) bucketCounts[workBucket(stream)] += 1

  return {
    asOf: now.toISOString(),
    totalCount: ordered.length,
    bucketCounts,
    top: ordered.slice(0, WIDGET_TOP_LIMIT).map(toWidgetSummary),
    liveActivity: {
      activeCount: bucketCounts.running,
      needsYouCount: bucketCounts.needsYou,
      top: ordered.slice(0, LIVE_ACTIVITY_TOP_LIMIT).map(toStreamLite),
    },
  }
}

export function buildLiveActivityState(streams: SnapshotSource[]): LiveActivityState {
  return buildWorkInterestSnapshot(streams).liveActivity
}

export function shouldShowLiveActivity(state: LiveActivityState): boolean {
  return state.activeCount > 0 || state.needsYouCount > 0
}

export function serializeLiveActivityState(streams: SnapshotSource[]): string {
  return JSON.stringify(buildLiveActivityState(streams))
}
