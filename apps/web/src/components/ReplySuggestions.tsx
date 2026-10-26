import { useEffect, useRef } from 'react'

/** How long a touch must be held to edit a reply instead of sending it. */
export const REPLY_LONG_PRESS_MS = 500

type Schedule = (fire: () => void, ms: number) => () => void

const scheduleTimeout: Schedule = (fire, ms) => {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

/**
 * One-tap replies to the agent's latest question, floating over the end of the transcript just above
 * the composer: each chip is its own raised pill, and the messages stay visible (and clickable)
 * around them. A tap (or Enter/Space) sends the reply as the user's message; Shift+click on desktop,
 * or a long press on touch, puts it in the composer to edit first. The replies are model-written
 * suggestions shown as plain text.
 */
export function ReplySuggestions({
  replies,
  onSend,
  onEdit,
  longPressMs = REPLY_LONG_PRESS_MS,
  schedule = scheduleTimeout,
}: {
  replies: readonly string[]
  onSend: (reply: string) => void
  onEdit: (reply: string) => void
  longPressMs?: number
  /** Test seam for the long-press timer. */
  schedule?: Schedule
}) {
  // A pending long press, and whether one just put a reply in the composer.
  const press = useRef<{ cancel: (() => void) | null; handled: boolean }>({ cancel: null, handled: false })
  const cancelPress = () => {
    press.current.cancel?.()
    press.current.cancel = null
  }
  useEffect(() => cancelPress, [])

  if (replies.length === 0) return null
  return (
    // Right-aligned, yet every chip stays reachable: the scroll container holds a max-content row
    // pushed right by ml-auto. When the row is wider than the composer the auto margin collapses
    // to zero, so it overflows to the right and scrolls from its first chip (justify-end on the
    // scrolling row itself would clip the leftmost chips out of reach). Only the chips row takes
    // pointer events: the empty space beside it belongs to the messages it floats over (ChatView's
    // floating slot passes clicks through too). The padding keeps the chips' shadows unclipped, and
    // -mx-1 keeps the last chip flush with the messages' right edge. The negative bottom margin lets
    // the chips overhang ChatView's transcript padding (p-3 md:p-4) plus that shadow padding, so they
    // sit 8px above the composer as they did in the old strip, both at the bottom and pinned while
    // scrolled up (the floating slot is a flow-root).
    <div
      role="group"
      aria-label="Suggested replies"
      className="pointer-events-none -mx-1 -mb-2.5 overflow-x-auto px-1 pb-1.5 pt-0.5 md:-mb-3.5"
    >
      <div data-reply-suggestions-row className="pointer-events-auto ml-auto flex w-max items-center gap-2">
        {replies.map((reply) => (
          <button
            key={reply}
            type="button"
            title="Send this reply. Shift+click or long-press to edit it first."
            // Raised like the pending-question pill: an opaque surface, a border and a shadow keep each chip
            // readable over the messages scrolling underneath, in both themes.
            className="ficus-button ficus-button-secondary flex shrink-0 items-center whitespace-nowrap rounded-full border border-th-border bg-surface px-3 py-1.5 text-xs shadow-md select-none hover:bg-selection hover:text-accent-light [-webkit-touch-callout:none]"
            onPointerDown={(event) => {
              press.current.handled = false
              cancelPress()
              if (event.pointerType === 'mouse') return
              press.current.cancel = schedule(() => {
                press.current.cancel = null
                press.current.handled = true
                onEdit(reply)
              }, longPressMs)
            }}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            // A held touch opens the context menu on some browsers; the long press owns that gesture.
            onContextMenu={(event) => {
              if (press.current.cancel || press.current.handled) event.preventDefault()
            }}
            onClick={(event) => {
              cancelPress()
              if (press.current.handled) {
                // The click that ends a long press: the reply is already in the composer.
                press.current.handled = false
                return
              }
              if (event.shiftKey) onEdit(reply)
              else onSend(reply)
            }}
          >
            {reply}
          </button>
        ))}
      </div>
    </div>
  )
}
