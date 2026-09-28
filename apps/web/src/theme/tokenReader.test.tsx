import { expect, test } from 'bun:test'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { applyResolvedTheme } from './apply'
import { IRIS_THEME } from './registry'
import { createTokenReader, readTokenColor, tokenColor } from './tokenReader'
import { useThemeColors } from './useThemeColors'
import { agentGraphColor, squadGraphColor } from './graph'

test('concrete colors preserve fractional channels, inline alpha, intrinsic alpha and sentinels', () => {
  expect(tokenColor('1.5 2.25 3.75')).toBe('rgb(1.5, 2.25, 3.75)')
  expect(tokenColor('1 2 3 / 50%', '0.2')).toBe('rgba(1, 2, 3, 0.1)')
  for (const sentinel of ['', 'auto', 'none']) expect(tokenColor(sentinel)).toBeUndefined()
  const tokens: Record<string, string> = {
    '--status-progress-surface': '1 2 3',
    '--opacity-status-progress-surface': '0.2',
    '--color-panel-border': '4 5 6',
    '--opacity-panel-border': '0.12',
  }
  const style = { getPropertyValue: (token: string) => tokens[token] ?? '' }
  expect(readTokenColor(style, '--status-progress-surface')).toBe('rgba(1, 2, 3, 0.2)')
  expect(readTokenColor(style, '--color-panel-border')).toBe('rgba(4, 5, 6, 0.12)')
})

test('memoized reader re-reads on appearance, theme, inline override and reset; unsubscribes', async () => {
  const harness = await acquireDomHarness({ url: 'https://tau.test' })
  let dispose: (() => void) | undefined
  try {
    const { window } = harness
    const root = document.documentElement
    const style = document.createElement('style')
    style.textContent =
      ':root { --graph-bg: 1 2 3; } .dark { --graph-bg: 4 5 6; } [data-theme="other"] { --graph-bg: 7 8 9; }'
    document.head.append(style)
    applyResolvedTheme(root, IRIS_THEME, 'light')
    const reader = createTokenReader(root)
    const first = reader.getSnapshot()
    expect(first['--graph-bg']).toBe('rgb(1, 2, 3)')
    expect(reader.getSnapshot()).toBe(first)
    let notifications = 0
    dispose = reader.subscribe(() => {
      notifications++
    })
    applyResolvedTheme(root, IRIS_THEME, 'dark')
    // Synchronous imperative read must not suppress the later React notification.
    expect(reader.getSnapshot()['--graph-bg']).toBe('rgb(4, 5, 6)')
    await window.happyDOM.waitUntilComplete()
    expect(notifications).toBeGreaterThan(0)
    applyResolvedTheme(
      root,
      { id: 'other', label: 'Other', kind: 'unified', variantClass: { constant: null } },
      'constant'
    )
    await window.happyDOM.waitUntilComplete()
    expect(reader.getSnapshot()['--graph-bg']).toBe('rgb(7, 8, 9)')
    root.style.setProperty('--graph-bg', '10.5 11 12 / 0.5')
    await window.happyDOM.waitUntilComplete()
    expect(reader.getSnapshot()['--graph-bg']).toBe('rgba(10.5, 11, 12, 0.5)')
    root.style.removeProperty('--graph-bg')
    await window.happyDOM.waitUntilComplete()
    expect(reader.getSnapshot()['--graph-bg']).toBe('rgb(7, 8, 9)')
    const last = notifications
    dispose()
    applyResolvedTheme(root, IRIS_THEME, 'light')
    await window.happyDOM.waitUntilComplete()
    expect(notifications).toBe(last)
    expect(reader.getSnapshot()['--graph-bg']).toBe('rgb(1, 2, 3)')
  } finally {
    dispose?.()
    await harness.cleanup()
  }
})

test('mounted consumers refresh graph and status colors without remounting or prop changes', async () => {
  const harness = await acquireDomHarness({ url: 'https://tau.test' })
  const host = document.createElement('div')
  document.body.append(host)
  const renderer = createRoot(host)
  try {
    const root = document.documentElement
    const style = document.createElement('style')
    style.textContent =
      ':root { --status-progress-solid: 1 2 3; --status-success-solid: 4 5 6; --graph-node-active: var(--status-success-solid); } .dark { --status-progress-solid: 7 8 9; --status-success-solid: 10 11 12; }'
    document.head.append(style)
    function Consumer() {
      const colors = useThemeColors()
      return (
        <output>
          {agentGraphColor(colors, 'active')}|{squadGraphColor(colors, 'active')}
        </output>
      )
    }
    await act(async () => {
      renderer.render(<Consumer />)
    })
    expect(host.textContent).toBe('rgb(1, 2, 3)|rgb(4, 5, 6)')
    const node = host.firstChild
    await act(async () => {
      applyResolvedTheme(root, IRIS_THEME, 'dark')
      await harness.window.happyDOM.waitUntilComplete()
    })
    expect(host.firstChild).toBe(node)
    expect(host.textContent).toBe('rgb(7, 8, 9)|rgb(10, 11, 12)')
    await act(async () => {
      root.style.setProperty('--status-success-solid', '13 14 15')
      await harness.window.happyDOM.waitUntilComplete()
    })
    expect(host.textContent).toBe('rgb(7, 8, 9)|rgb(13, 14, 15)')
  } finally {
    await act(async () => renderer.unmount())
    await harness.cleanup()
  }
})
