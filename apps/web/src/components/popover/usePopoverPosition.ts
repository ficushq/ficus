import { useLayoutEffect, useState, type RefObject } from 'react'
import { useStableRef } from '../../hooks/useStableRef'
import {
  intersectBoxes,
  placePopup,
  visualViewportBox,
  POPUP_VIEWPORT_MARGIN,
  type Box,
  type PlacementOptions,
  type PopupPlacement,
} from '../../lib/popupPosition'

export type PopoverWidth = number | 'anchor' | 'content'

export interface PopoverPositionOptions extends Omit<PlacementOptions, 'maxHeight'> {
  open: boolean
  anchor: RefObject<HTMLElement | null>
  popup: RefObject<HTMLElement | null>
  /** A fixed width, the anchor's width, or the surface's own CSS width (default). */
  width?: PopoverWidth
  /** The tallest the popup may be before it scrolls, or a function of the visual viewport. */
  maxHeight?: number | ((viewport: Box) => number)
  /** A region the popup must also stay inside (e.g. the page area above a phone's dock). */
  boundary?: RefObject<HTMLElement | null>
  /** The anchor stopped rendering (a breakpoint hid it), or, with `offscreen`, left the viewport. */
  onAnchorLost: () => void
  /** Also lose the anchor when it scrolls fully out of the visual viewport. */
  loseOffscreenAnchor?: boolean
}

export interface PopoverPlacement extends PopupPlacement {
  /** The widest the popup may grow: the usable viewport width. */
  maxWidth: number
  /** Bumped per opening, so the first placement of every opening is a new object. */
  opening: number
}

const same = (a: Omit<PopoverPlacement, 'opening'>, b: Omit<PopoverPlacement, 'opening'>) =>
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.maxWidth === b.maxWidth &&
  a.maxHeight === b.maxHeight &&
  a.side === b.side

let openings = 0

/**
 * Keeps an open popup placed against its anchor: on open, on any ancestor scroll, window and
 * visual-viewport resize or pan (the mobile keyboard), anchor or content size changes, and — once
 * per frame while open — any layout shift that moved the anchor without an event. Unchanged
 * placements are skipped so scrolling does not re-render the popup. The placement survives closing
 * so an exit animation stays where it was.
 */
export function usePopoverPosition({
  open,
  anchor,
  popup,
  width = 'content',
  maxHeight = Infinity,
  boundary,
  onAnchorLost,
  loseOffscreenAnchor = false,
  side,
  align,
  gap,
  alignOffset,
}: PopoverPositionOptions): PopoverPlacement | undefined {
  const [placement, setPlacement] = useState<PopoverPlacement>()
  const latest = useStableRef({
    width,
    maxHeight,
    boundary,
    onAnchorLost,
    loseOffscreenAnchor,
    side,
    align,
    gap,
    alignOffset,
  })

  useLayoutEffect(() => {
    if (!open) return
    const opening = ++openings
    const update = () => {
      const surface = popup.current
      if (!surface) return
      const options = latest.current
      const anchorElement = anchor.current
      const viewport = visualViewportBox()
      let anchorBox: Box
      if (anchorElement) {
        // Responsive anchors can disappear while their portal is still mounted.
        if (!anchorElement.getClientRects().length) return options.onAnchorLost()
        anchorBox = anchorElement.getBoundingClientRect()
        const offscreen =
          anchorBox.bottom < viewport.top ||
          anchorBox.top > viewport.bottom ||
          anchorBox.right < viewport.left ||
          anchorBox.left > viewport.right
        if (options.loseOffscreenAnchor && offscreen) return options.onAnchorLost()
      } else {
        // No anchor (its trigger is hidden): hang from the top-right corner of the viewport.
        anchorBox = { left: viewport.right, right: viewport.right, top: viewport.top, bottom: viewport.top }
      }
      const area = options.boundary?.current
        ? intersectBoxes(viewport, options.boundary.current.getBoundingClientRect())
        : viewport
      const contentWidth =
        typeof options.width === 'number'
          ? options.width
          : options.width === 'anchor'
            ? anchorBox.right - anchorBox.left
            : surface.offsetWidth
      const placed = placePopup(
        anchorBox,
        // Border-box height of the whole content, even while it is clipped to maxHeight.
        { width: contentWidth, height: surface.scrollHeight + surface.offsetHeight - surface.clientHeight },
        area,
        {
          side: options.side,
          align: options.align,
          gap: options.gap,
          alignOffset: options.alignOffset,
          maxHeight: typeof options.maxHeight === 'function' ? options.maxHeight(viewport) : options.maxHeight,
        }
      )
      const next = { ...placed, maxWidth: Math.max(0, area.right - area.left - 2 * POPUP_VIEWPORT_MARGIN) }
      setPlacement((current) =>
        current && current.opening === opening && same(current, next) ? current : { ...next, opening }
      )
    }
    update()
    const viewport = window.visualViewport
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    if (anchor.current) observer?.observe(anchor.current)
    if (popup.current) observer?.observe(popup.current)
    if (latest.current.boundary?.current) observer?.observe(latest.current.boundary.current)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    // Layout shifts move the anchor without any event. While open, compare one
    // rect per frame and reposition only when it actually changed.
    let frame = 0
    let last = ''
    const watch = () => {
      const rect = anchor.current?.getBoundingClientRect()
      const key = rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : ''
      if (key !== last) {
        if (last) update()
        last = key
      }
      frame = window.requestAnimationFrame(watch)
    }
    frame = window.requestAnimationFrame(watch)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
    }
  }, [open, anchor, popup, latest])

  return placement
}
