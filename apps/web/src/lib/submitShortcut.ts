import type { KeyboardEvent } from 'react'

/**
 * True when a keydown on a multi-line field is the "submit" chord: Cmd+Enter
 * on macOS, Ctrl+Enter elsewhere (either modifier is accepted everywhere).
 * Plain and Shift+Enter insert a newline, and an Enter that confirms an IME
 * composition never submits.
 */
export function isSubmitShortcut(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return false
  return !event.nativeEvent.isComposing
}

/** The keyboard hint for {@link isSubmitShortcut}, using the platform's modifier name. */
export function submitShortcutHint(): string {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
  return `${isMac ? '⌘' : 'Ctrl'} + Enter to submit`
}
