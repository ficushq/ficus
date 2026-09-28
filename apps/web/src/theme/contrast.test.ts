import { expect, test } from 'bun:test'
import { compileCustomTheme, validateCustomTheme } from '@ficus/shared'
import { BUILT_IN_THEMES } from './registry'
import { palettes } from './test/builtins'
import { composite, contrast, pairBackground, pairRatio, tokenRgba } from './contrast'

const pair = { fg: '--color-text-primary', bg: '--color-bg-surface', minimum: 4.5 }
function customTokens(overrides: Record<string, string>) {
  const raw = JSON.stringify({
    format: 'tau-custom-theme',
    version: 1,
    name: 'Contrast regression',
    base: 'tau',
    appearance: 'dark',
    overrides,
  })
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return {
    ...palettes.find((p) => p.id === 'tau' && p.appearance === 'dark')!.tokens,
    ...compileCustomTheme(result.document, 'dark'),
  }
}

test('transparent surface resolves to the page, not its own hidden RGB', () => {
  const tokens = customTokens({ '--color-bg-surface': 'rgba(255,255,255,0)', '--color-text-primary': '#ffffff' })
  expect(pairBackground(tokens, pair)).toEqual([9, 10, 18])
  expect(pairRatio(tokens, pair)).toBeCloseTo(19.741, 2)
  expect(contrast([0, 0, 0], pairBackground(tokens, pair)!)).toBeLessThan(1.1)
})

test('partially transparent background and under-surface both resolve before measuring or choosing safe ink', () => {
  const tokens = customTokens({
    '--color-bg-surface': 'rgba(255,255,255,0.25)',
    '--color-bg-inset': 'rgba(255,255,255,0.5)',
  })
  const next = { ...pair, bg: '--color-bg-inset' }
  const expected = composite([255, 255, 255, 0.5], composite([255, 255, 255, 0.25], [9, 10, 18]))
  expect(pairBackground(tokens, next)).toEqual(expected)
  const status = { fg: '--status-danger-fg', bg: '--status-danger-surface', under: '--color-bg-inset', minimum: 4.5 }
  expect(pairBackground(tokens, status)).toEqual(composite(tokenRgba(tokens, status.bg), expected))
  expect(pairRatio(tokens, status)).toBe(contrast(tokenRgba(tokens, status.fg), pairBackground(tokens, status)!))
})

test('an unknown translucent page is not silently replaced by white or black', () => {
  const tokens = customTokens({ '--color-bg-surface': 'rgba(255,255,255,0)', '--color-bg-page': 'rgba(0,0,0,0.5)' })
  expect(pairBackground(tokens, pair)).toBeNull()
  expect(() => pairRatio(tokens, pair)).toThrow('unknown')
  expect(() => composite([255, 255, 255, 0.5], [0, 0, 0, 0.5])).toThrow('opaque backdrop')
  // An opaque surface still establishes its own known backdrop.
  tokens['--color-bg-surface'] = '255 255 255'
  expect(pairBackground(tokens, pair)).toEqual([255, 255, 255])
})

test('validator → compiler → contrast retains tiny alpha emitted in exponent form', () => {
  for (const alpha of ['0.0000001', '0.00000001', '0.000000000001']) {
    const tokens = customTokens({
      '--color-bg-surface': '#000000',
      '--color-text-primary': `rgba(255,255,255,${alpha})`,
    })
    expect(tokens['--color-text-primary']).toContain('e-')
    expect(tokenRgba(tokens, '--color-text-primary')).toEqual([255, 255, 255, Number(alpha)])
    expect(pairRatio(tokens, pair)).toBeCloseTo(contrast([255, 255, 255, Number(alpha)], [0, 0, 0]), 12)
    expect(pairRatio(tokens, pair)).toBeGreaterThanOrEqual(1)
    expect(pairRatio(tokens, pair)).toBeLessThan(1.000001)
  }
})
