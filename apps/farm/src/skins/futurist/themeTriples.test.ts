import { describe, expect, it } from 'bun:test'
import { FUTURIST_DEFAULT, tripleFor, type ThemeTriple } from './themeTriples'

const t = (background: string): ThemeTriple => ({ background, foreground: '#fff', accent: '#f0f' })
const table = {
  ficus: { light: t('ficus-light'), dark: t('ficus-dark') },
  phosphorus: { light: t('phos'), dark: t('phos') },
  iris: { light: t('iris-light'), dark: t('iris-dark') },
}

describe('tripleFor', () => {
  it("uses the chosen theme's triple for the chosen appearance", () => {
    expect(tripleFor({ themeId: 'ficus', appearance: 'dark' }, false, table).background).toBe('ficus-dark')
    expect(tripleFor({ themeId: 'ficus', appearance: 'light' }, true, table).background).toBe('ficus-light')
    expect(tripleFor({ themeId: 'phosphorus', appearance: 'light' }, false, table).background).toBe('phos')
  })

  it('follows the OS for the system appearance', () => {
    expect(tripleFor({ themeId: 'ficus', appearance: 'system' }, true, table).background).toBe('ficus-dark')
    expect(tripleFor({ themeId: 'ficus', appearance: 'system' }, false, table).background).toBe('ficus-light')
  })

  it('falls back to ficus for unknown ids and uses the base of a custom theme', () => {
    expect(tripleFor({ themeId: 'gone', appearance: 'light' }, false, table).background).toBe('ficus-light')
    expect(tripleFor({ themeId: 'custom:phosphorus', appearance: 'light' }, false, table).background).toBe('phos')
  })

  it('maps ids stored before the theme migration to their final ids', () => {
    expect(tripleFor({ themeId: 'forest', appearance: 'dark' }, false, table).background).toBe('ficus-dark')
    expect(tripleFor({ themeId: 'tau', appearance: 'light' }, false, table).background).toBe('iris-light')
    expect(tripleFor({ themeId: 'custom:tau', appearance: 'dark' }, false, table).background).toBe('iris-dark')
  })

  it("uses Futurist's own palette when there is no table yet", () => {
    expect(tripleFor({ themeId: 'ficus', appearance: 'dark' }, true, {})).toEqual(FUTURIST_DEFAULT)
    expect(tripleFor(null, false, {})).toEqual(FUTURIST_DEFAULT)
  })
})
