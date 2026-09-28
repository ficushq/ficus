import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { ACTIVE_THEME_TOKENS, compileCustomTheme, validateCustomTheme } from '@ficus/shared'
import { TauLogo } from '../components/TauLogo'
import { BUILT_IN_THEMES } from './registry'
import { palettes } from './test/builtins'

const tokens = ['--brand-gradient-from', '--brand-gradient-to', '--brand-tile', '--brand-ink']
test('brand colors are active, complete in every builtin, and custom-overridable', () => {
  for (const token of tokens) {
    expect(ACTIVE_THEME_TOKENS).toContain(token)
    for (const palette of palettes) expect(palette.tokens[token]).toBeDefined()
    const result = validateCustomTheme(
      JSON.stringify({
        format: 'tau-custom-theme',
        version: 1,
        name: 'Brand',
        base: 'tau',
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
test('logo and refresh use scoped brand channels rather than literal colors', () => {
  const markup = renderToStaticMarkup(<TauLogo />)
  for (const token of tokens) expect(markup).toContain(`var(${token})`)
  expect(markup).not.toMatch(/#a855f7|#7c3aed|fill="white"/)
  const refresh = readFileSync(new URL('../components/PullToRefresh.tsx', import.meta.url), 'utf8')
  expect(refresh).toContain('var(--brand-gradient-to)')
  expect(refresh).not.toContain('#7c3aed')
})

test('separate logo scopes cannot reference another logo gradient', () => {
  const markup = renderToStaticMarkup(
    <>
      <TauLogo />
      <TauLogo />
    </>
  )
  const ids = [...markup.matchAll(/linearGradient id="([^"]+)"/g)].map((match) => match[1])
  expect(new Set(ids).size).toBe(2)
  for (const id of ids) expect(markup).toContain(`url(#${id})`)
})
