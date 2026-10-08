import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react'
import type { PopoverDismissReason } from './Popover'

export interface HoverCardOptions {
  /** Pointer hover on the anchor waits this long before opening. Default 250ms. */
  openDelay?: number
  /** Leaving the anchor and the card waits this long before closing, so the pointer can cross the gap. Default 150ms. */
  closeDelay?: number
  /** Open on keyboard focus (`:focus-visible`) only, never on the focus a click gives. Default true. */
  focusVisibleOnly?: boolean
}

export interface HoverCardState {
  open: boolean
  /** Open now, or after `delay` ms. */
  show: (delay?: number) => void
  /** Close now. */
  hide: () => void
  /** Cancel a pending open or close. */
  cancel: () => void
  /** Focus the anchor without that focus reopening the card (returning focus from a closed card). */
  focusAnchor: (anchor: HTMLElement | null | undefined) => void
  /** Spread on the anchor. */
  anchorHandlers: {
    onMouseEnter: () => void
    onMouseLeave: () => void
    onFocus: (event: ReactFocusEvent<HTMLElement>) => void
    onBlur: () => void
  }
  /** `HoverCard` wires these to the card. */
  cardHandlers: { onMouseEnter: () => void; onMouseLeave: () => void; onFocusCapture: () => void }
  /** `HoverCard`'s dismissal: Escape closes; a press or focus moving away only releases the focus hold. */
  onCardDismiss: (reason: PopoverDismissReason) => void
}

/**
 * Hover/focus intent for a `HoverCard`: hovering the anchor opens it after `openDelay`; keyboard focus
 * opens it at once; leaving both the anchor and the card (pointer and focus) closes it after
 * `closeDelay`, so moving the pointer from the anchor into the card keeps it open.
 */
export function useHoverCard({
  openDelay = 250,
  closeDelay = 150,
  focusVisibleOnly = true,
}: HoverCardOptions = {}): HoverCardState {
  const [open, setOpen] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hovered = useRef(false)
  const focused = useRef(false)
  const returning = useRef(false)
  const cancel = useCallback(() => {
    clearTimeout(showTimer.current)
    clearTimeout(hideTimer.current)
  }, [])
  useEffect(() => cancel, [cancel])
  // Stable handlers (only `open` changes), so callers can list them as effect dependencies.
  const actions = useMemo((): Omit<HoverCardState, 'open'> => {
    const show = (delay = 0) => {
      cancel()
      if (delay) showTimer.current = setTimeout(() => setOpen(true), delay)
      else setOpen(true)
    }
    const hide = () => {
      cancel()
      setOpen(false)
    }
    // Pointer and focus each hold the card open; with neither, it goes after the close delay.
    const release = () => {
      cancel()
      if (!focused.current && !hovered.current) hideTimer.current = setTimeout(() => setOpen(false), closeDelay)
    }
    return {
      show,
      hide,
      cancel,
      focusAnchor: (anchor) => {
        returning.current = true
        try {
          anchor?.focus({ preventScroll: true })
        } finally {
          returning.current = false
        }
      },
      anchorHandlers: {
        onMouseEnter: () => {
          hovered.current = true
          show(openDelay)
        },
        onMouseLeave: () => {
          hovered.current = false
          release()
        },
        onFocus: (event) => {
          focused.current = true
          if (returning.current) return
          if (!focusVisibleOnly || event.currentTarget.matches(':focus-visible')) show()
          else cancel()
        },
        onBlur: () => {
          focused.current = false
          release()
        },
      },
      cardHandlers: {
        onMouseEnter: () => {
          hovered.current = true
          cancel()
        },
        onMouseLeave: () => {
          hovered.current = false
          release()
        },
        onFocusCapture: () => {
          focused.current = true
          cancel()
        },
      },
      onCardDismiss: (reason) => {
        if (reason === 'escape' || reason === 'anchor') return hide()
        focused.current = false
        release()
      },
    }
  }, [cancel, openDelay, closeDelay, focusVisibleOnly])
  return useMemo(() => ({ open, ...actions }), [open, actions])
}
