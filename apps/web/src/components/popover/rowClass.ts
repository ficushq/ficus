import clsx from 'clsx'

/** The look of one row in a `Picker` or an `ActionPopup` menu: a 44px touch target, selected = accent. */
export function popoverRowClass(active: boolean | undefined) {
  return clsx(
    'ficus-button ficus-button-ghost flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm disabled:opacity-50',
    // A selected row keeps its selected look when hovered or focused (the ghost variant's hover would replace it);
    // only other rows take the hover fill.
    active
      ? 'bg-selection hover:bg-selection text-accent-light hover:text-accent-light'
      : 'focus-visible:bg-surface-hover focus-visible:text-primary'
  )
}
