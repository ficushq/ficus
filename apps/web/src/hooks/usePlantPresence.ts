import { useEffect, useState, type AnimationEvent } from 'react'

/** How long the plant's jump out of sight takes (index.css .ficus-plant-peek), the fallback if animationend never fires. */
export const PLANT_HIDE_MS = 600

/**
 * Mount state for a working plant that pops into view and jumps back out of
 * sight (index.css .ficus-plant-peek): `shown` turns on with `visible`, then
 * stays on after it turns off until the exit animation ends, so the plant is
 * kept mounted just for its retreat. Reduced motion has no animation, so it
 * hides at once. Spread `state` and `onAnimationEnd` onto the
 * `.ficus-plant-peek` element as `data-state` and its handler.
 */
export function usePlantPresence(visible: boolean) {
  const [shown, setShown] = useState(visible)
  if (visible && !shown) setShown(true)

  useEffect(() => {
    if (visible || !shown) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(false)
      return
    }
    const timeout = window.setTimeout(() => setShown(false), PLANT_HIDE_MS + 80)
    return () => window.clearTimeout(timeout)
  }, [visible, shown])

  return {
    shown,
    state: visible ? ('in' as const) : ('out' as const),
    onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
      if (!visible && event.target === event.currentTarget) setShown(false)
    },
  }
}
