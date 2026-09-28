import type { ReactNode } from 'react'
import type { AssistantActivityUpdate } from '@ficus/shared'
import { ASSISTANT_TASK_STATUS_LABELS, formatAssistantUpdateTime } from '../lib/assistantActivityPresentation'
import { MarkdownContent } from './MarkdownContent'

/**
 * The body of one task update: task label, reported status, sender and time, then the subject and
 * message. Shared by the Updates section and the task updates under an Assistant summary; the
 * caller owns the wrapper (list item, read state, observers) and any trailing `action`.
 */
export function AssistantUpdateCard({
  update,
  taskLabel,
  action,
}: {
  update: Pick<
    AssistantActivityUpdate,
    'reportedStatus' | 'senderName' | 'createdAt' | 'subject' | 'content' | 'seenAt'
  >
  taskLabel?: string | null
  action?: ReactNode
}) {
  const status = update.reportedStatus ? ASSISTANT_TASK_STATUS_LABELS[update.reportedStatus] : undefined
  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted">
        {!update.seenAt && (
          <span aria-label="Unread" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        )}
        {taskLabel && <span className="truncate font-medium text-primary">{taskLabel}</span>}
        {status && <span className="shrink-0">{status}</span>}
        <span className="ml-auto shrink-0">
          {update.senderName} · {formatAssistantUpdateTime(update.createdAt)}
        </span>
        {action}
      </div>
      {update.subject && <p className="mt-1 font-medium">{update.subject}</p>}
      <MarkdownContent className="mt-1 text-sm">{update.content}</MarkdownContent>
    </>
  )
}
