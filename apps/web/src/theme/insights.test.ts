import { expect, test } from 'bun:test'
import { computeThemeInsights } from './insights'
import { palettes } from './test/builtins'
import { pairBackground, contrast, tokenRgba } from './contrast'

const irisLight = palettes.find((p) => p.id === 'iris' && p.appearance === 'light')!.tokens

test('computes hex key colors from resolved tokens', () => {
  const insights = computeThemeInsights(irisLight, 'light', [])
  expect(insights.resolvedAppearance).toBe('light')
  expect(insights.keyColors.primary).toMatch(/^#[0-9a-f]{6}$/)
  expect(insights.keyColors.surface).toMatch(/^#[0-9a-f]{6}$/)
  expect(insights.keyColors.text).toMatch(/^#[0-9a-f]{6}$/)
  expect(insights.contrastWarnings).toEqual([])
})

test('formats already-computed warnings without recomputing contrast', () => {
  const pair = { fg: '--color-text-primary', bg: '--color-bg-surface', minimum: 4.5 }
  const bg = pairBackground(irisLight, pair)!
  const ratio = contrast(tokenRgba(irisLight, pair.fg), bg)
  const insights = computeThemeInsights(irisLight, 'light', [{ pair, ratio }])
  expect(insights.contrastWarnings).toHaveLength(1)
  expect(insights.contrastWarnings[0]).toContain('--color-text-primary on --color-bg-surface')
  expect(insights.contrastWarnings[0]).toContain(`${ratio.toFixed(2)}:1`)
})

test('an unknown-backdrop warning (null ratio) is reported without a fabricated number', () => {
  const pair = { fg: '--color-text-primary', bg: '--color-bg-surface', minimum: 4.5, under: '--color-bg-page' }
  const insights = computeThemeInsights(irisLight, 'light', [{ pair, ratio: null }])
  expect(insights.contrastWarnings[0]).toContain('unknown backdrop')
  expect(insights.contrastWarnings[0]).toContain('over --color-bg-page')
})

test('caps contrastWarnings at 20 even if more are passed in', () => {
  const pair = { fg: '--color-text-primary', bg: '--color-bg-surface', minimum: 4.5 }
  const many = Array.from({ length: 30 }, () => ({ pair, ratio: 1 }))
  const insights = computeThemeInsights(irisLight, 'light', many)
  expect(insights.contrastWarnings).toHaveLength(20)
})

test('missing/unreadable key tokens are simply omitted, never a fabricated color', () => {
  const insights = computeThemeInsights({}, 'constant', [])
  expect(insights.keyColors).toEqual({})
})
