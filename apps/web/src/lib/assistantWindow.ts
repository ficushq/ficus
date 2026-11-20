import { ASSISTANT_WINDOW_STORAGE_KEY } from '@ficus/shared/browser-keys'
import {
  clampRect as clampWindowRect,
  isRect,
  isSnap,
  snapRect,
  type Rect,
  type Size,
  type Snap,
  type ViewportSize,
} from './floatingWindow'

/*
 * The assistant as a floating window, like the farm's chat windows: a free rectangle you drag by its
 * header and resize from its edges, or snapped to fill part of the screen. The geometry is shared with
 * agent chat windows (lib/floatingWindow); this adds the assistant's own default card and its storage.
 */

export {
  clampPosition,
  DEFAULT_PLACEMENT_KEY,
  isDefaultPlacementKey,
  SNAP_INFO,
  SNAPS,
  snapForKey,
  snapRect,
  type Rect,
  type Snap,
  type ViewportSize,
} from './floatingWindow'

/** What the user chose: nothing (the default centered card), a free rectangle, or a snap. */
export interface AssistantWindowPlacement {
  rect?: Rect
  /** Where it's snapped, if it is: it refits that place as the screen resizes, until it's dragged or resized. */
  snap?: Snap
  /** While snapped: the free rectangle it had before, whose size it takes back when dragged out of the snap. */
  restore?: Rect
}

export const ASSISTANT_MIN_W = 320
export const ASSISTANT_MIN_H = 280
export const ASSISTANT_MIN: Size = { w: ASSISTANT_MIN_W, h: ASSISTANT_MIN_H }
/** The default card's size (Tailwind w-[44rem] × h-[40rem]), also when it's dragged first. */
export const ASSISTANT_DEFAULT_W = 704
export const ASSISTANT_DEFAULT_H = 640

/** Keeps a window on screen and at least the assistant's minimum size (shrinking below it only on a small screen). */
export function clampRect(rect: Rect, viewport: ViewportSize, min: Size = ASSISTANT_MIN): Rect {
  return clampWindowRect(rect, viewport, min)
}

/** Where the window is for a placement on this screen, or undefined for the default command center. */
export function placedRect(placement: AssistantWindowPlacement, viewport: ViewportSize): Rect | undefined {
  if (placement.snap) return snapRect(placement.snap, viewport)
  return placement.rect ? clampRect(placement.rect, viewport) : undefined
}

export function readAssistantWindow(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage()
): AssistantWindowPlacement {
  try {
    const value = JSON.parse(storage?.getItem(ASSISTANT_WINDOW_STORAGE_KEY) ?? 'null') as {
      rect?: unknown
      snap?: unknown
      restore?: unknown
    } | null
    const snap = isSnap(value?.snap) ? value.snap : undefined
    return {
      ...(isRect(value?.rect) ? { rect: value.rect } : {}),
      ...(snap ? { snap } : {}),
      ...(snap && isRect(value?.restore) ? { restore: value.restore } : {}),
    }
  } catch {
    return {}
  }
}

export function saveAssistantWindow(
  placement: AssistantWindowPlacement,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()
): void {
  try {
    if (!placement.rect && !placement.snap) storage?.removeItem(ASSISTANT_WINDOW_STORAGE_KEY)
    else storage?.setItem(ASSISTANT_WINDOW_STORAGE_KEY, JSON.stringify(placement))
  } catch {
    // Storage unavailable: the window just opens in its default place next time.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
