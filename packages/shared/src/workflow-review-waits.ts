import type { WorkStreamWaitType } from './types'

export interface WorkflowReviewWaitFacts {
  id?: string
  type: WorkStreamWaitType
  workStreamId?: string
  flowAttemptId?: number | null
  resolutionHandler?: 'workflow'
  /** Authoritative exact-reference projection. Omitted only by legacy servers. */
  workflowHumanGate?: boolean
}
export function isWorkflowHumanGateWait(wait: WorkflowReviewWaitFacts): boolean {
  return (
    wait.workflowHumanGate ??
    (wait.type === 'manual' && wait.resolutionHandler === 'workflow' && wait.flowAttemptId != null)
  )
}
/** Exempt only the gate itself, never all workflow-owned waits. Mirrors backend wait scope. */
export function workflowReviewBlockingWaits<T extends WorkflowReviewWaitFacts>(
  gate: WorkflowReviewWaitFacts,
  waits: readonly T[]
): T[] {
  return waits.filter(
    (wait) =>
      wait !== gate &&
      !(gate.id && wait.id === gate.id) &&
      (!gate.workStreamId || !wait.workStreamId || gate.workStreamId === wait.workStreamId) &&
      (wait.flowAttemptId == null || wait.flowAttemptId === gate.flowAttemptId)
  )
}
export function workStreamQueuedReviewLabel(stream: {
  status: string
  pause?: unknown
  derivedState?: string
  openWaits?: readonly WorkflowReviewWaitFacts[]
}): string | null {
  if (stream.pause || stream.derivedState === 'paused' || stream.status === 'done' || stream.status === 'canceled')
    return null
  const waits = stream.openWaits ?? []
  return waits.some((wait) => isWorkflowHumanGateWait(wait) && workflowReviewBlockingWaits(wait, waits).length)
    ? 'Review queued'
    : null
}
