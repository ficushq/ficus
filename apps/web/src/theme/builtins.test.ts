import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { ACTIVE_THEME_TOKENS, validateThemeTokenSet } from '@ficus/shared'
import { palettes, resolveToken, contrastPairs, pairRatio, contrast, composite } from './test/builtins'

test('contrast math uses sRGB luminance, fractional channels, and alpha compositing', () => {
  expect(contrast([0, 0, 0], [255, 255, 255])).toBe(21)
  expect(contrast([255, 255, 255], [255, 255, 255])).toBe(1)
  expect(composite([0, 0, 0, 0.5], [255, 255, 255])).toEqual([127.5, 127.5, 127.5])
  expect(contrast([0, 0, 0, 0.5], [255, 255, 255])).toBeCloseTo(3.977, 3)
})
for (const palette of palettes) {
  test(`${palette.id}/${palette.appearance}: complete explicit token and opacity metadata set`, () => {
    const names = Object.keys(palette.tokens).filter((name) => name.startsWith('--') && !name.startsWith('--opacity-'))
    expect(validateThemeTokenSet(names)).toEqual({ ok: true, missing: [], unexpected: [] })
    const metadata = Object.keys(palettes[0]!.tokens).filter((name) => name.startsWith('--opacity-'))
    for (const name of metadata) {
      expect(Number(palette.tokens[name])).toBeGreaterThan(0)
      expect(Number(palette.tokens[name])).toBeLessThanOrEqual(1)
    }
    for (const name of ACTIVE_THEME_TOKENS) {
      const value = resolveToken(palette.tokens, name)
      expect(value).toMatch(/^(?:\d+(?:\.\d+)?\s+){2}\d+(?:\.\d+)?(?:\s*\/\s*(?:[\d.]+%?))?$|^(?:none|auto)$/)
    }
    expect(resolveToken(palette.tokens, '--term-selection-foreground')).toBe('none')
    expect(resolveToken(palette.tokens, '--term-scrollbar-thumb')).toBe('auto')
  })
  test(`${palette.id}/${palette.appearance}: WCAG 1.4.3 text ≥4.5 and 1.4.11 indicators ≥3`, () => {
    const failures = contrastPairs
      .map((pair) => ({ ...pair, ratio: pairRatio(palette.tokens, pair) }))
      .filter((pair) => pair.ratio < pair.minimum)
    expect(failures).toEqual([])
  })
}

test('contrast gate multiplies channel alpha by intrinsic opacity and composites the surface', () => {
  const tokens = {
    '--fg': '0 0 0 / 0.5',
    '--opacity-fg': '0.5',
    '--bg': '0 0 0 / 0.5',
    '--opacity-bg': '0.5',
    '--color-bg-surface': '255 255 255',
  }
  const background = composite([0, 0, 0, 0.25], [255, 255, 255])
  expect(pairRatio(tokens, { fg: '--fg', bg: '--bg', minimum: 4.5 })).toBe(contrast([0, 0, 0, 0.25], background))
})

test('forced-colors retains real boundaries/focus and visible voice status without opting out', () => {
  const css = postcss.parse(readFileSync(new URL('../design-system.css', import.meta.url), 'utf8'))
  const declarations: Record<string, Record<string, string>> = {}
  css.walkAtRules('media', (media) => {
    if (media.params !== '(forced-colors: active)') return
    media.walkRules((rule) => {
      declarations[rule.selector] = {}
      rule.walkDecls((decl) => {
        declarations[rule.selector]![decl.prop] = decl.value
      })
    })
  })
  expect(declarations['.ficus-button,\n  .ficus-field']?.outline).toBe('1px solid ButtonText')
  expect(declarations['.voice-orb']?.outline).toBe('2px solid ButtonText')
  expect(declarations['.voice-orb:focus-visible']?.outline).toBe('3px solid Highlight')
  expect(declarations['.voice-orb-status']?.display).toBe('block')
  expect(declarations['.voice-orb-status::after']?.content).toBe('attr(aria-label)')
  expect(Object.values(declarations).some((decl) => decl['forced-color-adjust'] === 'none')).toBe(false)
})
