import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * The chat composer's control row, measured in CSS pixels: what decides whether its actions fit inline
 * beside the right-hand group or fold behind the More controls trigger.
 */
export type ComposerRowWidths = {
  /** The row's own width (the composer's width). */
  row: number
  /** The inline actions at their natural width, measured even while they are folded away. */
  actions: number
  /** The status beside the actions (the context indicator, a state word), or null when none is shown. */
  status: number | null
  /** The right-hand group as it is right now: Send, or Stop with the Interrupt / Follow up split button. */
  send: number
  /** The gap between the leading group and the right-hand group. */
  rowGap: number
  /** The gap between the actions and the status. */
  leadGap: number
}

/**
 * How much wider than the inline row the composer must be before folded actions come back. Without it a
 * width at the boundary (a window resized a pixel at a time, a ticking recording timer, the Auto hint
 * coming and going) would fold and unfold on every change.
 */
export const COMPOSER_UNFOLD_MARGIN = 16

/** The width the row needs to hold every action inline, the status and the right-hand group on one line. */
export function inlineComposerWidth(widths: ComposerRowWidths): number {
  const status = widths.status === null ? 0 : widths.leadGap + widths.status
  return widths.actions + status + widths.rowGap + widths.send
}

/**
 * Whether the actions should be folded, given whether they are now. They fold as soon as the inline row
 * would not fit, and unfold only once it fits with COMPOSER_UNFOLD_MARGIN to spare. A row with no width
 * (not laid out, or in a hidden tab) keeps its current state.
 */
export function nextComposerFolded(folded: boolean, widths: ComposerRowWidths): boolean {
  if (widths.row <= 0) return folded
  const needed = inlineComposerWidth(widths)
  // Half a pixel absorbs subpixel rounding between the boxes and the row.
  return folded ? needed > widths.row - COMPOSER_UNFOLD_MARGIN : needed > widths.row + 0.5
}

export type ComposerFitRefs = {
  row: RefObject<HTMLElement | null>
  actions: RefObject<HTMLElement | null>
  status: RefObject<HTMLElement | null>
  send: RefObject<HTMLElement | null>
  lead: RefObject<HTMLElement | null>
}

function gap(element: HTMLElement | null): number {
  if (!element) return 0
  const view = element.ownerDocument.defaultView
  const value = view ? parseFloat(view.getComputedStyle(element).columnGap) : NaN
  return Number.isFinite(value) ? value : 0
}

const width = (element: HTMLElement) => element.getBoundingClientRect().width

/** Reads the row's widths; null until every part it needs is mounted. */
export function measureComposerRow(refs: ComposerFitRefs): ComposerRowWidths | null {
  const row = refs.row.current
  const actions = refs.actions.current
  const send = refs.send.current
  if (!row || !actions || !send) return null
  const status = refs.status.current
  return {
    row: width(row),
    actions: width(actions),
    // A status rendering nothing is display: none, and takes no gap.
    status: status && status.getClientRects().length > 0 ? width(status) : null,
    send: width(send),
    rowGap: gap(row),
    leadGap: gap(refs.lead.current),
  }
}

/**
 * Folds the composer's actions behind its More controls trigger whenever they would not fit on one line
 * beside the status and the right-hand group, whatever that group holds right now. Everything is measured
 * by ResizeObserver, so the decision follows the composer's width, the right-hand group growing from Send
 * to Stop with Interrupt / Follow up (or a "Sending..." label), a recording timer, and font or zoom
 * changes. The first observation arrives before the first paint, and later changes are applied
 * synchronously, so a row that no longer fits is never painted wrapped in between.
 * onChange runs with each new decision.
 */
export function useComposerFit(refs: ComposerFitRefs, onChange?: (folded: boolean) => void): boolean {
  const [folded, setFolded] = useState(false)
  const foldedRef = useRef(false)
  const onChangeRef = useRef(onChange)
  useLayoutEffect(() => {
    onChangeRef.current = onChange
  })
  const { row, actions, status, send, lead } = refs
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const parts = { row, actions, status, send, lead }
    const observer = new ResizeObserver(() => {
      const widths = measureComposerRow(parts)
      if (!widths) return
      const next = nextComposerFolded(foldedRef.current, widths)
      if (next === foldedRef.current) return
      foldedRef.current = next
      flushSync(() => setFolded(next))
      onChangeRef.current?.(next)
    })
    for (const element of [row.current, actions.current, status.current, send.current]) {
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [row, actions, status, send, lead])
  return folded
}
