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
 * A task update as one muted line (`↳ task · status · time`, an unread dot while unseen) that
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
          'ficus-button ficus-button-ghost block w-full min-w-0 rounded-md px-1 py-0.5 text-left text-xs font-normal text-muted',
          'hover:text-primary'
        )}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className="shrink-0">
            ↳
          </span>
          {unread && <span aria-label="Unread" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
          <span className="min-w-0 truncate font-medium text-secondary">{label}</span>
          {status && <span className="shrink-0">· {status}</span>}
          <span className="shrink-0">· {formatAssistantUpdateTime(latest.createdAt)}</span>
          {updates.length > 1 && <span className="shrink-0">· {updates.length} updates</span>}
        </span>
        {/* Its own line, so a narrow panel still shows some of it. */}
        {preview && <span className="block truncate pl-3.5">{updatePreviewLine(latest)}</span>}
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
