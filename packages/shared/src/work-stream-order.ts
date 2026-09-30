import { selectWorkStreamPresentationState, type WorkStreamDeliveryPresentation } from './status-presentation'
import { priorityRank } from './work-stream-priority'
import type { WorkStreamDerivedState, WorkStreamPriority, WorkStreamStatus, WorkStreamWait } from './types'

export interface CanonicalWorkStreamOrderInput {
  pause?: unknown
  delivery?: WorkStreamDeliveryPresentation
  id: string
  status: WorkStreamStatus
  derivedState?: WorkStreamDerivedState
  openWaits?: ReadonlyArray<Pick<WorkStreamWait, 'type' | 'closedAt'> & { id?: string }>
  priority?: WorkStreamPriority
  effectivePriority?: WorkStreamPriority
  queuePosition?: number
  waitingOnDependencies?: boolean
  createdAt: Date | string
  completedAt?: Date | string | null
  updatedAt?: Date | string
  metadata?: unknown
  /**
   * Server-annotated discriminator for review-wait urgency: true when the open
   * review gate is expected to settle without a human verdict (code-host CI /
   * auto-merge delivery). Absent or false keeps the review wait
   * human-actionable, matching older payloads that cannot know.
   */
  automatedReviewGate?: boolean
}

export interface CanonicalWorkStreamSortKey {
  group: number
  activeUrgency: number
  queuePosition: number
  terminalCompletedAt: number
  priority: number
  createdAt: number
  id: string
}

const PRIORITIES = new Set<WorkStreamPriority>(['critical', 'high', 'normal', 'low'])
const WAIT_DERIVED_STATES = new Set<WorkStreamDerivedState>([
  'in_review',
  'waiting_on_answer',
  'waiting_on_dependency',
  'blocked',
])

function safePriority(value: unknown): WorkStreamPriority {
  return PRIORITIES.has(value as WorkStreamPriority) ? (value as WorkStreamPriority) : 'normal'
}

function validTime(value: unknown): number | undefined {
  if (!(value instanceof Date) && typeof value !== 'string') return undefined
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : undefined
}

function metadataCompletionTime(item: CanonicalWorkStreamOrderInput): { present: boolean; value?: number } {
  if (!item.metadata || typeof item.metadata !== 'object') return { present: false }
  const completion = (item.metadata as Record<string, unknown>).completion
  if (!completion || typeof completion !== 'object') return { present: false }
  const record = completion as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'completedAt')) return { present: false }
  return { present: true, value: validTime(record.completedAt) }
}

export function isValidQueuePosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
}

// Active urgency tiers, most human-actionable first:
// 0. Waits a human must clear: a review that needs a human verdict, a
//    question, or a manual/blocked wait.
// 1. Running work (in_progress).
// 2. A review gate the delivery pipeline settles itself (annotated
//    `automatedReviewGate`): CI / auto-merge pending, no human input needed.
//    A human delivery gate (PR review/merge) stays in tier 0 regardless.
// 3. Everything else: dependency waits (they wait on another stream, not a
//    person), other external delivery waits, delivery setup/failure, idle,
//    and failed executions.
function activeUrgency(item: CanonicalWorkStreamOrderInput): number {
  const state = selectWorkStreamPresentationState({
    ...item,
    openWaits: item.openWaits?.filter((wait) => wait.closedAt === null),
  })
  if (['in_review', 'delivery_approval', 'delivery_review', 'delivery_merge'].includes(state)) {
    // A pull request that needs a human review or merge is never automated,
    // whatever the annotation claims (auto-merge waits on that same human).
    const humanDelivery = ['approval', 'review', 'merge'].includes(String(item.delivery?.kind))
    return item.automatedReviewGate === true && !humanDelivery ? 2 : 0
  }
  if (state === 'waiting_on_answer' || state === 'blocked') return 0
  if (state === 'in_progress') return 1
  return 3
}

function queuedHasWait(item: CanonicalWorkStreamOrderInput): boolean {
  if (item.pause || item.derivedState === 'paused' || item.delivery) return true
  if (item.waitingOnDependencies === true) return true
  if (item.openWaits !== undefined) return item.openWaits.some((wait) => wait.closedAt === null)
  return item.derivedState !== undefined && WAIT_DERIVED_STATES.has(item.derivedState)
}

function terminalTime(item: CanonicalWorkStreamOrderInput): number | undefined {
  if (item.completedAt !== null && item.completedAt !== undefined) return validTime(item.completedAt)
  const metadataTime = metadataCompletionTime(item)
  if (metadataTime.present) return metadataTime.value
  return validTime(item.updatedAt)
}

export function canonicalWorkStreamSortKey(item: CanonicalWorkStreamOrderInput): CanonicalWorkStreamSortKey {
  const positioned = item.status === 'queued' && isValidQueuePosition(item.queuePosition) && !queuedHasWait(item)
  const group =
    item.status === 'active'
      ? 0
      : positioned
        ? 1
        : item.status === 'queued'
          ? 2
          : item.status === 'done' || item.status === 'canceled'
            ? 3
            : 4
  const effectivePriority = safePriority(item.effectivePriority ?? item.priority)

  return {
    group,
    activeUrgency: item.status === 'active' ? activeUrgency(item) : 0,
    queuePosition: positioned ? item.queuePosition! : Number.POSITIVE_INFINITY,
    terminalCompletedAt:
      item.status === 'done' || item.status === 'canceled'
        ? (terminalTime(item) ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY,
    priority: priorityRank(effectivePriority),
    createdAt: validTime(item.createdAt) ?? Number.POSITIVE_INFINITY,
    id: item.id,
  }
}

function ascending(a: number, b: number): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function descending(a: number, b: number): number {
  return ascending(b, a)
}

export function compareCanonicalWorkStreams<T extends CanonicalWorkStreamOrderInput>(a: T, b: T): number {
  const ak = canonicalWorkStreamSortKey(a)
  const bk = canonicalWorkStreamSortKey(b)

  let difference = ascending(ak.group, bk.group)
  if (difference !== 0) return difference

  if (ak.group === 0) {
    difference = ascending(ak.activeUrgency, bk.activeUrgency)
    if (difference !== 0) return difference
  } else if (ak.group === 1) {
    difference = ascending(ak.queuePosition, bk.queuePosition)
    if (difference !== 0) return difference
  } else if (ak.group === 3) {
    difference = descending(ak.terminalCompletedAt, bk.terminalCompletedAt)
    if (difference !== 0) return difference
  }

  difference = descending(ak.priority, bk.priority)
  if (difference !== 0) return difference
  difference = ascending(ak.createdAt, bk.createdAt)
  if (difference !== 0) return difference
  return ak.id < bk.id ? -1 : ak.id > bk.id ? 1 : 0
}

export function sortCanonicalWorkStreams<T extends CanonicalWorkStreamOrderInput>(items: readonly T[]): T[] {
  return [...items].sort(compareCanonicalWorkStreams)
}
