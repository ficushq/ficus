import { expect, test } from 'bun:test'
import tinycolor from 'tinycolor2'
import { css as xtermCss } from '@xterm/xterm/src/common/Color'
import { compileCustomTheme, validateCustomTheme } from '@ficus/shared/custom-theme'
import { BUILT_IN_THEMES } from './registry'
import { readTokenColor } from './tokenReader'
import { readTerminalTheme, terminalTokenColor } from './terminal'

for (const alpha of ['0.5', '0.0000001', `0.${'0'.repeat(323)}5`, '0', '1']) {
  test(`validator → compiler → actual graph/xterm parsers preserve alpha ${alpha}`, () => {
    const value = `rgba(10,20,30,${alpha})`
    const raw = JSON.stringify({
      format: 'tau-custom-theme',
      version: 1,
      name: 'Parser boundary',
      base: 'tau',
      appearance: 'light',
      overrides: {
        '--graph-link-2': value,
        '--term-selection-background': value,
        '--log-selection-background': value,
      },
    })
    const result = validateCustomTheme(raw, BUILT_IN_THEMES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const properties = compileCustomTheme(result.document, 'light')
    for (const intrinsic of ['1', '0.12', '0.00000001']) {
      const style = {
        getPropertyValue: (name: string) => (name === '--opacity-graph-link-2' ? intrinsic : (properties[name] ?? '')),
      }
      const concrete = readTokenColor(style, '--graph-link-2')!
      const expected = Number(alpha) * Number(intrinsic)
      const graph = tinycolor(concrete)
      expect(graph.isValid()).toBe(true)
      expect(graph.getAlpha()).toBe(expected)
      expect(concrete).not.toMatch(/[eE][+-]?\d/)
      // xterm necessarily quantizes alpha to 8 bits; transparent is correct,
      // parser rejection / fallback to its opaque default is not.
      expect(xtermCss.toColor(concrete).rgba & 255).toBe(Math.round(expected * 255))
      expect(xtermCss.toColor(terminalTokenColor(`10 20 30 / ${expected}`)!).rgba & 255).toBe(
        Math.round(expected * 255)
      )
    }
    const style = { getPropertyValue: (name: string) => properties[name] ?? '' }
    for (const palette of ['term', 'log'] as const) {
      const color = xtermCss.toColor(readTerminalTheme(style, palette).selectionBackground!)
      expect(color.rgba >>> 8).toBe(0x0a141e)
      expect(color.rgba & 255).toBe(Math.round(Number(alpha) * 255))
    }
  })
}
