import { useLayoutEffect, type RefObject } from 'react'
import { Popover, type PopoverProps } from './Popover'

export interface ComboboxListProps extends Omit<PopoverProps, 'trigger' | 'anchor' | 'initialFocus' | 'tabOut'> {
  /** The text field the list completes. Focus never leaves it; the list is placed against it. */
  input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  /** The id of the `role="listbox"` element inside the list. */
  listId: string
  /** The id of the highlighted option, for `aria-activedescendant`. */
  activeId?: string
}

/**
 * An autocomplete list anchored to a text field (above it by default, start-aligned): the field keeps
 * focus the whole time, so typing and the caret are never interrupted. The caller's key handler owns
 * arrows, Enter/Tab and Escape (so Escape and keyboard focus-out are not dismissal paths here); an
 * outside press — the field itself included, since the caret moves — closes it. While open the field
 * carries the combobox ARIA (`aria-expanded`, `aria-controls`, `aria-activedescendant`).
 */
export function ComboboxList({
  input,
  listId,
  activeId,
  open,
  side = 'above',
  align = 'start',
  gap = 8,
  ...props
}: ComboboxListProps) {
  useLayoutEffect(() => {
    const field = input.current
    if (!field || !open) return
    field.setAttribute('aria-autocomplete', 'list')
    field.setAttribute('aria-expanded', 'true')
    field.setAttribute('aria-controls', listId)
    if (activeId) field.setAttribute('aria-activedescendant', activeId)
    return () => {
      for (const name of ['aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'])
        field.removeAttribute(name)
    }
  }, [input, listId, activeId, open])

  return (
    <Popover
      {...props}
      open={open}
      anchor={input}
      side={side}
      align={align}
      gap={gap}
      initialFocus="none"
      tabOut="none"
      escape={false}
      focusOut={false}
      restoreFocus={false}
      // Keep focus (and the caret) in the field when an option is pressed with a mouse.
      onMouseDown={(event) => event.preventDefault()}
    />
  )
}
