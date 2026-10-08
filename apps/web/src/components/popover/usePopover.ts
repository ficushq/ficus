import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { useStableRef } from '../../hooks/useStableRef'
import type { PopoverKind } from './Popover'

export interface UsePopoverOptions {
  /** The trigger's `aria-haspopup`. */
  kind: PopoverKind
  /** Controlled openness; omit to let the hook own it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** A fixed id for the popover (default: a generated one). */
  id?: string
}

export interface PopoverState<T extends HTMLElement = HTMLButtonElement> {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** Close it; `returnFocus` moves focus to the trigger (skip it when the action moved focus on purpose). */
  close: (options?: { returnFocus?: boolean }) => void
  id: string
  kind: PopoverKind
  triggerRef: RefObject<T | null>
  /** Spread on the trigger: its ref and `aria-haspopup` / `aria-expanded` / `aria-controls`. */
  triggerProps: {
    ref: RefObject<T | null>
    'aria-haspopup'?: Exclude<PopoverKind, 'disclosure'>
    'aria-expanded': boolean
    'aria-controls': string
    /** Menus and listboxes also open on ArrowDown/ArrowUp. */
    onKeyDown?: (event: ReactKeyboardEvent<T>) => void
  }
  /** Spread on `Popover` (or a variant): openness, dismissal, the trigger and the id. */
  popoverProps: { open: boolean; onDismiss: () => void; trigger: RefObject<T | null>; id: string }
}

/** Openness, ids, refs and trigger ARIA for one popover. Spread `triggerProps` and `popoverProps`. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>({
  kind,
  open: controlled,
  onOpenChange,
  id: fixedId,
}: UsePopoverOptions): PopoverState<T> {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const triggerRef = useRef<T>(null)
  const generatedId = `${useId()}-popover`
  const id = fixedId ?? generatedId
  const change = useStableRef(onOpenChange)
  const setOpen = useCallback(
    (next: boolean) => {
      setOwn(next)
      change.current?.(next)
    },
    [change]
  )
  return useMemo(() => {
    const close = ({ returnFocus = false }: { returnFocus?: boolean } = {}) => {
      setOpen(false)
      if (returnFocus) triggerRef.current?.focus({ preventScroll: true })
    }
    return {
      open,
      setOpen,
      toggle: () => setOpen(!open),
      close,
      id,
      kind,
      triggerRef,
      triggerProps: {
        ref: triggerRef,
        'aria-haspopup': kind === 'disclosure' ? undefined : kind,
        'aria-expanded': open,
        // Always present (axe allows a missing target while collapsed), so the trigger is findable by it.
        'aria-controls': id,
        onKeyDown:
          kind === 'menu' || kind === 'listbox'
            ? (event: ReactKeyboardEvent<T>) => {
                if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
                  event.preventDefault()
                  setOpen(true)
                }
              }
            : undefined,
      },
      popoverProps: { open, onDismiss: () => close(), trigger: triggerRef, id },
    }
  }, [open, setOpen, id, kind])
}
