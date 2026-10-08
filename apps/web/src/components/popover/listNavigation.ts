import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { focusInPopover } from './focus'

/** The enabled items matching `selector` inside `root`, in DOM order. */
export function listItems(root: HTMLElement, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (item) =>
      !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true' && !item.closest('[inert]')
  )
}

/**
 * The menu/listbox keyboard model, shared by `Menu` and `Picker`: arrows (looping), Home and End move
 * focus only, skipping disabled items; Enter and Space activate the focused item once and never leak
 * into an enclosing form, composer or shortcut. Returns true when it handled the key.
 */
export function handleListKey(event: ReactKeyboardEvent<HTMLElement>, selector: string): boolean {
  const items = listItems(event.currentTarget, selector)
  if (!items.length) return false
  const current = (event.target as HTMLElement).closest<HTMLElement>(selector)
  const index = current ? items.indexOf(current) : -1
  const move = (next: HTMLElement | undefined) => {
    event.preventDefault()
    focusInPopover(next)
    return true
  }
  switch (event.key) {
    case 'ArrowDown':
      return move(items[(index + 1) % items.length])
    case 'ArrowUp':
      return move(items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length])
    case 'Home':
      return move(items[0])
    case 'End':
      return move(items.at(-1))
    case 'Enter':
    case ' ':
      if (!current) return false
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) current.click()
      return true
  }
  return false
}

/** Pointer hover moves keyboard focus to the item under it, so arrows continue from there. */
export function focusHoveredItem(event: ReactMouseEvent<HTMLElement>, selector: string) {
  const item = (event.target as HTMLElement).closest<HTMLElement>(selector)
  if (!item || !event.currentTarget.contains(item) || item.ownerDocument.activeElement === item) return
  if (item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true') return
  item.focus({ preventScroll: true })
}
