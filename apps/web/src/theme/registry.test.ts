import { describe, expect, test } from 'bun:test'
import { validateThemeRegistry } from '@ficus/shared'
import {
  BUILT_IN_THEMES,
  KNOWN_THEME_IDS,
  TAU_THEME,
  THEME_PICKER_ENABLED,
  findWebTheme,
  highContrastLast,
  resolveWebTheme,
} from './registry'
import { applyResolvedTheme } from './apply'

describe('web theme registry', () => {
  test('enables the picker after the built-in contrast and cold-load gates', () => {
    expect(THEME_PICKER_ENABLED).toBe(true)
  })
  test('ships Ficus, three dual recolors, a constant high-contrast theme, and six BigBrain-ported constants', () => {
    expect(BUILT_IN_THEMES).toHaveLength(11)
    expect(findWebTheme('high-contrast').kind).toBe('unified')
    expect(TAU_THEME.kind).toBe('dual')
    expect(KNOWN_THEME_IDS).toEqual([
      'tau',
      'harbor',
      'forest',
      'ember',
      'nurebairo',
      'phosphorus',
      'yamabukiiro',
      'moegiiro',
      'adzukiiro',
      'asagiiro',
      'high-contrast',
    ])
    expect(validateThemeRegistry(BUILT_IN_THEMES)).toEqual([])
  })

  test('the six BigBrain-ported themes are unified, with dark ones keeping the migration class', () => {
    const darkIds = ['nurebairo', 'moegiiro', 'adzukiiro', 'asagiiro']
    const lightIds = ['phosphorus', 'yamabukiiro']
    for (const id of [...darkIds, ...lightIds]) expect(findWebTheme(id).kind).toBe('unified')
    for (const id of darkIds) expect(findWebTheme(id).variantClass).toEqual({ constant: 'dark' })
    for (const id of lightIds) expect(findWebTheme(id).variantClass).toEqual({ constant: null })
  })

  test('the tau theme keeps the literal dark class as its dark variant scope', () => {
    // Migration invariant (report §4.1): the .dark class stays applied so all
    // existing Tailwind dark: variants keep working.
    expect(TAU_THEME.variantClass).toEqual({ light: null, dark: 'dark' })
  })

  test('unknown ids resolve to tau; findWebTheme never returns undefined', () => {
    expect(findWebTheme('tau').id).toBe('tau')
    expect(findWebTheme('nonsense').id).toBe('tau')
    expect(findWebTheme(undefined).id).toBe('tau')
  })
})

describe('resolveWebTheme', () => {
  test('light and dark resolve directly; system resolves against the OS preference', () => {
    expect(resolveWebTheme('tau', 'light', true)).toEqual({ theme: TAU_THEME, appearance: 'light' })
    expect(resolveWebTheme('tau', 'dark', false)).toEqual({ theme: TAU_THEME, appearance: 'dark' })
    expect(resolveWebTheme('tau', 'system', true)).toEqual({ theme: TAU_THEME, appearance: 'dark' })
    expect(resolveWebTheme('tau', 'system', false)).toEqual({ theme: TAU_THEME, appearance: 'light' })
  })

  test('unknown theme ids fall back to the default pair', () => {
    expect(resolveWebTheme('atlantis', 'dark', false)).toEqual({ theme: TAU_THEME, appearance: 'dark' })
    expect(resolveWebTheme(null, null, false)).toEqual({ theme: TAU_THEME, appearance: 'light' })
  })
})

/** Minimal HTMLElement double: only what applyResolvedTheme touches. */
function freshRoot(): HTMLElement {
  const attributes = new Map<string, string>()
  const classes = new Set<string>()
  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    classList: {
      contains: (cls: string) => classes.has(cls),
      add: (...cls: string[]) => void cls.forEach((c) => classes.add(c)),
      remove: (...cls: string[]) => void cls.forEach((c) => classes.delete(c)),
    },
    get className() {
      return [...classes].join(' ')
    },
  } as unknown as HTMLElement
}

describe('applyResolvedTheme', () => {
  test('dark resolution sets data-theme, data-appearance, and keeps the dark class', () => {
    const root = freshRoot()
    applyResolvedTheme(root, TAU_THEME, 'dark')
    expect(root.getAttribute('data-theme')).toBe('tau')
    expect(root.getAttribute('data-appearance')).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
  })

  test('light resolution sets attributes and removes the dark class', () => {
    const root = freshRoot()
    root.classList.add('dark')
    applyResolvedTheme(root, TAU_THEME, 'light')
    expect(root.getAttribute('data-theme')).toBe('tau')
    expect(root.getAttribute('data-appearance')).toBe('light')
    expect(root.classList.contains('dark')).toBe(false)
  })

  test('a unified theme applies its id and drops data-appearance entirely', () => {
    const root = freshRoot()
    root.setAttribute('data-appearance', 'dark')
    root.classList.add('dark')
    const unified = { id: 'high-contrast', label: 'High Contrast', kind: 'unified' as const, variantClass: {} }
    applyResolvedTheme(root, unified, 'constant')
    expect(root.getAttribute('data-theme')).toBe('high-contrast')
    expect(root.getAttribute('data-appearance')).toBeNull()
    expect(root.classList.contains('dark')).toBe(false)
  })

  test('switching variants swaps the scoped class instead of stacking them', () => {
    const root = freshRoot()
    applyResolvedTheme(root, TAU_THEME, 'dark')
    expect(root.classList.contains('dark')).toBe(true)
    applyResolvedTheme(root, TAU_THEME, 'light')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.className.trim()).toBe('')
  })
})

describe('highContrastLast', () => {
  test('moves only the built-in High contrast to the end, after presets', () => {
    const options = [
      { kind: 'builtin', id: 'tau' },
      { kind: 'builtin', id: 'high-contrast' },
      { kind: 'preset', id: 'high-contrast' },
      { kind: 'preset', id: 'mine' },
    ]
    expect(highContrastLast(options)).toEqual([
      { kind: 'builtin', id: 'tau' },
      { kind: 'preset', id: 'high-contrast' },
      { kind: 'preset', id: 'mine' },
      { kind: 'builtin', id: 'high-contrast' },
    ])
  })
})
