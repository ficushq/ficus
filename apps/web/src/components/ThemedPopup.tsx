import { useEffect, useId, type ReactNode } from 'react'
import { Menu, MenuItem, Picker, PopoverHeading, PopoverRowContent, popoverRowClass, usePopover } from './popover'
import type { PickerOption } from './popover'

/**
 * The ready-made trigger + popover pairs: a value picker and an action menu. Thin wrappers over the
 * `Picker` and `Menu` variants of `components/popover` (see `popover/Popover.md`); reach for those
 * directly when the trigger or the rows need to look different.
 */
interface PopupTrigger {
  label: string
  children: ReactNode
  className: string
  title?: string
  disabled?: boolean
  heading?: string
  width?: number
}

export type PopupOption<T extends string> = PickerOption<T>

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
  label,
  children,
  className,
  title,
  disabled,
  heading,
  width = 192,
}: PopupTrigger & {
  value: T
  options: readonly PopupOption<T>[]
  onChange: (value: T) => void
}) {
  const popover = usePopover({ kind: 'listbox' })
  useCloseWhenDisabled(popover, disabled)
  return (
    <>
      <button
        {...popover.triggerProps}
        type="button"
        role="combobox"
        aria-label={label}
        title={title}
        disabled={disabled}
        className={className}
        onClick={popover.toggle}
      >
        {children}
      </button>
      <Picker
        {...popover.popoverProps}
        label={label}
        heading={heading}
        value={value}
        options={options}
        onChange={onChange}
        width={width}
        maxHeight={360}
      />
    </>
  )
}

/** Actions and in-app section navigation use menu semantics, not value-selection semantics. */
export function ActionPopup({
  items,
  label,
  children,
  className,
  title,
  disabled,
  heading,
  width = 192,
}: PopupTrigger & { items: readonly PopupAction[] }) {
  const popover = usePopover({ kind: 'menu' })
  const id = useId()
  useCloseWhenDisabled(popover, disabled)
  return (
    <>
      <button
        {...popover.triggerProps}
        type="button"
        aria-label={label}
        title={title}
        disabled={disabled}
        className={className}
        onClick={popover.toggle}
      >
        {children}
      </button>
      <Menu
        {...popover.popoverProps}
        label={heading ?? label}
        initialFocus="selected"
        width={width}
        maxHeight={360}
        className="ficus-overlay p-1.5"
      >
        {heading && <PopoverHeading>{heading}</PopoverHeading>}
        {items.map((item, index) => (
          <MenuItem
            key={item.id}
            disabled={item.disabled}
            opensDialog={item.opensDialog}
            aria-current={item.active ? 'page' : undefined}
            aria-label={item.ariaLabel ?? item.label}
            aria-describedby={item.description ? `${id}-${index}-description` : undefined}
            onClick={item.onSelect}
            className={popoverRowClass(item.active)}
          >
            <PopoverRowContent
              icon={item.icon}
              label={item.label}
              description={item.description}
              descriptionId={`${id}-${index}-description`}
            />
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

function useCloseWhenDisabled(popover: { setOpen: (open: boolean) => void }, disabled: boolean | undefined) {
  const { setOpen } = popover
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled, setOpen])
}
