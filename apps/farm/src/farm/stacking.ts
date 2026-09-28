import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'

/*
 * One stacking order for everything that floats over the farm (the pop-up
 * card, chat windows, farm chat, the Look panel, the list): whatever you last
 * opened, clicked or focused is in front, and the rest keep the order you last
 * used them in. The welcome and phone sheets stay above it all.
 */

/** z-index of the backmost floating thing; each one in front is one higher. */
const BASE = 40

let order: readonly string[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Brings something to the front. */
export function raise(key: string): void {
  if (order[order.length - 1] === key) return
  order = [...order.filter((k) => k !== key), key]
  emit()
}

function drop(key: string): void {
  if (!order.includes(key)) return
  order = order.filter((k) => k !== key)
  emit()
}

/** Back to front, for tests. */
export function stackingOrder(): readonly string[] {
  return order
}

/**
 * A floating thing's place in the stack. It comes to the front when it opens
 * and whenever `raiseOn` changes (e.g. the card shows something new); spread
 * `onPointerDownCapture` and `onFocusCapture` on it so using it brings it forward.
 */
export function useStacking(key: string, raiseOn?: unknown) {
  const index = useSyncExternalStore(subscribe, () => order.indexOf(key))
  useLayoutEffect(() => {
    raise(key)
  }, [key, raiseOn])
  useLayoutEffect(() => () => drop(key), [key])
  const front = useCallback(() => raise(key), [key])
  return { zIndex: BASE + Math.max(0, index), onPointerDownCapture: front, onFocusCapture: front }
}
