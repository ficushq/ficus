import type { ITerminalAddon, Terminal } from '@xterm/xterm'

/** Turn a single-finger drag into scrollback without blurring xterm's input. Taps still go to xterm. */
function attachTerminalTouchScroll(terminal: Terminal, container: HTMLElement) {
  let drag: { id: number; y: number; scrolling: boolean } | undefined
  const start = (event: TouchEvent) => {
    const touch = event.touches[0]
    drag =
      event.touches.length === 1 && touch ? { id: touch.identifier, y: touch.clientY, scrolling: false } : undefined
  }
  const move = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!drag || event.touches.length !== 1 || touch?.identifier !== drag.id) return
    const rowHeight = Math.ceil((terminal.options.fontSize ?? 13) * (terminal.options.lineHeight ?? 1))
    const lines = Math.trunc((drag.y - touch.clientY) / rowHeight)
    if (lines) {
      terminal.scrollLines(lines)
      drag.y -= lines * rowHeight
      drag.scrolling = true
    }
    // Prevent a compatibility click after scrolling; it would move the terminal cursor or focus.
    if (drag.scrolling) event.preventDefault()
  }
  // This is an inside-only terminal gesture, not a document listener or popup dismissal.
  container.addEventListener('touchstart', start, { passive: true })
  container.addEventListener('touchmove', move, { passive: false })
  return () => {
    container.removeEventListener('touchstart', start)
    container.removeEventListener('touchmove', move)
  }
}

export function terminalTouchScroll(): ITerminalAddon {
  let removeListeners: (() => void) | undefined
  return {
    activate(terminal) {
      if (terminal.element) removeListeners = attachTerminalTouchScroll(terminal, terminal.element)
    },
    dispose() {
      removeListeners?.()
    },
  }
}
