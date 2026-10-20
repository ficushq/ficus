import { useId, useState } from 'react'
import clsx from 'clsx'
import type { AssistantActivityUpdate } from '@ficus/shared'
import {
  ASSISTANT_TASK_STATUS_LABELS,
  formatAssistantUpdateTime,
  updatePreviewLine,
} from '../lib/assistantActivityPresentation'
import { AssistantUpdateCard } from './AssistantUpdateCard'

type ChipUpdate = Pick<
  AssistantActivityUpdate,
  'messageId' | 'reportedStatus' | 'senderName' | 'createdAt' | 'subject' | 'content' | 'seenAt'
>

/**
 * A task update as a muted row (task, status, time, an unread dot while unseen) that
 * expands in place to the full report. Several updates coalesce: the line shows the latest and
 * expanding lists each one. `preview` adds a truncated one-line excerpt of the latest report
 * beneath it, for updates no Assistant reply summarizes.
 */
export function AssistantUpdateChip({
  updates,
  taskLabel,
  preview = false,
}: {
  /** Oldest first; the line describes the last one. */
  updates: ChipUpdate[]
  taskLabel?: string | null
  preview?: boolean
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const latest = updates[updates.length - 1]
  if (!latest) return null
  const status = latest.reportedStatus ? ASSISTANT_TASK_STATUS_LABELS[latest.reportedStatus] : undefined
  const unread = updates.some((update) => !update.seenAt)
  const label = taskLabel || latest.senderName
  return (
    <div className="min-w-0" data-assistant-update-chip>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          'ficus-button ficus-button-ghost flex w-full min-w-0 items-start gap-2 rounded-md px-3 py-2 text-left text-xs font-normal text-muted',
          'hover:text-primary'
        )}
      >
        <svg
          aria-hidden="true"
          className="mt-0.5 h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 10l5 5-5 5M4 4v7a4 4 0 004 4h12" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              {unread && (
                <span aria-label="Unread" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-badge" />
              )}
              <span className="min-w-0 truncate font-medium text-secondary" title={label}>
                {label}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {status && <span>{status}</span>}
              <span className="whitespace-nowrap">
                {status && '· '}
                {formatAssistantUpdateTime(latest.createdAt)}
              </span>
              {updates.length > 1 && <span className="whitespace-nowrap">· {updates.length} updates</span>}
            </span>
          </span>
          {/* Share the icon gutter with the header even when its metadata wraps. */}
          {preview && <span className="mt-1 block truncate">{updatePreviewLine(latest)}</span>}
        </span>
      </button>
      {open && (
        <ul id={panelId} className="mt-1 space-y-1">
          {updates.map((update) => (
            <li
              key={update.messageId}
              className="rounded-xl bg-surface-secondary px-3 py-2 text-sm [overflow-wrap:anywhere]"
            >
              <AssistantUpdateCard update={update} fullBody />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
