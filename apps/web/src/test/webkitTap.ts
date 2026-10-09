import { act } from 'react'

/**
 * Simulates a tap the way Safari and every iOS browser deliver it, because Chromium and happy-dom
 * do not: there, pressing a `<button>` focuses it. WebKit never focuses a pressed button or link.
 * It focuses the nearest mouse-focusable ANCESTOR instead (an element with a `tabindex`, such as a
 * settings `<section tabIndex={-1}>` or a dialog), or blurs to nothing when there is none. A popup
 * that closes on that blur unmounts or inerts the item before its click, and the tap is lost.
 *
 * The sequence, each step flushed through React on its own (as a real browser does after every
 * discrete event, so a close in an earlier step is rendered before the next one arrives):
 *
 * 1. `pointerdown` (and `mousedown`) on the element;
 * 2. focus moves: the focused element blurs (`blur` + `focusout`) with `relatedTarget` = the
 *    nearest mouse-focusable ancestor, which then focuses — or with `relatedTarget` null;
 * 3. `pointerup` (and `mouseup`);
 * 4. `click`, delivered only if the element is still connected, enabled and not inside an
 *    `inert` subtree — exactly when a browser would deliver it.
 *
 * `touch: true` uses iOS's touch order instead: `pointerup` fires at touchend, BEFORE the
 * compatibility mouse events that carry the focus change and the click.
 *
 * Returns whether the click was delivered.
 */
export async function webkitTap(element: Element, { touch = false }: { touch?: boolean } = {}): Promise<boolean> {
  const document = element.ownerDocument
  const window = document.defaultView as unknown as typeof globalThis
  const PointerCtor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, detail: 1 }
  const pointer = (type: string) =>
    act(async () => {
      element.dispatchEvent(
        new PointerCtor(type, { ...init, pointerType: touch ? 'touch' : 'mouse' } as MouseEventInit)
      )
    })
  const mouse = (type: string) =>
    act(async () => {
      if (element.isConnected) element.dispatchEvent(new window.MouseEvent(type, init))
    })

  await pointer('pointerdown')
  if (touch) await pointer('pointerup')
  await mouse('mousedown')
  await act(async () => {
    const target = mouseFocusTarget(element)
    const active = document.activeElement as HTMLElement | null
    if (target === active) return
    if (target) target.focus()
    else if (active && active !== document.body) active.blur()
  })
  if (!touch) await pointer('pointerup')
  await mouse('mouseup')
  const deliverable = element.isConnected && !element.closest('[inert]') && !(element as HTMLButtonElement).disabled
  if (deliverable) await act(async () => void element.dispatchEvent(new window.MouseEvent('click', init)))
  return deliverable
}

const TEXT_ENTRY = 'input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio]),textarea,select'

/** What WebKit focuses for a press on `element`: a text field itself, else the nearest ancestor with a tabindex. */
function mouseFocusTarget(element: Element): HTMLElement | null {
  if (element.matches(TEXT_ENTRY) || (element as HTMLElement).isContentEditable) return element as HTMLElement
  for (let node = element.parentElement; node; node = node.parentElement) {
    // Buttons, links and checkable inputs are never mouse-focusable in WebKit, even as ancestors.
    if (node.matches('button, a[href], input, summary')) continue
    if (node.matches(TEXT_ENTRY) || node.hasAttribute('tabindex') || node.isContentEditable) return node
  }
  return null
}
