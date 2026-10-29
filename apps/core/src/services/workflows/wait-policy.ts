import { workflowFingerprint } from './catalog'
import type { WorkStreamWaitRow } from '../work-streams/waits'

export function flowWaitReference(id: string, kind: 'human' | 'limit' | 'delivery', version: number) {
  const hash = workflowFingerprint({ id, kind, version })
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** Final delivery review can be sent back; questions and intermediate gates cannot. */
export function isDeliveryApprovalWait(id: string, wait: WorkStreamWaitRow): boolean {
  return (
    wait.flowAttemptId == null &&
    ((wait.type === 'review' && wait.completesOnApproval) ||
      (wait.resolutionHandler === 'workflow' && wait.referenceId === flowWaitReference(id, 'delivery', 0)))
  )
}

/** Canonical identity, not merely another workflow-owned wait on this attempt. */
export function isHumanFlowWait(
  wait: Pick<WorkStreamWaitRow, 'workStreamId' | 'flowAttemptId' | 'resolutionHandler' | 'referenceId'>
): boolean {
  return (
    wait.flowAttemptId != null &&
    wait.resolutionHandler === 'workflow' &&
    wait.referenceId === flowWaitReference(wait.workStreamId, 'human', wait.flowAttemptId)
  )
}
