/*
 * Geometry shared by every floating window (the assistant and agent chat windows): free rectangles,
 * snapping to parts of the screen, resizing from any edge, and the drag-to-snap targets. Coordinates
 * are relative to the visual viewport, so an on-screen keyboard shrinks and lifts a window instead of
 * covering it. A viewport may reserve a band at its top (Ficus Desktop's title bar, where macOS draws the
 * window buttons above the page): windows treat the bottom of that band as the top of the screen, so
 * clamping, resizing, every snap and the drag targets all keep out of it. Pure functions only; the hooks
 * and components draw and drive them.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface ViewportSize {
  width: number
  height: number
  /**
   * A band (px) at the top that windows keep out of: Ficus Desktop's title bar, where the native window
   * buttons draw over the page (lib/desktopTitleBar). 0 or absent everywhere else.
   */
  reservedTop?: number
}

/** Space kept between a window and the screen edge. */
export const WINDOW_MARGIN = 8
/** Space between snapped regions, as between neighbouring farm windows. */
const SNAP_GAP = 8

/** The reserved band at the top of the screen, if any. */
function reserved(viewport: ViewportSize) {
  return Math.max(0, viewport.reservedTop ?? 0)
}

/** The highest a window's top edge may be: below the reserved band, and a margin from it. */
export function windowTop(viewport: ViewportSize): number {
  return reserved(viewport) + WINDOW_MARGIN
}

/** The tallest a window may be: the screen below the reserved band, less a margin at each end. */
function usableHeight(viewport: ViewportSize) {
  return Math.max(0, viewport.height - reserved(viewport) - WINDOW_MARGIN * 2)
}

/** Keeps a window on screen and at least its minimum size (shrinking below it only on a small screen). */
export function clampRect(rect: Rect, viewport: ViewportSize, min: Size): Rect {
  const maxW = Math.max(0, viewport.width - WINDOW_MARGIN * 2)
  const maxH = usableHeight(viewport)
  const w = Math.min(maxW, Math.max(min.w, rect.w))
  const h = Math.min(maxH, Math.max(min.h, rect.h))
  return { ...clampPosition({ x: rect.x, y: rect.y, w, h }, viewport), w: Math.round(w), h: Math.round(h) }
}

/** Keeps something of a fixed size (the live-voice command bar) on screen, moving but never resizing it. */
export function clampPosition(rect: Rect, viewport: ViewportSize): Rect {
  const top = windowTop(viewport)
  return {
    ...rect,
    x: Math.round(
      Math.min(Math.max(WINDOW_MARGIN, rect.x), Math.max(WINDOW_MARGIN, viewport.width - rect.w - WINDOW_MARGIN))
    ),
    y: Math.round(Math.min(Math.max(top, rect.y), Math.max(top, viewport.height - rect.h - WINDOW_MARGIN))),
  }
}

/** A free rectangle of the same size, centered on the screen (below any reserved band). */
export function centerRect(size: Size, viewport: ViewportSize, min: Size): Rect {
  const band = reserved(viewport)
  return clampRect(
    { x: (viewport.width - size.w) / 2, y: band + (viewport.height - band - size.h) / 2, w: size.w, h: size.h },
    viewport,
    min
  )
}

/** Places a window can snap to, like a desktop's window tiling (the farm's set). */
export const SNAPS = [
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'left-third',
  'middle-third',
  'right-third',
  'full',
] as const
export type Snap = (typeof SNAPS)[number]

export function isSnap(value: unknown): value is Snap {
  return SNAPS.includes(value as Snap)
}

/** What each snap is called, and its shortcut key (after Ctrl+Option), by KeyboardEvent.code. */
export const SNAP_INFO: Record<Snap, { label: string; code: string; key: string }> = {
  left: { label: 'Left half', code: 'ArrowLeft', key: '←' },
  right: { label: 'Right half', code: 'ArrowRight', key: '→' },
  top: { label: 'Top half', code: 'ArrowUp', key: '↑' },
  bottom: { label: 'Bottom half', code: 'ArrowDown', key: '↓' },
  'top-left': { label: 'Top left', code: 'KeyU', key: 'U' },
  'top-right': { label: 'Top right', code: 'KeyI', key: 'I' },
  'bottom-left': { label: 'Bottom left', code: 'KeyJ', key: 'J' },
  'bottom-right': { label: 'Bottom right', code: 'KeyK', key: 'K' },
  'left-third': { label: 'Left third', code: 'KeyD', key: 'D' },
  'middle-third': { label: 'Middle third', code: 'KeyF', key: 'F' },
  'right-third': { label: 'Right third', code: 'KeyG', key: 'G' },
  full: { label: 'Fill the screen', code: 'Enter', key: '↵' },
}

/** Ctrl+Option+C, as Rectangle's "Center": the assistant's default card, or an agent window centered. */
export const DEFAULT_PLACEMENT_KEY = { code: 'KeyC', key: 'C' }

type ShortcutKeys = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'code'>

/** Whether a key is the default-placement (center) shortcut. */
export function isDefaultPlacementKey(e: ShortcutKeys): boolean {
  return e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.code === DEFAULT_PLACEMENT_KEY.code
}

/** The snap a key press asks for: Ctrl+Option (Ctrl+Alt) and one of the keys above, nothing else held. */
export function snapForKey(e: ShortcutKeys): Snap | null {
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return null
  return SNAPS.find((snap) => SNAP_INFO[snap].code === e.code) ?? null
}

/** Each snap as a share of the screen, in fractions: [x, y, w, h]. Also draws the menu and picker diagrams. */
export const SNAP_FRACTIONS: Record<Snap, [number, number, number, number]> = {
  left: [0, 0, 0.5, 1],
  right: [0.5, 0, 0.5, 1],
  top: [0, 0, 1, 0.5],
  bottom: [0, 0.5, 1, 0.5],
  'top-left': [0, 0, 0.5, 0.5],
  'top-right': [0.5, 0, 0.5, 0.5],
  'bottom-left': [0, 0.5, 0.5, 0.5],
  'bottom-right': [0.5, 0.5, 0.5, 0.5],
  'left-third': [0, 0, 1 / 3, 1],
  'middle-third': [1 / 3, 0, 1 / 3, 1],
  'right-third': [2 / 3, 0, 1 / 3, 1],
  full: [0, 0, 1, 1],
}

/** The part of the screen a snap fills. */
export function snapRect(snap: Snap, viewport: ViewportSize): Rect {
  const left = WINDOW_MARGIN
  const top = windowTop(viewport)
  const width = Math.max(0, viewport.width - WINDOW_MARGIN * 2)
  const height = usableHeight(viewport)
  const half = (size: number) => (size - SNAP_GAP) / 2
  const third = (width - SNAP_GAP * 2) / 3
  const box = (x: number, y: number, w: number, h: number) => ({
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  })
  switch (snap) {
    case 'left':
      return box(left, top, half(width), height)
    case 'right':
      return box(left + half(width) + SNAP_GAP, top, half(width), height)
    case 'top':
      return box(left, top, width, half(height))
    case 'bottom':
      return box(left, top + half(height) + SNAP_GAP, width, half(height))
    case 'top-left':
      return box(left, top, half(width), half(height))
    case 'top-right':
      return box(left + half(width) + SNAP_GAP, top, half(width), half(height))
    case 'bottom-left':
      return box(left, top + half(height) + SNAP_GAP, half(width), half(height))
    case 'bottom-right':
      return box(left + half(width) + SNAP_GAP, top + half(height) + SNAP_GAP, half(width), half(height))
    case 'left-third':
      return box(left, top, third, height)
    case 'middle-third':
      return box(left + third + SNAP_GAP, top, third, height)
    case 'right-third':
      return box(left + (third + SNAP_GAP) * 2, top, third, height)
    case 'full':
      return box(left, top, width, height)
  }
}

// --- Resizing from any edge ------------------------------------------------

export const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
export type ResizeEdge = (typeof RESIZE_EDGES)[number]

/**
 * A rect resized by dragging one edge or corner by (dx, dy). The opposite edges stay put; the window
 * never shrinks below its minimum size or grows past the screen.
 */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, viewport: ViewportSize, min: Size) {
  let { x, y, w, h } = start
  const right = start.x + start.w
  const bottom = start.y + start.h
  if (edge.includes('e')) w = Math.min(Math.max(min.w, start.w + dx), viewport.width - WINDOW_MARGIN - start.x)
  if (edge.includes('s')) h = Math.min(Math.max(min.h, start.h + dy), viewport.height - WINDOW_MARGIN - start.y)
  if (edge.includes('w')) {
    x = Math.min(Math.max(WINDOW_MARGIN, start.x + dx), right - min.w)
    w = right - x
  }
  if (edge.includes('n')) {
    y = Math.min(Math.max(windowTop(viewport), start.y + dy), bottom - min.h)
    h = bottom - y
  }
  return clampRect({ x, y, w, h }, viewport, min)
}

// --- Snapping by dragging ----------------------------------------------------

/** How close (px) the pointer must be to a screen edge to snap there. */
export const SNAP_EDGE = 6
/** How far (px) along an edge from a corner counts as that corner. */
export const SNAP_CORNER = 96

/**
 * The snap for a pointer at the screen's edge while dragging, as desktop operating systems do: the left
 * or right edge is that half, a corner is that quarter, the top edge fills the screen and the bottom
 * edge is the bottom half. Away from every edge, nothing. A reserved band at the top counts as the top
 * edge (like a menu bar), so it is measured from the band's bottom and the band itself is part of it.
 */
export function edgeSnapAt(point: Point, viewport: ViewportSize): Snap | null {
  const top = reserved(viewport)
  const atLeft = point.x <= SNAP_EDGE
  const atRight = point.x >= viewport.width - SNAP_EDGE
  const atTop = point.y <= top + SNAP_EDGE
  const atBottom = point.y >= viewport.height - SNAP_EDGE
  if (!atLeft && !atRight && !atTop && !atBottom) return null
  // On an edge and near a corner along it: that quarter.
  const side = point.x <= SNAP_CORNER ? 'left' : point.x >= viewport.width - SNAP_CORNER ? 'right' : null
  const band = point.y <= top + SNAP_CORNER ? 'top' : point.y >= viewport.height - SNAP_CORNER ? 'bottom' : null
  if (side && band) return `${band}-${side}`
  if (atLeft) return 'left'
  if (atRight) return 'right'
  return atTop ? 'full' : 'bottom'
}

/** The snap-zone picker's layouts, Windows 11 style: each is a tiny screen split into the zones it offers. */
export const SNAP_ZONE_GROUPS: readonly (readonly Snap[])[] = [
  ['left', 'right'],
  ['top', 'bottom'],
  ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  ['left-third', 'middle-third', 'right-third'],
  ['full'],
]

const ZONE_W = 52
const ZONE_H = 34
const ZONE_GAP = 8
const ZONE_PAD = 8
/** The picker's distance from the top of the screen (below any reserved band): below the top edge, which fills the screen. */
const ZONE_TOP = 16
/** Space between zones inside a layout. */
const ZONE_INSET = 2

export interface SnapZoneLayout {
  /** The picker itself. */
  frame: Rect
  /** Each layout's tiny screen. */
  groups: { rect: Rect; zones: { snap: Snap; rect: Rect }[] }[]
}

/** Where the picker and each of its zones sit on this screen, in viewport coordinates. */
export function snapZoneLayout(viewport: ViewportSize): SnapZoneLayout {
  const count = SNAP_ZONE_GROUPS.length
  const width = ZONE_PAD * 2 + count * ZONE_W + (count - 1) * ZONE_GAP
  const height = ZONE_PAD * 2 + ZONE_H
  const frame = { x: Math.round((viewport.width - width) / 2), y: reserved(viewport) + ZONE_TOP, w: width, h: height }
  const groups = SNAP_ZONE_GROUPS.map((snaps, index) => {
    const rect = { x: frame.x + ZONE_PAD + index * (ZONE_W + ZONE_GAP), y: frame.y + ZONE_PAD, w: ZONE_W, h: ZONE_H }
    return {
      rect,
      zones: snaps.map((snap) => {
        const [fx, fy, fw, fh] = SNAP_FRACTIONS[snap]
        return {
          snap,
          rect: {
            x: rect.x + fx * rect.w + ZONE_INSET / 2,
            y: rect.y + fy * rect.h + ZONE_INSET / 2,
            w: fw * rect.w - ZONE_INSET,
            h: fh * rect.h - ZONE_INSET,
          },
        }
      }),
    }
  })
  return { frame, groups }
}

function contains(rect: Rect, point: Point, slack = 0) {
  return (
    point.x >= rect.x - slack &&
    point.x <= rect.x + rect.w + slack &&
    point.y >= rect.y - slack &&
    point.y <= rect.y + rect.h + slack
  )
}

/** The picker zone under the pointer, if any (a zone's inset gap counts as that zone). */
export function snapZoneAt(point: Point, layout: SnapZoneLayout): Snap | null {
  for (const group of layout.groups)
    for (const zone of group.zones) if (contains(zone.rect, point, ZONE_INSET / 2)) return zone.snap
  return null
}

/** Where a dragged window would snap if released here: a picker zone first, then a screen edge. */
export function dragSnapTarget(
  point: Point,
  viewport: ViewportSize,
  layout: SnapZoneLayout = snapZoneLayout(viewport)
): { snap: Snap; source: 'zone' | 'edge' } | null {
  const zone = snapZoneAt(point, layout)
  if (zone) return { snap: zone, source: 'zone' }
  const edge = edgeSnapAt(point, viewport)
  return edge ? { snap: edge, source: 'edge' } : null
}

/**
 * Dragging a snapped window out of its snap, as desktop operating systems do: it takes back its free
 * size, keeping the point where it was grabbed under the pointer (the same share of its width, and the
 * same distance below its top edge, capped by its new height).
 */
export function unsnapUnderPointer(snapped: Rect, free: Size, grab: Point): Rect {
  const share = snapped.w > 0 ? (grab.x - snapped.x) / snapped.w : 0.5
  const below = Math.min(grab.y - snapped.y, Math.max(0, free.h - 1))
  return { x: Math.round(grab.x - share * free.w), y: Math.round(grab.y - below), w: free.w, h: free.h }
}

export function isRect(value: unknown): value is Rect {
  const rect = value as Partial<Rect> | null
  return (
    !!rect &&
    typeof rect === 'object' &&
    [rect.x, rect.y, rect.w, rect.h].every((part) => typeof part === 'number' && Number.isFinite(part)) &&
    rect.w! > 0 &&
    rect.h! > 0
  )
}
