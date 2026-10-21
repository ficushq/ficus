import { expect } from 'bun:test'
import { act } from 'react'
import { hoverOpenClock } from './hoverTimer'

export interface HoverMenuContract {
  /** The hover-open trigger (`useHoverOpen`'s `triggerProps`). */
  trigger: HTMLElement
  /** Whether it is open now. Default: the trigger's `aria-expanded`. */
  isOpen?: () => boolean
  /** The open surface. Default: the element the trigger's `aria-controls` names. */
  surface?: () => HTMLElement | null
  /** Where a press inside lands (a filter, a radio, the menu's padding), and whether that press pins it open. */
  pressInside: { target: () => HTMLElement; pins: boolean }
}

/**
 * The shared hover-menu behaviour (`useHoverOpen`), run against one real menu: resting the mouse on the
 * trigger opens it after the open delay without taking focus; passing over, a drag (a held button) and
 * touch never open it; leaving the trigger and the menu closes it after the close delay, and re-entering
 * either cancels that; a trigger click pins it; a press inside pins it or not, as `pressInside` says.
 * Leaves the menu closed. Real timers for the close delay, as in the other hover tests.
 */
export async function expectHoverMenuContract({
  trigger,
  isOpen = () => trigger.getAttribute('aria-expanded') === 'true',
  surface = () => trigger.ownerDocument.getElementById(trigger.getAttribute('aria-controls') ?? ''),
  pressInside,
}: HoverMenuContract) {
  const win = trigger.ownerDocument.defaultView!
  const doc = trigger.ownerDocument
  const clock = hoverOpenClock()
  const pointer = (target: Element, type: string, init: PointerEventInit = {}) =>
    act(async () => {
      target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, pointerType: 'mouse', ...init }))
    })
  const over = (target: Element, init?: PointerEventInit) => pointer(target, 'pointerover', init)
  const out = (target: Element, init?: PointerEventInit) => pointer(target, 'pointerout', init)
  const rest = () => clock.advance()
  const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  /** Past the close delay, with room to spare. */
  const closeDelay = () => wait(200)
  const hoverOpen = async () => {
    await over(trigger)
    await rest()
    expect(isOpen()).toBe(true)
  }
  const leaveAndSettle = async () => {
    const open = surface()
    if (open) await out(open)
    await out(trigger)
    await closeDelay()
  }

  try {
    // A drag across the trigger, touch, and a pointer just passing over never open it.
    await over(trigger, { buttons: 1 })
    await rest()
    expect(isOpen()).toBe(false)
    await out(trigger, { buttons: 1 })
    await over(trigger, { pointerType: 'touch' })
    await rest()
    expect(isOpen()).toBe(false)
    await out(trigger, { pointerType: 'touch' })
    await over(trigger)
    expect(isOpen()).toBe(false) // not yet: the open delay
    await out(trigger)
    await rest()
    expect(isOpen()).toBe(false)

    // Resting opens it without moving focus; leaving closes it after the close delay.
    const focused = doc.activeElement
    await hoverOpen()
    expect(doc.activeElement).toBe(focused)
    await out(trigger)
    expect(isOpen()).toBe(true) // not yet: the pointer may be crossing the gap
    await closeDelay()
    expect(isOpen()).toBe(false)

    // Crossing into the menu, or back onto the trigger, cancels the close.
    await hoverOpen()
    await out(trigger)
    await over(surface()!)
    await closeDelay()
    expect(isOpen()).toBe(true)
    await out(surface()!)
    await over(trigger)
    await closeDelay()
    expect(isOpen()).toBe(true)
    await out(trigger)
    await closeDelay()
    expect(isOpen()).toBe(false)

    // A press inside pins it, or keeps hover mode so leaving still closes it.
    await hoverOpen()
    await over(surface()!)
    const target = pressInside.target()
    await pointer(target, 'pointerdown', { buttons: 1 })
    await act(async () => target.click())
    expect(isOpen()).toBe(true)
    await leaveAndSettle()
    expect(isOpen()).toBe(pressInside.pins)
    if (isOpen()) await act(async () => trigger.click())
    expect(isOpen()).toBe(false)

    // A trigger click pins a hover-opened menu; the next click closes it.
    await hoverOpen()
    await act(async () => trigger.click())
    await leaveAndSettle()
    expect(isOpen()).toBe(true)
    await act(async () => trigger.click())
    expect(isOpen()).toBe(false)
  } finally {
    clock.restore()
  }
}
