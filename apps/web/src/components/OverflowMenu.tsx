import type { ReactNode } from 'react'
import { MoreIcon } from './icons'
import { Menu, usePopover } from './popover'

/**
 * A "…" trigger that opens a small menu of action buttons — the shared shape behind
 * ProviderAccountActions (secret/provider account rows) and the "My themes" library row overflow
 * (Rename/Share/Duplicate/Export/Delete). A thin wrapper over the `Menu` popover variant: the caller's
 * plain `<button>`s become its items (inside the `itemsMarker` wrapper, so arbitrary children such as
 * dividers never take focus), arrows move between them, and clicking one runs it, then closes the
 * menu and returns focus to the trigger.
 */
export function OverflowMenu({
  label,
  itemsMarker,
  children,
}: {
  /** Full accessible name for the trigger, e.g. "More actions for Midnight". */
  label: string
  /** A boolean attribute (no value) marking the wrapper around this menu's own action buttons. */
  itemsMarker: string
  children: ReactNode
}) {
  const popover = usePopover({ kind: 'menu' })
  return (
    <div className="relative shrink-0">
      <button
        {...popover.triggerProps}
        type="button"
        aria-label={label}
        onClick={popover.toggle}
        className="ficus-button flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-primary"
      >
        <MoreIcon className="h-4 w-4" />
      </button>
      <Menu
        {...popover.popoverProps}
        label={label}
        itemSelector={`[${itemsMarker}] button`}
        gap={4}
        className="ficus-overlay w-44 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
      >
        <div
          {...{ [itemsMarker]: '' }}
          className="flex flex-col [&>button]:rounded-md [&>button]:px-3 [&>button]:py-2 [&>button]:text-left [&>button]:text-sm [&>button:hover]:bg-surface-hover"
        >
          {children}
        </div>
      </Menu>
    </div>
  )
}
