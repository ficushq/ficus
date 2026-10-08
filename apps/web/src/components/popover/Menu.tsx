import { useCallback, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type Ref } from 'react'
import { useStableRef } from '../../hooks/useStableRef'
import { Popover, type PopoverProps } from './Popover'
import { focusHoveredItem, handleListKey, listItems } from './listNavigation'

export const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

export interface MenuProps extends Omit<PopoverProps, 'role' | 'initialFocus' | 'tabOut'> {
  /** The menu's accessible name. */
  label: string
  /**
   * Which descendants are the items, when the caller renders plain buttons (`OverflowMenu`). Matching
   * elements without a role get `role="menuitem"`. Default: the menuitem roles (`MenuItem`).
   */
  itemSelector?: string
  /** `first` item (default), the checked/current `selected` one, or `none`. */
  initialFocus?: 'first' | 'selected' | 'none'
}

/**
 * A menu of actions or in-app navigation (role=menu). Arrows, Home and End move between items; Enter,
 * Space or a click runs the item's own action and then closes the menu, returning focus to the trigger
 * unless the action moved focus elsewhere (a dialog) or the item has `opensDialog`. An item whose click
 * handler calls `event.preventDefault()` keeps the menu open. Tab closes it and continues from the
 * trigger. Use with `usePopover({ kind: 'menu' })`.
 */
export function Menu({
  label,
  itemSelector = MENU_ITEM_SELECTOR,
  initialFocus = 'first',
  onDismiss,
  trigger,
  onClick,
  ref,
  children,
  ...props
}: MenuProps) {
  const latest = useStableRef({ itemSelector, onDismiss, trigger })
  const assignRoles = useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
      node?.querySelectorAll(latest.current.itemSelector).forEach((item) => {
        if (!item.getAttribute('role')) item.setAttribute('role', 'menuitem')
      })
    },
    [ref, latest]
  )

  const activate = (event: ReactMouseEvent<HTMLDivElement>) => {
    onClick?.(event)
    const item = (event.target as HTMLElement).closest<HTMLElement>(itemSelector)
    if (!item || !event.currentTarget.contains(item) || event.defaultPrevented) return
    if (item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true') return
    // The item's own click handler has run (this listener is on an ancestor). Hand focus back to the
    // trigger unless that action put it somewhere on purpose.
    const active = item.ownerDocument.activeElement
    const movedOnPurpose =
      item.hasAttribute('data-opens-dialog') ||
      (active &&
        active !== item.ownerDocument.body &&
        !event.currentTarget.contains(active) &&
        active !== trigger?.current)
    if (!movedOnPurpose) trigger?.current?.focus({ preventScroll: true })
    // Leave focus for the dialog to take, never on (or returned from) the closing menu.
    else if (event.currentTarget.contains(active)) (active as HTMLElement).blur()
    onDismiss('select')
  }

  return (
    <Popover
      {...props}
      ref={assignRoles}
      role="menu"
      aria-label={label}
      trigger={trigger}
      onDismiss={onDismiss}
      tabOut="close"
      initialFocus={(surface) => {
        const items = listItems(surface, latest.current.itemSelector)
        if (initialFocus === 'none') return null
        if (initialFocus === 'selected')
          return (
            items.find((item) => item.matches('[aria-checked="true"], [aria-current]:not([aria-current="false"])')) ??
            items[0]
          )
        return items[0]
      }}
      onKeyDown={(event) => handleListKey(event, itemSelector)}
      onMouseMove={(event) => focusHoveredItem(event, itemSelector)}
      onClick={activate}
    >
      {children}
    </Popover>
  )
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `menuitemradio` / `menuitemcheckbox` take `checked`. Default `menuitem`. */
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  checked?: boolean
  /** The action opens a dialog that takes focus itself; never restore focus to the trigger behind it. */
  opensDialog?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** One item of a `Menu`: a button with the menuitem role. Its `onClick` is the action; the menu closes after it. */
export function MenuItem({ role = 'menuitem', checked, opensDialog, type = 'button', ...props }: MenuItemProps) {
  return (
    <button
      {...props}
      type={type}
      role={role}
      tabIndex={-1}
      aria-checked={role === 'menuitem' ? undefined : !!checked}
      data-opens-dialog={opensDialog ? '' : undefined}
    />
  )
}
