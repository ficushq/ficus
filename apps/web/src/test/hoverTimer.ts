import { spyOn } from 'bun:test'
import { act } from 'react'
import { HOVER_OPEN_DELAY_MS } from '../components/popover/useHoverOpen'
import { HOVER_PREVIEW_DELAY_MS } from '../hooks/useThemeHoverPreview'

/**
 * Owns just one hover-intent deadline (`delay`, default HOVER_PREVIEW_DELAY_MS); everything else keeps
 * the real clock. `advance(ms)` fires the pending deadlines of at most `ms`.
 */
export function useHoverTimer(delay: number = HOVER_PREVIEW_DELAY_MS) {
  return createHoverTimer(delay)
}

function createHoverTimer(delay: number) {
  const deadlines = new Map<number, { callback: () => void; ms: number }>()
  let serial = 10000
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === delay) {
      deadlines.set(++serial, { callback, ms })
      return serial
    }
    return originalSet(callback, ms, ...(rest as []))
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    if (!deadlines.delete(Number(id))) originalClear(id)
  }) as typeof clearTimeout)
  return {
    advance: (ms: number = delay) =>
      act(async () => {
        for (const [id, deadline] of [...deadlines])
          if (deadline.ms <= ms) {
            deadlines.delete(id)
            deadline.callback()
          }
      }),
    pending: () => deadlines.size,
    restore: () => {
      timer.mockRestore()
      clear.mockRestore()
    },
  }
}

/**
 * Owns the hover-open delay of `useHoverOpen` (HOVER_OPEN_DELAY_MS): `advance()` is the mouse resting on
 * the trigger long enough, without sleeping; until then a hovered trigger stays closed.
 */
export function hoverOpenClock() {
  return createHoverTimer(HOVER_OPEN_DELAY_MS)
}

/**
 * A mouse arriving on `target` and resting there past the hover-open delay (no sleep): what the hover
 * menus' tests mean by hovering a trigger. Elsewhere (into an open popover) the rest is a no-op.
 */
export async function restPointerOn(target: Element, pointerType = 'mouse') {
  const clock = hoverOpenClock()
  try {
    await act(async () => {
      target.dispatchEvent(
        new target.ownerDocument.defaultView!.PointerEvent('pointerover', { bubbles: true, pointerType })
      )
    })
    await clock.advance()
  } finally {
    clock.restore()
  }
}
