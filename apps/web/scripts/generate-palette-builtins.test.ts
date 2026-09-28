import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GENERATED_END,
  GENERATED_START,
  PALETTE_BUILTINS,
  generatePaletteBuiltinsCss,
  generatePaletteThemes,
} from './generate-palette-builtins'

const builtinsCssPath = resolve(import.meta.dir, '../src/theme/builtins.css')

test('the committed builtins.css matches a fresh generator run (regenerate with: bun apps/web/scripts/generate-palette-builtins.ts)', async () => {
  const committed = readFileSync(builtinsCssPath, 'utf8')
  const generated = await generatePaletteBuiltinsCss()
  const startIndex = committed.indexOf(GENERATED_START)
  const endIndex = committed.indexOf(GENERATED_END)
  expect(startIndex).toBeGreaterThan(-1)
  expect(endIndex).toBeGreaterThan(startIndex)
  const committedSection = committed.slice(startIndex, endIndex + GENERATED_END.length)
  expect(committedSection).toBe(generated)
})

describe('generatePaletteThemes', () => {
  test('produces one light and one dark CSS block per dual palette built-in, in order', async () => {
    const themes = await generatePaletteThemes()
    expect(themes.map((t) => t.builtin.id)).toEqual(PALETTE_BUILTINS.flatMap((b) => [b.id, b.id]))
    expect(themes.map((t) => t.appearance)).toEqual(PALETTE_BUILTINS.flatMap(() => ['light', 'dark']))
    for (const theme of themes) {
      expect(theme.css).toContain(`:root[data-theme='${theme.builtin.id}'][data-appearance='${theme.appearance}']`)
      expect(theme.css).toContain(`color-scheme: ${theme.appearance};`)
    }
  })

  test('running twice produces byte-identical output (deterministic, no incidental object-key ordering drift)', async () => {
    const [first, second] = await Promise.all([generatePaletteThemes(), generatePaletteThemes()])
    expect(first.map((t) => t.css)).toEqual(second.map((t) => t.css))
  })

  test('ficus keeps status static: the utility-ramp parity gate freezes --status-ROLE-{50..950} byte-identical to Iris across every built-in', async () => {
    const ficus = PALETTE_BUILTINS.find((b) => b.id === 'ficus')!
    expect(ficus.palette.status).toBe('static')
  })
})
