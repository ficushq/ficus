import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ITheme } from '@xterm/xterm'
import { acquireDomHarness } from '../test/domHarness'
import { observeTerminalTheme, readTerminalTheme } from './terminal'
import { applyResolvedTheme } from './apply'
import { IRIS_THEME } from './registry'

// Test the real DOM observer and computed-style bridge, without replacing global
// modules or opening a real terminal socket. Minimal CSS scopes mirror real tokens.
test('terminal initializes from applied CSS and repaints the same instance on appearance/custom changes', async () => {
  const harness = await acquireDomHarness({ url: 'https://tau.test' })
  let dispose: (() => void) | undefined
  try {
    const { window } = harness
    const { document } = window
    const root = document.documentElement
    const style = document.createElement('style')
    style.textContent =
      ':root { --term-bg: 1 2 3; --term-red: 190 40 50; --term-selection-foreground: none; --term-scrollbar-thumb: auto; } .dark { --term-bg: 10 20 30; --term-red: 220 70 80; }'
    document.head.append(style)
    const container = document.createElement('div')
    document.body.append(container)
    applyResolvedTheme(root as unknown as HTMLElement, IRIS_THEME, 'dark')

    const paints: ITheme[] = []
    const options = {
      get theme() {
        return paints.at(-1)
      },
      set theme(value: ITheme | undefined) {
        if (value) paints.push(value)
      },
    }
    // Same path as Terminal's constructor, before open() creates the first canvas.
    options.theme = readTerminalTheme(window.getComputedStyle(root) as unknown as CSSStyleDeclaration)
    expect(options.theme?.background).toBe('rgb(10, 20, 30)')
    dispose = observeTerminalTheme({ options }, container as unknown as HTMLElement)
    expect(container.hasAttribute('data-terminal-scrollbar')).toBe(false)

    applyResolvedTheme(root as unknown as HTMLElement, IRIS_THEME, 'light')
    await window.happyDOM.waitUntilComplete()
    expect(options.theme?.background).toBe('rgb(1, 2, 3)')
    expect(options.theme?.red).toBe('rgb(190, 40, 50)')

    root.style.setProperty('--term-bg', '40 50 60')
    root.style.setProperty('--term-selection-foreground', '70 80 90')
    root.style.setProperty('--term-scrollbar-thumb', '100 110 120')
    await window.happyDOM.waitUntilComplete()
    expect(options.theme?.background).toBe('rgb(40, 50, 60)')
    expect(options.theme?.selectionForeground).toBe('rgb(70, 80, 90)')
    expect(container.hasAttribute('data-terminal-scrollbar')).toBe(true)

    root.style.removeProperty('--term-selection-foreground')
    root.style.removeProperty('--term-scrollbar-thumb')
    await window.happyDOM.waitUntilComplete()
    expect(options.theme?.selectionForeground).toBeUndefined()
    expect(container.hasAttribute('data-terminal-scrollbar')).toBe(false)

    dispose()
    const before = paints.length
    root.style.setProperty('--term-bg', '90 80 70')
    await window.happyDOM.waitUntilComplete()
    expect(paints).toHaveLength(before)
  } finally {
    dispose?.()
    await harness.cleanup()
  }
})

test('Terminal wires initial and live theme reads independently of session setup', () => {
  const source = readFileSync(new URL('../components/workspace/Terminal.tsx', import.meta.url), 'utf8')
  expect(source.indexOf('theme: readTerminalTheme(')).toBeLessThan(source.indexOf('terminal.open(container)'))
  expect(source).toContain('stopThemeObserverRef.current = observeTerminalTheme(terminal, container)')
  expect(source.indexOf('stopThemeObserverRef.current?.()')).toBeLessThan(
    source.indexOf('terminalRef.current?.dispose()')
  )
  expect(source).not.toContain('useTheme(')
})

test('read-only logs retain their distinct palette and repaint from log tokens', async () => {
  const harness = await acquireDomHarness({ url: 'https://tau.test' })
  let dispose: (() => void) | undefined
  try {
    const { document } = harness.window
    const root = document.documentElement
    root.style.setProperty('--log-bg', '40 44 52')
    root.style.setProperty('--log-red', '204 0 0')
    root.style.setProperty('--term-bg', '1 2 3')
    const container = document.createElement('div')
    document.body.append(container)
    const terminal = {
      options: {
        theme: readTerminalTheme(harness.window.getComputedStyle(root) as unknown as CSSStyleDeclaration, 'log'),
      },
    }
    expect(terminal.options.theme.background).toBe('rgb(40, 44, 52)')
    expect(terminal.options.theme.red).toBe('rgb(204, 0, 0)')
    dispose = observeTerminalTheme(terminal, container as unknown as HTMLElement, 'log')
    root.style.setProperty('--log-red', '1 2 3 / 0.5')
    await harness.window.happyDOM.waitUntilComplete()
    expect(terminal.options.theme.red).toBe('rgba(1, 2, 3, 0.5)')
  } finally {
    dispose?.()
    await harness.cleanup()
  }
})

test('all log scopes preserve the pre-migration xterm 5.5 palette and both viewers own their observer', async () => {
  const { default: legacy } = await import('./fixtures/legacy-log-colors.json')
  const { palettes } = await import('./test/builtins')
  for (const palette of palettes) {
    for (const [token, channels] of Object.entries(legacy)) expect(palette.tokens[token]).toBe(channels)
  }
  for (const file of ['settings/SystemLogsSection.tsx', 'squads/SandboxLogs.tsx']) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8')
    expect(source).toContain("theme: readTerminalTheme(window.getComputedStyle(document.documentElement), 'log')")
    expect(source.indexOf("observeTerminalTheme(term, containerRef.current, 'log')")).toBeLessThan(
      source.indexOf('term.open(')
    )
    expect(source.indexOf('stopThemeObserver()')).toBeLessThan(source.indexOf('term.dispose()'))
  }
})
