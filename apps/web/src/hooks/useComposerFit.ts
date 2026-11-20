import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * How the chat composer's control row makes room, least to most:
 * - inline: every action beside the status and the right-hand group;
 * - folded: the actions behind the More controls trigger;
 * - compact: folded, and the right-hand group drops its Auto hint (Interrupt / Follow up still says it is
 *   suggested in its label and tooltip).
 * A compact row's status text (a state word, the Assistant's routing chip label) then truncates, and is
 * hidden (`terse`) once fewer than COMPOSER_TEXT_MIN pixels of it would show; the context ring and the
 * chip's icon stay. `wrap` is the last resort, for a row where even that cannot share a line.
 */
export type ComposerLevel = 'inline' | 'folded' | 'compact'
export type ComposerLayout = { level: ComposerLevel; terse: boolean; wrap: boolean }

const RANK: Record<ComposerLevel, number> = { inline: 0, folded: 1, compact: 2 }

/** The row's parts, measured in CSS pixels. */
export type ComposerRowWidths = {
  /** The row's own width (the composer's width). */
  row: number
  /** The inline actions at their natural width, measured even while they are folded away. */
  actions: number
  /** The More controls trigger, or null while it is hidden (the actions are inline). */
  trigger: number | null
  /** The status beside the actions (the context indicator, a state word) at its natural width, or null when none is shown. */
  status: number | null
  /** The part of the status that cannot shrink: the status without its truncating text (its gap kept). */
  statusMin: number
  /** The status's truncating text at its whole width (0 when there is none). */
  text: number
  /** The right-hand group with its Auto hint, as it is right now: Send, or Stop with Interrupt / Follow up. */
  send: number
  /** What the Auto hint adds to the right-hand group (0 when there is none): what compact saves. */
  hint: number
  /** The gap between the leading group and the right-hand group. */
  rowGap: number
  /** The gap between the leading group's items (the actions or the trigger, and the status). */
  leadGap: number
}

/**
 * How much room a more collapsed row must have to spare before it expands again. Without it a width at
 * the boundary (a window resized a pixel at a time, a ticking recording timer, the Auto hint coming and
 * going) would fold and unfold on every change.
 */
export const COMPOSER_UNFOLD_MARGIN = 16

/** The least of a status text worth showing truncated; any less (a lone "W…") and it is hidden. */
export const COMPOSER_TEXT_MIN = 48

const withStatus = (widths: ComposerRowWidths, status: number | null) => (status === null ? 0 : widths.leadGap + status)

/** What one line needs at each level, and at the smallest the row can get (compact, status shrunk). */
export function composerNeeds(widths: ComposerRowWidths, trigger = widths.trigger ?? 0) {
  const right = widths.rowGap + widths.send
  const lead = trigger + withStatus(widths, widths.status)
  return {
    inline: widths.actions + withStatus(widths, widths.status) + right,
    folded: lead + right,
    compact: lead + right - widths.hint,
    minimum: trigger + withStatus(widths, widths.status === null ? null : widths.statusMin) + right - widths.hint,
  }
}

/**
 * The row's next layout, given its current one. It collapses as soon as a level no longer fits, and
 * expands only once the less collapsed level fits with COMPOSER_UNFOLD_MARGIN to spare. While the actions
 * are inline the trigger's width is unknown, so a row that no longer fits goes to folded and is measured
 * again from there. `floor` keeps a phone's row folded. A row with no width (not laid out, or in a hidden
 * tab) keeps its layout.
 */
export function nextComposerLayout(
  current: ComposerLayout,
  widths: ComposerRowWidths,
  floor: ComposerLevel = 'inline'
): ComposerLayout {
  if (widths.row <= 0) return current
  const needs = composerNeeds(widths)
  // Half a pixel absorbs subpixel rounding between the boxes and the row.
  const fits = (needed: number, collapsing: boolean) =>
    collapsing ? needed <= widths.row + 0.5 : needed <= widths.row - COMPOSER_UNFOLD_MARGIN
  const rank = RANK[current.level]
  let level: ComposerLevel
  if (RANK[floor] === 0 && fits(needs.inline, rank <= 0)) level = 'inline'
  else if (widths.trigger === null || fits(needs.folded, rank <= 1)) level = 'folded'
  else level = 'compact'
  if (RANK[level] < RANK[floor]) level = floor
  const compact = level === 'compact' && widths.trigger !== null
  // Text that would show less than COMPOSER_TEXT_MIN goes; it comes back with the margin to spare.
  const terse = compact && widths.text > 0 && !fits(needs.minimum + COMPOSER_TEXT_MIN, !current.terse)
  // Start wrapping only once the minimum no longer fits; stop only once it fits with the margin to spare.
  const wrap = compact && !fits(needs.minimum, !current.wrap)
  return level === current.level && terse === current.terse && wrap === current.wrap ? current : { level, terse, wrap }
}

export type ComposerFitRefs = {
  row: RefObject<HTMLElement | null>
  lead: RefObject<HTMLElement | null>
  trigger: RefObject<HTMLElement | null>
  actions: RefObject<HTMLElement | null>
  status: RefObject<HTMLElement | null>
  send: RefObject<HTMLElement | null>
}

function gap(element: Element | null): number {
  const value = element ? parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).columnGap ?? '') : NaN
  return Number.isFinite(value) ? value : 0
}

const width = (element: Element) => element.getBoundingClientRect().width
const shown = (element: Element | null): element is HTMLElement => !!element && element.getClientRects().length > 0

/**
 * Reads the row's widths; null until every part it needs is mounted. `layout` is how the row is laid out
 * now: compact takes the Auto hint out of the flow, terse the status text (both stay measurable).
 */
export function measureComposerRow(refs: ComposerFitRefs, layout: ComposerLayout): ComposerRowWidths | null {
  const row = refs.row.current
  const actions = refs.actions.current
  const send = refs.send.current
  if (!row || !actions || !send) return null
  const trigger = refs.trigger.current
  // A status rendering nothing is display: none, and takes no gap.
  const status = refs.status.current
  let statusWidth: number | null = null
  let statusMin = 0
  let text = 0
  if (shown(status)) {
    // The status may be squeezed narrower than its content (its parts that cannot shrink then overflow
    // it), so its content's extent counts. Truncating text counts at its whole width, and not at all in
    // the minimum, as it can shrink away.
    const extent = Math.max(width(status), status.scrollWidth)
    const truncating = [...status.querySelectorAll('.truncate')]
    // Hidden (terse), the text is out of the flow and its gap is gone; otherwise both are in the extent.
    const shownText = layout.terse
      ? -truncating.reduce((sum, el) => sum + gap(el.parentElement), 0)
      : truncating.reduce((sum, el) => sum + width(el), 0)
    // A truncated text's scrollWidth is its whole text.
    text = truncating.reduce((sum, el) => sum + Math.max(width(el), el.scrollWidth), 0)
    statusMin = extent - shownText
    statusWidth = statusMin + text
  }
  // While compact the Auto hint is out of the flow (laid out but hidden), so the group is that much narrower.
  const hintElement = send.querySelector('.chat-composer-auto')
  const hint = hintElement ? width(hintElement) + gap(hintElement.parentElement) : 0
  return {
    row: width(row),
    actions: width(actions),
    trigger: shown(trigger) ? width(trigger) : null,
    status: statusWidth,
    statusMin,
    text,
    send: width(send) + (layout.level === 'compact' ? hint : 0),
    hint,
    rowGap: gap(row),
    leadGap: gap(refs.lead.current),
  }
}

const INLINE: ComposerLayout = { level: 'inline', terse: false, wrap: false }

/**
 * Lays out the composer's control row by measured space: the actions fold behind its More controls
 * trigger whenever they would not fit on one line beside the status and the right-hand group, whatever
 * that group holds right now, and the Auto hint goes next (see ComposerLevel). Everything is measured by
 * ResizeObserver, plus a MutationObserver for content that changes without resizing anything observed, so
 * the layout follows the composer's width, the right-hand group growing from Send to Stop with
 * Interrupt / Follow up (or a "Sending..." label), a state word, a recording timer, and font or zoom
 * changes. The first observation arrives before the first paint, and each change is committed and
 * measured again synchronously, so a row that no longer fits is never painted wrapped in between.
 * `floor` is the least collapsed level allowed (folded on a phone). onChange runs with each new layout.
 */
export function useComposerFit(
  refs: ComposerFitRefs,
  { floor = 'inline', onChange }: { floor?: ComposerLevel; onChange?: (layout: ComposerLayout) => void } = {}
): ComposerLayout {
  const [layout, setLayout] = useState<ComposerLayout>(INLINE)
  const layoutRef = useRef(INLINE)
  const onChangeRef = useRef(onChange)
  useLayoutEffect(() => {
    onChangeRef.current = onChange
  })
  const { row, lead, trigger, actions, status, send } = refs
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const parts = { row, lead, trigger, actions, status, send }
    const update = () => {
      // Each change shows or hides the trigger, the hint or the status text, so measure again; inline to
      // compact takes two changes and a pass to confirm, and a bound keeps any rounding from looping.
      for (let pass = 0; pass < 4; pass++) {
        const widths = measureComposerRow(parts, layoutRef.current)
        if (!widths) return
        const next = nextComposerLayout(layoutRef.current, widths, floor)
        if (next === layoutRef.current) return
        layoutRef.current = next
        flushSync(() => setLayout(next))
        onChangeRef.current?.(next)
      }
    }
    const resize = new ResizeObserver(update)
    for (const element of [row.current, actions.current, status.current, send.current]) {
      if (element) resize.observe(element)
    }
    // Content that changes while its box keeps its size: a state word inside a shrunk status, or the
    // Auto hint appearing while it is hidden.
    const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update)
    for (const element of [status.current, send.current]) {
      if (element) mutation?.observe(element, { childList: true, subtree: true, characterData: true })
    }
    // Observing delivers a first measurement before the next paint, also after a new floor (a phone
    // rotated past 767px) re-creates the observers.
    return () => {
      resize.disconnect()
      mutation?.disconnect()
    }
  }, [row, lead, trigger, actions, status, send, floor])
  return layout
}
