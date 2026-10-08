import type { PopoverInitialFocus } from './Popover'

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** Keyboard-reachable elements inside `root`, in DOM order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      !element.matches('[tabindex="-1"]') &&
      !element.closest('[inert], [hidden]') &&
      !element.closest('details:not([open]) > :not(summary)')
  )
}

const SELECTED =
  '[aria-selected="true"]:not([disabled]), [aria-checked="true"]:not([disabled]), [aria-current]:not([aria-current="false"]):not([disabled])'

export function initialTarget(surface: HTMLElement, focus: PopoverInitialFocus): HTMLElement | null | undefined {
  if (focus === 'none') return null
  if (typeof focus === 'function') return focus(surface)
  if (focus === 'selected') return surface.querySelector<HTMLElement>(SELECTED) ?? tabbables(surface)[0]
  return tabbables(surface)[0]
}

/** Focuses `element` without scrolling the page, then reveals it inside a scrolling popover. */
export function focusInPopover(element: HTMLElement | null | undefined) {
  if (!element) return
  element.focus({ preventScroll: true })
  element.scrollIntoView?.({ block: 'nearest' })
}
