import { useHref } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import type { WorkStream } from '@ficus/shared'
import { getWorkStreamLink } from '../lib/inboxWorkStreamLink'
import { AttentionMenu } from './AttentionMenu'
import { Panel, usePopover } from './popover'
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
  const popover = usePopover({ kind: 'disclosure' })
  const { close, triggerRef: trigger } = popover
  const [feedback, setFeedback] = useState('')
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !controls.editing) trigger.current?.focus()
    wasEditing.current = controls.editing
  }, [controls.editing, trigger])
  const itemClass = 'ficus-button w-full rounded-md px-3 py-2 text-left text-sm text-secondary hover:bg-surface-hover'
  const copyLink = async () => {
    close({ returnFocus: true })
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href)
      setFeedback('Link copied')
    } catch {
      setFeedback('Could not copy link. Try again.')
    }
  }
  return (
    <div className="relative">
      <button
        {...popover.triggerProps}
        type="button"
        aria-label="More actions"
        className="ficus-button rounded-md px-3 py-1 text-secondary hover:bg-surface-hover"
        onClick={() => {
          popover.toggle()
          setFeedback('')
        }}
      >
        ⋯
      </button>
      <Panel
        {...popover.popoverProps}
        role="group"
        label="More actions"
        initialFocus="none"
        gap={4}
        className="ficus-overlay w-72 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
      >
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
              close({ returnFocus: true })
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
      </Panel>
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
