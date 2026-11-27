import type {
  AgentQuestionActionData,
  PendingAction,
  WorkStream,
  WorkStreamActionData,
  WorkStreamDeliveryActionData,
} from '@ficus/shared'

/** A squad card lists at most this many streams before "+N more". */
export const SQUAD_CARD_WORK_LIMIT = 4

/**
 * The streams the viewer's Needs you list points at: review, blocker and delivery
 * actions name their stream, and a blocking agent question is matched through the
 * stream's open question wait, whose reference is the question's id.
 */
export function workStreamIdsNeedingViewer(
  actions: readonly PendingAction[],
  workStreams: readonly Pick<WorkStream, 'id' | 'openWaits'>[]
): Set<string> {
  const ids = new Set<string>()
  const questionIds = new Set<string>()
  for (const action of actions) {
    if (action.type === 'workstream-review' || action.type === 'workstream-blocked') {
      ids.add((action.data as WorkStreamActionData).workStreamId)
    } else if (action.type === 'workstream-delivery') {
      ids.add((action.data as WorkStreamDeliveryActionData).workStreamId)
    } else if (action.type === 'agent-question') {
      questionIds.add((action.data as AgentQuestionActionData).questionId)
    }
  }
  if (questionIds.size > 0) {
    for (const workStream of workStreams) {
      const asks = workStream.openWaits?.some(
        (wait) => wait.type === 'question' && wait.referenceId && questionIds.has(wait.referenceId)
      )
      if (asks) ids.add(workStream.id)
    }
  }
  return ids
}

type ActivityFields = Pick<WorkStream, 'createdAt' | 'updatedAt' | 'runtime'>

function time(value: Date | string | null | undefined): number {
  if (value == null) return 0
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * When the stream's work last moved: the newest work by one of its executions, or
 * its creation when that is later or nothing has run yet. Edits to the stream's own
 * fields bump `updatedAt` but are not activity, so it is the fallback only for a
 * server that does not report `runtime.lastWorkedAt`.
 */
export function lastActivityTime(workStream: ActivityFields): number {
  const lastWorkedAt = workStream.runtime?.lastWorkedAt
  if (lastWorkedAt === undefined) return time(workStream.updatedAt)
  return Math.max(time(lastWorkedAt), time(workStream.createdAt))
}

/**
 * Active streams only: the ones that need the viewer first, then the rest by most
 * recent activity. Streams working right now share one activity time, so newer
 * streams lead among them and the id settles the rest, keeping the order stable
 * across refetches.
 */
export function orderSquadCardWork<T extends Pick<WorkStream, 'id' | 'status'> & ActivityFields>(
  workStreams: readonly T[],
  needsViewer: ReadonlySet<string>
): T[] {
  return workStreams
    .filter((workStream) => workStream.status === 'queued' || workStream.status === 'active')
    .sort((a, b) => {
      const needs = Number(needsViewer.has(b.id)) - Number(needsViewer.has(a.id))
      return (
        needs ||
        lastActivityTime(b) - lastActivityTime(a) ||
        time(b.createdAt) - time(a.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      )
    })
}
