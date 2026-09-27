import postcss from 'postcss'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ACTIVE_THEME_TOKENS, type CustomThemeDocument } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import {
  applyCustomTheme,
  clearCustomTheme,
  CUSTOM_THEME_KEY,
  PRESET_ID_KEY,
  PRESET_OWNER_ID_KEY,
  RESOLVED_SNAPSHOT_KEY,
  exportCustomTheme,
  importCustomTheme,
  loadCustomTheme,
  persistCustomTheme,
  removeCustomProperties,
} from './custom'
import { palettes, resolveToken } from './test/builtins'
import { applyResolvedTheme } from './apply'
import { findWebTheme } from './registry'
import { createTokenReader } from './tokenReader'
import { observeTerminalTheme, readTerminalTheme } from './terminal'
import { generateThemeFlash } from '../../scripts/generate-theme-flash'
import type { ThemeStorage } from './storage'

// v2: a preset covers both light and dark. This fixture is dark-only (light
// stays empty), matching what a v1 dark document normalizes to.
export const custom: CustomThemeDocument = {
  format: 'tau-custom-theme',
  version: 2,
  name: 'Test theme',
  base: 'ember',
  variants: {
    light: {},
    dark: { '--color-bg-surface': '#123456', '--term-bg': '#123456', '--graph-bg': '#234567' },
  },
}
function storageFor(raw: string | null): ThemeStorage {
  const map = new Map<string, string>([
    ['ficus-theme-id', 'harbor'],
    ['ficus-appearance', 'dark'],
    ['ficus-theme-surface', 'stale'],
  ])
  if (raw !== null) map.set(CUSTOM_THEME_KEY, raw)
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

test('custom theme storage keys are the ficus names', () => {
  expect(CUSTOM_THEME_KEY).toBe('ficus-custom-theme')
  expect(PRESET_ID_KEY).toBe('ficus-theme-preset-id')
  expect(PRESET_OWNER_ID_KEY).toBe('ficus-theme-preset-owner-id')
  expect(RESOLVED_SNAPSHOT_KEY).toBe('ficus-custom-theme-resolved')
})

test('every authored built-in scope also defines the nested preview base (no copied runtime palette)', () => {
  for (const p of palettes) {
    const css = postcss.parse(
      readFileSync(new URL(p.id === 'tau' ? '../index.css' : './builtins.css', import.meta.url), 'utf8')
    )
    const expected = `[data-theme-scope][data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
    let matches = 0
    css.walkRules((rule) => {
      const selectors = rule.selectors.map((selector) => selector.replaceAll("'", '"'))
      if (!selectors.includes(p.selector)) return
      expect(selectors).toContain(expected)
      matches++
    })
    expect(matches).toBe(1)
  }
})

test('recovery matrix: invalid documents clear storage/snapshots, retain a known base, never reload', () => {
  for (const raw of [
    '{broken',
    'null',
    ' '.repeat(32769),
    JSON.stringify({ ...custom, version: 9 }),
    JSON.stringify({ ...custom, variants: { light: {}, dark: { '--term-bg': 'url(x)' } } }),
    JSON.stringify({ ...custom, base: 'unknown' }),
    JSON.stringify({ ...custom, variants: { light: {}, dark: { '--status-danger-fg': '#fff' } } }),
  ]) {
    const storage = storageFor(raw)
    const state = loadCustomTheme(storage)
    expect(state.custom).toBeNull()
    expect(state.presetId).toBeNull()
    expect(state.error).toContain('Custom theme removed')
    expect(storage.getItem(CUSTOM_THEME_KEY)).toBeNull()
    expect(storage.getItem('ficus-theme-surface')).toBeNull()
    expect(state.selection.themeId).toBe(raw.includes('"base":"ember"') ? 'ember' : 'harbor')
    expect(loadCustomTheme(storage).error).toBeNull()
  }
  expect(loadCustomTheme(storageFor(JSON.stringify(custom))).custom).toEqual(custom)
  expect(loadCustomTheme(null).custom).toBeNull()
  const denied = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
    removeItem() {
      throw new Error('denied')
    },
  }
  expect(loadCustomTheme(denied).custom).toBeNull()
  expect(persistCustomTheme(denied, custom)).toBe(false)
  expect(() => clearCustomTheme(denied)).not.toThrow()
})

test('a v1 document (raw string) still loads and normalizes to a v2 pair', () => {
  const v1 = JSON.stringify({
    format: 'tau-custom-theme',
    version: 1,
    name: 'Legacy',
    base: 'ember',
    appearance: 'dark',
    overrides: { '--term-bg': '#123456' },
  })
  const state = loadCustomTheme(storageFor(v1))
  expect(state.custom).toEqual({
    format: 'tau-custom-theme',
    version: 2,
    name: 'Legacy',
    base: 'ember',
    variants: { light: {}, dark: { '--term-bg': '#123456' } },
  })
})

test('import/export round trip is bounded, rejects malicious files before reading oversize data', async () => {
  const json = exportCustomTheme(custom)
  expect(await importCustomTheme({ size: json.length, text: async () => json })).toEqual({
    ok: true,
    document: custom,
    warnings: [],
  })
  expect(
    (
      await importCustomTheme({
        size: 32769,
        text: async () => {
          throw new Error('must not read')
        },
      })
    ).ok
  ).toBe(false)
  expect((await importCustomTheme({ size: 1, text: async () => ' '.repeat(32769) })).ok).toBe(false)
  expect(() =>
    exportCustomTheme({ ...custom, variants: { light: {}, dark: { '--color-primary': 'url(x)' } } })
  ).toThrow()
  const storage = storageFor(null)
  expect(persistCustomTheme(storage, custom)).toBe(true)
  expect(storage.getItem(CUSTOM_THEME_KEY)).toBe(json)
})

test('preview isolation, inheritance, alpha/fractions/sentinels, graph/xterm live updates and reset', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  let dispose: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  try {
    const root = document.documentElement
    // Flatten test CSS because the DOM emulator does not implement CSS layers.
    const style = document.createElement('style')
    style.textContent = palettes
      .map((p) => {
        const attributes = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
        return `:root${attributes}, [data-theme-scope]${attributes} { ${Object.entries(p.tokens)
          .map(([name]) => `${name}: ${resolveToken(p.tokens, name)};`)
          .join(' ')} }`
      })
      .join('\n')
    document.head.append(style)
    applyResolvedTheme(root, findWebTheme('tau'), 'light')
    const preview = document.createElement('div')
    preview.setAttribute('data-theme-scope', '')
    document.body.append(preview)
    const before = root.outerHTML.split('<head>')[0]
    applyCustomTheme(preview, custom, 'dark')
    expect(root.outerHTML.split('<head>')[0]).toBe(before)
    expect(preview.style.getPropertyValue('--term-bg')).toBe('18 52 86')
    const get = (token: string) => window.getComputedStyle(preview).getPropertyValue(token).trim()
    const base = palettes.find((p) => p.id === custom.base && p.appearance === 'dark')!
    const darkOverrides = custom.variants.dark
    for (const token of ACTIVE_THEME_TOKENS.filter((t) => !(t in darkOverrides)))
      expect(get(token)).toBe(resolveToken(base.tokens, token))
    expect(get('--opacity-status-danger-surface')).toBe(base.tokens['--opacity-status-danger-surface']!)
    expect(get('--term-selection-foreground')).toBe('none')
    expect(get('--term-scrollbar-thumb')).toBe('auto')
    expect(get('--syntax-property')).toContain('.')
    const reader = createTokenReader(root)
    let paints = 0
    unsubscribe = reader.subscribe(() => paints++)
    const container = document.createElement('div')
    document.body.append(container)
    const terminal = { options: { theme: readTerminalTheme(window.getComputedStyle(root)) } }
    dispose = observeTerminalTheme(terminal, container)
    applyCustomTheme(root, custom, 'dark')
    applyCustomTheme(preview, { ...custom, variants: { light: {}, dark: {} } }, 'dark')
    expect(preview.style.getPropertyValue('--custom-rgb-term-bg')).toBe('initial')
    expect(window.getComputedStyle(preview).getPropertyValue('--term-bg').trim()).toBe(
      resolveToken(base.tokens, '--term-bg')
    )
    await dom.window.happyDOM.waitUntilComplete()
    expect(reader.getSnapshot()['--graph-bg']).toBe('rgb(35, 69, 103)')
    expect(paints).toBeGreaterThan(0)
    expect(terminal.options.theme.background).toBe('rgb(18, 52, 86)')
    removeCustomProperties(root)
    applyResolvedTheme(root, findWebTheme('tau'), 'light')
    await dom.window.happyDOM.waitUntilComplete()
    expect(terminal.options.theme.background).not.toBe('rgb(18, 52, 86)')
    expect(reader.getSnapshot()['--graph-bg']).not.toBe('rgb(35, 69, 103)')
    expect(root.style.getPropertyValue('--graph-bg')).toBe('')
  } finally {
    dispose?.()
    unsubscribe?.()
    await dom.cleanup()
  }
})

test('a light/dark pair resolves the correct side per requested appearance', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    const style = document.createElement('style')
    style.textContent = palettes
      .map((p) => {
        const attributes = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
        return `:root${attributes}, [data-theme-scope]${attributes} { ${Object.entries(p.tokens)
          .map(([name]) => `${name}: ${resolveToken(p.tokens, name)};`)
          .join(' ')} }`
      })
      .join('\n')
    document.head.append(style)
    const pair: CustomThemeDocument = {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Pair',
      base: 'tau',
      variants: {
        light: { '--color-primary': '#111111' },
        dark: { '--color-primary': '#eeeeee' },
      },
    }
    const preview = document.createElement('div')
    preview.setAttribute('data-theme-scope', '')
    document.body.append(preview)
    applyCustomTheme(preview, pair, 'light')
    expect(window.getComputedStyle(preview).getPropertyValue('--color-primary').trim()).toBe('17 17 17')
    applyCustomTheme(preview, pair, 'dark')
    expect(window.getComputedStyle(preview).getPropertyValue('--color-primary').trim()).toBe('238 238 238')
  } finally {
    await dom.cleanup()
  }
})

test('application revalidates, rejects injection before any mutation, cleans partially applied properties on throw', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    const element = document.createElement('div')
    for (const variants of [
      { light: {}, dark: { '--term-bg': 'url(https://evil.test)' } },
      { light: {}, dark: { '--status-danger-fg': '#fff' } },
    ]) {
      expect(() => applyCustomTheme(element, { ...custom, variants }, 'dark')).toThrow()
      expect(element.attributes.length).toBe(0)
    }
    const original = element.style.setProperty.bind(element.style)
    element.style.setProperty = (name, value, priority) => {
      if (name === '--term-bg') throw new Error('application failure')
      original(name, value, priority)
    }
    expect(() => applyCustomTheme(element, custom, 'dark')).toThrow('application failure')
    expect(element.getAttribute('data-theme')).toBe('ember')
    for (const name of ACTIVE_THEME_TOKENS) expect(element.style.getPropertyValue(name)).toBe('')
  } finally {
    await dom.cleanup()
  }
})

test('security contract: custom runtime never writes HTML/CSS text, inline bootstrap shares current validator/compiler', async () => {
  for (const file of [
    'custom.ts',
    'flash.ts',
    'preview.ts',
    '../components/settings/CustomThemeEditor.tsx',
    '../providers/ThemeProvider.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|cssText|textContent\s*=|createElement\(['"]style/)
  }
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  expect(html.match(/<script data-tau-theme-flash>([\s\S]*?)<\/script>/)![1]).toBe(await generateThemeFlash())
})

test('shipped pre-paint custom matrix (v2 pair) and broken-document fallback run before React/CSS', async () => {
  const script = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').match(
    /<script data-tau-theme-flash>([\s\S]*?)<\/script>/
  )![1]!
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    for (const p of palettes) {
      const patch = { ...custom.variants.dark, '--brand-tile': '#123456' }
      const doc: CustomThemeDocument = {
        format: 'tau-custom-theme',
        version: 2,
        name: custom.name,
        base: p.id,
        variants: p.appearance === 'constant' ? { constant: patch } : { light: patch, dark: patch },
      }
      for (const broken of [false, true]) {
        const brokenDoc: CustomThemeDocument = broken
          ? {
              ...doc,
              variants:
                'constant' in doc.variants
                  ? { constant: { '--term-bg': 'url(x)' } }
                  : { light: { '--term-bg': 'url(x)' }, dark: { '--term-bg': 'url(x)' } },
            }
          : doc
        const storage = storageFor(JSON.stringify(brokenDoc))
        storage.setItem('ficus-appearance', p.appearance === 'constant' ? 'light' : p.appearance)
        removeCustomProperties(document.documentElement)
        document.head.innerHTML = '<meta name="msapplication-TileColor" content="#7c3aed" />'
        new Function('window', 'document', 'localStorage', script)(window, document, storage)
        expect(document.documentElement.getAttribute('data-theme')).toBe(p.id)
        expect(document.documentElement.getAttribute('data-appearance')).toBe(
          p.appearance === 'constant' ? null : p.appearance
        )
        expect(document.documentElement.style.getPropertyValue('--term-bg')).toBe(broken ? '' : '18 52 86')
        expect(storage.getItem(CUSTOM_THEME_KEY) === null).toBe(broken)
        expect(document.querySelector('meta[name="msapplication-TileColor"]')?.getAttribute('content')).toBe(
          broken ? '#7c3aed' : 'rgb(18, 52, 86)'
        )
        expect(document.documentElement.style.backgroundColor).toBe(
          broken ? `rgb(${resolveToken(p.tokens, '--color-bg-surface')})` : 'rgb(18, 52, 86)'
        )
      }
    }
  } finally {
    await dom.cleanup()
  }
})

test('pre-paint bundle stays independent of unrelated shared runtime exports', async () => {
  const { generateThemeFlash } = await import('../../scripts/generate-theme-flash')
  // Theme-only code fits comfortably here; the shared barrel pulled in Zod and
  // workflow schemas (~100 KiB) before any page could paint.
  expect(new TextEncoder().encode(await generateThemeFlash()).length).toBeLessThan(30000)
})

test('a palette derives most tokens from the real built-in CSS cascade, explicit overrides still win', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    const style = document.createElement('style')
    style.textContent = palettes
      .map((p) => {
        const attributes = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
        return `:root${attributes}, [data-theme-scope]${attributes} { ${Object.entries(p.tokens)
          .map(([name]) => `${name}: ${resolveToken(p.tokens, name)};`)
          .join(' ')} }`
      })
      .join('\n')
    document.head.append(style)
    const preview = document.createElement('div')
    preview.setAttribute('data-theme-scope', '')
    document.body.append(preview)
    const doc: CustomThemeDocument = {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Palette',
      base: 'tau',
      palette: { primary: '#0ea5e9' },
      variants: { light: { '--color-primary': '#ff0000' }, dark: {} },
    }
    applyCustomTheme(preview, doc, 'light')
    const get = (token: string) => window.getComputedStyle(preview).getPropertyValue(token).trim()
    // Explicit override wins over the derived value for the same token.
    expect(get('--color-primary')).toBe('255 0 0')
    // A neutral/chrome token not explicitly overridden is derived (differs
    // from the plain base value, since the base's own primary isn't sky blue).
    const base = palettes.find((p) => p.id === 'tau' && p.appearance === 'light')!
    expect(get('--color-primary-hover')).not.toBe(resolveToken(base.tokens, '--color-primary-hover'))
    // Status stays static (semantic) by default: untouched by the palette.
    expect(get('--status-danger-solid')).toBe(resolveToken(base.tokens, '--status-danger-solid'))
  } finally {
    await dom.cleanup()
  }
})

test('the pre-paint flash script skips palette derivation (no reliable computed style yet) but still applies explicit overrides', async () => {
  const script = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').match(
    /<script data-tau-theme-flash>([\s\S]*?)<\/script>/
  )![1]!
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    const doc: CustomThemeDocument = {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Palette',
      base: 'tau',
      palette: { primary: '#0ea5e9' },
      variants: { light: { '--color-primary': '#ff0000' }, dark: {} },
    }
    const storage = storageFor(JSON.stringify(doc))
    storage.setItem('ficus-appearance', 'light')
    new Function('window', 'document', 'localStorage', script)(window, document, storage)
    // The explicit override still applies synchronously, pre-paint.
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('255 0 0')
  } finally {
    await dom.cleanup()
  }
})

// --- Resolved pre-paint snapshot (persisted so a palette preset paints its
// derived look before CSS/React, instead of flashing the plain base theme) ---

function memoryStorage(): ThemeStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const paletteDoc: CustomThemeDocument = {
  format: 'tau-custom-theme',
  version: 2,
  name: 'Palette preset',
  base: 'harbor',
  palette: { primary: '#0ea5e9' },
  variants: { light: {}, dark: {} },
}

test('hashCustomThemeDocument is deterministic and sensitive to any document change', async () => {
  const { hashCustomThemeDocument } = await import('./custom')
  expect(hashCustomThemeDocument(paletteDoc)).toBe(hashCustomThemeDocument(structuredClone(paletteDoc)))
  expect(hashCustomThemeDocument(paletteDoc)).not.toBe(
    hashCustomThemeDocument({ ...paletteDoc, palette: { primary: '#123456' } })
  )
  expect(hashCustomThemeDocument(paletteDoc)).not.toBe(hashCustomThemeDocument({ ...paletteDoc, name: 'Other' }))
})

test('persistResolvedSnapshot/readResolvedSnapshot round-trip on an exact (doc, appearance) match', async () => {
  const { persistResolvedSnapshot, readResolvedSnapshot } = await import('./custom')
  const storage = memoryStorage()
  const vars = {
    '--color-primary': '14 165 233',
    '--custom-rgb-color-primary': '14 165 233',
    '--custom-alpha-color-primary': '1',
  }
  persistResolvedSnapshot(storage, paletteDoc, 'dark', vars)
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toEqual(vars)
})

test('readResolvedSnapshot ignores a stale snapshot: edited document, or a different resolved appearance', async () => {
  const { persistResolvedSnapshot, readResolvedSnapshot } = await import('./custom')
  const storage = memoryStorage()
  const vars = { '--color-primary': '14 165 233' }
  persistResolvedSnapshot(storage, paletteDoc, 'dark', vars)
  // Same document, other side: absent (never stored for it) -> fall back.
  expect(readResolvedSnapshot(storage, paletteDoc, 'light')).toBeNull()
  // Document edited (even a single-field change) invalidates the stored hash.
  const edited = { ...paletteDoc, palette: { primary: '#ff0000' } }
  expect(readResolvedSnapshot(storage, edited, 'dark')).toBeNull()
  // No snapshot at all.
  expect(readResolvedSnapshot(memoryStorage(), paletteDoc, 'dark')).toBeNull()
  // Corrupt JSON never throws.
  storage.setItem('ficus-custom-theme-resolved', '{not json')
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toBeNull()
})

test('readResolvedSnapshot only applies known registry property names, dropping anything else', async () => {
  const { readResolvedSnapshot, hashCustomThemeDocument } = await import('./custom')
  const { BUILTIN_CSS_FINGERPRINT } = await import('./builtinFingerprint')
  const storage = memoryStorage()
  storage.setItem(
    'ficus-custom-theme-resolved',
    JSON.stringify({
      docHash: hashCustomThemeDocument(paletteDoc),
      fingerprint: BUILTIN_CSS_FINGERPRINT,
      sides: { dark: { '--color-primary': '1 2 3', '--not-a-real-token': 'x', 'background-color': 'red' } },
    })
  )
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toEqual({ '--color-primary': '1 2 3' })
})

test('readResolvedSnapshot rejects the WHOLE snapshot if any known-token value is not a compiled channel string', async () => {
  const { readResolvedSnapshot, hashCustomThemeDocument } = await import('./custom')
  const { BUILTIN_CSS_FINGERPRINT } = await import('./builtinFingerprint')
  const hostileValues = [
    'red', // a CSS color keyword, not the compiled "r g b" grammar
    'rgb(1, 2, 3)', // unparsed rgb() syntax, not the post-compile form
    '1 2 3; background: url(https://evil.example/track.png)', // CSS-injection-shaped payload
    'javascript:alert(1)',
    '-1 2 3', // out of the 0-255 channel range
    '1 2 3 4', // wrong arity
    '1 2', // wrong arity
    '',
  ]
  for (const hostile of hostileValues) {
    const storage = memoryStorage()
    storage.setItem(
      'ficus-custom-theme-resolved',
      JSON.stringify({
        docHash: hashCustomThemeDocument(paletteDoc),
        fingerprint: BUILTIN_CSS_FINGERPRINT,
        sides: { dark: { '--color-primary': hostile, '--custom-rgb-color-primary': '14 165 233' } },
      })
    )
    expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toBeNull()
  }
  // --custom-alpha-* tokens are a bare 0..1 number, not the "r g b" grammar.
  for (const hostileAlpha of ['2', '-0.5', 'rgb(1,2,3)', '1e10', 'true', '']) {
    const storage = memoryStorage()
    storage.setItem(
      'ficus-custom-theme-resolved',
      JSON.stringify({
        docHash: hashCustomThemeDocument(paletteDoc),
        fingerprint: BUILTIN_CSS_FINGERPRINT,
        sides: { dark: { '--color-primary': '1 2 3', '--custom-alpha-color-primary': hostileAlpha } },
      })
    )
    expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toBeNull()
  }
  // A fully well-formed snapshot (the control case) still round-trips.
  const storage = memoryStorage()
  storage.setItem(
    'ficus-custom-theme-resolved',
    JSON.stringify({
      docHash: hashCustomThemeDocument(paletteDoc),
      fingerprint: BUILTIN_CSS_FINGERPRINT,
      sides: {
        dark: {
          '--color-primary': '14 165 233',
          '--custom-rgb-color-primary': '14 165 233',
          '--custom-alpha-color-primary': '1',
          '--term-bg': '1 2 3 / 0.5',
        },
      },
    })
  )
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toEqual({
    '--color-primary': '14 165 233',
    '--custom-rgb-color-primary': '14 165 233',
    '--custom-alpha-color-primary': '1',
    '--term-bg': '1 2 3 / 0.5',
  })
})

test('readResolvedSnapshot rejects a snapshot from a different build (fingerprint mismatch)', async () => {
  const { readResolvedSnapshot, hashCustomThemeDocument } = await import('./custom')
  const storage = memoryStorage()
  storage.setItem(
    'ficus-custom-theme-resolved',
    JSON.stringify({
      docHash: hashCustomThemeDocument(paletteDoc),
      fingerprint: 'a-stale-build-that-had-different-builtin-tokens',
      sides: { dark: { '--color-primary': '14 165 233' } },
    })
  )
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toBeNull()
})

test('persistResolvedSnapshot stores BOTH resolved sides for the same document, so a system-appearance OS flip has a snapshot either way', async () => {
  const { persistResolvedSnapshot, readResolvedSnapshot } = await import('./custom')
  const storage = memoryStorage()
  const lightVars = { '--color-primary': '1 1 1' }
  const darkVars = { '--color-primary': '2 2 2' }
  // The real paint persists its own (light) side...
  persistResolvedSnapshot(storage, paletteDoc, 'light', lightVars)
  // ...and separately, the off-screen-derived OTHER (dark) side, merged into
  // the SAME stored snapshot rather than overwriting it.
  persistResolvedSnapshot(storage, paletteDoc, 'dark', darkVars)
  expect(readResolvedSnapshot(storage, paletteDoc, 'light')).toEqual(lightVars)
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toEqual(darkVars)
})

test('persistResolvedSnapshot skips (never writes) an oversized snapshot', async () => {
  const { persistResolvedSnapshot, readResolvedSnapshot, RESOLVED_SNAPSHOT_MAX_BYTES } = await import('./custom')
  const storage = memoryStorage()
  const huge = Object.fromEntries(
    Array.from({ length: Math.ceil(RESOLVED_SNAPSHOT_MAX_BYTES / 20) }, (_, i) => [`--k${i}`, 'x'.repeat(15)])
  )
  persistResolvedSnapshot(storage, paletteDoc, 'dark', huge)
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toBeNull()
})

test('clearCustomTheme also clears the resolved snapshot', async () => {
  const { persistResolvedSnapshot, readResolvedSnapshot } = await import('./custom')
  const storage = memoryStorage()
  persistResolvedSnapshot(storage, paletteDoc, 'dark', { '--color-primary': '1 2 3' })
  clearCustomTheme(storage)
  expect(storage.getItem('ficus-custom-theme-resolved')).toBeNull()
  expect(readResolvedSnapshot(storage, paletteDoc, 'dark')).toBeNull()
})

test('applyCustomTheme returns the exact compiled vars it applied, for the caller to persist as a snapshot', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    const element = document.createElement('div')
    const vars = applyCustomTheme(element, custom, 'dark')
    expect(vars['--term-bg']).toBe('18 52 86')
    for (const [token, value] of Object.entries(vars)) expect(element.style.getPropertyValue(token)).toBe(value)
  } finally {
    await dom.cleanup()
  }
})
