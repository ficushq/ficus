import { expect, test } from 'bun:test'
import { applyThemeOperations, themeAssistantContract, themeOperationSchema } from './theme-assistant'
import type { CustomThemeDocument } from './custom-theme'

function dualDoc(): CustomThemeDocument {
  return { format: 'ficus-custom-theme', version: 2, name: 'My theme', base: 'iris', variants: { light: {}, dark: {} } }
}

test('set-palette starts, patches, and clears a palette without disturbing other fields', () => {
  const base = dualDoc()
  const started = applyThemeOperations(base, [{ op: 'set-palette', primary: '#336699' }])
  expect(base.palette).toBeUndefined() // pure: input untouched
  expect(started.palette).toEqual({ primary: '#336699' })
  expect(started.name).toBe('My theme')

  const patched = applyThemeOperations(started, [
    { op: 'set-palette', secondary: '#ff8800', contrast: 'high', status: 'harmonized' },
  ])
  expect(patched.palette).toEqual({
    primary: '#336699',
    secondary: '#ff8800',
    contrast: 'high',
    status: 'harmonized',
  })

  const clearedSeed = applyThemeOperations(patched, [{ op: 'set-palette', secondary: null }])
  expect(clearedSeed.palette).toEqual({ primary: '#336699', contrast: 'high', status: 'harmonized' })

  const clearedAll = applyThemeOperations(clearedSeed, [{ op: 'set-palette', primary: null }])
  expect(clearedAll.palette).toBeUndefined()
})

test('set-overrides writes and removes tokens on the addressed variant only', () => {
  const base = dualDoc()
  const withLight = applyThemeOperations(base, [
    { op: 'set-overrides', variant: 'light', tokens: { '--color-primary': '#112233' } },
  ])
  expect(withLight.variants).toEqual({ light: { '--color-primary': '#112233' }, dark: {} })
  const withDark = applyThemeOperations(withLight, [
    { op: 'set-overrides', variant: 'dark', tokens: { '--color-primary': '#445566' } },
  ])
  expect(withDark.variants).toEqual({
    light: { '--color-primary': '#112233' },
    dark: { '--color-primary': '#445566' },
  })
  const removed = applyThemeOperations(withDark, [
    { op: 'set-overrides', variant: 'light', tokens: { '--color-primary': null } },
  ])
  expect(removed.variants).toEqual({ light: {}, dark: { '--color-primary': '#445566' } })
})

test('set-base reshapes variants for the new base kind (dual -> unified merges; unified -> dual seeds both)', () => {
  const dual: CustomThemeDocument = {
    ...dualDoc(),
    variants: { light: { '--color-primary': '#111111' }, dark: { '--color-primary': '#222222' } },
  }
  const unified = applyThemeOperations(dual, [{ op: 'set-base', base: 'high-contrast' }])
  expect(unified.base).toBe('high-contrast')
  expect(unified.variants).toEqual({ constant: { '--color-primary': '#222222' } })
  const backToDual = applyThemeOperations(unified, [{ op: 'set-base', base: 'iris' }])
  expect(backToDual.variants).toEqual({
    light: { '--color-primary': '#222222' },
    dark: { '--color-primary': '#222222' },
  })
})

test('set-base rejects an unknown base id', () => {
  expect(() => applyThemeOperations(dualDoc(), [{ op: 'set-base', base: 'nonexistent' }])).toThrow()
})

test('rename and clear-overrides', () => {
  const withOverrides: CustomThemeDocument = {
    ...dualDoc(),
    variants: { light: { '--color-primary': '#111111' }, dark: { '--color-primary': '#222222' } },
  }
  const renamed = applyThemeOperations(withOverrides, [{ op: 'rename', name: 'Midnight' }])
  expect(renamed.name).toBe('Midnight')
  const clearedLight = applyThemeOperations(withOverrides, [{ op: 'clear-overrides', variant: 'light' }])
  expect(clearedLight.variants).toEqual({ light: {}, dark: { '--color-primary': '#222222' } })
  const clearedAll = applyThemeOperations(withOverrides, [{ op: 'clear-overrides' }])
  expect(clearedAll.variants).toEqual({ light: {}, dark: {} })
})

test('a batch applies atomically in order', () => {
  const next = applyThemeOperations(dualDoc(), [
    { op: 'rename', name: 'Ocean' },
    { op: 'set-palette', primary: '#0ea5e9' },
    { op: 'set-overrides', variant: 'dark', tokens: { '--term-bg': '#0c141e' } },
  ])
  expect(next.name).toBe('Ocean')
  expect(next.palette).toEqual({ primary: '#0ea5e9' })
  expect(next.variants).toEqual({ light: {}, dark: { '--term-bg': '#0c141e' } })
})

test('rejects a malformed operation batch (schema-level)', () => {
  expect(() => applyThemeOperations(dualDoc(), [{ op: 'not-a-real-op' }])).toThrow()
  expect(() => applyThemeOperations(dualDoc(), [])).toThrow() // empty batch
  expect(() => applyThemeOperations(dualDoc(), [{ op: 'rename', name: '' }])).toThrow()
})

test('themeOperationSchema accepts every documented op literal', () => {
  for (const op of ['set-palette', 'set-overrides', 'set-base', 'rename', 'clear-overrides']) {
    const sample = {
      'set-palette': { op, primary: '#000000' },
      'set-overrides': { op, variant: 'light', tokens: { '--color-primary': '#000000' } },
      'set-base': { op, base: 'iris' },
      rename: { op, name: 'x' },
      'clear-overrides': { op },
    }[op as 'set-palette']
    expect(themeOperationSchema.safeParse(sample).success).toBe(true)
  }
})

test('the model-facing contract lists palette fields, token families, and built-in bases', () => {
  expect(themeAssistantContract).toContain('primary')
  expect(themeAssistantContract).toContain('harmonized')
  expect(themeAssistantContract).toContain('chrome')
  expect(themeAssistantContract).toContain('iris')
  expect(themeAssistantContract).toContain('high-contrast')
  expect(themeAssistantContract.length).toBeLessThan(20_000)
})
