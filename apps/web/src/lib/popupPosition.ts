/**
 * Anchored popup geometry, generalised from EntityReferencePreview's clamp/flip.
 * Pure so every viewport edge case is unit-testable without a layout engine.
 */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PopupPlacement {
  left: number
  top: number
  width: number
  maxHeight: number
  side: 'below' | 'above'
}

const MARGIN = 8
const GAP = 6

/**
 * Prefers opening below with the popup's right edge on the anchor's right edge.
 * Flips above when the content does not fit below and more room is above, then
 * shifts both axes to keep an 8px margin inside the (visual) viewport. The
 * width and scroll height shrink to what the viewport can show.
 */
export function placePopup(
  anchor: Box,
  content: { width: number; height: number },
  viewport: Box,
  maxHeightLimit = 360
): PopupPlacement {
  const width = Math.max(0, Math.min(content.width, viewport.right - viewport.left - 2 * MARGIN))
  const below = viewport.bottom - anchor.bottom - GAP - MARGIN
  const above = anchor.top - viewport.top - GAP - MARGIN
  const wanted = Math.min(content.height, maxHeightLimit)
  const side = below >= wanted || below >= above ? 'below' : 'above'
  const viewportHeight = viewport.bottom - viewport.top - 2 * MARGIN
  const room = side === 'below' ? below : above
  // With no usable room beside the anchor (e.g. it is panned out of the visual
  // viewport), overlap it rather than collapse; the clamp keeps it on-screen.
  const maxHeight = Math.max(0, Math.min(maxHeightLimit, viewportHeight, room >= 48 ? room : viewportHeight))
  const height = Math.min(content.height, maxHeight)
  const top = side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - height
  return {
    side,
    width,
    maxHeight,
    top: clamp(top, viewport.top + MARGIN, viewport.bottom - MARGIN - height),
    left: clamp(anchor.right - width, viewport.left + MARGIN, viewport.right - MARGIN - width),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

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
