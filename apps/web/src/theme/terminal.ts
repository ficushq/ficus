import type { ITheme } from '@xterm/xterm'
import { tokenColor as terminalTokenColor } from './tokenReader'

const TERMINAL_TOKENS = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  cursorAccent: '--term-cursor-accent',
  selectionBackground: '--term-selection-background',
  selectionForeground: '--term-selection-foreground',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white',
  // xterm 6 draws its own scrollbar slider. The log palette defines no
  // `--log-scrollbar-*` tokens, so log viewers keep xterm's default slider.
  scrollbarSliderBackground: '--term-scrollbar-thumb',
  scrollbarSliderHoverBackground: '--term-scrollbar-thumb-hover',
  scrollbarSliderActiveBackground: '--term-scrollbar-thumb-active',
} as const satisfies Partial<Record<keyof ITheme, string>>

/** Share the renderer-safe decimal serializer with graph/chart consumers.
 * `none` keeps selected ANSI ink and `auto` keeps xterm's default scrollbar
 * slider; neither sentinel is sent into xterm's color parser.
 */
export { terminalTokenColor }

export function readTerminalTheme(
  style: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  palette: 'term' | 'log' = 'term'
): ITheme {
  return Object.fromEntries(
    Object.entries(TERMINAL_TOKENS).map(([key, token]) => [
      key,
      terminalTokenColor(style.getPropertyValue(token.replace('--term-', `--${palette}-`)).trim()),
    ])
  )
}

/**
 * Repaint the existing terminal after CSS scope/override changes; never recreate
 * its session or socket. Observing the applied root (rather than a React theme
 * effect) avoids child/parent effect ordering races and handles custom overrides.
 * The constructor also reads tokens BEFORE open(), so the first canvas is right.
 */
export function observeTerminalTheme(
  terminal: { options: { theme?: ITheme } },
  container: HTMLElement,
  palette: 'term' | 'log' = 'term'
): () => void {
  const root = container.ownerDocument.documentElement
  const view = container.ownerDocument.defaultView!
  const update = () => {
    const style = view.getComputedStyle(root)
    terminal.options.theme = readTerminalTheme(style, palette)
  }
  const observer = new view.MutationObserver(update)
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-appearance'] })
  update()
  return () => observer.disconnect()
}
