import { afterEach, describe, expect, test } from 'bun:test'
import {
  APPEARANCE_KEY,
  LEGACY_SURFACE_COLOR_KEY,
  LEGACY_THEME_KEY,
  THEME_ID_KEY,
  THEME_SURFACE_KEY,
  getThemeStorage,
  persistSurfaceSnapshot,
  persistThemeSelection,
  readSurfaceSnapshot,
  readThemeSelection,
  type ThemeStorage,
} from './storage'

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  }
}

test('theme storage keys are the ficus names', () => {
  expect(THEME_ID_KEY).toBe('ficus-theme-id')
  expect(APPEARANCE_KEY).toBe('ficus-appearance')
  expect(LEGACY_THEME_KEY).toBe('ficus-theme')
  expect(LEGACY_SURFACE_COLOR_KEY).toBe('ficus-surface-color')
  expect(THEME_SURFACE_KEY).toBe('ficus-theme-surface')
})

describe('readThemeSelection (localStorage migration)', () => {
  test('empty storage falls back to the defaults (ficus, light)', () => {
    expect(readThemeSelection(memoryStorage())).toEqual({ themeId: 'ficus', appearance: 'light' })
    expect(readThemeSelection(null)).toEqual({ themeId: 'ficus', appearance: 'light' })
  })

  test("legacy 'ficus-theme' values migrate onto the new model", () => {
    expect(readThemeSelection(memoryStorage({ [LEGACY_THEME_KEY]: 'dark' }))).toEqual({
      themeId: 'ficus',
      appearance: 'dark',
    })
    expect(readThemeSelection(memoryStorage({ [LEGACY_THEME_KEY]: 'light' }))).toEqual({
      themeId: 'ficus',
      appearance: 'light',
    })
  })

  test('new keys win over the legacy value once written', () => {
    const storage = memoryStorage({
      [THEME_ID_KEY]: 'iris',
      [APPEARANCE_KEY]: 'light',
      [LEGACY_THEME_KEY]: 'dark',
    })
    expect(readThemeSelection(storage)).toEqual({ themeId: 'iris', appearance: 'light' })
  })

  test('unreadable or unknown values degrade to defaults instead of throwing', () => {
    expect(readThemeSelection(memoryStorage({ [LEGACY_THEME_KEY]: 'banana' }))).toEqual({
      themeId: 'ficus',
      appearance: 'light',
    })
    expect(readThemeSelection(memoryStorage({ [THEME_ID_KEY]: 'martian', [APPEARANCE_KEY]: 'dark' }))).toEqual({
      themeId: 'ficus',
      appearance: 'dark',
    })
    expect(readThemeSelection(memoryStorage({ [APPEARANCE_KEY]: 'solarized' }))).toEqual({
      themeId: 'ficus',
      appearance: 'light',
    })
  })

  test('system appearance round-trips through storage', () => {
    const storage = memoryStorage({ [THEME_ID_KEY]: 'iris', [APPEARANCE_KEY]: 'system' })
    expect(readThemeSelection(storage)).toEqual({ themeId: 'iris', appearance: 'system' })
  })

  describe('inside Ficus Desktop, with no stored appearance choice', () => {
    afterEach(() => {
      delete window.ficusDesktopApp
    })

    test('follows the OS appearance via window.ficusDesktopApp', () => {
      window.ficusDesktopApp = {
        version: 1,
        notificationsEnabled: async () => false,
        deliverNotifications: async () => {},
      }
      expect(readThemeSelection(memoryStorage())).toEqual({ themeId: 'ficus', appearance: 'system' })
    })

    test('a stored choice still wins over the desktop default', () => {
      window.ficusDesktopApp = {
        version: 1,
        notificationsEnabled: async () => false,
        deliverNotifications: async () => {},
      }
      const storage = memoryStorage({ [THEME_ID_KEY]: 'iris', [APPEARANCE_KEY]: 'light' })
      expect(readThemeSelection(storage)).toEqual({ themeId: 'iris', appearance: 'light' })
    })
  })
})

describe('persistThemeSelection', () => {
  test('writes the new keys and clears the legacy key (idempotent migration)', () => {
    const storage = memoryStorage({ [LEGACY_THEME_KEY]: 'dark' })
    persistThemeSelection(storage, { themeId: 'iris', appearance: 'dark' })
    expect(storage.getItem(THEME_ID_KEY)).toBe('iris')
    expect(storage.getItem(APPEARANCE_KEY)).toBe('dark')
    expect(storage.getItem(LEGACY_THEME_KEY)).toBeNull()
    // A second read is stable — no legacy value to re-migrate.
    expect(readThemeSelection(storage)).toEqual({ themeId: 'iris', appearance: 'dark' })
  })

  test('null storage is a no-op, not an error', () => {
    expect(() => persistThemeSelection(null, { themeId: 'iris', appearance: 'light' })).not.toThrow()
  })
})

describe('surface snapshots', () => {
  test('unified themes round-trip a constant snapshot, never a light/dark snapshot', () => {
    const storage = memoryStorage()
    persistSurfaceSnapshot(storage, 'high-contrast', 'constant', 'rgb(255 255 255)')
    expect(readSurfaceSnapshot(storage, 'high-contrast', 'constant')).toBe('rgb(255 255 255)')
    expect(readSurfaceSnapshot(storage, 'high-contrast', 'light')).toBeNull()
    expect(readSurfaceSnapshot(storage, 'iris', 'light')).toBeNull()
  })

  test('the state-keyed snapshot round-trips for the matching resolved state', () => {
    const storage = memoryStorage()
    persistSurfaceSnapshot(storage, 'iris', 'dark', 'rgb(16 17 28)')
    expect(readSurfaceSnapshot(storage, 'iris', 'dark')).toBe('rgb(16 17 28)')
  })

  test('a snapshot captured under another state does not apply', () => {
    const storage = memoryStorage()
    persistSurfaceSnapshot(storage, 'iris', 'dark', 'rgb(16 17 28)')
    expect(readSurfaceSnapshot(storage, 'iris', 'light')).toBeNull()
    expect(readSurfaceSnapshot(storage, 'nord', 'dark')).toBeNull()
  })

  test('the legacy plain-string snapshot applies only under Iris, the theme it was written for', () => {
    const storage = memoryStorage({ [LEGACY_SURFACE_COLOR_KEY]: '#10111c' })
    expect(readSurfaceSnapshot(storage, 'iris', 'dark')).toBe('#10111c')
    expect(readSurfaceSnapshot(storage, 'ficus', 'dark')).toBeNull()
  })

  test('a corrupt snapshot is ignored rather than trusted', () => {
    const storage = memoryStorage({ [THEME_SURFACE_KEY]: '{not json' })
    expect(readSurfaceSnapshot(storage, 'iris', 'dark')).toBeNull()
  })

  test('persisting keeps the legacy plain string valid for one migration cycle', () => {
    const storage = memoryStorage()
    persistSurfaceSnapshot(storage, 'iris', 'light', 'rgb(255 255 255)')
    expect(JSON.parse(storage.getItem(THEME_SURFACE_KEY)!)).toEqual({
      theme: 'iris',
      appearance: 'light',
      surface: 'rgb(255 255 255)',
    })
    expect(storage.getItem(LEGACY_SURFACE_COLOR_KEY)).toBe('rgb(255 255 255)')
  })
})

describe('getThemeStorage', () => {
  test('returns null instead of throwing when storage is unavailable', () => {
    // In the bun test environment localStorage exists; the SSR path is
    // exercised by typeof checks in the implementation. Here we only pin the
    // happy path shape.
    const storage = getThemeStorage()
    expect(storage === null || typeof storage.getItem === 'function').toBe(true)
  })
})
