import clsx from 'clsx'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { placePopup, visualViewportBox, type PopupPlacement } from '../lib/popupPosition'
import { CheckIcon } from './icons'

interface PopupTrigger {
  label: string
  children: ReactNode
  className: string
  title?: string
  disabled?: boolean
  heading?: string
  width?: number
}

export interface PopupOption<T extends string> {
  value: T
  label: string
  description?: string
  ariaLabel?: string
  disabled?: boolean
  icon?: ReactNode
}

export interface PopupAction extends Omit<PopupOption<string>, 'value'> {
  id: string
  active?: boolean
  onSelect: () => void
  /** A dialog takes focus itself; never restore focus behind it. */
  opensDialog?: boolean
}

/** A value picker: arrows only move focus; activation commits the value. */
export function SelectionPopup<T extends string>({
  value,
  options,
  onChange,
  ...trigger
}: PopupTrigger & {
  value: T
  options: readonly PopupOption<T>[]
  onChange: (value: T) => void
}) {
  return (
    <Popup
      {...trigger}
      role="listbox"
      items={options.map((option) => ({
        ...option,
        id: option.value,
        active: option.value === value,
        onSelect: () => onChange(option.value),
      }))}
    />
  )
}

/** Actions and in-app section navigation use menu semantics, not value-selection semantics. */
export function ActionPopup({ items, ...trigger }: PopupTrigger & { items: readonly PopupAction[] }) {
  return <Popup {...trigger} role="menu" items={items} />
}

function Popup({
  label,
  children,
  className,
  title,
  disabled,
  heading,
  width = 192,
  role,
  items,
}: PopupTrigger & {
  role: 'menu' | 'listbox'
  items: readonly PopupAction[]
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [placement, setPlacement] = useState<PopupPlacement>()
  const [container, setContainer] = useState<HTMLElement>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const id = useId()
  const popupId = `${id}-popup`

  const enabled = items.flatMap((item, index) => (item.disabled ? [] : [index]))
  const initialIndex = items.findIndex((item) => item.active && !item.disabled)

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }
  const focusRow = (index: number | undefined) => {
    const row = index === undefined ? undefined : rowRefs.current[index]
    if (!row) return
    setActiveIndex(index!)
    row.focus({ preventScroll: true })
    row.scrollIntoView?.({ block: 'nearest' })
  }
  // The first placement of each opening sets the scroll height; only then can
  // the initially focused (possibly late) row be scrolled into view.
  const revealInitialRow = useRef(false)

  const openPopup = () => {
    // Stay inside an aria-modal dialog so assistive technology keeps the popup
    // reachable; fixed positioning still escapes clipping ancestors.
    setContainer(triggerRef.current?.closest<HTMLElement>('[aria-modal="true"]') ?? document.body)
    setOpen(true)
  }

  // Initial focus: the selected/active enabled row, else the first enabled row.
  useLayoutEffect(() => {
    if (open) {
      revealInitialRow.current = true
      focusRow(initialIndex >= 0 ? initialIndex : enabled[0])
    } else {
      setActiveIndex(-1)
      setPlacement(undefined)
    }
    // Only on opening; later value changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, container])

  // Position and keep positioned: ancestor scrolls, window and visual viewport
  // (mobile keyboard/pan) changes, and anchor/content size changes.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const trigger = triggerRef.current
      const popup = popupRef.current
      if (!trigger || !popup) return
      // Responsive triggers can disappear while their portal is still mounted.
      if (!trigger.getClientRects().length) return setOpen(false)
      const next = placePopup(
        trigger.getBoundingClientRect(),
        { width, height: popup.scrollHeight + popup.offsetHeight - popup.clientHeight } /* border-box */,
        visualViewportBox()
      )
      // Skip unchanged placements so scrolling does not re-render the popup.
      setPlacement((current) =>
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight &&
        current.side === next.side
          ? current
          : next
      )
    }
    update()
    const viewport = window.visualViewport
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    if (triggerRef.current) observer?.observe(triggerRef.current)
    if (popupRef.current) observer?.observe(popupRef.current)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    // Layout shifts move the anchor without any event. While open, compare one
    // rect per frame and reposition only when it actually changed.
    let frame = 0
    let last = ''
    const watch = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      const key = rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : ''
      if (key !== last) {
        if (last) update()
        last = key
      }
      frame = window.requestAnimationFrame(watch)
    }
    frame = window.requestAnimationFrame(watch)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
    }
  }, [open, container, width, items.length])

  useLayoutEffect(() => {
    if (!open || !placement || !revealInitialRow.current) return
    revealInitialRow.current = false
    rowRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
    // Runs once per opening, after the placement (and maxHeight) is in the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement])

  // Outside press, Escape (topmost popup only, restoring trigger focus) and keyboard focus leaving.
  usePopupDismiss({ open, popup: popupRef, trigger: triggerRef, onDismiss: () => setOpen(false) })

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
      event.preventDefault()
      openPopup()
    }
  }

  const onPopupKeyDown = (event: ReactKeyboardEvent) => {
    const position = enabled.indexOf(activeIndex)
    const move = (index: number | undefined) => {
      event.preventDefault()
      focusRow(index)
    }
    switch (event.key) {
      case 'ArrowDown':
        return move(enabled[(position + 1) % enabled.length])
      case 'ArrowUp':
        return move(enabled[(position - 1 + enabled.length) % enabled.length])
      case 'Home':
        return move(enabled[0])
      case 'End':
        return move(enabled.at(-1))
      case 'Enter':
      case ' ':
        // Never leak row activation into a surrounding form, composer or shortcut.
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) rowRefs.current[activeIndex]?.click()
        return
      case 'Tab':
        // Nonmodal: continue the page's Tab order from the trigger (the portal
        // lives elsewhere in the DOM). Forward Tab moves natively past the
        // trigger; Shift+Tab lands on the trigger itself.
        if (event.shiftKey) event.preventDefault()
        close(true)
        return
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role={role === 'listbox' ? 'combobox' : undefined}
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={label}
        title={title}
        disabled={disabled}
        className={className}
        onClick={() => (open ? setOpen(false) : openPopup())}
        onKeyDown={onTriggerKeyDown}
      >
        {children}
      </button>
      {open &&
        container &&
        createPortal(
          <div
            ref={popupRef}
            id={popupId}
            role={role}
            aria-label={heading ?? label}
            data-placement={placement?.side}
            onKeyDown={onPopupKeyDown}
            className="ficus-overlay fixed z-[90] overflow-y-auto overscroll-contain p-1.5 outline-none"
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              width: placement?.width ?? width,
              maxHeight: placement?.maxHeight,
            }}
          >
            {heading && (
              <p aria-hidden="true" className="ficus-section-title px-2 py-1.5">
                {heading}
              </p>
            )}
            {items.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => {
                  rowRefs.current[index] = node
                }}
                type="button"
                role={role === 'listbox' ? 'option' : 'menuitem'}
                tabIndex={activeIndex === index ? 0 : -1}
                disabled={item.disabled}
                aria-selected={role === 'listbox' ? !!item.active : undefined}
                aria-current={role === 'menu' && item.active ? 'page' : undefined}
                aria-label={item.ariaLabel ?? item.label}
                aria-describedby={item.description ? `${id}-${index}-description` : undefined}
                onFocus={() => setActiveIndex(index)}
                onMouseMove={() => {
                  if (!item.disabled && activeIndex !== index) focusRow(index)
                }}
                onClick={() => {
                  if (item.disabled) return
                  close(!item.opensDialog)
                  item.onSelect()
                }}
                className={clsx(
                  'ficus-button flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-hover hover:text-primary focus-visible:bg-surface-hover focus-visible:text-primary disabled:opacity-50',
                  item.active ? 'bg-selection text-accent-light' : 'text-secondary'
                )}
              >
                {item.icon}
                <span className="min-w-0 flex-1 break-words">
                  <span>{item.label}</span>
                  {item.description && (
                    <span id={`${id}-${index}-description`} className="mt-1 block text-xs font-normal text-secondary">
                      {item.description}
                    </span>
                  )}
                </span>
                {role === 'listbox' && item.active && <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </button>
            ))}
          </div>,
          container
        )}
    </>
  )
}
