import type { Terminal } from '@xterm/xterm'

type ArrowKeyEvent = Pick<KeyboardEvent, 'type' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing'>

const ESC = '\x1b'

// Byte-for-byte the translation xterm 5.5 applied in its keyboard evaluator.
// xterm 6 removed it (xtermjs/xterm.js PR 5346) and now sends the standard
// ESC [1;3X sequences, leaving word movement to embedders.
const LINUX_AND_WINDOWS: Readonly<Record<string, string>> = {
  ArrowLeft: `${ESC}[1;5D`,
  ArrowRight: `${ESC}[1;5C`,
  ArrowUp: `${ESC}[1;5A`,
  ArrowDown: `${ESC}[1;5B`,
}
// xterm 5.5 sent the readline meta bindings on macOS and left Alt+Up/Down
// as ESC [1;3A/B, which xterm 6 still sends unchanged.
const MAC: Readonly<Record<string, string>> = {
  ArrowLeft: `${ESC}b`,
  ArrowRight: `${ESC}f`,
}

/** The same platform test xterm uses for its keyboard evaluation. */
export function isMacPlatform(platform: string): boolean {
  return ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(platform)
}

/**
 * The bytes xterm 5.5 sent for a plain Alt+arrow keydown, or undefined when
 * xterm 6's own handling already matches (other keys, other modifier sets,
 * keyup, IME composition and Alt+Up/Down on macOS).
 */
export function legacyAltArrowSequence(event: ArrowKeyEvent, isMac: boolean): string | undefined {
  if (event.type !== 'keydown' || event.isComposing) return undefined
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined
  return (isMac ? MAC : LINUX_AND_WINDOWS)[event.key]
}

/**
 * Keep Alt+Left/Right word movement (and the Alt+Up/Down bytes) that terminal
 * users had with xterm 5.5. Sending the translated bytes through `input()`
 * fires `onData` exactly like a typed key. The browser default is cancelled,
 * as xterm does for keys it handles, so Alt+Left never triggers history Back.
 */
export function attachLegacyAltArrowKeys(
  terminal: Pick<Terminal, 'attachCustomKeyEventHandler' | 'input'>,
  isMac = isMacPlatform(globalThis.navigator?.platform ?? '')
): void {
  terminal.attachCustomKeyEventHandler((event) => {
    const sequence = legacyAltArrowSequence(event, isMac)
    if (sequence === undefined) return true
    event.preventDefault()
    event.stopPropagation()
    terminal.input(sequence, true)
    return false
  })
}
