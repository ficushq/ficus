import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { MoreIcon } from './icons'
import { Presence } from './Presence'

/**
 * A "…" trigger that opens a small popover of action buttons — the shared
 * shape behind ProviderAccountActions (secret/provider account rows) and the
 * "My themes" library row overflow (Rename/Share/Duplicate/Export/Delete on
 * narrow widths). Dismissal (outside press, Escape, keyboard focus leaving) is
 * `usePopupDismiss`; clicking any action button inside closes it, after the
 * action, and returns focus to the trigger. `itemsMarker` scopes the initial-focus query to this menu's
 * own action buttons so a caller can render arbitrary children (dividers,
 * headings) without every descendant button stealing focus-on-open.
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
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) container.current?.querySelector<HTMLButtonElement>(`[${itemsMarker}] button`)?.focus()
  }, [open, itemsMarker])
  usePopupDismiss({ open, popup: surface, trigger, onDismiss: () => setOpen(false) })
  return (
    <div ref={container} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="ficus-button flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-primary"
      >
        <MoreIcon className="h-4 w-4" />
      </button>
      <Presence
        ref={surface}
        open={open}
        className="ficus-overlay absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
      >
        <div
          {...{ [itemsMarker]: '' }}
          className="flex flex-col [&>button]:rounded-md [&>button]:px-3 [&>button]:py-2 [&>button]:text-left [&>button]:text-sm [&>button:hover]:bg-surface-hover"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('button')) {
              trigger.current?.focus()
              setOpen(false)
            }
          }}
        >
          {children}
        </div>
      </Presence>
    </div>
  )
}
