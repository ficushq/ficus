import { isDefaultPlacementKey, snapForKey, type Snap } from './floatingWindow'

/**
 * Every floating window on the page (the assistant and agent chat windows) registers here, so the
 * Ctrl+Option snap and center shortcuts reach exactly one of them: the window holding keyboard focus,
 * otherwise the frontmost one. A window the user is not using never moves.
 */
export interface FloatingWindowEntry {
  /** The window's frame element, to tell whether focus is inside it. */
  element: () => HTMLElement | null
  /** Its place in the stack: higher is in front. */
  z: () => number
  /** Shown and arrangeable right now (not closed, minimized, or the compact voice bar). */
  visible: () => boolean
  snap: (snap: Snap) => void
  /** Ctrl+Option+C: the assistant's default card, or an agent window centered. */
  center: () => void
}

const entries = new Map<string, FloatingWindowEntry>()

function inside(entry: FloatingWindowEntry, node: Node | null | undefined) {
  const element = entry.element()
  return !!node && !!element && element.contains(node)
}

/**
 * The window a keyboard command is for: the one containing `target` (or, failing that, the focused
 * element), else the frontmost visible window. Undefined when no window is showing.
 */
export function activeFloatingWindow(target?: EventTarget | null): string | undefined {
  const nodes = [target as Node | null | undefined, typeof document === 'undefined' ? null : document.activeElement]
  for (const node of nodes) {
    if (!node || typeof (node as Node).nodeType !== 'number') continue
    for (const [key, entry] of entries) if (inside(entry, node)) return entry.visible() ? key : undefined
  }
  let front: [string, number] | undefined
  for (const [key, entry] of entries) {
    if (!entry.visible()) continue
    const z = entry.z()
    if (!front || z > front[1]) front = [key, z]
  }
  return front?.[0]
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  const center = isDefaultPlacementKey(event)
  const snap = center ? null : snapForKey(event)
  if (!center && !snap) return
  const key = activeFloatingWindow(event.target)
  const entry = key ? entries.get(key) : undefined
  if (!entry) return
  event.preventDefault()
  if (snap) entry.snap(snap)
  else entry.center()
}

let listening: Document | null = null

function listen(next: Document | null) {
  if (listening === next) return
  listening?.removeEventListener('keydown', onKeyDown)
  next?.addEventListener('keydown', onKeyDown)
  listening = next
}

/** Adds a window; the returned function removes it. One document listener serves them all. */
export function registerFloatingWindow(key: string, entry: FloatingWindowEntry): () => void {
  entries.set(key, entry)
  listen(typeof document === 'undefined' ? null : document)
  return () => {
    if (entries.get(key) !== entry) return
    entries.delete(key)
    if (!entries.size) listen(null)
  }
}
