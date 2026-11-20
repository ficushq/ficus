import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react'
import {
  ASSISTANT_DEFAULT_H,
  ASSISTANT_DEFAULT_W,
  ASSISTANT_MIN,
  clampPosition,
  clampRect,
  placedRect,
  readAssistantWindow,
  saveAssistantWindow,
  snapRect,
  type AssistantWindowPlacement,
  type Rect,
  type Snap,
} from '../lib/assistantWindow'
import { registerFloatingWindow } from '../lib/floatingWindowRegistry'
import { ASSISTANT_WINDOW_KEY } from '../lib/chatWindows'
import { ASSISTANT_GUTTER, currentViewport, dockAssistant } from './useAssistantPosition'
import { useStableRef } from './useStableRef'
import { useAdjustOnChange } from './useAdjustOnChange'
import { useFloatingWindowGesture } from './useFloatingWindowGesture'

const KEY_STEP = 16

/**
 * The assistant command center as a floating window, sharing its gestures with agent chat windows. Until
 * the user moves it, it sits at the default centered card with its CSS size. Dragging its header places
 * it anywhere (or snaps it at a screen edge or the zone picker), its edges and corner resize it, and the
 * layout menu (or Ctrl+Option shortcuts, when it is the window in use) snaps it to fill part of the
 * screen. The latest placement is remembered in the browser. `small` is the live-voice command bar: it
 * follows a free placement's position but keeps its own size, and ignores snaps.
 */
export function useAssistantWindow(
  ref: RefObject<HTMLDivElement | null>,
  {
    visible,
    small,
    layoutKey,
    z = 0,
  }: {
    visible: boolean
    small: boolean
    layoutKey?: string
    /** Its place in the shared window stack, for keyboard shortcuts aimed at the frontmost window. */
    z?: number
  }
) {
  const [placement, setPlacementState] = useState<AssistantWindowPlacement>(() => readAssistantWindow())
  // Gestures read the placement from this ref; setPlacement also writes it at once, before React renders.
  const placementRef = useStableRef(placement)
  const [style, setStyle] = useState<CSSProperties>({})

  const setPlacement = useCallback(
    (next: AssistantWindowPlacement) => {
      placementRef.current = next
      setPlacementState(next)
      saveAssistantWindow(next)
    },
    [placementRef]
  )

  // A reopened assistant picks up a placement another tab or a remount saved, while rendering.
  useAdjustOnChange(
    [visible],
    () => {
      if (visible) setPlacementState(readAssistantWindow())
    },
    { onMount: true }
  )

  /** The window's current rect relative to the visual viewport, as drawn. */
  const currentRect = useCallback((): Rect | undefined => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return undefined
    const viewport = currentViewport()
    return { x: box.left - viewport.left, y: box.top - viewport.top, w: box.width, h: box.height }
  }, [ref])

  const snap = useCallback(
    (next: Snap, free?: Rect) => {
      const current = placementRef.current
      // The free rectangle it returns to when dragged out of the snap (none for the default card).
      const restore = free ?? (current.snap ? current.restore : current.rect)
      setPlacement({ snap: next, rect: snapRect(next, currentViewport()), ...(restore ? { restore } : {}) })
    },
    [placementRef, setPlacement]
  )
  const reset = useCallback(() => setPlacement({}), [setPlacement])
  /** Double-click on the header: fill the screen, and back to where it was. */
  const toggleFull = useCallback(() => {
    const current = placementRef.current
    if (current.snap !== 'full') snap('full')
    else setPlacement(current.restore ? { rect: current.restore } : {})
  }, [placementRef, setPlacement, snap])

  const gesture = useFloatingWindowGesture({
    currentRect,
    min: ASSISTANT_MIN,
    snapOnDrag: !small,
    restoreSize: () => {
      const current = placementRef.current
      return current.snap && current.restore && !small ? current.restore : undefined
    },
    // The command bar moves as itself; clampRect's minimum window size would otherwise stretch it.
    clampMove: small ? clampPosition : undefined,
    onTitleDoubleClick: small ? undefined : toggleFull,
    onCommit: ({ kind, rect, snap: to }) => {
      if (to && kind === 'move' && !small) {
        snap(to, rect)
        return
      }
      // Dragging or resizing unsnaps it, keeping where it was left. A dragged command bar keeps the
      // window's remembered size (or the default) for when it expands.
      const previous = placementRef.current.rect
      setPlacement({
        rect: small
          ? { x: rect.x, y: rect.y, w: previous?.w ?? ASSISTANT_DEFAULT_W, h: previous?.h ?? ASSISTANT_DEFAULT_H }
          : rect,
      })
    },
  })
  const live = gesture.live

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
      // The default: a card centered on the screen (the compact voice bar keeps the upper-center anchor),
      // capped above the bottom edge (and keyboard).
      const dock = small
        ? dockAssistant('center', viewport, box.width, box.height)
        : {
            left: viewport.left + Math.max(ASSISTANT_GUTTER, (viewport.width - box.width) / 2),
            top: viewport.top + Math.max(ASSISTANT_GUTTER, (viewport.height - box.height) / 2),
          }
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
  }, [ref, visible, small, layoutKey, placement, live, placementRef])

  // Rectangle-style shortcuts, as in the farm: Ctrl+Option with arrows, U I J K, D F G, Enter, and C for the
  // default card. They reach the assistant only when it holds focus or is the frontmost window.
  const shortcutState = useStableRef({ visible: visible && !small, z, snap, reset })
  useEffect(
    () =>
      registerFloatingWindow(ASSISTANT_WINDOW_KEY, {
        element: () => ref.current,
        z: () => shortcutState.current.z,
        visible: () => shortcutState.current.visible,
        snap: (to) => shortcutState.current.snap(to),
        center: () => shortcutState.current.reset(),
      }),
    [ref, shortcutState]
  )

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
    snap: useCallback((next: Snap) => snap(next), [snap]),
    reset,
    toggleFull,
    style: live ? { ...style, transition: 'none' } : style,
    moving: live !== undefined,
    /** What a drag would snap to if released now (for the preview and zone picker). */
    dragSnap: gesture.dragSnap,
    dragging: gesture.dragging,
    beginResize: gesture.beginResize,
    panelHandlers: gesture.handlers,
    resizeHandle: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => gesture.beginResize('se', event),
      onKeyDown: onResizeKeyDown,
      onDoubleClick: reset,
    },
  }
}
