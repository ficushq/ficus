import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { ACTIVE_THEME_TOKENS, compileCustomTheme, validateCustomTheme } from '@ficus/shared'
import { FicusLogo } from '../components/FicusLogo'
import { BUILT_IN_THEMES } from './registry'
import { palettes } from './test/builtins'

const tokens = ['--brand-gradient-from', '--brand-gradient-to', '--brand-tile', '--brand-ink']
test('brand colors are active, complete in every builtin, and custom-overridable', () => {
  for (const token of tokens) {
    expect(ACTIVE_THEME_TOKENS).toContain(token)
    for (const palette of palettes) expect(palette.tokens[token]).toBeDefined()
    const result = validateCustomTheme(
      JSON.stringify({
        format: 'ficus-custom-theme',
        version: 1,
        name: 'Brand',
        base: 'iris',
        appearance: 'light',
        overrides: { [token]: '#12345680' },
      }),
      BUILT_IN_THEMES
    )
    if (!result.ok) throw new Error(result.error)
    const compiled = compileCustomTheme(result.document, 'light')
    expect(compiled[token]).toBe('18 52 86 / 0.5019607843137255')
  }
})

test('the logo is the Ficus mark, not the old tau glyph', () => {
  // Outside a ThemeProvider, FicusLogo falls back to its light-mode colors —
  // this asserts the mark's leaf fill from brand/ficus-mark.svg verbatim.
  const markup = renderToStaticMarkup(<FicusLogo />)
  expect(markup).not.toContain(String.fromCharCode(0x3c4)) // the old tau glyph
  expect(markup).toMatch(/<svg[^>]*>/)
  expect(markup).toContain('fill="#3f6b4f"')
})

test('refresh still uses the scoped brand channel rather than a literal color', () => {
  const refresh = readFileSync(new URL('../components/PullToRefresh.tsx', import.meta.url), 'utf8')
  expect(refresh).toContain('var(--brand-gradient-to)')
  expect(refresh).not.toContain('#7c3aed')
})
