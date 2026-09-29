import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, RefObject } from 'react'
import { ASSISTANT_SIZE_STORAGE_KEY } from '@ficus/shared/browser-keys'
import { ASSISTANT_GUTTER, currentViewport, type AssistantCorner, type Viewport } from './useAssistantPosition'

export type AssistantSize = { width: number; height: number }
export type ResizeHandleCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

const MIN_WIDTH = 320
const MIN_HEIGHT = 280
const KEY_STEP = 16
const KEY_STEPS: Record<string, [number, number]> = {
  ArrowLeft: [-KEY_STEP, 0],
  ArrowRight: [KEY_STEP, 0],
  ArrowUp: [0, -KEY_STEP],
  ArrowDown: [0, KEY_STEP],
}

/**
 * Where the resize handle sits and how a pointer delta maps onto the size. The
 * handle takes the corner opposite the pin, so the pinned edges never move:
 * useAssistantPosition re-docks on every size change, which keeps a right
 * dock's right edge and a bottom dock's bottom edge in place. A center-lane
 * dock grows on both sides, so its width changes by twice the pointer travel
 * and the handle stays under the pointer while the panel stays centered.
 */
export function assistantResizeHandle(corner: AssistantCorner): {
  corner: ResizeHandleCorner
  horizontal: 1 | -1 | 2
  vertical: 1 | -1
} {
  const pinnedBottom = corner.startsWith('bottom')
  const pinnedRight = corner.endsWith('right')
  return {
    corner: `${pinnedBottom ? 'top' : 'bottom'}-${pinnedRight ? 'left' : 'right'}`,
    horizontal: pinnedRight ? -1 : corner.endsWith('left') ? 1 : 2,
    vertical: pinnedBottom ? -1 : 1,
  }
}

export function resizeAssistant(
  corner: AssistantCorner,
  start: AssistantSize,
  dx: number,
  dy: number,
  viewport: Pick<Viewport, 'width' | 'height'>
): AssistantSize {
  const { horizontal, vertical } = assistantResizeHandle(corner)
  const maxWidth = Math.max(MIN_WIDTH, viewport.width - 2 * ASSISTANT_GUTTER)
  const maxHeight = Math.max(MIN_HEIGHT, viewport.height - 2 * ASSISTANT_GUTTER)
  return {
    width: Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, start.width + horizontal * dx))),
    height: Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, start.height + vertical * dy))),
  }
}

function savedSize(): AssistantSize | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(ASSISTANT_SIZE_STORAGE_KEY) ?? 'null')
    if (Number.isFinite(value?.width) && Number.isFinite(value?.height))
      return { width: Math.max(MIN_WIDTH, value.width), height: Math.max(MIN_HEIGHT, value.height) }
  } catch {
    // Unreadable or malformed: fall back to the default size.
  }
  return undefined
}

function saveSize(size: AssistantSize | undefined): void {
  try {
    if (size) window.localStorage.setItem(ASSISTANT_SIZE_STORAGE_KEY, JSON.stringify(size))
    else window.localStorage.removeItem(ASSISTANT_SIZE_STORAGE_KEY)
  } catch {
    // Keep resizing usable when browser storage is unavailable.
  }
}

/**
 * A user-chosen assistant size, persisted across sessions. `size` is undefined
 * until the user resizes (or after a double-click reset), leaving the panel on
 * its default per-mode size.
 */
export function useAssistantSize(ref: RefObject<HTMLDivElement | null>, corner: AssistantCorner) {
  const [size, setSize] = useState<AssistantSize | undefined>(savedSize)
  const [resizing, setResizing] = useState(false)
  const start = useRef<{ pointer: number; x: number; y: number; size: AssistantSize; next?: AssistantSize } | null>(
    null
  )

  const measured = useCallback((): AssistantSize | undefined => {
    const rect = ref.current?.getBoundingClientRect()
    return rect ? { width: rect.width, height: rect.height } : undefined
  }, [ref])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const current = measured()
    if (event.button !== 0 || !current) return
    start.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, size: current }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
    setResizing(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const from = start.current
    if (!from || from.pointer !== event.pointerId) return
    from.next = resizeAssistant(corner, from.size, event.clientX - from.x, event.clientY - from.y, currentViewport())
    setSize(from.next)
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const from = start.current
    if (!from || from.pointer !== event.pointerId) return
    start.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (from.next) saveSize(from.next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = KEY_STEPS[event.key]
    const current = size ?? measured()
    if (!step || !current) return
    event.preventDefault()
    const next = resizeAssistant(corner, current, step[0], step[1], currentViewport())
    setSize(next)
    saveSize(next)
  }
  const reset = () => {
    setSize(undefined)
    saveSize(undefined)
  }

  return {
    size,
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
