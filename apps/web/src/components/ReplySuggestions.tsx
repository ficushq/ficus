import { useEffect, useRef } from 'react'

/** How long a touch must be held to edit a reply instead of sending it. */
export const REPLY_LONG_PRESS_MS = 500

type Schedule = (fire: () => void, ms: number) => () => void

const scheduleTimeout: Schedule = (fire, ms) => {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

/**
 * One-tap replies to the agent's latest question, just above the composer. A tap (or Enter/Space)
 * sends the reply as the user's message; Shift+click on desktop, or a long press on touch, puts it
 * in the composer to edit first. The replies are model-written suggestions shown as plain text.
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
    // scrolling row itself would clip the leftmost chips out of reach).
    <div role="group" aria-label="Suggested replies" className="overflow-x-auto pb-0.5">
      <div data-reply-suggestions-row className="ml-auto flex w-max items-center gap-2">
        {replies.map((reply) => (
          <button
            key={reply}
            type="button"
            title="Send this reply. Shift+click or long-press to edit it first."
            className="ficus-button ficus-button-secondary flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1.5 text-xs select-none hover:bg-selection hover:text-accent-light [-webkit-touch-callout:none]"
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
