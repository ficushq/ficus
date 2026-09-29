import { createContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SNAPS, type Snap } from './chatWindowState'

/*
 * Snapping chat windows into place: a layout button beside a window's close
 * button, and Rectangle-style shortcuts (Ctrl+Option with arrows, U I J K,
 * D F G, Enter) for the window you used last. Dragging and resizing stay free.
 */

/** What each snap is called, and its shortcut key (after Ctrl+Option), by KeyboardEvent.code. */
export const SNAP_INFO: Record<Snap, { label: string; code: string; key: string }> = {
  left: { label: 'Left half', code: 'ArrowLeft', key: '←' },
  right: { label: 'Right half', code: 'ArrowRight', key: '→' },
  top: { label: 'Top half', code: 'ArrowUp', key: '↑' },
  bottom: { label: 'Bottom half', code: 'ArrowDown', key: '↓' },
  'top-left': { label: 'Top left', code: 'KeyU', key: 'U' },
  'top-right': { label: 'Top right', code: 'KeyI', key: 'I' },
  'bottom-left': { label: 'Bottom left', code: 'KeyJ', key: 'J' },
  'bottom-right': { label: 'Bottom right', code: 'KeyK', key: 'K' },
  'left-third': { label: 'Left third', code: 'KeyD', key: 'D' },
  'middle-third': { label: 'Middle third', code: 'KeyF', key: 'F' },
  'right-third': { label: 'Right third', code: 'KeyG', key: 'G' },
  full: { label: 'Fill the screen', code: 'Enter', key: '↵' },
}

/** The snap a key press asks for: Ctrl+Option (Ctrl+Alt) and one of the keys above, nothing else held. */
export function snapForKey(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'code'>
): Snap | null {
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return null
  return SNAPS.find((snap) => SNAP_INFO[snap].code === e.code) ?? null
}

/** The menu's height, px, near enough, for keeping it on screen. */
const MENU_H = 350

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MODIFIERS = MAC ? '⌃⌥' : 'Ctrl+Alt+'

/** The part of the screen a snap takes, as a tiny picture (in a 30×20 box). */
function Diagram({ snap }: { snap: Snap }) {
  const [x, y, w, h] = {
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
    <svg className="g-snap-diagram" viewBox="-1 -1 32 22" aria-hidden="true">
      <rect x={0} y={0} width={30} height={20} rx={2} className="g-snap-screen" />
      <rect x={x} y={y} width={w} height={h} rx={1.5} className="g-snap-area" />
    </svg>
  )
}

/** The window layout button, and its menu of places to snap to. */
export function SnapMenu({ onSnap }: { onSnap: (snap: Snap) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  // The menu floats over the page beside its button (a small window would clip it), right-aligned below it.
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return setPlace(null)
    const button = root.current?.getBoundingClientRect()
    // Kept on screen for a window low down (the menu is about MENU_H tall).
    if (button)
      setPlace({
        top: Math.max(8, Math.min(button.bottom + 8, window.innerHeight - MENU_H - 8)),
        right: Math.max(8, window.innerWidth - button.right - 52),
      })
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const target = e.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return (
    <div className="g-snap" ref={root}>
      <button
        type="button"
        className="g-snap-button"
        aria-label="Arrange this window"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Arrange this window"
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="g-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 4 V20 M12 12 H21" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            className="g-snap-menu"
            style={{ top: place.top, right: place.right }}
            role="menu"
            aria-label="Arrange this window"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Close the menu, not the chat.
                e.stopPropagation()
                setOpen(false)
              }
            }}
          >
            {SNAPS.map((snap) => (
              <button
                key={snap}
                type="button"
                role="menuitem"
                className="g-snap-item"
                title={`${SNAP_INFO[snap].label} (${MODIFIERS}${SNAP_INFO[snap].key})`}
                onClick={() => {
                  setOpen(false)
                  onSnap(snap)
                }}
              >
                <Diagram snap={snap} />
                <span className="g-snap-label">{SNAP_INFO[snap].label}</span>
                <kbd className="g-snap-key">
                  {MODIFIERS}
                  {SNAP_INFO[snap].key}
                </kbd>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}

/** Controls a floating chat window adds to its chat's header (the layout button), for ChatShell to show. */
export const ChatWindowControls = createContext<ReactNode>(null)
