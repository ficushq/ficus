import { describe, expect, test } from 'bun:test'
import { ACTIVE_THEME_TOKENS, STATUS_TOKENS, THEME_TOKEN_NAMES } from './theme-schema'
import {
  CUSTOM_THEME_MAX_BYTES,
  compileCustomTheme,
  customColorChannels,
  readCustomThemeVariant,
  validateCustomTheme,
} from './custom-theme'

const builtins = [
  { id: 'iris', label: 'Iris', kind: 'dual' as const },
  { id: 'high-contrast', label: 'High contrast', kind: 'unified' as const },
]
// v1 input: one concrete appearance per document.
const v1doc = {
  format: 'ficus-custom-theme',
  version: 1,
  name: 'My theme',
  base: 'iris',
  appearance: 'dark',
  overrides: {},
}
// v2 input: a light/dark pair (dual base) that follows the appearance toggle.
const v2doc = {
  format: 'ficus-custom-theme',
  version: 2,
  name: 'My theme',
  base: 'iris',
  variants: { light: {}, dark: {} },
}
const validate = (value: unknown) => validateCustomTheme(JSON.stringify(value), builtins)

describe('closed custom color grammar', () => {
  for (const [value, channels] of [
    ['#aBc', '170 187 204'],
    ['#0102ff', '1 2 255'],
    ['#01020300', '1 2 3 / 0'],
    ['#ffffff80', `255 255 255 / ${128 / 255}`],
    ['rgb(0, 128, 255)', '0 128 255'],
    ['rgba(1,2,3,.5)', '1 2 3 / 0.5'],
    ['rgba(1,2,3,1)', '1 2 3 / 1'],
  ] as const) {
    test(`accepts ${value}`, () => expect(customColorChannels(value)).toBe(channels))
  }
  for (const value of [
    null,
    1,
    {},
    [],
    '',
    '#12',
    '#1234',
    '#12345',
    '#gggggg',
    'red',
    'transparent',
    'none',
    'auto',
    '1 2 3',
    'var(--x)',
    'url(https://evil.test)',
    'color-mix(in srgb, red, blue)',
    'env(x)',
    'calc(1 + 2)',
    '#fff;',
    '#fff{}',
    '<style>',
    '#fff/*x*/',
    '#fff//x',
    'rgb(256,0,0)',
    'rgb(-1,0,0)',
    'rgb(1.1,2,3)',
    'rgb(10%,2,3)',
    'rgb(1 2 3)',
    'rgb(1,2,3,1)',
    'rgba(1,2,3)',
    'rgba(1,2,3,1.1)',
    'rgba(1,2,3,-1)',
    'rgba(1,2,3,50%)',
    'rgb(1e2,2,3)',
    'rgba(1,2,3,NaN)',
    '#fff\nurl(x)',
  ]) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expect(customColorChannels(value)).toBeNull()
      expect(validate({ ...v2doc, variants: { light: { '--color-primary': value }, dark: {} } }).ok).toBe(false)
    })
  }
})

describe('format marker', () => {
  test('exports carry ficus-custom-theme and an unknown marker is rejected', () => {
    const result = validate(v2doc)
    expect(result.ok && result.document.format).toBe('ficus-custom-theme')
    expect(validate({ ...v2doc, format: 'other-custom-theme' })).toEqual({
      ok: false,
      error: 'Expected format ficus-custom-theme.',
    })
  })

  // Files exported before the Ficus rename. Remove with the old marker in the Wave 3 sweep.
  test('an import with the pre-rename marker is accepted and rewritten to ficus-custom-theme', () => {
    for (const doc of [v1doc, v2doc]) {
      const result = validate({ ...doc, format: 'tau-custom-theme' })
      expect(result.ok && result.document.format).toBe('ficus-custom-theme')
    }
  })

  test('a pre-rename file keeps its look: the purple base resolves to iris and Forest to ficus', () => {
    const renamed = [...builtins, { id: 'ficus', label: 'Ficus', kind: 'dual' as const }]
    const load = (base: string, format: string) =>
      validateCustomTheme(JSON.stringify({ ...v2doc, base, format }), renamed)
    const purple = load('tau', 'tau-custom-theme')
    expect(purple.ok && purple.document.base).toBe('iris')
    expect(purple.ok && purple.document.format).toBe('ficus-custom-theme')
    const forest = load('forest', 'tau-custom-theme')
    expect(forest.ok && forest.document.base).toBe('ficus')
    const iris = load('iris', 'tau-custom-theme')
    expect(iris.ok && iris.document.base).toBe('iris')
    // A current-format document names current ids only.
    expect(load('tau', 'ficus-custom-theme').ok).toBe(false)
    expect(load('forest', 'ficus-custom-theme').ok).toBe(false)
  })
})

describe('v1 documents load and normalize into v2 pairs', () => {
  test('required fields, types, version, base and concrete appearance are enforced', () => {
    for (const key of Object.keys(v1doc)) {
      const broken = { ...v1doc } as Record<string, unknown>
      delete broken[key]
      expect(validate(broken).ok).toBe(false)
    }
    for (const value of [
      null,
      [],
      true,
      'text',
      { ...v1doc, name: '' },
      { ...v1doc, name: '   ' },
      { ...v1doc, name: 'x'.repeat(41) },
      { ...v1doc, base: '__proto__' },
      { ...v1doc, base: 'missing' },
      { ...v1doc, appearance: 'system' },
      { ...v1doc, appearance: 'constant' },
      { ...v1doc, base: 'high-contrast' },
      { ...v1doc, overrides: [] },
      { ...v1doc, overrides: null },
    ])
      expect(validate(value).ok).toBe(false)
    expect(validate({ ...v1doc, base: 'high-contrast', appearance: 'constant' }).ok).toBe(true)
    expect(validateCustomTheme('{broken', builtins).ok).toBe(false)
  })

  test('a v1 dark document normalizes to a v2 pair with an empty light side', () => {
    const result = validate({
      ...v1doc,
      overrides: { '--color-primary': '#0ea5e9' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document).toEqual({
      format: 'ficus-custom-theme',
      version: 2,
      name: 'My theme',
      base: 'iris',
      variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
    })
  })

  test('a v1 unified (constant) document normalizes into a single constant variant', () => {
    const result = validate({
      ...v1doc,
      base: 'high-contrast',
      appearance: 'constant',
      overrides: { '--color-primary': '#0ea5e9' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.variants).toEqual({ constant: { '--color-primary': '#0ea5e9' } })
  })
})

describe('v2 documents hold an explicit light/dark pair or a constant variant', () => {
  test('dual bases require both light and dark variant keys', () => {
    expect(validate({ ...v2doc, variants: { light: {} } }).ok).toBe(false)
    expect(validate({ ...v2doc, variants: { dark: {} } }).ok).toBe(false)
    expect(validate({ ...v2doc, variants: {} }).ok).toBe(false)
    expect(validate({ ...v2doc, variants: null }).ok).toBe(false)
    expect(validate({ ...v2doc, variants: [] }).ok).toBe(false)
    expect(validate({ ...v2doc, variants: { light: {}, dark: {}, constant: {} } }).ok).toBe(true)
    // A high-contrast (unified) base with a light/dark pair is refused; it requires 'constant'.
    expect(validate({ ...v2doc, base: 'high-contrast', variants: { light: {}, dark: {} } }).ok).toBe(false)
    expect(validate({ ...v2doc, base: 'high-contrast', variants: { constant: {} } }).ok).toBe(true)
  })

  test('each variant is validated independently: an invalid dark side fails even with a valid light side', () => {
    expect(
      validate({
        ...v2doc,
        variants: { light: { '--color-primary': '#0ea5e9' }, dark: { '--color-primary': 'url(x)' } },
      }).ok
    ).toBe(false)
  })

  test('one variant can be empty while the other carries overrides (a partial pair is valid)', () => {
    const result = validate({
      ...v2doc,
      variants: { light: { '--color-primary': '#0ea5e9' }, dark: {} },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.variants).toEqual({ light: { '--color-primary': '#0ea5e9' }, dark: {} })
  })

  test('unknown top-level fields (like a stray v1 appearance) are dropped, not errors', () => {
    const result = validate({ ...v2doc, appearance: 'dark' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document).not.toHaveProperty('appearance')
  })
})

test('caps UTF-8 document bytes before parsing and override count before ignoring unknown names', () => {
  expect(validateCustomTheme(' '.repeat(CUSTOM_THEME_MAX_BYTES + 1), builtins).ok).toBe(false)
  const raw = JSON.stringify(v2doc)
  expect(validateCustomTheme(raw.padEnd(CUSTOM_THEME_MAX_BYTES, ' '), builtins).ok).toBe(true)
  const overrides = Object.fromEntries(
    Array.from({ length: THEME_TOKEN_NAMES.length + 1 }, (_, i) => [`x${i}`, '#fff'])
  )
  expect(validate({ ...v2doc, variants: { light: overrides, dark: {} } })).toEqual({
    ok: false,
    error: 'light: Too many token overrides.',
  })
})

test('the byte cap is measured in UTF-8 bytes, not JS string (UTF-16 code unit) length', () => {
  // A supplementary-plane emoji is 2 UTF-16 code units (counted by .length) but
  // 4 UTF-8 bytes. Padding with it keeps .length comfortably under the cap
  // while pushing the real UTF-8 byte size well over it — this would slip past
  // a cap check that used raw.length instead of TextEncoder byte length.
  const emoji = '\u{1F3A8}'
  const raw = emoji.repeat(10000)
  expect(raw.length).toBeLessThan(CUSTOM_THEME_MAX_BYTES)
  expect(new TextEncoder().encode(raw).length).toBeGreaterThan(CUSTOM_THEME_MAX_BYTES)
  expect(validateCustomTheme(raw, builtins).ok).toBe(false)
})

test('a full light+dark override of every active token (worst-case pair) fits the byte cap', () => {
  // Justifies the raised cap: a v1 single-variant document only ever needed one
  // side of the grid; a v2 pair can carry BOTH sides at once. #rrggbbaa (9 chars)
  // is the longest fixed-length accepted color form, so this is the realistic
  // worst case, not an adversarial unbounded-decimal one (which the overall byte
  // cap already rejects regardless of this test).
  const light = Object.fromEntries(ACTIVE_THEME_TOKENS.map((t) => [t, '#ffffffaa']))
  const dark = Object.fromEntries(ACTIVE_THEME_TOKENS.map((t) => [t, '#000000aa']))
  const doc = {
    format: 'ficus-custom-theme',
    version: 2,
    name: 'x'.repeat(40),
    base: 'iris',
    variants: { light, dark },
  }
  const raw = JSON.stringify(doc)
  expect(new TextEncoder().encode(raw).length).toBeLessThan(CUSTOM_THEME_MAX_BYTES)
  const result = validateCustomTheme(raw, builtins)
  expect(result.ok).toBe(true)
})

test('unknown/inactive names warn and cannot become properties, including prototype names', () => {
  const result = validateCustomTheme(
    JSON.stringify(v2doc).replace(
      '"dark":{}',
      '"dark":{"__proto__":"#fff","constructor":"#000","--future":"#abc","--future-brand-tile":"#def","--color-primary":"#123"}'
    ),
    builtins
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.warnings).toHaveLength(4)
  expect(Object.keys(result.document.variants).includes('dark')).toBe(true)
  expect(
    'dark' in result.document.variants ? Object.keys((result.document.variants as { dark: object }).dark) : []
  ).toEqual(['--color-primary'])
  expect(validate({ ...v2doc, variants: { light: {}, dark: { '--future': 'url(x)' } } }).ok).toBe(false)
})

test('status overrides are atomic BEFORE base inheritance, independently per variant', () => {
  for (const token of STATUS_TOKENS)
    expect(validate({ ...v2doc, variants: { light: {}, dark: { [token]: '#fff' } } }).ok).toBe(false)
  const status = Object.fromEntries(STATUS_TOKENS.map((token) => [token, '#fff']))
  expect(validate({ ...v2doc, variants: { light: {}, dark: status } }).ok).toBe(true)
  for (const token of ACTIVE_THEME_TOKENS.filter((t) => !STATUS_TOKENS.includes(t)))
    expect(validate({ ...v2doc, variants: { light: {}, dark: { [token]: '#fff' } } }).ok).toBe(true)
})

test('compileCustomTheme resolves the requested variant and computes custom-rgb/alpha helpers', () => {
  const result = validate({
    ...v2doc,
    variants: {
      light: { '--graph-bg': '#123456' },
      dark: { '--graph-bg': '#123', '--term-bg': 'rgba(1,2,3,0.5)' },
    },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(compileCustomTheme(result.document, 'dark')).toEqual({
    '--graph-bg': '17 34 51',
    '--term-bg': '1 2 3 / 0.5',
    '--custom-rgb-graph-bg': '17 34 51',
    '--custom-alpha-graph-bg': '1',
    '--custom-rgb-term-bg': '1 2 3',
    '--custom-alpha-term-bg': '0.5',
  })
  expect(compileCustomTheme(result.document, 'light')).toEqual({
    '--graph-bg': '18 52 86',
    '--custom-rgb-graph-bg': '18 52 86',
    '--custom-alpha-graph-bg': '1',
  })
  // 'system' is never a compile-time appearance; callers resolve it first. If one
  // ever slipped through anyway (bypassing the type system), a dual document
  // must still fall back to 'light' rather than throw or silently pick 'dark'.
  expect(compileCustomTheme(result.document, 'system' as never)).toEqual(compileCustomTheme(result.document, 'light'))
})

test('compileCustomTheme on a unified document always resolves the constant variant', () => {
  const result = validate({
    ...v1doc,
    base: 'high-contrast',
    appearance: 'constant',
    overrides: { '--graph-bg': '#123456' },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(compileCustomTheme(result.document, 'constant')).toEqual({
    '--graph-bg': '18 52 86',
    '--custom-rgb-graph-bg': '18 52 86',
    '--custom-alpha-graph-bg': '1',
  })
})

test('readCustomThemeVariant exposes raw (uncompiled) overrides per variant, for editor tabs', () => {
  const result = validate({
    ...v2doc,
    variants: { light: { '--color-primary': '#111' }, dark: { '--color-primary': '#222' } },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(readCustomThemeVariant(result.document.variants, 'light')).toEqual({ '--color-primary': '#111' })
  expect(readCustomThemeVariant(result.document.variants, 'dark')).toEqual({ '--color-primary': '#222' })
})
