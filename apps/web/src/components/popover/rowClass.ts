import clsx from 'clsx'

/** The look of one row in a `Picker` or an `ActionPopup` menu: a 44px touch target, selected = accent. */
export function popoverRowClass(active: boolean | undefined) {
  return clsx(
    'ficus-button flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-hover hover:text-primary focus-visible:bg-surface-hover focus-visible:text-primary disabled:opacity-50',
    active ? 'bg-selection text-accent-light' : 'text-secondary'
  )
}
