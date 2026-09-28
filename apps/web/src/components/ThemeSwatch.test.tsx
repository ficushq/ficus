import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { findWebTheme } from '../theme/registry'
import { ThemeSwatch } from './ThemeSwatch'

const halves = (html: string) =>
  [...html.matchAll(/class="theme-swatch-half"[^>]*|data-appearance="(light|dark)"[^>]*class="theme-swatch-half"/g)]
    .length

test('a theme with light and dark appearances shows both halves; a one-appearance theme stays whole', () => {
  const dual = renderToStaticMarkup(
    <ThemeSwatch spec={{ kind: 'builtin', theme: findWebTheme('harbor'), appearance: 'dark' }} />
  )
  expect(dual).toContain('theme-swatch-split')
  expect(dual).toContain('data-appearance="light" class="theme-swatch-half"')
  expect(dual).toContain('data-appearance="dark" class="theme-swatch-half"')
  const unified = renderToStaticMarkup(
    <ThemeSwatch spec={{ kind: 'builtin', theme: findWebTheme('high-contrast'), appearance: 'light' }} />
  )
  expect(unified).not.toContain('theme-swatch-split')
  expect(halves(unified)).toBe(0)
})

test('a preset on a light/dark base is split too', () => {
  const html = renderToStaticMarkup(
    <ThemeSwatch
      spec={{
        kind: 'preset',
        document: {
          format: 'ficus-custom-theme',
          version: 2,
          name: 'Mine',
          base: 'ember',
          variants: { light: {}, dark: {} },
        },
        appearance: 'light',
      }}
    />
  )
  expect(html).toContain('theme-swatch-split')
  expect(html).toContain('data-appearance="dark" class="theme-swatch-half"')
})
