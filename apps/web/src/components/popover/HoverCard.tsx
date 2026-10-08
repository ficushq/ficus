import { useLayoutEffect, useRef } from 'react'
import { Popover, type PopoverProps } from './Popover'
import type { HoverCardState } from './useHoverCard'

export interface HoverCardProps extends Omit<PopoverProps, 'open' | 'onDismiss' | 'trigger' | 'role'> {
  hover: HoverCardState
  /** Narrow when it shows (e.g. not while the reference's own dialog is open). Default `hover.open`. */
  open?: boolean
  /** The element it describes; hovering or focusing it is what opened the card. */
  anchor: NonNullable<PopoverProps['anchor']>
  /** The card's accessible name. */
  label: string
}

/**
 * A preview card for a link or reference (role=dialog, non-modal), driven by `useHoverCard`. Placed below
 * the anchor's start edge (flipping above), it never takes focus on open; Tab on the anchor enters it,
 * Tab past its last link continues after the anchor, and Escape closes it, returning focus to the anchor
 * only when focus was inside. It closes when the anchor scrolls out of view.
 */
export function HoverCard({ hover, anchor, label, open = hover.open, ...props }: HoverCardProps) {
  const card = useRef<HTMLDivElement>(null)
  // Closing with focus inside (Escape, a quick link) hands focus back to the anchor without reopening it.
  useLayoutEffect(() => {
    if (!open && card.current?.contains(document.activeElement)) hover.focusAnchor(anchor.current)
  }, [open, hover, anchor])
  return (
    <Popover
      ref={card}
      align="start"
      gap={8}
      {...props}
      open={open}
      onDismiss={hover.onCardDismiss}
      trigger={anchor}
      role="dialog"
      aria-label={label}
      initialFocus="none"
      restoreFocus={false}
      returnFocus={false}
      loseOffscreenAnchor
      onMouseEnter={hover.cardHandlers.onMouseEnter}
      onMouseLeave={hover.cardHandlers.onMouseLeave}
      onFocusCapture={hover.cardHandlers.onFocusCapture}
    />
  )
}
