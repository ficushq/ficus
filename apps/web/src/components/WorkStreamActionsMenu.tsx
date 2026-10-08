import { useHref } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkStream } from '@ficus/shared'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { getWorkStreamLink } from '../lib/inboxWorkStreamLink'
import { AttentionMenu } from './AttentionMenu'
import type { useWorkStreamPauseControls } from './WorkStreamPauseControls'

/** A disclosure of secondary actions; native buttons remain reachable with Tab. */
export function WorkStreamActionsMenu({
  stream,
  controls,
}: {
  stream: WorkStream
  controls: ReturnType<typeof useWorkStreamPauseControls>
}) {
  const href = useHref(
    getWorkStreamLink({ squadId: stream.squadId, workStreamId: stream.id, workStreamNumber: stream.number })!
  )
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !controls.editing) trigger.current?.focus()
    wasEditing.current = controls.editing
  }, [controls.editing])
  const close = useCallback(() => setOpen(false), [])
  usePopupDismiss({ open, popup: container, trigger, onDismiss: close })
  const itemClass = 'ficus-button w-full rounded-md px-3 py-2 text-left text-sm text-secondary hover:bg-surface-hover'
  const copyLink = async () => {
    close()
    trigger.current?.focus()
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href)
      setFeedback('Link copied')
    } catch {
      setFeedback('Could not copy link. Try again.')
    }
  }
  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="More actions"
        aria-expanded={open}
        className="ficus-button rounded-md px-3 py-1 text-secondary hover:bg-surface-hover"
        onClick={() => {
          setOpen(!open)
          setFeedback('')
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="ficus-overlay absolute right-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg">
          {controls.canPause && (
            <button
              type="button"
              className={itemClass}
              disabled={controls.action.isPending}
              onClick={() => {
                close()
                controls.openPause()
              }}
            >
              Pause work…
            </button>
          )}
          {controls.canPark && (
            <button
              type="button"
              className={itemClass}
              disabled={controls.action.isPending}
              onClick={() => {
                close()
                trigger.current?.focus()
                controls.park()
              }}
            >
              Park while paused
            </button>
          )}
          <AttentionMenu target={{ kind: 'workStream', id: stream.id }} inline />
          <button type="button" className={itemClass} onClick={copyLink}>
            Copy link
          </button>
        </div>
      )}
      {feedback && (
        <span
          role="status"
          className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded border border-th-border bg-surface p-2 text-xs"
        >
          {feedback}
        </span>
      )}
    </div>
  )
}
