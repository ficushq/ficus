import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { palettes, pairRatio } from './test/builtins'

// Markdown prose on the app's surfaces (MarkdownContent's non-bubble variants) takes every colour from
// `.prose.prose-themed` in design-system.css. The typography plugin's own gray palette is fixed Tailwind gray, which
// fell below 4.5:1 on the mid-tone built-ins (adzukiiro, moegiiro, asagiiro, yamabukiiro).
const rule = (() => {
  let found: postcss.Rule | undefined
  postcss.parse(readFileSync(new URL('../design-system.css', import.meta.url), 'utf8')).walkRules((r) => {
    if (r.selector === '.prose.prose-themed') found = r
  })
  if (!found) throw new Error('.prose.prose-themed is missing from design-system.css')
  return found
})()
const declarations: Record<string, string> = {}
rule.walkDecls((decl) => {
  declarations[decl.prop] = decl.value
})
const token = (value: string) => /^rgb\(var\((--[\w-]+)\)\)$/.exec(value)?.[1]

const surfaces = ['page', 'surface', 'surface-secondary', 'pill', 'surface-hover', 'inset'].map(
  (slot) => `--color-bg-${slot}`
)
// Text drawn directly on the surface (bullets and counters are list markers, also text).
const textRoles = ['headings', 'lead', 'links', 'bold', 'counters', 'bullets', 'quotes', 'captions', 'kbd']

test('every prose colour is a theme token (or the caller ink), and the invert set cannot differ', () => {
  const names = Object.keys(declarations).filter((name) => name.startsWith('--tw-prose-'))
  expect(names.length).toBeGreaterThan(0)
  for (const name of names) {
    const value = declarations[name]!
    const tokenized =
      value === 'currentColor' ||
      token(value) !== undefined ||
      /^color-mix\(in srgb, rgb\(var\(--[\w-]+\)\) \d+%, transparent\)$/.test(value)
    expect({ name, value, tokenized }).toEqual({ name, value, tokenized: true })
    if (!name.startsWith('--tw-prose-invert-'))
      expect(declarations[name.replace('--tw-prose-', '--tw-prose-invert-')]).toBe(value)
  }
  // Body text is the ink the caller puts on or around the markdown (text-primary, -secondary or -muted).
  expect(declarations['--tw-prose-body']).toBe('currentColor')
  expect(token(declarations['--tw-prose-code']!)).toBe('--color-code-text')
})

for (const palette of palettes) {
  test(`${palette.id}/${palette.appearance}: markdown prose text meets 4.5:1 on every surface`, () => {
    const pairs = [
      ...textRoles.flatMap((role) =>
        surfaces.map((bg) => ({ role, fg: token(declarations[`--tw-prose-${role}`]!)!, bg, minimum: 4.5 }))
      ),
      { role: 'code', fg: token(declarations['--tw-prose-code']!)!, bg: '--color-code-bg', minimum: 4.5 },
      { role: 'pre-code', fg: token(declarations['--tw-prose-pre-code']!)!, bg: '--syntax-bg', minimum: 4.5 },
    ]
    const failures = pairs
      .map((pair) => ({ ...pair, ratio: pairRatio(palette.tokens, pair) }))
      .filter((pair) => pair.ratio < pair.minimum)
    expect(failures).toEqual([])
  })
}
