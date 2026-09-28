import { expect, test } from 'bun:test'
import type { ThemePreference } from './theme-preferences'
import type { CustomThemeDocument } from './custom-theme'
import { STATUS_TOKENS } from './theme-schema'
import { SYNC_THEME_DESCRIPTORS, validateThemePreference } from './theme-preferences'

const theme: ThemePreference = {
  themeId: 'harbor',
  appearance: 'dark',
  customTheme: null,
  presetId: null,
  presetOwnerId: null,
}
const custom: CustomThemeDocument = {
  format: 'ficus-custom-theme',
  version: 2,
  name: 'Shared',
  base: 'harbor',
  variants: { light: {}, dark: { '--term-bg': 'rgba(1,2,3,0.000000001)' } },
}
test('validates a complete preference including tiny-alpha custom values; strips unknown fields', () => {
  expect(validateThemePreference({ ...theme, userId: 'other' })).toEqual({ ok: true, theme })
  expect(validateThemePreference({ ...theme, customTheme: custom })).toEqual({
    ok: true,
    theme: { ...theme, customTheme: custom },
  })
  expect(
    validateThemePreference({
      themeId: 'high-contrast',
      appearance: 'system',
      customTheme: { ...custom, base: 'high-contrast', variants: { constant: {} } },
      presetId: null,
    }).ok
  ).toBe(true)
})

test('accepts every BigBrain-ported unified built-in id (docs/wiki/theme/builtins.md)', () => {
  const bigBrainIds = ['nurebairo', 'phosphorus', 'yamabukiiro', 'moegiiro', 'adzukiiro', 'asagiiro']
  expect(SYNC_THEME_DESCRIPTORS.filter((d) => bigBrainIds.includes(d.id)).map((d) => d.kind)).toEqual(
    bigBrainIds.map(() => 'unified')
  )
  for (const themeId of bigBrainIds) {
    const result = validateThemePreference({ themeId, appearance: 'system', customTheme: null, presetId: null })
    expect(result).toEqual({
      ok: true,
      theme: { themeId, appearance: 'system', customTheme: null, presetId: null, presetOwnerId: null },
    })
  }
})
test('presetId is optional; when present it must be a non-empty string, defaulting to null when absent', () => {
  const { presetId: _drop, ...withoutPresetId } = theme
  expect(validateThemePreference(withoutPresetId)).toEqual({ ok: true, theme })
  const withPreset = { ...theme, presetId: '11111111-1111-4111-8111-111111111111' }
  expect(validateThemePreference(withPreset)).toEqual({ ok: true, theme: withPreset })
  expect(validateThemePreference({ ...theme, presetId: '' }).ok).toBe(false)
  expect(validateThemePreference({ ...theme, presetId: 123 }).ok).toBe(false)
})
test('presetOwnerId is optional; a non-empty string when present, but only alongside a customTheme', () => {
  const { presetOwnerId: _drop, ...withoutOwnerId } = theme
  expect(validateThemePreference(withoutOwnerId)).toEqual({ ok: true, theme })
  const withOwner = {
    ...theme,
    customTheme: custom,
    presetId: '11111111-1111-4111-8111-111111111111',
    presetOwnerId: '22222222-2222-4222-8222-222222222222',
  }
  expect(validateThemePreference(withOwner)).toEqual({ ok: true, theme: withOwner })
  // Phase 2 detached-shared state: presetId cleared (the live link 404'd) but
  // presetOwnerId retained — this is exactly what tells the UI "no longer
  // shared" apart from an ordinary silently-detached own preset.
  const detachedShared = {
    ...theme,
    customTheme: custom,
    presetId: null,
    presetOwnerId: '22222222-2222-4222-8222-222222222222',
  }
  expect(validateThemePreference(detachedShared)).toEqual({ ok: true, theme: detachedShared })
  expect(validateThemePreference({ ...theme, presetOwnerId: '' }).ok).toBe(false)
  expect(validateThemePreference({ ...theme, presetOwnerId: 123 }).ok).toBe(false)
  // No customTheme at all: an owner id would be meaningless (nothing to detach from).
  expect(validateThemePreference({ ...theme, presetOwnerId: '22222222-2222-4222-8222-222222222222' }).ok).toBe(false)
})
test('a custom theme pair may resolve either side regardless of the current appearance (no forced match)', () => {
  // Previously appearance had to equal the document's single concrete appearance;
  // v2 pairs follow the Light/Dark/System toggle instead, so a 'light' appearance
  // with a dark-only-populated pair (and vice versa) is valid as long as the base matches.
  expect(validateThemePreference({ ...theme, appearance: 'light', customTheme: custom }).ok).toBe(true)
  expect(validateThemePreference({ ...theme, appearance: 'system', customTheme: custom }).ok).toBe(true)
})
test('rejects missing fields, unknowns, unsafe values, incoherent status sets, base/variant mismatch and oversized docs', () => {
  for (const input of [
    null,
    [],
    {},
    { ...theme, appearance: 'constant' },
    { ...theme, themeId: 'unknown' },
    { themeId: 'iris', appearance: 'dark' },
    ...[
      { ...custom, base: 'ember' },
      { ...custom, version: 3 },
      { ...custom, variants: { light: { '--term-bg': 'url(https://bad.test)' }, dark: {} } },
      { ...custom, variants: { light: {}, dark: { [STATUS_TOKENS[0]!]: '#123456' } } },
      { ...custom, extra: 'x'.repeat(40000) },
    ].map((doc) => ({ ...theme, customTheme: doc })),
  ]) {
    expect(validateThemePreference(input).ok).toBe(false)
  }
})
