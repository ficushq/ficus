import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, RefObject } from 'react'

const KEY_STEP = 16

export interface SidebarWidthBounds {
  min: number
  max: number
}

/** Clamp a width to the bounds; the max never drops below the min on a narrow container. */
export function clampSidebarWidth(width: number, { min, max }: SidebarWidthBounds): number {
  return Math.round(Math.min(Math.max(min, max), Math.max(min, width)))
}

function savedWidth(storageKey: string): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function saveWidth(storageKey: string, width: number | undefined): void {
  try {
    if (width === undefined) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, String(width))
  } catch {
    // Keep resizing usable when browser storage is unavailable.
  }
}

/**
 * A user-resizable sidebar width, persisted across sessions, for a sidebar on the left of a
 * horizontal split. `width` is undefined until the user resizes (or after a double-click reset),
 * leaving the sidebar at its default CSS width. `bounds` is read at drag time so a max can depend
 * on the container's current size.
 */
export function useSidebarWidth(
  ref: RefObject<HTMLElement | null>,
  storageKey: string,
  bounds: () => SidebarWidthBounds
) {
  const [width, setWidth] = useState<number | undefined>(() => savedWidth(storageKey))
  const [resizing, setResizing] = useState(false)
  const start = useRef<{ pointer: number; x: number; width: number; next?: number } | null>(null)

  const measured = useCallback(() => ref.current?.getBoundingClientRect().width, [ref])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const current = measured()
    if (event.button !== 0 || current === undefined) return
    start.current = { pointer: event.pointerId, x: event.clientX, width: current }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    setResizing(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const from = start.current
    if (!from || from.pointer !== event.pointerId) return
    from.next = clampSidebarWidth(from.width + event.clientX - from.x, bounds())
    setWidth(from.next)
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const from = start.current
    if (!from || from.pointer !== event.pointerId) return
    start.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (from.next !== undefined) saveWidth(storageKey, from.next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0
    const current = width ?? measured()
    if (!step || current === undefined) return
    event.preventDefault()
    const next = clampSidebarWidth(current + step, bounds())
    setWidth(next)
    saveWidth(storageKey, next)
  }
  const reset = () => {
    setWidth(undefined)
    saveWidth(storageKey, undefined)
  }

  return {
    width,
    resizing,
    handle: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: reset,
    },
  }
}
