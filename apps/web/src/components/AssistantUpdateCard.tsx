import type { ReactNode } from 'react'
import type { AssistantActivityUpdate } from '@ficus/shared'
import { ASSISTANT_TASK_STATUS_LABELS, formatAssistantUpdateTime } from '../lib/assistantActivityPresentation'
import { CollapsibleMarkdown } from './CollapsibleMarkdown'
import { MarkdownContent } from './MarkdownContent'

/**
 * The body of one task update: task label, reported status, sender and time, then the subject and
 * message (long reports collapse to a few lines behind Show more unless `fullBody`). Shown when a
 * compact update chip is expanded (AssistantUpdateChip); the caller owns the wrapper and any
 * trailing `action`.
 */
export function AssistantUpdateCard({
  update,
  taskLabel,
  action,
  fullBody = false,
}: {
  update: Pick<
    AssistantActivityUpdate,
    'reportedStatus' | 'senderName' | 'createdAt' | 'subject' | 'content' | 'seenAt'
  >
  taskLabel?: string | null
  action?: ReactNode
  /** Render the whole report: the reader already asked to see it. */
  fullBody?: boolean
}) {
  const status = update.reportedStatus ? ASSISTANT_TASK_STATUS_LABELS[update.reportedStatus] : undefined
  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted">
        {!update.seenAt && (
          <span aria-label="Unread" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-badge" />
        )}
        {taskLabel && <span className="truncate font-medium text-primary">{taskLabel}</span>}
        {status && <span className="shrink-0">{status}</span>}
        <span className="ml-auto shrink-0">
          {update.senderName} · {formatAssistantUpdateTime(update.createdAt)}
        </span>
        {action}
      </div>
      {update.subject && <p className="mt-1 font-medium">{update.subject}</p>}
      {fullBody ? (
        <div className="mt-1">
          <MarkdownContent className="text-sm">{update.content}</MarkdownContent>
        </div>
      ) : (
        <CollapsibleMarkdown className="mt-1" markdownClassName="text-sm">
          {update.content}
        </CollapsibleMarkdown>
      )}
    </>
  )
}
