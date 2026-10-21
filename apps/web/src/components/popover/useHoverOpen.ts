import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStableRef } from '../../hooks/useStableRef'
import { focusInPopover, initialTarget } from './focus'
import { listItems } from './listNavigation'
import { MENU_ITEM_SELECTOR } from './Menu'
import type { PopoverState } from './usePopover'

/**
 * How long a mouse rests on a hover-open trigger before it opens, for every hover menu: a pointer just
 * passing over (on its way to the button beside it, say) never flashes the menu open.
 */
export const HOVER_OPEN_DELAY_MS = 80

export interface HoverOpenOptions {
  /** Off: the trigger only opens on click/keyboard, as without this hook. */
  enabled: boolean
  /** Resting on the trigger waits this long before opening. Default `HOVER_OPEN_DELAY_MS`; tests shorten it. */
  openDelay?: number
  /** Leaving the trigger and the popover waits this long before closing, so the pointer can cross the gap. Default 150ms. */
  closeDelay?: number
  /**
   * What gets focus when the popover opens by click/keyboard, or a hover-opened one is pinned. Default `first`;
   * `none` leaves focus alone (a surface that never moves focus on open, like the inbox popup).
   */
  initialFocus?: 'first' | 'selected' | 'none'
}

/**
 * The open state the hook drives: a `usePopover` result, or any surface with the same shape (the inbox
 * popup keeps its own). `id` is the popover element's id, `triggerRef` its trigger.
 */
export type HoverOpenTarget<T extends HTMLElement> = Pick<
  PopoverState<T>,
  'open' | 'setOpen' | 'toggle' | 'triggerRef' | 'id'
>

export interface HoverOpenState {
  /** Whether it is open because of the mouse, so leaving closes it. A click pins it (false again). */
  hoverOpened: boolean
  /**
   * Pins a hover-opened popover open without moving focus, as a click on the trigger does: for a press
   * inside a surface the user then works in (a search field, say). Does nothing otherwise.
   */
  pin: () => void
  /** Spread on the trigger. `onClick` toggles, or pins a hover-opened popover instead of closing it. */
  triggerProps: {
    onClick: () => void
    onPointerEnter: (event: ReactPointerEvent) => void
    onPointerLeave: (event: ReactPointerEvent) => void
  }
  /** Spread on the popover (`Menu`, `Popover`, …). */
  popoverProps: {
    initialFocus: 'first' | 'selected' | 'none'
    restoreFocus: boolean
    onPointerEnter: (event: ReactPointerEvent) => void
    onPointerLeave: (event: ReactPointerEvent) => void
  }
}

/**
 * Hover-to-open for a click popover (`usePopover`), for a mouse only: touch and pen keep tap-to-open.
 * Resting on the trigger for `openDelay` opens it without taking focus (not while a mouse button is held,
 * so dragging something across the trigger never opens it); leaving both the trigger and the popover closes it
 * after `closeDelay` (re-entering either cancels that), handing focus back to where it was before the
 * hover if the pointer had moved it onto a row. Opened by click or keyboard, it behaves exactly
 * as without this hook; clicking the trigger of a hover-opened popover pins it open (focusing its
 * `initialFocus` item, as a click-open would) rather than closing it.
 */
export function useHoverOpen<T extends HTMLElement>(
  popover: HoverOpenTarget<T>,
  { enabled, openDelay = HOVER_OPEN_DELAY_MS, closeDelay = 150, initialFocus = 'first' }: HoverOpenOptions
): HoverOpenState {
  const [byHover, setByHover] = useState(false)
  // Any close (leaving, Escape, an outside press, a choice) ends the hover mode, so a later keyboard open is not one.
  if (byHover && !popover.open) setByHover(false)
  const hoverOpened = byHover && popover.open
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusBefore = useRef<Element | null>(null)
  // The pending open reads these when it fires: a click or a key may have opened it, or the trigger been disabled, meanwhile.
  const latest = useStableRef({ open: popover.open, enabled })
  const cancelClose = () => clearTimeout(closeTimer.current)
  const cancelOpen = () => clearTimeout(openTimer.current)
  const pin = () => {
    cancelClose()
    setByHover(false)
  }
  useEffect(
    () => () => {
      clearTimeout(closeTimer.current)
      clearTimeout(openTimer.current)
    },
    []
  )

  const isMouse = (event: ReactPointerEvent) => enabled && event.pointerType === 'mouse'
  const enter = (event: ReactPointerEvent) => {
    if (isMouse(event)) cancelClose()
  }
  const leave = (event: ReactPointerEvent) => {
    if (!isMouse(event) || !hoverOpened) return
    cancelClose()
    closeTimer.current = setTimeout(() => {
      // A pointer over the rows focuses them; leaving returns focus to what had it before the hover (the
      // composer, say), not to the trigger, where the popover itself would put it.
      const doc = popover.triggerRef.current?.ownerDocument
      const active = doc?.activeElement
      if (active instanceof HTMLElement && doc?.getElementById(popover.id)?.contains(active)) {
        const before = focusBefore.current
        if (before instanceof HTMLElement && before.isConnected && before !== doc.body)
          before.focus({ preventScroll: true })
        else active.blur()
      }
      popover.setOpen(false)
    }, closeDelay)
  }

  return {
    hoverOpened,
    pin,
    triggerProps: {
      onClick: () => {
        cancelOpen()
        cancelClose()
        if (!hoverOpened) return popover.toggle()
        pin()
        if (initialFocus === 'none') return
        const surface = popover.triggerRef.current?.ownerDocument.getElementById(popover.id)
        // Menu items are out of the Tab order, so the first one is not a tabbable: fall back to it explicitly.
        if (surface) focusInPopover(initialTarget(surface, initialFocus) ?? listItems(surface, MENU_ITEM_SELECTOR)[0])
      },
      onPointerEnter: (event) => {
        enter(event)
        // A held button is a drag (a window header, a selection) passing over, not a hover.
        if (!isMouse(event) || popover.open || event.buttons !== 0) return
        cancelOpen()
        openTimer.current = setTimeout(() => {
          if (latest.current.open || !latest.current.enabled) return
          focusBefore.current = popover.triggerRef.current?.ownerDocument.activeElement ?? null
          setByHover(true)
          popover.setOpen(true)
        }, openDelay)
      },
      onPointerLeave: (event) => {
        cancelOpen()
        leave(event)
      },
    },
    popoverProps: {
      // Opening under a passing pointer never steals focus from what the user is doing (typing, say).
      initialFocus: hoverOpened ? 'none' : initialFocus,
      // Nor does Escape send it to the trigger; focus inside still returns there as the popover closes.
      restoreFocus: !hoverOpened,
      onPointerEnter: enter,
      onPointerLeave: leave,
    },
  }
}
