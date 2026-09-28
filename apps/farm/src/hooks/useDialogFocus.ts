import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0
  )
}

/**
 * Keyboard focus for a dialog or panel: it moves in when it opens (to
 * `initial`, else the first control), goes back where it was when it closes,
 * and, for a modal (`trap`), Tab and Shift+Tab stay inside it.
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  { trap = false, initial }: { trap?: boolean; initial?: string } = {}
): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = (initial ? root.querySelector<HTMLElement>(initial) : null) ?? focusables(root)[0] ?? root
    first.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      if (!trap || e.key !== 'Tab') return
      const list = focusables(root)
      if (!list.length) return
      const head = list[0]!
      const tail = list[list.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === head || !root.contains(active))) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && (active === tail || !root.contains(active))) {
        e.preventDefault()
        head.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Back to what opened it, if that's still on the page.
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
    // Opening and closing are mount and unmount (the options are constants per dialog).
  }, [ref, trap, initial])
}
