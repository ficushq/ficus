/**
 * Anchored popup geometry for `components/popover` (generalised from EntityReferencePreview's
 * clamp/flip, then ThemedPopup's). Pure so every viewport edge case is unit-testable without a
 * layout engine.
 */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export type PopupSide = 'below' | 'above'
export type PopupAlign = 'start' | 'end'

export interface PopupPlacement {
  left: number
  top: number
  width: number
  maxHeight: number
  side: PopupSide
}

export interface PlacementOptions {
  /** The side to open on when it fits (or has at least as much room as the other). Default `below`. */
  side?: PopupSide
  /** Which anchor edge the popup lines up with: `start` = left edges, `end` = right edges. Default `end`. */
  align?: PopupAlign
  /** Space between the anchor and the popup. Default 6. */
  gap?: number
  /** Inset from the aligned anchor edge, toward the anchor's centre. Default 0. */
  alignOffset?: number
  /** The tallest the popup may be before it scrolls. Default 360; `Infinity` leaves only the viewport limit. */
  maxHeight?: number
}

/** The minimum distance a popup keeps from every visual-viewport edge. */
export const POPUP_VIEWPORT_MARGIN = 8
const MARGIN = POPUP_VIEWPORT_MARGIN

/**
 * Prefers opening on `side` (below by default) with the popup's `align` edge on the anchor's.
 * Flips to the other side when the content does not fit and there is more room there, then
 * shifts both axes to keep an 8px margin inside the (visual) viewport. The width and scroll
 * height shrink to what the viewport can show.
 */
export function placePopup(
  anchor: Box,
  content: { width: number; height: number },
  viewport: Box,
  { side: preferred = 'below', align = 'end', gap = 6, alignOffset = 0, maxHeight: limit = 360 }: PlacementOptions = {}
): PopupPlacement {
  const width = Math.max(0, Math.min(content.width, viewport.right - viewport.left - 2 * MARGIN))
  const room = {
    below: viewport.bottom - anchor.bottom - gap - MARGIN,
    above: anchor.top - viewport.top - gap - MARGIN,
  }
  const other: PopupSide = preferred === 'below' ? 'above' : 'below'
  const wanted = Math.min(content.height, limit)
  const side = room[preferred] >= wanted || room[preferred] >= room[other] ? preferred : other
  const viewportHeight = viewport.bottom - viewport.top - 2 * MARGIN
  // With no usable room beside the anchor (e.g. it is panned out of the visual
  // viewport), overlap it rather than collapse; the clamp keeps it on-screen.
  const maxHeight = Math.max(0, Math.min(limit, viewportHeight, room[side] >= 48 ? room[side] : viewportHeight))
  const height = Math.min(content.height, maxHeight)
  const top = side === 'below' ? anchor.bottom + gap : anchor.top - gap - height
  const left = align === 'end' ? anchor.right - alignOffset - width : anchor.left + alignOffset
  return {
    side,
    width,
    maxHeight,
    top: clamp(top, viewport.top + MARGIN, viewport.bottom - MARGIN - height),
    left: clamp(left, viewport.left + MARGIN, viewport.right - MARGIN - width),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

/** The visible part of the layout viewport (the mobile keyboard and pinch-zoom shrink it). */
export function visualViewportBox(): Box {
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft ?? 0
  const top = viewport?.offsetTop ?? 0
  return {
    left,
    top,
    right: left + (viewport?.width ?? window.innerWidth),
    bottom: top + (viewport?.height ?? window.innerHeight),
  }
}

/** `a` ∩ `b`; an empty intersection collapses to a zero-size box inside `a`. */
export function intersectBoxes(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  return {
    left,
    top,
    right: Math.max(left, Math.min(a.right, b.right)),
    bottom: Math.max(top, Math.min(a.bottom, b.bottom)),
  }
}
