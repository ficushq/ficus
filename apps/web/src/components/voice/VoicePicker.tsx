import { ChevronDownIcon } from '../icons'
import { SelectionPopup, type PopupOption } from '../ThemedPopup'

const PICKER_CLASS =
  'ficus-button ficus-button-secondary flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm'

/** A one-value picker for the voice settings, on the shared `SelectionPopup`. */
export function VoicePicker<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string
  value: T
  options: readonly PopupOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <SelectionPopup
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      className={className ? `${PICKER_CLASS} ${className}` : PICKER_CLASS}
    >
      <span className="truncate">{options.find((option) => option.value === value)?.label ?? value}</span>
      <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" />
    </SelectionPopup>
  )
}
