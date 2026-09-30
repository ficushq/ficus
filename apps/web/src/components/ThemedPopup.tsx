import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
} from '@floating-ui/react'
import clsx from 'clsx'
import { useEffect, useId, useRef, useState, type ReactNode, type FocusEvent } from 'react'
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

// Window capture precedes the app's document-level modal/voice/global shortcuts.
// Registration order must not decide which popup consumes Escape.
const popupStack: object[] = []

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
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])
  const pointerSelection = useRef(false)
  const tabExitTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(tabExitTimer.current), [])
  const id = useId()
  const selectedIndex = items.findIndex((item) => item.active && !item.disabled)
  const { refs, floatingStyles, context, update, placement } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8, crossAxis: true }),
      size({
        padding: 8,
        apply({ availableWidth, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, availableWidth)}px`,
            maxHeight: `${Math.max(0, Math.min(360, availableHeight))}px`,
          })
        },
      }),
    ],
  })
  const click = useClick(context)
  const dismiss = useDismiss(context, { escapeKey: false })
  const semantics = useRole(context, { role })
  const navigation = useListNavigation(context, {
    listRef,
    activeIndex,
    selectedIndex: selectedIndex < 0 ? null : selectedIndex,
    onNavigate: setActiveIndex,
    loop: true,
    focusItemOnOpen: true,
    disabledIndices: items.flatMap((item, index) => (item.disabled ? [index] : [])),
  })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([click, dismiss, semantics, navigation])

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus && refs.domReference.current instanceof HTMLElement) refs.domReference.current.focus()
  }

  useEffect(() => {
    if (!open) return
    const token = {}
    popupStack.push(token)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || popupStack.at(-1) !== token) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(false)
      if (refs.domReference.current instanceof HTMLElement) refs.domReference.current.focus()
    }
    window.addEventListener('keydown', escape, true)
    // autoUpdate covers layout/ancestor scrolling and resizing; visualViewport
    // also changes when a phone keyboard opens or the visual viewport pans.
    const viewport = window.visualViewport
    const resize = () => {
      // Responsive triggers can disappear while their portal is still mounted.
      if (!refs.domReference.current?.getClientRects().length) setOpen(false)
      else update()
    }
    window.addEventListener('resize', resize)
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', update)
    return () => {
      popupStack.splice(popupStack.indexOf(token), 1)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', resize)
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', update)
    }
  }, [open, refs.domReference, update])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const target = event.relatedTarget
    // Portal guards transfer Tab to the logical sibling before dismissing.
    // Removing the popup while a guard is focused would strand focus on body.
    if (target instanceof HTMLElement && target.hasAttribute('data-floating-ui-focus-guard')) return
    if (
      !pointerSelection.current &&
      target instanceof Node &&
      !refs.floating.current?.contains(target) &&
      !refs.domReference.current?.contains(target)
    )
      setOpen(false)
  }

  return (
    <>
      <button
        {...getReferenceProps({ onBlur })}
        ref={refs.setReference}
        type="button"
        aria-label={label}
        title={title}
        disabled={disabled}
        className={className}
      >
        {children}
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false}>
            <div
              {...getFloatingProps({
                onBlur,
                onPointerDownCapture() {
                  pointerSelection.current = true
                },
                onKeyDown(event) {
                  pointerSelection.current = false
                  if (event.key === 'Tab') {
                    // Let the native Tab and portal guards transfer focus first.
                    window.clearTimeout(tabExitTimer.current)
                    tabExitTimer.current = window.setTimeout(() => setOpen(false), 0)
                  }
                  // Never leak row activation into a surrounding composer or global shortcut.
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!event.repeat) listRef.current[activeIndex ?? -1]?.click()
                  }
                },
              })}
              ref={refs.setFloating}
              aria-label={heading ?? label}
              data-placement={placement}
              className="ficus-overlay fixed z-[90] overflow-y-auto overscroll-contain p-1.5 outline-none"
              style={{ ...floatingStyles, width }}
            >
              {heading && <p className="ficus-section-title px-2 py-1.5">{heading}</p>}
              {items.map((item, index) => (
                <button
                  key={item.id}
                  {...getItemProps({
                    onClick() {
                      if (item.disabled) return
                      close(!item.opensDialog)
                      item.onSelect()
                    },
                  })}
                  ref={(node) => {
                    listRef.current[index] = node
                  }}
                  type="button"
                  role={role === 'listbox' ? 'option' : 'menuitem'}
                  tabIndex={activeIndex === index ? 0 : -1}
                  disabled={item.disabled}
                  aria-selected={role === 'listbox' ? !!item.active : undefined}
                  aria-current={role === 'menu' && item.active ? 'page' : undefined}
                  aria-label={item.ariaLabel ?? item.label}
                  aria-describedby={item.description ? `${id}-${index}-description` : undefined}
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
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}
