import { compileCustomTheme, validateCustomTheme, STATUS_TOKENS } from '@ficus/shared'
import { palettes } from './theme/test/builtins'
import { BUILT_IN_THEMES } from './theme/registry'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Root, type Rule } from 'postcss'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../tailwind.config.js'

/** Validates a raw (v1 or v2) document, then compiles the resolved variant. */
function compileRaw(raw: unknown, appearance: 'light' | 'dark' | 'constant') {
  const result = validateCustomTheme(JSON.stringify(raw), BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  return compileCustomTheme(result.document, appearance)
}

// Regression history:
// 1. Plain var(--color-*) mappings silently emitted no rule for /50 utilities.
// 2. rgb(var(--token) / <alpha-value>) emitted rules, but tokens containing an
//    intrinsic alpha substituted to invalid rgb(R G B / intrinsic / requested).
// Both the actual generated rules AND their fully substituted values must be
// checked. Intrinsic opacity is multiplied by a modifier, never discarded.

const srcRoot = import.meta.dir
const sourceCss = postcss.parse(readFileSync(join(srcRoot, 'index.css'), 'utf8'))

function declarations(rule: Rule): Record<string, string> {
  const result: Record<string, string> = {}
  rule.each((node) => {
    if (node.type === 'decl') result[node.prop] = node.value
  })
  return result
}

function scopeVariables(selector: string): Record<string, string> {
  const scopes: Rule[] = []
  sourceCss.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    scopes.push(rule)
  })
  expect(scopes).toHaveLength(1)
  return declarations(scopes[0]!)
}

const scopes = {
  light: scopeVariables(':root'),
  dark: scopeVariables('.dark'),
}

/** Flatten Tailwind DEFAULT keys into the real utility name. */
function colorEntries(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    colorEntries(value, key === 'DEFAULT' ? prefix : [prefix, key].filter(Boolean).join('-'))
  )
}

const colors = colorEntries(tailwindConfig.theme.extend.colors)

async function compile(classes: string[]): Promise<Root> {
  const result = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: classes.join(' '), extension: 'html' }],
      plugins: [],
    }),
  ]).process('@tailwind utilities', { from: undefined })
  return result.root
}

/** Resolve the real scope variables, generated opacity variables and fallbacks. */
function substitute(value: string, variables: Record<string, string>): string {
  while (value.includes('var(')) {
    const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name: string, fallback?: string) => {
      const replacement = variables[name] ?? fallback
      if (replacement == null) throw new Error(`Missing ${name} in ${value}`)
      return replacement
    })
    if (next === value) throw new Error(`Unresolved or cyclic variable in ${value}`)
    value = next
  }
  // The adapter's only arithmetic is multiplication of two scalar alphas.
  // Reject anything else rather than silently accepting an unevaluated calc.
  return value.replace(/calc\(([\d.\s*]+)\)/g, (_, factors: string) =>
    String(
      factors
        .split('*')
        .map(Number)
        .reduce((a, b) => a * b, 1)
    )
  )
}

/** Strict Color-4 numeric RGB grammar; double-alpha separators cannot pass. */
function numericRgb(value: string) {
  const match = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/.exec(value)
  if (!match) throw new Error(`Invalid fully substituted RGB color: ${value}`)
  const channels = match.slice(1, 4).map(Number)
  const alpha = Number(match[4])
  for (const channel of channels) {
    expect(channel).toBeGreaterThanOrEqual(0)
    expect(channel).toBeLessThanOrEqual(255)
  }
  expect(alpha).toBeGreaterThanOrEqual(0)
  expect(alpha).toBeLessThanOrEqual(1)
  return { channels, alpha }
}

function intrinsicAlpha(name: string, appearance: 'light' | 'dark') {
  if (appearance === 'dark') {
    if (/^status-.*-badge-(surface|hover)$/.test(name) && !name.startsWith('status-neutral-'))
      return name.endsWith('-hover') ? 0.7 : 0.3
    if (/^status-.*-surface$/.test(name) && !name.includes('-badge-')) return 0.2
    if (/^badge-accent-\d+-(surface|hover)$/.test(name)) return name.endsWith('-hover') ? 0.7 : 0.3
  }
  if (name === 'panel-border') return 0.12
  if (name === 'input-border' && appearance === 'dark') return 0.16
  return 1
}

describe('tailwind theme color opacity after variable substitution', () => {
  test('every mapped color is channel-form with an opacity placeholder', () => {
    expect(colors.length).toBeGreaterThan(20)
    for (const [, mapping] of colors) {
      expect(mapping).toContain('<alpha-value>')
      expect(mapping).toMatch(/^rgb\(var\(--custom-rgb-[a-z0-9-]+, var\(--[a-z0-9-]+\)\) \/ /)
      const token = /var\((--[a-z0-9-]+)\)/.exec(mapping)![1]!
      // Audit ALL mappings: none may embed an alpha before the adapter adds it.
      for (const variables of Object.values(scopes)) {
        expect(variables[token]).toMatch(/^\d+ \d+ \d+$/)
      }
    }
  })

  test('the repaired token channels match the original translucent colors', () => {
    expect(scopes.light['--color-panel-border']).toBe('94 75 132')
    expect(scopes.dark['--color-panel-border']).toBe('190 181 215')
    expect(scopes.light['--color-input-border']).toBe('209 203 220')
    expect(scopes.dark['--color-input-border']).toBe('209 202 232')
  })

  test('the only remaining embedded-alpha tokens are unmapped CSS-only shadow/glass tokens', () => {
    const expected = ['--color-glass', '--color-shadow', '--color-shadow-lg']
    for (const variables of Object.values(scopes)) {
      const embeddedAlpha = Object.entries(variables)
        .filter(([name, value]) => name.startsWith('--color-') && value.includes('/'))
        .map(([name]) => name)
        .sort()
      expect(embeddedAlpha).toEqual(expected)
    }
  })

  test('all semantic utilities resolve to valid RGB, plain and modified, in BOTH appearances', async () => {
    const modifiers = ['', '/25', '/50', '/100']
    const expectedClasses = colors.flatMap(([name]) => modifiers.map((modifier) => `border-${name}${modifier}`))
    const generated = await compile(expectedClasses)
    const rules = new Map<string, Rule>()
    generated.walkRules((rule) => {
      // These generated selectors need only Tailwind's escaped slash removed.
      rules.set(rule.selector.replaceAll('\\', '').slice(1), rule)
    })
    expect([...rules.keys()].sort()).toEqual([...expectedClasses].sort())

    for (const [appearance, variables] of Object.entries(scopes) as Array<['light' | 'dark', Record<string, string>]>) {
      for (const [name, mapping] of colors) {
        const token = /var\((--[a-z0-9-]+)\)/.exec(mapping)![1]!
        for (const modifier of modifiers) {
          const rule = rules.get(`border-${name}${modifier}`)!
          const declared = declarations(rule)
          const resolved = substitute(declared['border-color']!, { ...variables, ...declared })
          const { channels, alpha } = numericRgb(resolved)
          expect(channels).toEqual(variables[token]!.split(/\s+/).map(Number))
          const requestedOpacity = modifier ? Number(modifier.slice(1)) / 100 : 1
          expect(alpha).toBeCloseTo(intrinsicAlpha(name, appearance) * requestedOpacity, 8)
        }
      }
    }
  })

  test('custom rgba composes with intrinsic alpha AND Tailwind modifiers for every mapped token', async () => {
    const rules = new Map<string, Rule>()
    ;(await compile(colors.map(([name]) => `border-${name}/50`))).walkRules((rule) => {
      rules.set(rule.selector.replaceAll('\\', '').slice(1), rule)
    })
    for (const [appearance, base] of Object.entries(scopes) as Array<['light' | 'dark', Record<string, string>]>) {
      for (const [name, mapping] of colors) {
        const token = /var\((--[a-z0-9-]+)\)/.exec(mapping)![1]!
        const overrides = Object.fromEntries(
          (STATUS_TOKENS.includes(token) ? STATUS_TOKENS : [token]).map((key) => [key, 'rgba(12,34,56,0.5)'])
        )
        const variables = compileRaw(
          { format: 'tau-custom-theme', version: 1, name: 'Alpha', base: 'tau', appearance, overrides },
          appearance
        )
        const declared = declarations(rules.get(`border-${name}/50`)!)
        const color = numericRgb(substitute(declared['border-color']!, { ...base, ...variables, ...declared }))
        expect(color.channels).toEqual([12, 34, 56])
        expect(color.alpha).toBeCloseTo(0.5 * 0.5 * intrinsicAlpha(name, appearance), 8)
      }
    }
  })

  test('the original double-alpha regression is rejected even though PostCSS emits a rule', () => {
    const substituted = substitute('rgb(var(--color-panel-border) / var(--tw-border-opacity, 1))', {
      '--color-panel-border': '94 75 132 / 0.12',
    })
    expect(substituted).toBe('rgb(94 75 132 / 0.12 / 1)')
    expect(() => numericRgb(substituted)).toThrow('Invalid fully substituted RGB')
  })

  test('direct CSS consumers retain the original panel/input alpha in both scopes', () => {
    // Audit every direct consumer, including borders, autofill and inset shadows.
    let consumers = 0
    for (const path of new Bun.Glob('**/*.css').scanSync({ cwd: srcRoot })) {
      const sheet = postcss.parse(readFileSync(join(srcRoot, path), 'utf8'))
      sheet.walkDecls((declaration) => {
        const matched = /var\(--color-(panel-border|input-border)\)/.exec(declaration.value)
        if (!matched) return
        consumers++
        const name = matched[1]!
        for (const [appearance, variables] of Object.entries(scopes) as Array<
          ['light' | 'dark', Record<string, string>]
        >) {
          const resolved = substitute(declaration.value, variables)
          const rgb = /rgb\([^()]+\)/.exec(resolved)
          expect(rgb).not.toBeNull()
          const { channels, alpha } = numericRgb(rgb![0])
          expect(channels).toEqual(variables[`--color-${name}`]!.split(/\s+/).map(Number))
          expect(alpha).toBeCloseTo(intrinsicAlpha(name, appearance), 8)
        }
      })
    }
    // ThemeQuickPicker's swatch border joined this audit as consumer #7 and the
    // full-bleed color input outline as #8 (see design-system.css).
    expect(consumers).toBe(8)
  })

  test('non-border opacity utilities still compile (including the original divide regression)', async () => {
    const compiled = (
      await compile(['bg-surface/50', 'divide-th-border/50', 'text-accent/70', 'ring-focus/30'])
    ).toString()
    expect(compiled).toContain(
      'rgb(var(--custom-rgb-color-bg-surface, var(--color-bg-surface)) / calc(var(--custom-alpha-color-bg-surface, 1) * 0.5))'
    )
    expect(compiled).toContain(
      'rgb(var(--custom-rgb-color-border, var(--color-border)) / calc(var(--custom-alpha-color-border, 1) * 0.5))'
    )
    expect(compiled).toContain(
      'rgb(var(--custom-rgb-color-primary, var(--color-primary)) / calc(var(--custom-alpha-color-primary, 1) * 0.7))'
    )
    expect(compiled).toContain(
      'rgb(var(--custom-rgb-color-focus, var(--color-focus)) / calc(var(--custom-alpha-color-focus, 1) * 0.3))'
    )
  })
})

test('actual spinner and narrow Stop CSS follows custom status colors without changing builtin defaults', async () => {
  const spinner = readFileSync(join(srcRoot, 'components/VoiceFormFillButton.tsx'), 'utf8')
  expect(spinner).toContain('border-t-status-danger-600')
  const generated = await compile(['border-t-status-danger-600', 'dark:border-t-status-danger-400'])
  const css = await postcss([
    tailwindcss({ ...tailwindConfig, content: [{ raw: 'chat-composer-stop' }], plugins: [] }),
  ]).process(readFileSync(join(srcRoot, 'components/ResponsiveChat.css'), 'utf8'), { from: undefined })
  const stop: string[] = []
  css.root.walkRules((rule) => {
    if (rule.selector.endsWith('.chat-composer .chat-composer-stop'))
      rule.walkDecls('color', (decl) => {
        stop.push(decl.value)
      })
  })
  expect(stop).toEqual(['rgb(var(--status-danger-600))', 'rgb(var(--status-danger-400))'])
  const custom = compileRaw(
    {
      format: 'tau-custom-theme',
      version: 1,
      name: 'Spinner',
      base: 'tau',
      appearance: 'light',
      overrides: Object.fromEntries(STATUS_TOKENS.map((name) => [name, 'rgba(12, 34, 56, 0.5)'])),
    },
    'light'
  )
  for (const [i, shade] of ['600', '400'].entries()) {
    const expected = shade === '600' ? [220, 38, 38] : [248, 113, 113]
    for (const { tokens: scope } of palettes) {
      expect(substitute(stop[i]!, scope)).toBe(`rgb(${expected.join(' ')})`)
      expect(substitute(stop[i]!, { ...scope, ...custom })).toBe('rgb(12 34 56 / 0.5)')
    }
  }
  let count = 0
  generated.walkDecls('border-top-color', (decl) => {
    count++
    for (const { tokens } of palettes) {
      const vars = { ...tokens, ...declarations(decl.parent as Rule) }
      const channels = decl.value.includes('--status-danger-400') ? [248, 113, 113] : [220, 38, 38]
      expect(numericRgb(substitute(decl.value, vars))).toEqual({ channels, alpha: 1 })
      expect(numericRgb(substitute(decl.value, { ...vars, ...custom }))).toEqual({ channels: [12, 34, 56], alpha: 0.5 })
    }
  })
  expect(count).toBe(2)
})

test('new storage warnings preserve main shades and opacity while accepting custom status colors', async () => {
  const expected = [
    [
      'components/StorageBanner.tsx',
      'border-status-attention-500/30',
      'border-color',
      '--status-attention-500',
      0.3,
      [245, 158, 11],
    ],
    [
      'components/StorageBanner.tsx',
      'bg-status-attention-500/10',
      'background-color',
      '--status-attention-500',
      0.1,
      [245, 158, 11],
    ],
    [
      'components/settings/StorageSection.tsx',
      'text-status-attention-500',
      'color',
      '--status-attention-500',
      1,
      [245, 158, 11],
    ],
    [
      'components/settings/StorageMonitorSettings.tsx',
      'text-status-danger-400',
      'color',
      '--status-danger-400',
      1,
      [248, 113, 113],
    ],
  ] as const
  for (const [file, utility] of expected) expect(readFileSync(join(srcRoot, file), 'utf8')).toContain(utility)
  const generated = await compile(expected.map(([, utility]) => utility))
  const rules = new Map<string, Rule>()
  generated.walkRules((rule) => {
    rules.set(rule.selector.slice(1).replaceAll('\\', ''), rule)
  })
  const custom = compileRaw(
    {
      format: 'tau-custom-theme',
      version: 1,
      name: 'Storage',
      base: 'tau',
      appearance: 'light',
      overrides: Object.fromEntries(STATUS_TOKENS.map((key) => [key, 'rgba(12,34,56,0.5)'])),
    },
    'light'
  )
  for (const [, utility, prop, , opacity, channels] of expected) {
    const decls = declarations(rules.get(utility)!)
    for (const { tokens } of palettes) {
      expect(numericRgb(substitute(decls[prop]!, { ...tokens, ...decls }))).toEqual({ channels, alpha: opacity })
      expect(numericRgb(substitute(decls[prop]!, { ...tokens, ...decls, ...custom }))).toEqual({
        channels: [12, 34, 56],
        alpha: 0.5 * opacity,
      })
    }
  }
})
