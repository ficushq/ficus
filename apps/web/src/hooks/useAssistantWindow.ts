import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react'
import {
  ASSISTANT_DEFAULT_H,
  ASSISTANT_DEFAULT_W,
  clampPosition,
  clampRect,
  placedRect,
  readAssistantWindow,
  saveAssistantWindow,
  snapForKey,
  snapRect,
  type AssistantWindowPlacement,
  type Rect,
  type Snap,
} from '../lib/assistantWindow'
import { ASSISTANT_GUTTER, currentViewport, dockAssistant } from './useAssistantPosition'

const KEY_STEP = 16
/** Pointer travel before a press on the header becomes a drag (so clicks stay clicks). */
const DRAG_THRESHOLD = 4

type Gesture = { kind: 'move' | 'resize'; pointer: number; x: number; y: number; start: Rect; moved: boolean }

/**
 * The assistant command center as a floating window, like the farm's chat windows. Until the
 * user moves it, it sits at the default upper-center command-center anchor with its CSS size.
 * Dragging its header places it anywhere, the corner handle resizes it, and the layout menu (or
 * Ctrl+Option shortcuts) snaps it to fill part of the screen. The latest placement is remembered
 * in the browser. `small` is the live-voice command bar: it follows a free placement's position
 * but keeps its own size, and ignores snaps.
 */
export function useAssistantWindow(
  ref: RefObject<HTMLDivElement | null>,
  { visible, small, layoutKey }: { visible: boolean; small: boolean; layoutKey?: string }
) {
  const [placement, setPlacementState] = useState<AssistantWindowPlacement>(() => readAssistantWindow())
  const placementRef = useRef(placement)
  const gesture = useRef<Gesture | null>(null)
  const [live, setLiveState] = useState<Rect>()
  // The gesture's latest rect, for committing on release without waiting for a render.
  const liveRef = useRef<Rect | undefined>(undefined)
  const setLive = (next: Rect | undefined) => {
    liveRef.current = next
    setLiveState(next)
  }
  const [style, setStyle] = useState<CSSProperties>({})

  const setPlacement = useCallback((next: AssistantWindowPlacement) => {
    placementRef.current = next
    setPlacementState(next)
    saveAssistantWindow(next)
  }, [])

  // A reopened assistant picks up a placement another tab or a remount saved.
  useLayoutEffect(() => {
    if (!visible) return
    const saved = readAssistantWindow()
    placementRef.current = saved
    setPlacementState(saved)
  }, [visible])

  /** The window's current rect relative to the visual viewport, as drawn. */
  const currentRect = useCallback((): Rect | undefined => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return undefined
    const viewport = currentViewport()
    return { x: box.left - viewport.left, y: box.top - viewport.top, w: box.width, h: box.height }
  }, [ref])

  useLayoutEffect(() => {
    if (!visible || !ref.current) return
    const update = () => {
      const node = ref.current
      if (!node) return
      const viewport = currentViewport()
      const place = placementRef.current
      const rect = live ?? (small ? undefined : placedRect(place, viewport))
      if (rect && !small) {
        setStyle({
          left: viewport.left + rect.x,
          top: viewport.top + rect.y,
          width: rect.w,
          height: rect.h,
          right: 'auto',
          bottom: 'auto',
        })
        return
      }
      const box = node.getBoundingClientRect()
      const free = live ?? (place.rect && !place.snap ? place.rect : undefined)
      if (small && free) {
        const spot = clampPosition({ ...free, w: box.width, h: box.height }, viewport)
        setStyle({ left: viewport.left + spot.x, top: viewport.top + spot.y, right: 'auto', bottom: 'auto' })
        return
      }
      // The default: the upper-center command-center anchor, capped above the bottom edge (and keyboard).
      const dock = dockAssistant('center', viewport, box.width, box.height)
      setStyle({
        ...dock,
        maxHeight: Math.max(0, viewport.top + viewport.height - dock.top - ASSISTANT_GUTTER),
        right: 'auto',
        bottom: 'auto',
      })
    }
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined
    observer?.observe(ref.current)
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [ref, visible, small, layoutKey, placement, live])

  const snap = useCallback(
    (next: Snap) => setPlacement({ snap: next, rect: snapRect(next, currentViewport()) }),
    [setPlacement]
  )
  const reset = useCallback(() => setPlacement({}), [setPlacement])

  // Rectangle-style shortcuts, as in the farm: Ctrl+Option with arrows, U I J K, D F G, Enter.
  useEffect(() => {
    if (!visible || small) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      const next = snapForKey(event)
      if (!next) return
      event.preventDefault()
      snap(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, small, snap])

  const begin = (kind: Gesture['kind'], event: PointerEvent<HTMLElement>) => {
    const start = currentRect()
    if (!start) return
    gesture.current = { kind, pointer: event.pointerId, x: event.clientX, y: event.clientY, start, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || g.pointer !== event.pointerId) return
    const dx = event.clientX - g.x
    const dy = event.clientY - g.y
    if (!g.moved && g.kind === 'move' && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    g.moved = true
    const viewport = currentViewport()
    if (g.kind === 'move') {
      const moved = { ...g.start, x: g.start.x + dx, y: g.start.y + dy }
      // The command bar moves as itself; clampRect's minimum window size would otherwise stretch it.
      setLive(small ? clampPosition(moved, viewport) : clampRect(moved, viewport))
    } else setLive(clampRect({ ...g.start, w: g.start.w + dx, h: g.start.h + dy }, viewport))
  }
  const end = (event: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || g.pointer !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    const final = liveRef.current
    setLive(undefined)
    if (!g.moved || !final) return
    // Dragging or resizing unsnaps it, keeping where it was left. A dragged command bar keeps the
    // window's remembered size (or the default) for when it expands.
    const previous = placementRef.current.rect
    setPlacement({
      rect: small
        ? { x: final.x, y: final.y, w: previous?.w ?? ASSISTANT_DEFAULT_W, h: previous?.h ?? ASSISTANT_DEFAULT_H }
        : final,
    })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (
      event.button !== 0 ||
      !target.closest('[data-assistant-drag-handle]') ||
      target.closest('button, input, select, label, a, textarea, [data-assistant-snap-menu]')
    )
      return
    begin('move', event)
  }

  const onResizeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step =
      { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[
        event.key
      ] ?? undefined
    const start = currentRect()
    if (!step || !start) return
    event.preventDefault()
    setPlacement({ rect: clampRect({ ...start, w: start.w + step[0], h: start.h + step[1] }, currentViewport()) })
  }

  return {
    placement,
    snap,
    reset,
    style: live ? { ...style, transition: 'none' } : style,
    moving: live !== undefined,
    panelHandlers: { onPointerDown, onPointerMove: move, onPointerUp: end, onPointerCancel: end },
    resizeHandle: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        event.stopPropagation()
        if (event.button === 0) begin('resize', event)
      },
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown: onResizeKeyDown,
      onDoubleClick: reset,
    },
  }
}
