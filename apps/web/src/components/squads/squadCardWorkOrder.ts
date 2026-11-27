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

function activityTime(workStream: Pick<WorkStream, 'updatedAt'>): number {
  const time = new Date(workStream.updatedAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

/** Active streams only: the ones that need the viewer first, then the rest by most recent activity. */
export function orderSquadCardWork<T extends Pick<WorkStream, 'id' | 'status' | 'updatedAt'>>(
  workStreams: readonly T[],
  needsViewer: ReadonlySet<string>
): T[] {
  return workStreams
    .filter((workStream) => workStream.status === 'queued' || workStream.status === 'active')
    .sort((a, b) => {
      const needs = Number(needsViewer.has(b.id)) - Number(needsViewer.has(a.id))
      return needs || activityTime(b) - activityTime(a)
    })
}
