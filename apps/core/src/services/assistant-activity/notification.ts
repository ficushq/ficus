import type { AssistantTaskStatus } from '@ficus/shared'

/** Facts frozen while the update was projected; a later status change must not alter the decision. */
export interface AssistantNotificationDecision {
  isCurrentRequest: boolean
  changedStatus: boolean
  reportedStatus: AssistantTaskStatus | null
}

/**
 * Only actionable, status-changing reports on the current request push. Routine progress and
 * waiting updates still refresh badges; stale reports against an older request and duplicate
 * terminal reports never push.
 */
export function shouldPushAssistantUpdate(update: AssistantNotificationDecision): boolean {
  return (
    update.isCurrentRequest &&
    update.changedStatus &&
    (update.reportedStatus === 'needs-input' ||
      update.reportedStatus === 'completed' ||
      update.reportedStatus === 'failed')
  )
}
