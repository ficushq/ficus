import { useLayoutEffect, type RefObject } from 'react'
import { useStableRef } from './useStableRef'

export type PopupDismissReason = 'pointer' | 'escape' | 'focus'

export interface PopupDismissOptions {
  /** Listeners exist only while this is true, so a page of closed popups costs nothing. */
  open: boolean
  /** The popup surface. It may be portaled anywhere. */
  popup: RefObject<HTMLElement | null>
  /** The control that opened it. Presses on it are inside (it toggles itself); Escape returns focus to it. */
  trigger?: RefObject<HTMLElement | null>
  /** Further regions that count as inside, e.g. a second portaled surface. */
  inside?: readonly RefObject<HTMLElement | null>[]
  onDismiss: (reason: PopupDismissReason) => void
  /** Close on Escape. Off only for a combobox whose own key handler owns Escape. Default true. */
  escape?: boolean
  /** On Escape, focus the trigger after dismissing. Default true. */
  restoreFocus?: boolean
  /** Close when keyboard focus leaves (see the rules below). Default true. */
  focusOut?: boolean
}

interface StackEntry {
  regions: () => HTMLElement[]
  escape: () => boolean
}

// Every open popup, in opening order. A popup opened while another stays open is nested in it
// (its trigger is inside the outer one, or a press there would have closed the outer one), so a
// press or focus inside a LATER entry counts as inside every earlier one, even when the inner
// popup is portaled elsewhere in the DOM. The last entry that handles Escape consumes it.
const stack: StackEntry[] = []

/** How long after a pointerup without a click an inside press still shields focus loss. iOS sends
 *  its compatibility mouse events (and so the focus change and the click) only after touchend. */
const PRESS_GRACE_MS = 600

/**
 * The ONE way a popup (menu, popover, disclosure panel, preview card) dismisses itself. Every
 * popup in `apps/web` uses it; `components/popupDismissal.guard.test.ts` fails the build on a
 * component that closes a popup from its own onBlur/focusout handler, reads `relatedTarget`, or adds
 * its own outside-press listener (with a tiny, reasoned allowlist for non-popup uses). Tap tests use
 * `test/webkitTap.ts`, which delivers a tap the way WebKit does.
 *
 * It closes on exactly three things:
 *
 * 1. A pointer press outside the popup, its trigger, the `inside` regions, and any popup opened
 *    on top of it. Insideness is read from `event.composedPath()`, so portaled content counts when
 *    its root is passed as a region. Never steals focus.
 * 2. Escape, consumed by the most recently opened popup in the window CAPTURE phase with
 *    `preventDefault` + `stopImmediatePropagation`, before document-level modal, drawer and app
 *    shortcuts. Returns focus to the trigger unless `restoreFocus` is false.
 * 3. Keyboard focus leaving: a `focusout` from inside whose new focus target is a known element
 *    outside the popup, its trigger and anything stacked above it, AND is not an ancestor of the
 *    popup or trigger, AND happens while no pointer press that began inside is in progress.
 *
 * Why the focus rule is so narrow (the WebKit rule — do not loosen it): in Safari and every iOS
 * browser, pressing a `<button>` does NOT focus it. WebKit focuses the nearest mouse-focusable
 * ANCESTOR instead (any element with a `tabindex`, such as a settings `<section tabIndex={-1}>`
 * or a dialog), or blurs to `null`/body when there is none. Pressing a non-focusable label does
 * the same in every browser. So tapping an item inside an open popup blurs the focused item with a
 * `relatedTarget` that is outside the popup — an ancestor — or null, BEFORE the item's click. A
 * popup that closed on that blur unmounted (or made `inert`, via `Presence`) the item before its
 * click arrived, and the tap silently did nothing. Chrome, Playwright Chromium and happy-dom all
 * focus the pressed button, so no test caught it; that is how this bug kept coming back (PRs 44
 * and 203, then the Mobile & Pro overflow menu).
 *
 * The rules that follow, for every popup:
 * - A blur caused by a pointer interaction never closes a popup: presses that start inside are
 *   tracked from pointerdown until just after the following click (or a short grace period after
 *   pointerup/pointercancel), and focus loss during them is ignored.
 * - A focus move to null/body or to an ancestor of the popup never closes it; only a pointer press
 *   outside or Escape does.
 * - Item activation closes the popup from the item's own click handler, after the action.
 * - Never close a popup from a component's own `onBlur`/`focusout`, or attach a bespoke
 *   outside-`pointerdown`/`mousedown` listener. Use this hook; if a popup needs different
 *   behavior, add an option here.
 */
export function usePopupDismiss({
  open,
  popup,
  trigger,
  inside,
  onDismiss,
  escape = true,
  restoreFocus = true,
  focusOut = true,
}: PopupDismissOptions) {
  const latest = useStableRef({ popup, trigger, inside, onDismiss, escape, restoreFocus, focusOut })

  // Layout phase: registered (and on the stack) before any initial-focus effect of this popup or one
  // opened inside it runs.
  useLayoutEffect(() => {
    if (!open) return
    let active = true
    const regions = () => {
      const { popup, trigger, inside = [] } = latest.current
      return [popup, trigger, ...inside].flatMap((ref) => (ref?.current ? [ref.current] : []))
    }
    const entry: StackEntry = { regions, escape: () => latest.current.escape }
    stack.push(entry)
    // Own regions plus every popup opened on top of this one.
    const insideRegions = () => {
      const index = stack.indexOf(entry)
      return [...regions(), ...stack.slice(index + 1).flatMap((above) => above.regions())]
    }
    const isInsideNode = (node: unknown) =>
      node instanceof Node && insideRegions().some((region) => region.contains(node))
    const isInsideEvent = (event: Event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      if (path.length) {
        const all = insideRegions()
        return path.some((node) => all.includes(node as HTMLElement))
      }
      return isInsideNode(event.target)
    }

    let pressing = false
    let release: ReturnType<typeof setTimeout> | undefined
    const endPressAfter = (ms: number) => {
      clearTimeout(release)
      release = setTimeout(() => {
        pressing = false
      }, ms)
    }

    const onPointerDown = (event: Event) => {
      if (isInsideEvent(event)) {
        pressing = true
        clearTimeout(release)
        return
      }
      latest.current.onDismiss('pointer') // never steal focus from what the user just targeted
    }
    const onPointerUp = () => {
      if (pressing) endPressAfter(PRESS_GRACE_MS)
    }
    // Capture, then release on the next task: focus moves made BY the click's handlers (opening a
    // dialog, returning focus to the trigger) are still part of the press.
    const onClick = () => {
      if (pressing) endPressAfter(0)
    }
    const leftFocus = (next: unknown) => {
      // null/body: WebKit's tap fallback, a window switch, or Tab off the end of the document.
      if (!(next instanceof Node) || next === document.body) return false
      if (isInsideNode(next)) return false
      // An ancestor: WebKit's tap fallback (or a label press) focusing the nearest focusable container.
      return !regions().some((region) => next.contains(region))
    }
    const onFocusOut = (event: FocusEvent) => {
      if (!latest.current.focusOut || pressing || !isInsideNode(event.target) || !leftFocus(event.relatedTarget)) return
      // Decide once the focus move has settled: a popup opening on top of this one moves focus into
      // itself before (or in the same commit as) registering, and focus may already be back inside.
      queueMicrotask(() => {
        if (!active || pressing || !leftFocus(event.relatedTarget)) return
        const now = document.activeElement
        if (now !== event.target && isInsideNode(now)) return
        latest.current.onDismiss('focus')
      })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      const top = [...stack].reverse().find((candidate) => candidate.escape())
      if (top !== entry) return
      event.preventDefault()
      event.stopImmediatePropagation()
      latest.current.onDismiss('escape')
      if (latest.current.restoreFocus) latest.current.trigger?.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      active = false
      clearTimeout(release)
      stack.splice(stack.indexOf(entry), 1)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, latest])
}
