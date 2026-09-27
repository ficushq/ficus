import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent, RefObject } from 'react'
import { ASSISTANT_POSITION_STORAGE_KEY } from '@ficus/shared/browser-keys'

export type AssistantCorner =
  | 'center'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

const corners: readonly AssistantCorner[] = [
  'center',
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]

function savedCorner(): AssistantCorner | undefined {
  try {
    const value = window.localStorage.getItem(ASSISTANT_POSITION_STORAGE_KEY)
    return corners.find((corner) => corner === value)
  } catch {
    return undefined
  }
}

type Viewport = { left: number; top: number; width: number; height: number }
const gutter = 8
export function dockAssistant(corner: AssistantCorner, viewport: Viewport, width: number, height: number) {
  const left = viewport.left + gutter
  const top = viewport.top + gutter
  return {
    left: corner.endsWith('right')
      ? Math.max(left, viewport.left + viewport.width - width - gutter)
      : corner.endsWith('center')
        ? Math.max(left, viewport.left + (viewport.width - width) / 2)
        : left,
    top:
      corner === 'center'
        ? Math.max(top, viewport.top + Math.min(160, viewport.height * 0.18))
        : corner.startsWith('bottom')
          ? Math.max(top, viewport.top + viewport.height - height - gutter)
          : top,
  }
}
/** Include the command bar's upper-center anchor when snapping a center-lane drop. */
export function snapAssistant(
  viewport: Viewport,
  rect: { left: number; top: number; width: number; height: number }
): AssistantCorner {
  const horizontalCenter = (rect.left + rect.width / 2 - viewport.left) / viewport.width
  const horizontal = horizontalCenter < 1 / 3 ? 'left' : horizontalCenter > 2 / 3 ? 'right' : 'center'
  const candidates: AssistantCorner[] =
    horizontal === 'center' ? ['center', 'top-center', 'bottom-center'] : [`top-${horizontal}`, `bottom-${horizontal}`]
  return candidates.reduce((nearest, candidate) =>
    Math.abs(dockAssistant(candidate, viewport, rect.width, rect.height).top - rect.top) <
    Math.abs(dockAssistant(nearest, viewport, rect.width, rect.height).top - rect.top)
      ? candidate
      : nearest
  )
}

function currentViewport(): Viewport {
  const viewport = window.visualViewport
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

export function useAssistantPosition(
  ref: RefObject<HTMLDivElement | null>,
  visible: boolean,
  initialCorner: AssistantCorner = 'top-right',
  layoutKey?: string
) {
  const [corner, updateCorner] = useState<AssistantCorner>(() => savedCorner() ?? initialCorner)
  const setCorner = useCallback((next: AssistantCorner) => {
    updateCorner(next)
    try {
      window.localStorage.setItem(ASSISTANT_POSITION_STORAGE_KEY, next)
    } catch {
      // Keep positioning usable when browser storage is unavailable.
    }
  }, [])
  useLayoutEffect(() => {
    if (!visible) return
    const saved = savedCorner()
    if (saved) updateCorner(saved)
  }, [visible])
  const [point, setPoint] = useState<{ left: number; top: number; maxHeight?: number }>()
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  useLayoutEffect(() => {
    if (!visible || !ref.current) return
    const update = () => {
      if (drag.current?.moved || !corner || !ref.current) return
      const rect = ref.current.getBoundingClientRect()
      const viewport = currentViewport()
      const dock = dockAssistant(corner, viewport, rect.width, rect.height)
      setPoint({
        ...dock,
        // Bottom docks need the full available height as their cap, not the
        // current measured height, so they can grow again after keyboard close.
        maxHeight: Math.max(
          0,
          corner === 'center' ? viewport.top + viewport.height - dock.top - gutter : viewport.height - 2 * gutter
        ),
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
  }, [corner, ref, visible, layoutKey])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (
      event.button !== 0 ||
      !target.closest('[data-assistant-drag-handle]') ||
      target.closest('button, input, select, label, a, textarea')
    )
      return
    const rect = event.currentTarget.getBoundingClientRect()
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.pointer !== event.pointerId) return
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return
    start.moved = true
    setDragging(true)
    const viewport = currentViewport(),
      rect = event.currentTarget.getBoundingClientRect()
    const top = Math.max(
      viewport.top + gutter,
      Math.min(viewport.top + viewport.height - rect.height - gutter, start.top + event.clientY - start.y)
    )
    setPoint({
      left: Math.max(
        viewport.left + gutter,
        Math.min(viewport.left + viewport.width - rect.width - gutter, start.left + event.clientX - start.x)
      ),
      top,
      maxHeight: Math.max(0, viewport.top + viewport.height - top - gutter),
    })
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.pointer !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (!start.moved) return
    const viewport = currentViewport(),
      rect = event.currentTarget.getBoundingClientRect()
    const next = snapAssistant(viewport, rect)
    setCorner(next)
    const dock = dockAssistant(next, viewport, rect.width, rect.height)
    setPoint({
      ...dock,
      maxHeight: Math.max(
        0,
        next === 'center' ? viewport.top + viewport.height - dock.top - gutter : viewport.height - 2 * gutter
      ),
    })
  }
  const style: CSSProperties = point
    ? {
        left: point.left,
        top: point.top,
        maxHeight: point.maxHeight,
        right: 'auto',
        bottom: 'auto',
        ...(dragging ? { transition: 'none' } : {}),
      }
    : {}
  return { corner, setCorner, style, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }
}
