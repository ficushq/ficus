import { describe, expect, test } from 'bun:test'
import { validateThemeRegistry } from '@ficus/shared'
import {
  BUILT_IN_THEMES,
  FICUS_THEME,
  KNOWN_THEME_IDS,
  IRIS_THEME,
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
  test('ships the Ficus default, Iris, two more dual recolors, a constant high-contrast theme, and six BigBrain-ported constants', () => {
    expect(BUILT_IN_THEMES).toHaveLength(11)
    expect(findWebTheme('high-contrast').kind).toBe('unified')
    expect(FICUS_THEME.kind).toBe('dual')
    expect(IRIS_THEME.kind).toBe('dual')
    expect(BUILT_IN_THEMES).toContainEqual(expect.objectContaining({ id: 'ficus', label: 'Ficus' }))
    expect(BUILT_IN_THEMES).toContainEqual(expect.objectContaining({ id: 'iris', label: 'Iris' }))
    expect(KNOWN_THEME_IDS).toEqual([
      'ficus',
      'iris',
      'harbor',
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

  test('the dual themes keep the literal dark class as their dark variant scope', () => {
    // Migration invariant (report §4.1): the .dark class stays applied so all
    // existing Tailwind dark: variants keep working.
    expect(FICUS_THEME.variantClass).toEqual({ light: null, dark: 'dark' })
    expect(IRIS_THEME.variantClass).toEqual({ light: null, dark: 'dark' })
  })

  test('unknown ids resolve to ficus; findWebTheme never returns undefined', () => {
    expect(findWebTheme('iris').id).toBe('iris')
    expect(findWebTheme('nonsense').id).toBe('ficus')
    expect(findWebTheme(undefined).id).toBe('ficus')
  })

  test('an unknown stored id falls back to the Ficus default', () => {
    expect(findWebTheme('no-such-theme').id).toBe('ficus')
    expect(findWebTheme('iris').id).toBe('iris')
  })
})

describe('resolveWebTheme', () => {
  test('light and dark resolve directly; system resolves against the OS preference', () => {
    expect(resolveWebTheme('iris', 'light', true)).toEqual({ theme: IRIS_THEME, appearance: 'light' })
    expect(resolveWebTheme('iris', 'dark', false)).toEqual({ theme: IRIS_THEME, appearance: 'dark' })
    expect(resolveWebTheme('iris', 'system', true)).toEqual({ theme: IRIS_THEME, appearance: 'dark' })
    expect(resolveWebTheme('iris', 'system', false)).toEqual({ theme: IRIS_THEME, appearance: 'light' })
  })

  test('unknown theme ids fall back to the default pair', () => {
    expect(resolveWebTheme('atlantis', 'dark', false)).toEqual({ theme: FICUS_THEME, appearance: 'dark' })
    expect(resolveWebTheme(null, null, false)).toEqual({ theme: FICUS_THEME, appearance: 'light' })
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
    applyResolvedTheme(root, IRIS_THEME, 'dark')
    expect(root.getAttribute('data-theme')).toBe('iris')
    expect(root.getAttribute('data-appearance')).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
  })

  test('light resolution sets attributes and removes the dark class', () => {
    const root = freshRoot()
    root.classList.add('dark')
    applyResolvedTheme(root, IRIS_THEME, 'light')
    expect(root.getAttribute('data-theme')).toBe('iris')
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
    applyResolvedTheme(root, IRIS_THEME, 'dark')
    expect(root.classList.contains('dark')).toBe(true)
    applyResolvedTheme(root, IRIS_THEME, 'light')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.className.trim()).toBe('')
  })
})

describe('highContrastLast', () => {
  test('moves only the built-in High contrast to the end, after presets', () => {
    const options = [
      { kind: 'builtin', id: 'iris' },
      { kind: 'builtin', id: 'high-contrast' },
      { kind: 'preset', id: 'high-contrast' },
      { kind: 'preset', id: 'mine' },
    ]
    expect(highContrastLast(options)).toEqual([
      { kind: 'builtin', id: 'iris' },
      { kind: 'preset', id: 'high-contrast' },
      { kind: 'preset', id: 'mine' },
      { kind: 'builtin', id: 'high-contrast' },
    ])
  })
})
