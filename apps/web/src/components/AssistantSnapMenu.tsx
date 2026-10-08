import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { DEFAULT_PLACEMENT_KEY, SNAPS, SNAP_INFO, type Snap } from '../lib/assistantWindow'
import { WindowLayoutIcon } from './icons'

/** The menu's height, px, near enough, for keeping it on screen. */
const MENU_H = 400

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MODIFIERS = MAC ? '⌃⌥' : 'Ctrl+Alt+'

/** The part of the screen a snap fills (or the default centered card), as a tiny picture (in a 30×20 box). */
function SnapDiagram({ snap }: { snap: Snap | 'default' }) {
  const [x, y, w, h] = {
    default: [7.5, 4, 15, 12],
    left: [0, 0, 14.5, 20],
    right: [15.5, 0, 14.5, 20],
    top: [0, 0, 30, 9.5],
    bottom: [0, 10.5, 30, 9.5],
    'top-left': [0, 0, 14.5, 9.5],
    'top-right': [15.5, 0, 14.5, 9.5],
    'bottom-left': [0, 10.5, 14.5, 9.5],
    'bottom-right': [15.5, 10.5, 14.5, 9.5],
    'left-third': [0, 0, 9.3, 20],
    'middle-third': [10.3, 0, 9.4, 20],
    'right-third': [20.7, 0, 9.3, 20],
    full: [0, 0, 30, 20],
  }[snap]
  return (
    <svg className="h-5 w-[30px] shrink-0" viewBox="-1 -1 32 22" aria-hidden="true">
      <rect x={0} y={0} width={30} height={20} rx={2} className="fill-none stroke-current text-muted" />
      <rect x={x} y={y} width={w} height={h} rx={1.5} className="fill-current text-accent-light" />
    </svg>
  )
}

/**
 * The assistant's layout button and its menu of screen regions to fill, like the farm's chat
 * windows. Dragging and resizing stay free; a snap holds until the window is dragged or resized.
 */
export function AssistantSnapMenu({
  snap,
  isDefault = false,
  onSnap,
  onReset,
}: {
  snap?: Snap
  /** Neither snapped nor moved: the default centered card. */
  isDefault?: boolean
  onSnap: (snap: Snap) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  // The menu floats over the page (the assistant would clip it), right-aligned below its button.
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return setPlace(null)
    const button = root.current?.getBoundingClientRect()
    if (button)
      setPlace({
        top: Math.max(8, Math.min(button.bottom + 8, window.innerHeight - MENU_H - 8)),
        right: Math.max(8, window.innerWidth - button.right),
      })
  }, [open])
  // Escape at window capture closes the menu, not the assistant (whose Escape is a document listener).
  usePopupDismiss({ open, popup: menu, trigger, onDismiss: () => setOpen(false) })
  const choose = (action: () => void) => {
    setOpen(false)
    action()
  }
  return (
    <div ref={root} data-assistant-snap-menu className="shrink-0">
      <button
        ref={trigger}
        type="button"
        className={clsx(
          'ficus-button flex h-8 w-8 items-center justify-center rounded-lg',
          open ? 'bg-selection text-accent-light' : 'text-muted hover:bg-surface-hover hover:text-primary'
        )}
        aria-label="Arrange assistant"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Arrange assistant"
        onClick={() => setOpen((value) => !value)}
      >
        <WindowLayoutIcon className="h-4 w-4" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Arrange assistant"
            data-assistant-snap-menu
            style={{ top: place.top, right: place.right }}
            className="ficus-overlay fixed z-[70] w-60 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={isDefault}
              title={`Default size and position, centered (${MODIFIERS}${DEFAULT_PLACEMENT_KEY.key})`}
              className={clsx(
                'ficus-button flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover',
                isDefault ? 'text-accent-light' : 'text-secondary'
              )}
              onClick={() => choose(onReset)}
            >
              <SnapDiagram snap="default" />
              <span className="min-w-0 flex-1 truncate">Default (centered)</span>
              <kbd className="shrink-0 font-sans text-xs text-muted">
                {MODIFIERS}
                {DEFAULT_PLACEMENT_KEY.key}
              </kbd>
            </button>
            <div className="my-1 border-t border-th-border" />
            {SNAPS.map((item) => (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={snap === item}
                title={`${SNAP_INFO[item].label} (${MODIFIERS}${SNAP_INFO[item].key})`}
                className={clsx(
                  'ficus-button flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover',
                  snap === item ? 'text-accent-light' : 'text-secondary'
                )}
                onClick={() => choose(() => onSnap(item))}
              >
                <SnapDiagram snap={item} />
                <span className="min-w-0 flex-1 truncate">{SNAP_INFO[item].label}</span>
                <kbd className="shrink-0 font-sans text-xs text-muted">
                  {MODIFIERS}
                  {SNAP_INFO[item].key}
                </kbd>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
