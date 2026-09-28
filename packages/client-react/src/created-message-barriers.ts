import type { StreamGroupSnapshot } from '@ficus/client-core'

export interface ExactResponseIdentity {
  executionId: string
  streamGroupId: string
}

export interface CreatedMessageBarrier {
  generation: number
  arrivedAt: number
  identity: ExactResponseIdentity | null
  /**
   * streamGroupIds already in the stream store when the creation event arrived. A barrier holds
   * back only groups that begin AFTER it; these were on screen first and are never retracted.
   * Causal (captured at arrival) rather than clock-based: same-millisecond arrivals are ambiguous.
   */
  preexistingGroupIds: ReadonlySet<string>
}

export function exactResponseIdentity(data: Record<string, unknown>): ExactResponseIdentity | null {
  return typeof data.executionId === 'string' &&
    data.executionId.length > 0 &&
    typeof data.streamGroupId === 'string' &&
    data.streamGroupId.length > 0
    ? { executionId: data.executionId, streamGroupId: data.streamGroupId }
    : null
}

/**
 * A created-message barrier holds back a response group that BEGINS after the durable row's
 * creation event arrives, until that row has been fetched, so the response cannot render before the
 * row it answers. It never retracts a group that was already streaming when the event arrived: the
 * server persists each segment of the group being streamed as an assistant row stamped with that
 * same exact identity, so hiding an already-visible target would collapse the live response on
 * every completed thought / tool call.
 */
export function barrierHidesGroup(
  barrier: CreatedMessageBarrier,
  group: StreamGroupSnapshot,
  groups: StreamGroupSnapshot[]
): boolean {
  const beganAfterArrival = !barrier.preexistingGroupIds.has(group.streamGroupId)
  if (!barrier.identity) return beganAfterArrival

  const { executionId, streamGroupId } = barrier.identity
  const exactExists = groups.some(
    (candidate) => candidate.executionId === executionId && candidate.streamGroupId === streamGroupId
  )
  if (exactExists) {
    return group.executionId === executionId && group.streamGroupId === streamGroupId && beganAfterArrival
  }

  const partialConflict = groups.some(
    (candidate) => (candidate.executionId === executionId) !== (candidate.streamGroupId === streamGroupId)
  )
  return partialConflict && beganAfterArrival
}
