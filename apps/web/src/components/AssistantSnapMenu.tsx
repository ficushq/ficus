import clsx from 'clsx'
import { DEFAULT_PLACEMENT_KEY, SNAPS, SNAP_INFO, type Snap } from '../lib/assistantWindow'
import { WindowLayoutIcon } from './icons'
import { Menu, MenuItem, usePopover } from './popover'

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
  const popover = usePopover({ kind: 'menu' })
  // The menu floats over the page (the assistant would clip it), right-aligned below its button; Escape
  // closes the menu, not the assistant (whose Escape is a document listener).
  return (
    <div data-assistant-snap-menu className="shrink-0">
      <button
        {...popover.triggerProps}
        type="button"
        className={clsx(
          'ficus-button flex h-8 w-8 items-center justify-center rounded-lg',
          popover.open ? 'bg-selection text-accent-light' : 'text-muted hover:bg-surface-hover hover:text-primary'
        )}
        aria-label="Arrange assistant"
        title="Arrange assistant"
        onClick={popover.toggle}
      >
        <WindowLayoutIcon className="h-4 w-4" />
      </button>
      <Menu
        {...popover.popoverProps}
        label="Arrange assistant"
        initialFocus="selected"
        gap={8}
        data-assistant-snap-menu
        className="ficus-overlay w-60 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
      >
        <MenuItem
          role="menuitemradio"
          checked={isDefault}
          title={`Default size and position, centered (${MODIFIERS}${DEFAULT_PLACEMENT_KEY.key})`}
          className={clsx(
            'ficus-button flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover',
            isDefault ? 'text-accent-light' : 'text-secondary'
          )}
          onClick={onReset}
        >
          <SnapDiagram snap="default" />
          <span className="min-w-0 flex-1 truncate">Default (centered)</span>
          <kbd className="shrink-0 font-sans text-xs text-muted">
            {MODIFIERS}
            {DEFAULT_PLACEMENT_KEY.key}
          </kbd>
        </MenuItem>
        <div className="my-1 border-t border-th-border" />
        {SNAPS.map((item) => (
          <MenuItem
            key={item}
            role="menuitemradio"
            checked={snap === item}
            title={`${SNAP_INFO[item].label} (${MODIFIERS}${SNAP_INFO[item].key})`}
            className={clsx(
              'ficus-button flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover',
              snap === item ? 'text-accent-light' : 'text-secondary'
            )}
            onClick={() => onSnap(item)}
          >
            <SnapDiagram snap={item} />
            <span className="min-w-0 flex-1 truncate">{SNAP_INFO[item].label}</span>
            <kbd className="shrink-0 font-sans text-xs text-muted">
              {MODIFIERS}
              {SNAP_INFO[item].key}
            </kbd>
          </MenuItem>
        ))}
      </Menu>
    </div>
  )
}
