import clsx from 'clsx'
import { useId, type ReactNode } from 'react'
import { Popover, type PopoverProps } from './Popover'
import { focusHoveredItem, handleListKey, listItems } from './listNavigation'
import { popoverRowClass } from './rowClass'
import { PopoverHeading, PopoverRowContent } from './rows'

export interface PickerOption<T extends string> {
  value: T
  label: string
  description?: string
  ariaLabel?: string
  disabled?: boolean
  icon?: ReactNode
}

export interface PickerProps<T extends string> extends Omit<
  PopoverProps,
  'role' | 'initialFocus' | 'tabOut' | 'onChange'
> {
  /** The listbox's accessible name. */
  label: string
  /** A visible title above the options (hidden from assistive technology; `label` names the list). */
  heading?: string
  value: T
  options: readonly PickerOption<T>[]
  onChange: (value: T) => void
}

const OPTION = '[role="option"]'

/**
 * Pick one value (role=listbox, the `SelectionPopup` behavior): the selected option gets focus on open,
 * arrows/Home/End only move focus (never the value), and Enter, Space or a click commits the value,
 * closes the list and returns focus to the trigger. Tab closes it and continues from the trigger. The
 * trigger is a `role="combobox"` button from `usePopover({ kind: 'listbox' })`.
 */
export function Picker<T extends string>({
  label,
  heading,
  value,
  options,
  onChange,
  onDismiss,
  trigger,
  className,
  ...props
}: PickerProps<T>) {
  const id = useId()
  return (
    <Popover
      {...props}
      role="listbox"
      aria-label={heading ?? label}
      trigger={trigger}
      onDismiss={onDismiss}
      tabOut="close"
      className={clsx('ficus-overlay p-1.5', className)}
      initialFocus={(surface) => {
        const items = listItems(surface, OPTION)
        return items.find((item) => item.getAttribute('aria-selected') === 'true') ?? items[0]
      }}
      onKeyDown={(event) => handleListKey(event, OPTION)}
      onMouseMove={(event) => focusHoveredItem(event, OPTION)}
    >
      {heading && <PopoverHeading>{heading}</PopoverHeading>}
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="option"
          tabIndex={-1}
          disabled={option.disabled}
          aria-selected={option.value === value}
          aria-label={option.ariaLabel ?? option.label}
          aria-describedby={option.description ? `${id}-${index}-description` : undefined}
          onClick={() => {
            if (option.disabled) return
            trigger?.current?.focus({ preventScroll: true })
            onDismiss('select')
            onChange(option.value)
          }}
          className={popoverRowClass(option.value === value)}
        >
          <PopoverRowContent
            icon={option.icon}
            label={option.label}
            description={option.description}
            descriptionId={`${id}-${index}-description`}
            checked={option.value === value}
          />
        </button>
      ))}
    </Popover>
  )
}
