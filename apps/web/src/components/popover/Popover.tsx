import clsx from 'clsx'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AriaRole,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { usePopupDismiss, type PopupDismissReason } from '../../hooks/usePopupDismiss'
import { useStableRef } from '../../hooks/useStableRef'
import type { Box, PopupAlign, PopupSide } from '../../lib/popupPosition'
import { Presence } from '../Presence'
import { focusInPopover, initialTarget, tabbables } from './focus'
import { usePopoverPosition, type PopoverWidth } from './usePopoverPosition'

/**
 * Stacking tokens for floating UI. A popover renders at its layer's z-index plus its nesting depth, so a
 * popover opened from inside another always stacks above it. `popover` sits above modals (z-60) and the
 * assistant window (z-60) so a menu opened inside either is never covered; `companion` is for a persistent
 * floating panel that lives under modals (the voice companion).
 */
export const POPOVER_LAYERS = { popover: 90, companion: 50 } as const
export type PopoverLayer = keyof typeof POPOVER_LAYERS

const PopoverDepth = createContext(0)

/** Why a popover closed: `usePopupDismiss`'s reasons, its anchor disappearing, Tab leaving a menu, or an item chosen. */
export type PopoverDismissReason = PopupDismissReason | 'anchor' | 'tab' | 'select'

/** What gets focus when a popover opens: the first focusable element, the selected one, nothing, or a pick. */
export type PopoverInitialFocus =
  | 'first'
  | 'selected'
  | 'none'
  | ((surface: HTMLElement) => HTMLElement | null | undefined)

/** The value of the trigger's `aria-haspopup`; `disclosure` renders none (a plain expanded/collapsed control). */
export type PopoverKind = 'menu' | 'listbox' | 'dialog' | 'disclosure'

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  open: boolean
  /** Asked to close: an outside press, Escape, keyboard focus leaving, its anchor disappearing, or Tab out of a menu. */
  onDismiss: (reason: PopoverDismissReason) => void
  /** The control that opens it: presses on it are inside, Escape and closing return focus to it, Tab enters from it. */
  trigger?: RefObject<HTMLElement | null>
  /** What it is positioned against. Defaults to `trigger`. */
  anchor?: RefObject<HTMLElement | null>
  role?: AriaRole
  /** Preferred side; it flips when the other side has more room. Default `below`. */
  side?: PopupSide
  /** Which anchor edge it lines up with. Default `end` (right edges). */
  align?: PopupAlign
  /** Space between the anchor and the surface, px. Default 6. */
  gap?: number
  /** Inset from the aligned anchor edge, px. */
  alignOffset?: number
  /** A fixed width, the anchor's width, or the surface's own CSS width (default `content`). */
  width?: PopoverWidth
  /** The tallest it may be before it scrolls (default: whatever the viewport allows). */
  maxHeight?: number | ((viewport: Box) => number)
  /** A region it must also stay inside. */
  boundary?: RefObject<HTMLElement | null>
  /** Close when the anchor scrolls fully out of view (hover cards). */
  loseOffscreenAnchor?: boolean
  /**
   * Portal out of clipping and stacking ancestors (default). The portal goes into the enclosing
   * `aria-modal` dialog when there is one, so assistive technology keeps it reachable, else `document.body`.
   * `false` renders it in place, still `position: fixed` — only for a host that must contain it.
   */
  portal?: boolean
  layer?: PopoverLayer
  /** What gets focus on open. Default `first`. */
  initialFocus?: PopoverInitialFocus
  /**
   * Tab inside a portaled popover. `continue` (default): Tab past the last element continues the page order
   * after the trigger, Shift+Tab before the first returns to the trigger, and Tab on the open trigger enters
   * the popover. `close`: any Tab closes it (a menu or listbox), continuing from the trigger. `none`: native.
   */
  tabOut?: 'continue' | 'close' | 'none'
  /** Whether outside presses, Escape and focus loss dismiss it right now. Default true. */
  dismissible?: boolean
  /** Close on Escape. Off only when a field's own key handler owns Escape. Default true. */
  escape?: boolean
  /** Close when keyboard focus leaves it. Default true. */
  focusOut?: boolean
  /** On Escape, focus the trigger. Default true. */
  restoreFocus?: boolean
  /** Closing with focus inside moves it to the trigger. Default true; off when the caller returns focus itself. */
  returnFocus?: boolean
  /** Further regions that count as inside. */
  inside?: readonly RefObject<HTMLElement | null>[]
  /** Add `overflow-y-auto` so content beyond the max height scrolls. Default true. */
  scroll?: boolean
  ref?: Ref<HTMLDivElement>
}

/**
 * The ONE floating surface for `apps/web`: menus, pickers, panels, hover cards and autocomplete lists
 * all render through it (see `Popover.md`). It owns anchoring and edge-aware placement, the portal,
 * dismissal (`usePopupDismiss`, with the portaled surface as the popup region), the `Presence`
 * enter/exit animation, focus on open and return, Tab order across the portal, and the z-index layer.
 * The trigger's ARIA comes from `usePopover`.
 */
export function Popover({
  open,
  onDismiss,
  trigger,
  anchor,
  role,
  side,
  align,
  gap,
  alignOffset,
  width = 'content',
  maxHeight,
  boundary,
  loseOffscreenAnchor,
  portal = true,
  layer = 'popover',
  initialFocus = 'first',
  tabOut = 'continue',
  dismissible = true,
  escape,
  focusOut,
  restoreFocus,
  returnFocus = true,
  inside = [],
  scroll = true,
  className,
  style,
  onKeyDown,
  ref,
  children,
  ...props
}: PopoverProps) {
  const surface = useRef<HTMLDivElement>(null)
  const noAnchor = useRef<HTMLElement>(null)
  const depth = useContext(PopoverDepth)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const latest = useStableRef({ onDismiss, initialFocus, tabOut, trigger, dismissible, returnFocus })

  useLayoutEffect(() => {
    if (!open || !portal) return
    const from = trigger?.current ?? anchor?.current
    setContainer(from?.closest<HTMLElement>('[aria-modal="true"]') ?? document.body)
  }, [open, portal, trigger, anchor])
  const mounted = !portal || !!container

  const placement = usePopoverPosition({
    open: open && mounted,
    anchor: anchor ?? trigger ?? noAnchor,
    popup: surface,
    width,
    maxHeight,
    boundary,
    side,
    align,
    gap,
    alignOffset,
    loseOffscreenAnchor,
    // A persistent (non-dismissible) surface outlives its anchor at its last placement.
    onAnchorLost: () => latest.current.dismissible && latest.current.onDismiss('anchor'),
  })

  // Focus on open, once the first placement (and so the max height and scroll range) is in the DOM.
  const focusPending = useRef(false)
  useLayoutEffect(() => {
    focusPending.current = open
  }, [open])
  useLayoutEffect(() => {
    if (!placement || !focusPending.current || !surface.current) return
    focusPending.current = false
    focusInPopover(initialTarget(surface.current, latest.current.initialFocus))
  }, [placement, latest])

  // Focus return: closing with focus inside (an item ran, the anchor went away) hands it back to the
  // trigger before the surface goes inert. Escape's return is usePopupDismiss's `restoreFocus`.
  useLayoutEffect(() => {
    if (open || !latest.current.returnFocus) return
    if (surface.current?.contains(document.activeElement))
      latest.current.trigger?.current?.focus({ preventScroll: true })
  }, [open, latest])

  usePopupDismiss({
    open: open && dismissible,
    popup: surface,
    trigger,
    inside,
    escape,
    focusOut,
    restoreFocus,
    onDismiss: (reason) => latest.current.onDismiss(reason),
  })

  // A portaled surface is not next to its trigger in the Tab order: Tab on the open trigger enters it.
  useEffect(() => {
    const element = trigger?.current
    if (!open || !portal || !element || tabOut === 'none') return
    const onTriggerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.shiftKey || event.defaultPrevented || !surface.current) return
      const first = tabbables(surface.current)[0]
      if (!first) return
      event.preventDefault()
      focusInPopover(first)
    }
    element.addEventListener('keydown', onTriggerKeyDown)
    return () => element.removeEventListener('keydown', onTriggerKeyDown)
  }, [open, portal, trigger, tabOut])

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    const triggerElement = trigger?.current
    if (event.key !== 'Tab' || event.defaultPrevented || !portal || !triggerElement || tabOut === 'none') return
    const all = tabbables(event.currentTarget)
    const target = event.target as HTMLElement
    if (tabOut === 'close') {
      // Nonmodal: continue the page's Tab order from the trigger. Forward Tab moves natively past the
      // trigger once it holds focus; Shift+Tab lands on the trigger itself.
      if (event.shiftKey) event.preventDefault()
      triggerElement.focus({ preventScroll: true })
      latest.current.onDismiss('tab')
    } else if (event.shiftKey ? target === all[0] || !all.length : target === all.at(-1) || !all.length) {
      // Loosely trapped: leaving either end goes back through the trigger, not to the end of the document.
      if (event.shiftKey) event.preventDefault()
      triggerElement.focus({ preventScroll: true })
    }
  }

  const surfaceRef = useCallback(
    (node: HTMLDivElement | null) => {
      surface.current = node
      if (typeof ref === 'function') return ref(node)
      if (ref) ref.current = node
    },
    [ref]
  )

  const zIndex = POPOVER_LAYERS[layer] + depth
  const element = mounted && (
    <PopoverDepth.Provider value={depth + 1}>
      <Presence
        ref={surfaceRef}
        open={open}
        role={role}
        data-popover=""
        data-placement={placement?.side}
        onKeyDown={onSurfaceKeyDown}
        className={clsx('fixed outline-none', scroll && 'overflow-y-auto overscroll-contain', className)}
        style={{
          left: placement?.left ?? 0,
          top: placement?.top ?? 0,
          width:
            width === 'content' ? undefined : (placement?.width ?? (typeof width === 'number' ? width : undefined)),
          ...style,
          // A caller's own numeric max width still never exceeds the viewport.
          maxWidth:
            width === 'content' && placement
              ? Math.min(placement.maxWidth, typeof style?.maxWidth === 'number' ? style.maxWidth : Infinity)
              : style?.maxWidth,
          maxHeight: placement?.maxHeight,
          zIndex,
        }}
        {...props}
      >
        {children}
      </Presence>
    </PopoverDepth.Provider>
  )
  if (!element) return null
  return portal ? createPortal(element, container!) : element
}
