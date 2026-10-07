import { useEffect, type RefObject } from 'react'

export interface VisualViewportLike {
  height: number
  offsetTop: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

export interface VisualViewportShellDependencies {
  viewport?: VisualViewportLike | null
  /** Layout viewport height the visual viewport is compared against. */
  innerHeight?: () => number
  /** Reset the visual viewport's own scroll offset (Safari scrolls fixed pages to reveal inputs). */
  resetScroll?: () => void
}

/** Below this many pixels of difference the visual viewport is treated as full height (browser chrome jitter). */
export const KEYBOARD_OPEN_THRESHOLD_PX = 80

/** A focused field closer than this to the visible edge is scrolled; once scrolling, this much room is kept around it. */
export const FIELD_REVEAL_MARGIN_PX = 12

/** A label or action at most this far from the field reads with it and is revealed alongside it. */
export const FIELD_CONTEXT_REACH_PX = 96

/** Pure decision: should the shell be pinned to the visual viewport height? */
export function keyboardShellHeight(viewportHeight: number, layoutHeight: number): number | null {
  return layoutHeight - viewportHeight > KEYBOARD_OPEN_THRESHOLD_PX ? Math.round(viewportHeight) : null
}

export interface VerticalSpan {
  top: number
  bottom: number
}

/**
 * Pure decision: how far a scroll container should scroll (positive = down) to reveal a focused
 * field inside the visible part of that container.
 *
 * `field` is the focused control, `context` is the field plus what reads with it (its label above,
 * the form's next action below) and `view` is the visible part of the container. A field that is
 * already comfortably visible is left alone, so the chat composer and anything the person scrolled
 * to deliberately never move. Otherwise the label (or, failing that, the field's top) stays in
 * view first and the trailing context is revealed as far as the space allows.
 */
export function revealScrollDelta(field: VerticalSpan, context: VerticalSpan, view: VerticalSpan): number {
  if (field.top >= view.top && field.bottom <= view.bottom - FIELD_REVEAL_MARGIN_PX) return 0
  const lead = Math.min(field.top, context.top) - FIELD_REVEAL_MARGIN_PX
  if (field.top < view.top) return Math.min(0, lead - view.top)
  const trail = Math.max(field.bottom, context.bottom) + FIELD_REVEAL_MARGIN_PX
  const limit = lead >= view.top ? lead - view.top : field.top - view.top
  return Math.max(0, Math.min(trail - view.bottom, limit))
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** True for controls that raise the software keyboard (or iOS's picker in its place). */
export function isKeyboardField(element: Element | null): element is HTMLElement {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(((element as HTMLInputElement).type || 'text').toLowerCase())
  return (element as HTMLElement).isContentEditable === true
}

function span(element: Element): VerticalSpan {
  const { top, bottom } = element.getBoundingClientRect()
  return { top, bottom }
}

/** The field's own extent plus its label just above and the form's next action just below. */
function fieldContext(field: HTMLElement, own: VerticalSpan): VerticalSpan {
  let { top, bottom } = own
  const labels = (field as HTMLInputElement).labels
  const label = (labels && labels.length > 0 ? labels[0] : null) ?? field.closest('label')
  if (label) {
    const box = span(label)
    if (box.top <= own.top && own.top - box.top <= FIELD_CONTEXT_REACH_PX) top = box.top
  }
  const form = (field as HTMLInputElement).form ?? field.closest('form')
  const next = form
    ? Array.from(form.querySelectorAll('button, input[type="submit"]')).find(
        (action) => (field.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      )
    : undefined
  if (next) {
    const box = span(next)
    if (box.bottom > own.bottom && box.top - own.bottom <= FIELD_CONTEXT_REACH_PX) bottom = box.bottom
  }
  return { top, bottom }
}

function scrollsVertically(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 1) return false
  const overflowY = element.ownerDocument.defaultView?.getComputedStyle(element).overflowY
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
}

/**
 * Scroll a focused field into the visible part of the shell through its own scroll containers,
 * nearest first. Only element `scrollTop` changes: `scrollIntoView` would also pan iOS's visual
 * viewport over the fixed page, which is exactly the shift the shell sizing undoes.
 */
export function revealFieldInShell(field: HTMLElement, shell: HTMLElement): void {
  const shellBox = span(shell)
  for (let container = field.parentElement; container && container !== shell; container = container.parentElement) {
    if (!scrollsVertically(container)) continue
    const box = span(container)
    const view = { top: Math.max(box.top, shellBox.top), bottom: Math.min(box.bottom, shellBox.bottom) }
    if (view.bottom <= view.top) continue
    const own = span(field)
    const delta = revealScrollDelta(own, fieldContext(field, own), view)
    if (delta !== 0) container.scrollTop += delta
  }
}

/**
 * Keep the fixed app shell the size of the visible area while the software keyboard is open.
 *
 * `html`/`body`/`#root` are locked to 100% and the body is `position: fixed`, so the layout
 * viewport does not shrink when iOS shows the keyboard. Safari then scrolls the visual viewport
 * over the fixed page to reveal the focused composer, which drags the whole shell (composer, dock,
 * everything) upward and leaves a blank band where the shell extends under the keyboard. Sizing
 * the shell to the visual viewport and resetting that scroll keeps the composer just above the
 * keyboard with the transcript scrolling inside. Desktop browsers never trip the threshold.
 *
 * Shrinking the shell can leave a field on an ordinary scrolling page (settings, forms) below the
 * new bottom edge, where Safari pans the page to find it again: the shell rides up and the body
 * shows through below it. So while the keyboard is open, the focused field inside the shell is
 * scrolled into view within its own scroll containers whenever the visible height changes,
 * Safari pans, or focus moves, and the page reads as an ordinary scrolling page above the keyboard.
 */
export function useVisualViewportShell(
  ref: RefObject<HTMLElement | null>,
  dependencies: VisualViewportShellDependencies = {}
): void {
  useEffect(() => {
    const viewport =
      dependencies.viewport !== undefined
        ? dependencies.viewport
        : typeof window === 'undefined'
          ? null
          : (window.visualViewport as VisualViewportLike | null)
    if (!viewport) return
    const innerHeight = dependencies.innerHeight ?? (() => window.innerHeight)
    const resetScroll = dependencies.resetScroll ?? (() => window.scrollTo(0, 0))
    let pinnedHeight: number | null = null
    const revealFocusedField = () => {
      const element = ref.current
      if (!element || pinnedHeight === null) return
      const focused = element.ownerDocument.activeElement
      if (isKeyboardField(focused) && element.contains(focused)) revealFieldInShell(focused, element)
    }
    const update = () => {
      const element = ref.current
      if (!element) return
      const height = keyboardShellHeight(viewport.height, innerHeight())
      const panned = viewport.offsetTop > 0
      const resized = height !== pinnedHeight
      pinnedHeight = height
      if (height === null) {
        element.style.removeProperty('height')
        element.style.removeProperty('max-height')
        delete element.dataset.keyboard
      } else {
        element.style.height = `${height}px`
        element.style.maxHeight = `${height}px`
        element.dataset.keyboard = 'open'
        // The shell just got shorter, or Safari panned to find the field: bring the field into the
        // shell's visible area so Safari has nothing left to reveal by panning the page.
        if (resized || panned) revealFocusedField()
      }
      // Whatever the browser scrolled to reveal the input is now inside the shell; undo the shift.
      if (panned) resetScroll()
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    const focusTarget = typeof document === 'undefined' ? null : document
    focusTarget?.addEventListener('focusin', revealFocusedField)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      focusTarget?.removeEventListener('focusin', revealFocusedField)
      const element = ref.current
      if (!element) return
      element.style.removeProperty('height')
      element.style.removeProperty('max-height')
      delete element.dataset.keyboard
    }
  }, [ref, dependencies.viewport, dependencies.innerHeight, dependencies.resetScroll])
}
