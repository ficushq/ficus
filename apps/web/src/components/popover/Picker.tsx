import clsx from 'clsx'
import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Popover, type PopoverProps } from './Popover'
import { focusHoveredItem, handleListKey, listItems } from './listNavigation'
import { popoverRowClass } from './rowClass'
import { PopoverHeading, PopoverRowContent } from './rows'

export interface PickerOption<T extends string> {
  value: T
  label: string
  description?: string
  /** Keep the label on one line, clipped with an ellipsis; the full label shows on hover. */
  singleLine?: boolean
  ariaLabel?: string
  disabled?: boolean
  icon?: ReactNode
  /** Extra text a `search` matches besides the label and description (an ID, a short key, unshown details). */
  keywords?: string
}

export interface PickerSearch {
  /** The search field's accessible name. */
  label: string
  placeholder?: string
  /** Shown when nothing matches. Default "No matches". */
  empty?: string
}

interface PickerBaseProps<T extends string> extends Omit<
  PopoverProps,
  'role' | 'initialFocus' | 'tabOut' | 'onChange'
> {
  /** The listbox's accessible name. */
  label: string
  /** A visible title above the options (hidden from assistive technology; `label` names the list). */
  heading?: string
  options: readonly PickerOption<T>[]
  /** The `selected` option (default; the first when none is), the `first` one, or `none` (a hover-open). */
  initialFocus?: 'first' | 'selected' | 'none'
  /**
   * A filter field above the options, for long lists. It takes focus on open (unless `initialFocus` is
   * `none`); ArrowDown moves into the list, and typing on an option returns to the field. The surface is
   * then a `dialog` holding the field and the listbox, so open it with `usePopover({ kind: 'dialog' })`.
   */
  search?: PickerSearch
}

/** One value: committing closes the list. */
interface SinglePickerProps<T extends string> extends PickerBaseProps<T> {
  multiple?: false
  value: T
  onChange: (value: T) => void
}

/** Several values (`aria-multiselectable`): activating an option toggles it and the list stays open. */
interface MultiPickerProps<T extends string> extends PickerBaseProps<T> {
  multiple: true
  value: readonly T[]
  onChange: (value: T[]) => void
}

export type PickerProps<T extends string> = SinglePickerProps<T> | MultiPickerProps<T>

const OPTION = '[role="option"]'

function matches(option: PickerOption<string>, query: string) {
  if (!query) return true
  return [option.label, option.description, option.keywords].some((text) => text?.toLowerCase().includes(query))
}

/**
 * Pick one value (role=listbox, the `SelectionPopup` behavior): the selected option gets focus on open,
 * arrows/Home/End only move focus (never the value), and Enter, Space or a click commits the value,
 * closes the list and returns focus to the trigger. Tab closes it and continues from the trigger. The
 * trigger is a `role="combobox"` button from `usePopover({ kind: 'listbox' })`. With `multiple`,
 * activation toggles the option and keeps the list open; with `search`, a filter field leads the list.
 */
export function Picker<T extends string>(props: PickerProps<T>) {
  const {
    label,
    heading,
    value,
    options,
    onChange,
    multiple,
    search,
    initialFocus = 'selected',
    onDismiss,
    trigger,
    className,
    ...popoverProps
  } = props
  const id = useId()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // Each opening starts from the full list (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(popoverProps.open)
  if (wasOpen !== popoverProps.open) {
    setWasOpen(popoverProps.open)
    if (!popoverProps.open) setQuery('')
  }
  const selected = (option: T) => (multiple ? (value as readonly T[]).includes(option) : option === (value as T))
  const needle = query.trim().toLowerCase()
  const shown = search ? options.filter((option) => matches(option, needle)) : options

  const select = (option: PickerOption<T>) => {
    if (option.disabled) return
    if (multiple) {
      const current = value as readonly T[]
      ;(onChange as MultiPickerProps<T>['onChange'])(
        current.includes(option.value) ? current.filter((item) => item !== option.value) : [...current, option.value]
      )
      return
    }
    trigger?.current?.focus({ preventScroll: true })
    onDismiss('select')
    ;(onChange as SinglePickerProps<T>['onChange'])(option.value)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const inField = event.target === searchRef.current
    // The field owns its caret keys; arrows still move into the list.
    if (inField && (event.key === 'Home' || event.key === 'End')) return
    if (
      search &&
      !inField &&
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      searchRef.current?.focus({ preventScroll: true })
      return
    }
    handleListKey(event, OPTION)
  }

  const rows = shown.map((option, index) => (
    <button
      key={option.value}
      type="button"
      role="option"
      tabIndex={-1}
      disabled={option.disabled}
      aria-selected={selected(option.value)}
      aria-label={option.ariaLabel ?? option.label}
      aria-describedby={option.description ? `${id}-${index}-description` : undefined}
      title={option.singleLine ? option.label : undefined}
      onClick={() => select(option)}
      className={popoverRowClass(selected(option.value))}
    >
      <PopoverRowContent
        icon={option.icon}
        label={option.label}
        description={option.description}
        singleLine={option.singleLine}
        descriptionId={`${id}-${index}-description`}
        checked={selected(option.value)}
      />
    </button>
  ))

  return (
    <Popover
      {...popoverProps}
      role={search ? 'dialog' : 'listbox'}
      aria-label={heading ?? label}
      aria-multiselectable={!search && multiple ? true : undefined}
      trigger={trigger}
      onDismiss={onDismiss}
      tabOut="close"
      className={clsx('ficus-overlay scroll-py-1.5 p-1.5', className)}
      initialFocus={(surface) => {
        if (initialFocus === 'none') return null
        if (search) return searchRef.current
        const items = listItems(surface, OPTION)
        if (initialFocus === 'first') return items[0]
        return items.find((item) => item.getAttribute('aria-selected') === 'true') ?? items[0]
      }}
      onKeyDown={onKeyDown}
      onMouseMove={(event) => focusHoveredItem(event, OPTION)}
    >
      {heading && <PopoverHeading>{heading}</PopoverHeading>}
      {search ? (
        <>
          <input
            ref={searchRef}
            type="search"
            aria-label={search.label}
            aria-controls={`${id}-list`}
            placeholder={search.placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter picks the first match, so "type, Enter" works without the arrows.
              if (event.key !== 'Enter') return
              event.preventDefault()
              event.stopPropagation()
              const first = shown.find((option) => !option.disabled)
              if (!first) return
              select(first)
              if (multiple) setQuery('')
            }}
            className="ficus-field mb-1.5 w-full rounded-md border border-panel-border bg-surface px-2.5 py-2 text-sm"
          />
          <div id={`${id}-list`} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined}>
            {rows}
          </div>
          {shown.length === 0 && (
            <p role="status" className="px-2.5 py-2 text-sm text-muted">
              {search.empty ?? 'No matches'}
            </p>
          )}
        </>
      ) : (
        rows
      )}
    </Popover>
  )
}
