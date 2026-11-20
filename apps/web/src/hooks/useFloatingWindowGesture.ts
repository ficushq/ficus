import { useRef, useState } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import {
  clampRect,
  dragSnapTarget,
  resizeRect,
  unsnapUnderPointer,
  type Rect,
  type ResizeEdge,
  type Size,
  type Snap,
  type ViewportSize,
} from '../lib/floatingWindow'
import { currentViewport } from './useAssistantPosition'
import { useStableRef } from './useStableRef'

/** Pointer travel before a press on the title bar becomes a drag (so clicks stay clicks). */
const DRAG_THRESHOLD = 4
/** Where a press starts a drag: the title bar. The assistant's older attribute still counts. */
const DRAG_HANDLE = '[data-window-drag-handle], [data-assistant-drag-handle]'
/** Controls inside the title bar keep their own clicks. */
const NO_DRAG = 'button, input, select, label, a, textarea, [data-window-no-drag], [data-assistant-snap-menu]'

type Gesture = {
  kind: 'move' | 'resize'
  edge?: ResizeEdge
  pointer: number
  x: number
  y: number
  start: Rect
  moved: boolean
  capture: Element
}

export interface GestureCommit {
  kind: 'move' | 'resize'
  /** The free rectangle it was left at (for a snap, the one it returns to when dragged out again). */
  rect: Rect
  /** Released over a screen edge or a picker zone: snap here. */
  snap?: Snap
}

/** Where a drag would snap if released now, and whether that came from the zone picker or a screen edge. */
export type DragSnap = { snap: Snap; source: 'zone' | 'edge' } | null

export interface FloatingWindowGestureOptions {
  /** The window's current rect relative to the visual viewport, as drawn. */
  currentRect: () => Rect | undefined
  min: Size
  /** Snap by dragging to an edge or the zone picker (off for the compact voice bar). */
  snapOnDrag: boolean
  /** While snapped: the free size to take back when dragged out of the snap. Undefined keeps the size. */
  restoreSize?: () => Size | undefined
  /** Keeps a dragged window on screen; by default at least its minimum size. */
  clampMove?: (rect: Rect, viewport: ViewportSize) => Rect
  /** Double-click on the title bar. */
  onTitleDoubleClick?: () => void
  onCommit: (commit: GestureCommit) => void
}

/**
 * Dragging a floating window by its title bar and resizing it from any edge, shared by the assistant and
 * agent chat windows. While dragging, a pointer at a screen edge or over the zone picker previews a snap
 * (Alt/Option suppresses it); a snapped window dragged out takes back its free size under the pointer.
 * The rect updates live and is committed once, on release.
 */
export function useFloatingWindowGesture(options: FloatingWindowGestureOptions) {
  const optionsRef = useStableRef(options)
  const gesture = useRef<Gesture | null>(null)
  const [live, setLiveState] = useState<Rect>()
  const liveRef = useRef<Rect | undefined>(undefined)
  const [dragSnap, setDragSnapState] = useState<DragSnap>(null)
  const dragSnapRef = useRef<DragSnap>(null)
  const [kind, setKind] = useState<Gesture['kind']>()
  const setLive = (next: Rect | undefined) => {
    liveRef.current = next
    setLiveState(next)
  }
  const setDragSnap = (next: DragSnap) => {
    if (next?.snap === dragSnapRef.current?.snap && next?.source === dragSnapRef.current?.source) return
    dragSnapRef.current = next
    setDragSnapState(next)
  }

  const begin = (gestureKind: Gesture['kind'], event: PointerEvent<HTMLElement>, edge?: ResizeEdge) => {
    const start = optionsRef.current.currentRect()
    if (!start) return false
    gesture.current = {
      kind: gestureKind,
      edge,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start,
      moved: false,
      capture: event.currentTarget,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    return true
  }

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || g.pointer !== event.pointerId) return
    const dx = event.clientX - g.x
    const dy = event.clientY - g.y
    if (!g.moved && g.kind === 'move' && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    const viewport = currentViewport()
    const { min, clampMove, snapOnDrag, restoreSize } = optionsRef.current
    if (!g.moved) {
      g.moved = true
      setKind(g.kind)
      // Dragged out of a snap: back to its free size, still held where it was grabbed.
      const free = g.kind === 'move' ? restoreSize?.() : undefined
      if (free) g.start = unsnapUnderPointer(g.start, free, { x: g.x - viewport.left, y: g.y - viewport.top })
    }
    if (g.kind === 'resize') {
      setLive(resizeRect(g.start, g.edge ?? 'se', dx, dy, viewport, min))
      return
    }
    const moved = { ...g.start, x: g.start.x + dx, y: g.start.y + dy }
    setLive(clampMove ? clampMove(moved, viewport) : clampRect(moved, viewport, min))
    const point = { x: event.clientX - viewport.left, y: event.clientY - viewport.top }
    setDragSnap(snapOnDrag && !event.altKey ? dragSnapTarget(point, viewport) : null)
  }

  const end = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || g.pointer !== event.pointerId) return
    gesture.current = null
    if (g.capture.hasPointerCapture?.(event.pointerId)) g.capture.releasePointerCapture(event.pointerId)
    const final = liveRef.current
    const target = event.type === 'pointercancel' || event.altKey ? null : dragSnapRef.current
    setLive(undefined)
    setDragSnap(null)
    setKind(undefined)
    if (!g.moved || !final) return
    optionsRef.current.onCommit({
      kind: g.kind,
      rect: final,
      ...(g.kind === 'move' && target ? { snap: target.snap } : {}),
    })
  }

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (event.button !== 0 || !target.closest(DRAG_HANDLE) || target.closest(NO_DRAG)) return
    begin('move', event)
  }

  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    const toggle = optionsRef.current.onTitleDoubleClick
    if (!toggle || !target.closest(DRAG_HANDLE) || target.closest(NO_DRAG)) return
    event.preventDefault()
    toggle()
  }

  return {
    live,
    /** What a drag would snap to if released now. */
    dragSnap,
    /** A drag (not a resize) is under way past its threshold. */
    dragging: kind === 'move',
    resizing: kind === 'resize',
    beginResize: (edge: ResizeEdge, event: PointerEvent<HTMLElement>) => {
      event.stopPropagation()
      if (event.button === 0) begin('resize', event, edge)
    },
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onDoubleClick },
  }
}
