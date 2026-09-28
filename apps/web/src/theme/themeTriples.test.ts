import { describe, expect, test } from 'bun:test'
import { THEME_TRIPLES, type ThemeTriple } from '@ficus/shared/theme-triples'
import { BUILT_IN_THEMES } from './registry'
import { palettes } from './test/builtins'

/** "r g b" channels (the CSS token form) as the lowercase #rrggbb the triples use. */
function hex(channels: string): string {
  const parts = channels.trim().split(/\s+/)
  expect(parts).toHaveLength(3)
  return `#${parts.map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
}

describe('THEME_TRIPLES (@ficus/shared/theme-triples) matches the built-in CSS', () => {
  test('has exactly one entry per built-in theme id', () => {
    expect(Object.keys(THEME_TRIPLES).sort()).toEqual(BUILT_IN_THEMES.map((theme) => theme.id).sort())
  })

  test('every value is a lowercase #rrggbb string', () => {
    for (const { light, dark } of Object.values(THEME_TRIPLES))
      for (const value of [...Object.values(light), ...Object.values(dark)]) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })

  for (const palette of palettes) {
    test(`${palette.id} (${palette.appearance}): page, primary text and primary`, () => {
      const expected: ThemeTriple = {
        background: hex(palette.tokens['--color-bg-page']!),
        foreground: hex(palette.tokens['--color-text-primary']!),
        accent: hex(palette.tokens['--color-primary']!),
      }
      const entry = THEME_TRIPLES[palette.id]!
      // A constant (unified) theme repeats its one triple for light and dark.
      const sides = palette.appearance === 'constant' ? [entry.light, entry.dark] : [entry[palette.appearance]]
      for (const side of sides) expect(side).toEqual(expected)
    })
  }
})
