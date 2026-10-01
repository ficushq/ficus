import { ASSISTANT_WINDOW_STORAGE_KEY } from '@ficus/shared/browser-keys'

/*
 * The assistant as a floating window, like the farm's chat windows: a free
 * rectangle you drag by its header and resize from its corner, or snapped to
 * fill part of the screen. Coordinates are relative to the visual viewport so
 * an on-screen keyboard shrinks and lifts the window instead of covering it.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ViewportSize {
  width: number
  height: number
}

/** What the user chose: nothing (the default centered card), a free rectangle, or a snap. */
export interface AssistantWindowPlacement {
  rect?: Rect
  /** Where it's snapped, if it is: it refits that place as the screen resizes, until it's dragged or resized. */
  snap?: Snap
}

export const ASSISTANT_MIN_W = 320
export const ASSISTANT_MIN_H = 280
/** The default card's size (Tailwind w-[44rem] × h-[40rem]), also when it's dragged first. */
export const ASSISTANT_DEFAULT_W = 704
export const ASSISTANT_DEFAULT_H = 640
const MARGIN = 8
/** Space between snapped regions, as between neighbouring farm windows. */
const SNAP_GAP = 8

/** Keeps a window on screen and at least its minimum size (shrinking below it only on a small screen). */
export function clampRect(rect: Rect, viewport: ViewportSize): Rect {
  const maxW = Math.max(0, viewport.width - MARGIN * 2)
  const maxH = Math.max(0, viewport.height - MARGIN * 2)
  const w = Math.min(maxW, Math.max(ASSISTANT_MIN_W, rect.w))
  const h = Math.min(maxH, Math.max(ASSISTANT_MIN_H, rect.h))
  return {
    x: Math.round(Math.min(Math.max(MARGIN, rect.x), Math.max(MARGIN, viewport.width - w - MARGIN))),
    y: Math.round(Math.min(Math.max(MARGIN, rect.y), Math.max(MARGIN, viewport.height - h - MARGIN))),
    w: Math.round(w),
    h: Math.round(h),
  }
}

/** Keeps something of a fixed size (the live-voice command bar) on screen, moving but never resizing it. */
export function clampPosition(rect: Rect, viewport: ViewportSize): Rect {
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(MARGIN, rect.x), Math.max(MARGIN, viewport.width - rect.w - MARGIN))),
    y: Math.round(Math.min(Math.max(MARGIN, rect.y), Math.max(MARGIN, viewport.height - rect.h - MARGIN))),
  }
}

/** Places the window can snap to, like a desktop's window tiling (the farm's set). */
export const SNAPS = [
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'left-third',
  'middle-third',
  'right-third',
  'full',
] as const
export type Snap = (typeof SNAPS)[number]

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
/** Ctrl+Option+C, as Rectangle's "Center": back to the default centered card. */
export const DEFAULT_PLACEMENT_KEY = { code: 'KeyC', key: 'C' }

/** Whether a key is the default-placement shortcut. */
export function isDefaultPlacementKey(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'code'>
): boolean {
  return e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.code === DEFAULT_PLACEMENT_KEY.code
}

export function snapForKey(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'code'>
): Snap | null {
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return null
  return SNAPS.find((snap) => SNAP_INFO[snap].code === e.code) ?? null
}

/** The part of the screen a snap fills. */
export function snapRect(snap: Snap, viewport: ViewportSize): Rect {
  const left = MARGIN
  const top = MARGIN
  const width = Math.max(0, viewport.width - MARGIN * 2)
  const height = Math.max(0, viewport.height - MARGIN * 2)
  const half = (size: number) => (size - SNAP_GAP) / 2
  const third = (width - SNAP_GAP * 2) / 3
  const box = (x: number, y: number, w: number, h: number) => ({
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  })
  switch (snap) {
    case 'left':
      return box(left, top, half(width), height)
    case 'right':
      return box(left + half(width) + SNAP_GAP, top, half(width), height)
    case 'top':
      return box(left, top, width, half(height))
    case 'bottom':
      return box(left, top + half(height) + SNAP_GAP, width, half(height))
    case 'top-left':
      return box(left, top, half(width), half(height))
    case 'top-right':
      return box(left + half(width) + SNAP_GAP, top, half(width), half(height))
    case 'bottom-left':
      return box(left, top + half(height) + SNAP_GAP, half(width), half(height))
    case 'bottom-right':
      return box(left + half(width) + SNAP_GAP, top + half(height) + SNAP_GAP, half(width), half(height))
    case 'left-third':
      return box(left, top, third, height)
    case 'middle-third':
      return box(left + third + SNAP_GAP, top, third, height)
    case 'right-third':
      return box(left + (third + SNAP_GAP) * 2, top, third, height)
    case 'full':
      return box(left, top, width, height)
  }
}

/** Where the window is for a placement on this screen, or undefined for the default command center. */
export function placedRect(placement: AssistantWindowPlacement, viewport: ViewportSize): Rect | undefined {
  if (placement.snap) return snapRect(placement.snap, viewport)
  return placement.rect ? clampRect(placement.rect, viewport) : undefined
}

function isRect(value: unknown): value is Rect {
  const rect = value as Partial<Rect> | null
  return !!rect && [rect.x, rect.y, rect.w, rect.h].every((part) => typeof part === 'number' && Number.isFinite(part))
}

export function readAssistantWindow(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage()
): AssistantWindowPlacement {
  try {
    const value = JSON.parse(storage?.getItem(ASSISTANT_WINDOW_STORAGE_KEY) ?? 'null') as {
      rect?: unknown
      snap?: unknown
    } | null
    return {
      ...(isRect(value?.rect) ? { rect: value.rect } : {}),
      ...(SNAPS.includes(value?.snap as Snap) ? { snap: value!.snap as Snap } : {}),
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
