import { describe, expect, test } from 'bun:test'
import {
  ACTIVE_THEME_TOKENS,
  APPEARANCE_SETTINGS,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME_ID,
  PLANNED_THEME_TOKENS,
  THEME_TOKEN_FAMILIES,
  THEME_TOKEN_NAMES,
  isAppearanceSetting,
  isThemeTokenName,
  normalizeStoredThemeSelection,
  resolveThemeSelection,
  themeTokenFamily,
  validateThemeRegistry,
  validateThemeTokenSet,
  validateThemeTokenOverrides,
  STATUS_TOKENS,
  type ThemeDescriptor,
} from './theme-schema'

const TAU: ThemeDescriptor = { id: 'tau', label: 'Iris', kind: 'dual' }
const NORD: ThemeDescriptor = { id: 'nord', label: 'Nord', kind: 'dual' }
const CONTRAST: ThemeDescriptor = { id: 'high-contrast', label: 'High Contrast', kind: 'unified' }

describe('theme token registry', () => {
  test('every registered token name is unique and kebab-case-custom-property shaped', () => {
    const names = [...THEME_TOKEN_NAMES]
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^--[a-z0-9][a-z0-9-]*$/)
  })

  test('families are uniquely named and never mix active/planned tokens', () => {
    expect(new Set(THEME_TOKEN_FAMILIES.map((f) => f.family)).size).toBe(THEME_TOKEN_FAMILIES.length)
    for (const family of THEME_TOKEN_FAMILIES) {
      expect(family.tokens.length).toBeGreaterThan(0)
      expect(family.description.length).toBeGreaterThan(0)
    }
  })

  test('chrome and semantic families are active', () => {
    for (const family of [
      'chrome',
      'status',
      'agent-type',
      'misc-chrome',
      'badge-decoration',
      'syntax',
      'terminal',
      'ansi',
    ]) {
      expect(THEME_TOKEN_FAMILIES.find((entry) => entry.family === family)?.status).toBe('active')
    }
    expect(ACTIVE_THEME_TOKENS).toContain('--color-bg-page')
    expect(ACTIVE_THEME_TOKENS).toContain('--status-progress-fg')
    expect(PLANNED_THEME_TOKENS).not.toContain('--status-progress-fg')
  })

  test('status family includes all nine roles and their distinct badge treatments', () => {
    expect(STATUS_TOKENS).toHaveLength(162)
    for (const suffix of ['fg', 'solid', 'surface', 'border', 'badge-fg', 'badge-surface', 'badge-hover']) {
      expect(STATUS_TOKENS).toContain(`--status-human-wait-${suffix}`)
    }
  })

  test('terminal and ANSI families carry the full 16-color ANSI slots', () => {
    const terminal = THEME_TOKEN_FAMILIES.find((f) => f.family === 'terminal')!
    const ansi = THEME_TOKEN_FAMILIES.find((f) => f.family === 'ansi')!
    expect(terminal.tokens).toContain('--term-bright-white')
    expect(ansi.tokens.filter((token) => !token.startsWith('--ansi-on-'))).toHaveLength(32)
    expect(ansi.tokens).toContain('--ansi-bg-bright-black')
  })

  test('brand family exists per PD-5 (brand assets are themeable, not pinned)', () => {
    const brand = THEME_TOKEN_FAMILIES.find((f) => f.family === 'brand')!
    expect(brand.tokens).toContain('--brand-gradient-from')
    expect(brand.tokens).toContain('--brand-tile')
    expect(brand.status).toBe('active')
  })

  test('isThemeTokenName / themeTokenFamily lookups', () => {
    expect(isThemeTokenName('--color-bg-surface')).toBe(true)
    expect(isThemeTokenName('--status-danger-solid')).toBe(true)
    expect(isThemeTokenName('--color-not-a-token')).toBe(false)
    expect(themeTokenFamily('--term-bg')?.family).toBe('terminal')
    expect(themeTokenFamily('--nope')).toBeUndefined()
  })
})

describe('validateThemeTokenSet (completeness schema)', () => {
  test('accepts a set defining exactly the active registry tokens', () => {
    const tokens = [...ACTIVE_THEME_TOKENS]
    const result = validateThemeTokenSet(tokens)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
  })

  test('reports missing tokens', () => {
    const tokens = ACTIVE_THEME_TOKENS.filter((name) => name !== '--color-focus')
    const result = validateThemeTokenSet(tokens)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['--color-focus'])
  })

  test('reports unknown tokens, including planned names defined before their family activates', () => {
    const tokens = [...ACTIVE_THEME_TOKENS, '--future-brand-tile']
    const result = validateThemeTokenSet(tokens)
    expect(result.ok).toBe(false)
    expect(result.unexpected).toEqual(['--future-brand-tile'])
  })

  test('duplicate definitions stay valid (a set is a set)', () => {
    const result = validateThemeTokenSet([...ACTIVE_THEME_TOKENS, ACTIVE_THEME_TOKENS[0]!])
    expect(result.ok).toBe(true)
  })
})

describe('theme registry validation', () => {
  test('accepts a well-formed registry containing the default theme', () => {
    expect(validateThemeRegistry([TAU, NORD, CONTRAST])).toEqual([])
  })

  test('rejects duplicate ids, malformed ids, empty labels, and bad kinds', () => {
    const issues = validateThemeRegistry([
      { ...TAU },
      { ...TAU, label: 'Ficus again' },
      { id: 'Bad Id', label: 'x', kind: 'dual' },
      { id: 'empty-label', label: '', kind: 'dual' },
      { id: 'bad-kind', label: 'x', kind: 'recolor' as unknown as 'dual' },
    ])
    const issueText = issues.map((i) => `${i.themeId}:${i.issue}`)
    expect(issueText).toContain('tau:duplicate id')
    expect(issueText).toContain('Bad Id:id must be kebab-case')
    expect(issueText).toContain('empty-label:label must be a non-empty string')
    expect(issueText).toContain('bad-kind:invalid kind recolor')
  })

  test('rejects an empty registry', () => {
    expect(validateThemeRegistry([])).toHaveLength(1)
  })
})

describe('resolveThemeSelection (themeId × appearance model)', () => {
  const registry = [TAU, NORD, CONTRAST]

  test('dual themes resolve light and dark directly', () => {
    expect(resolveThemeSelection(registry, 'tau', 'light', false)).toEqual({ theme: TAU, appearance: 'light' })
    expect(resolveThemeSelection(registry, 'tau', 'dark', false)).toEqual({ theme: TAU, appearance: 'dark' })
    expect(resolveThemeSelection(registry, 'nord', 'dark', true)).toEqual({ theme: NORD, appearance: 'dark' })
  })

  test("appearance 'system' resolves against the OS preference", () => {
    expect(resolveThemeSelection(registry, 'tau', 'system', true)).toEqual({ theme: TAU, appearance: 'dark' })
    expect(resolveThemeSelection(registry, 'tau', 'system', false)).toEqual({ theme: TAU, appearance: 'light' })
  })

  test('unified themes ignore appearance entirely (PD-6)', () => {
    for (const appearance of APPEARANCE_SETTINGS) {
      expect(resolveThemeSelection(registry, 'high-contrast', appearance, true)).toEqual({
        theme: CONTRAST,
        appearance: 'constant',
      })
    }
  })

  test('unknown or missing theme id falls back to the default theme, keeping the appearance', () => {
    expect(resolveThemeSelection(registry, 'does-not-exist', 'dark', false)).toEqual({ theme: TAU, appearance: 'dark' })
    expect(resolveThemeSelection(registry, undefined, 'system', true)).toEqual({ theme: TAU, appearance: 'dark' })
    expect(resolveThemeSelection(registry, null, undefined, false)).toEqual({ theme: TAU, appearance: 'light' })
  })

  test('missing appearance falls back to DEFAULT_APPEARANCE, never to system probing', () => {
    expect(resolveThemeSelection(registry, 'nord', undefined, true)).toEqual({ theme: NORD, appearance: 'light' })
  })

  test('never invents entries: the resolved theme is always a registry member object', () => {
    const resolved = resolveThemeSelection(registry, 'garbage', 'system', false)
    expect(registry).toContain(resolved.theme)
    expect(resolved.theme.id).toBe(DEFAULT_THEME_ID)
    expect(DEFAULT_APPEARANCE).toBe('light')
  })

  test('when the registry lacks the default id, its first entry is the fallback', () => {
    expect(resolveThemeSelection([NORD], 'garbage', 'light', false)).toEqual({ theme: NORD, appearance: 'light' })
  })

  test('resolution is pure selection: identical inputs return identical values', () => {
    const a = resolveThemeSelection(registry, 'tau', 'system', true)
    const b = resolveThemeSelection(registry, 'tau', 'system', true)
    expect(a.theme).toBe(b.theme)
    expect(a.appearance).toBe(b.appearance)
  })
})

describe('normalizeStoredThemeSelection (localStorage migration)', () => {
  test('valid new-key values pass through', () => {
    expect(
      normalizeStoredThemeSelection({ themeId: 'tau', appearance: 'dark', legacyTheme: null, knownThemeIds: ['tau'] })
    ).toEqual({ themeId: 'tau', appearance: 'dark' })
    expect(
      normalizeStoredThemeSelection({ themeId: 'tau', appearance: 'system', legacyTheme: null, knownThemeIds: ['tau'] })
    ).toEqual({ themeId: 'tau', appearance: 'system' })
  })

  test('legacy tau-theme light/dark migrates onto the default theme', () => {
    expect(normalizeStoredThemeSelection({ themeId: null, appearance: null, legacyTheme: 'dark' })).toEqual({
      themeId: 'tau',
      appearance: 'dark',
    })
    expect(normalizeStoredThemeSelection({ themeId: null, appearance: null, legacyTheme: 'light' })).toEqual({
      themeId: 'tau',
      appearance: 'light',
    })
  })

  test('unreadable or unknown values fall back to the defaults', () => {
    expect(normalizeStoredThemeSelection({ themeId: null, appearance: null, legacyTheme: null })).toEqual({
      themeId: 'tau',
      appearance: 'light',
    })
    expect(normalizeStoredThemeSelection({ themeId: null, appearance: null, legacyTheme: 'banana' })).toEqual({
      themeId: 'tau',
      appearance: 'light',
    })
    expect(normalizeStoredThemeSelection({ themeId: null, appearance: 'ultraviolet', legacyTheme: 'dark' })).toEqual({
      themeId: 'tau',
      appearance: 'dark',
    })
    expect(normalizeStoredThemeSelection({ themeId: 'hologram', appearance: 'light', legacyTheme: null })).toEqual({
      themeId: 'tau',
      appearance: 'light',
    })
  })

  test('new appearance key wins over the legacy value once written', () => {
    expect(normalizeStoredThemeSelection({ themeId: 'tau', appearance: 'light', legacyTheme: 'dark' })).toEqual({
      themeId: 'tau',
      appearance: 'light',
    })
  })

  test('unknown theme ids are rejected against the known id list', () => {
    expect(
      normalizeStoredThemeSelection({ themeId: 'nord', appearance: 'dark', legacyTheme: null, knownThemeIds: ['tau'] })
    ).toEqual({ themeId: 'tau', appearance: 'dark' })
    expect(
      normalizeStoredThemeSelection({
        themeId: 'nord',
        appearance: 'dark',
        legacyTheme: null,
        knownThemeIds: ['tau', 'nord'],
      })
    ).toEqual({ themeId: 'nord', appearance: 'dark' })
  })

  test('isAppearanceSetting guards stored strings', () => {
    expect(isAppearanceSetting('light')).toBe(true)
    expect(isAppearanceSetting('dark')).toBe(true)
    expect(isAppearanceSetting('system')).toBe(true)
    expect(isAppearanceSetting('Dark')).toBe(false)
    expect(isAppearanceSetting(null)).toBe(false)
    expect(isAppearanceSetting(42)).toBe(false)
  })
})

describe('coherent partial theme overrides', () => {
  test('non-status overrides may inherit the rest of the theme', () => {
    expect(validateThemeTokenOverrides([]).ok).toBe(true)
    expect(validateThemeTokenOverrides(['--color-focus', '--agent-type-1-fg']).ok).toBe(true)
  })
  test('any status slot requires all roles and every slot, including badges', () => {
    for (const token of STATUS_TOKENS) {
      const result = validateThemeTokenOverrides([token])
      expect(result.ok).toBe(false)
      expect(result.missing).toEqual(STATUS_TOKENS.filter((name) => name !== token))
      expect(validateThemeTokenOverrides(STATUS_TOKENS.filter((name) => name !== token)).missing).toEqual([token])
    }
    expect(validateThemeTokenOverrides(STATUS_TOKENS).ok).toBe(true)
  })
  test('rejects unknown and inactive token names', () => {
    expect(validateThemeTokenOverrides(['--status-typo-fg', '--future-brand-tile']).unexpected).toEqual([
      '--status-typo-fg',
      '--future-brand-tile',
    ])
  })
})
