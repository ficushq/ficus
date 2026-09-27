import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreIcon } from './icons'
import { Presence } from './Presence'

/**
 * A "…" trigger that opens a small popover of action buttons — the shared
 * shape behind ProviderAccountActions (secret/provider account rows) and the
 * "My themes" library row overflow (Rename/Share/Duplicate/Export/Delete on
 * narrow widths). Outside click, Escape, and blur-out-of-the-container all
 * close it; clicking any action button inside closes it and returns focus to
 * the trigger. `itemsMarker` scopes the initial-focus query to this menu's
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
  useEffect(() => {
    if (!open) return
    container.current?.querySelector<HTMLButtonElement>(`[${itemsMarker}] button`)?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, itemsMarker])
  return (
    <div
      ref={container}
      className="relative shrink-0"
      onBlur={(event) => {
        // Only close when focus moves to a known element outside. Safari (iOS
        // and macOS) doesn't focus a tapped button, so tapping a menu item
        // blurs the focused one with a null relatedTarget; closing then would
        // unmount the item before its click fires. Outside taps are handled
        // by the pointerdown listener above.
        const next = event.relatedTarget
        if (next && !event.currentTarget.contains(next)) setOpen(false)
      }}
    >
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
