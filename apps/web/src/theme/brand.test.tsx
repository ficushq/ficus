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

test('the logo is the Ficus mark, not the old ficus glyph', () => {
  // Outside a ThemeProvider, FicusLogo falls back to its light-mode colors —
  // this asserts the mark's leaf fill from brand/ficus-mark.svg verbatim.
  const markup = renderToStaticMarkup(<FicusLogo />)
  expect(markup).not.toContain(String.fromCharCode(0x3c4)) // the old glyph
  expect(markup).toMatch(/<svg[^>]*>/)
  expect(markup).toContain('fill="#3f6b4f"')
})

test('refresh still uses the scoped brand channel rather than a literal color', () => {
  const refresh = readFileSync(new URL('../components/PullToRefresh.tsx', import.meta.url), 'utf8')
  expect(refresh).toContain('var(--brand-gradient-to)')
  expect(refresh).not.toContain('#7c3aed')
})

test('a decorative logo is hidden from assistive tech; a standalone one is labelled', () => {
  const standalone = renderToStaticMarkup(<FicusLogo />)
  expect(standalone).toContain('role="img"')
  expect(standalone).toContain('aria-label="Ficus"')
  const decorative = renderToStaticMarkup(<FicusLogo decorative />)
  expect(decorative).toContain('aria-hidden="true"')
  expect(decorative).not.toContain('aria-label')
})

test('the page head carries the Ficus tile color and the dark-scheme favicons', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const head = html.slice(0, html.indexOf('<script data-ficus-theme-flash>'))
  expect(head).toContain('<meta name="msapplication-TileColor" content="#3f6b4f" />')
  expect(head.match(/media="\(prefers-color-scheme: dark\)"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  for (const [, href] of head.matchAll(/href="\/icons\/([^"]+)"/g)) {
    expect(() => readFileSync(new URL(`../../public/icons/${href}`, import.meta.url))).not.toThrow()
  }
})
