import type { AriaRole } from 'react'
import { Popover, type PopoverProps } from './Popover'

export interface PanelProps extends Omit<PopoverProps, 'role'> {
  /** The panel's accessible name. */
  label: string
  /**
   * `dialog` (default) for a non-modal dialog-ish panel (pair with `usePopover({ kind: 'dialog' })`);
   * `region` or `group` for a disclosure panel whose trigger only reports expanded/collapsed
   * (`usePopover({ kind: 'disclosure' })`).
   */
  role?: Extract<AriaRole, 'dialog' | 'region' | 'group'>
}

/**
 * A non-modal panel of arbitrary content anchored to its trigger: filters, a theme picker, a settings
 * chooser, the voice companion. Focus moves to its first control on open (or as `initialFocus` says),
 * is trapped loosely (Tab past either end goes back through the trigger, never to the end of the
 * document), and it closes on an outside press, Escape or keyboard focus leaving.
 */
export function Panel({ label, role = 'dialog', ...props }: PanelProps) {
  return <Popover {...props} role={role} aria-label={label} />
}
