import type { RefObject } from 'react'
import type { PopoverProps } from './popover'

/**
 * The header dropdowns (the inbox popup and the Action Center) hang from the viewport's top-right corner, not
 * from their trigger: the inbox also opens from its `I` shortcut while its nav button is hidden, and the
 * Action Center has no button at all. This empty anchor makes `Popover` place them against the corner.
 */
const VIEWPORT_CORNER: RefObject<HTMLElement | null> = { current: null }

/** The app header's height: the dropdowns open just under it. */
const HEADER_HEIGHT = 56
/** Inset from the viewport's right edge. */
const RIGHT_INSET = 12
/** Room kept below the dropdown, so it never reaches the bottom of the window. */
const BOTTOM_ROOM = 24

/**
 * Spread on the header dropdown's `Popover`/`Panel`: under the header, 12px in from the right edge, at most
 * the viewport height less 5rem tall — where their old `fixed top-14 right-3 max-h-[calc(100dvh-5rem)]`
 * markup put them, now on the `popover` layer above floating windows and the Assistant.
 */
export const HEADER_DROPDOWN_PLACEMENT = {
  anchor: VIEWPORT_CORNER,
  side: 'below',
  align: 'end',
  gap: HEADER_HEIGHT,
  alignOffset: RIGHT_INSET,
  maxHeight: (viewport) => viewport.bottom - viewport.top - HEADER_HEIGHT - BOTTOM_ROOM,
} satisfies Partial<PopoverProps>
