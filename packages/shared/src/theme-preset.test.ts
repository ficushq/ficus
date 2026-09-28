import { expect, test } from 'bun:test'
import {
  THEME_PRESET_MAX_PER_USER,
  createThemePresetRequestSchema,
  deleteThemePresetRequestSchema,
  isThemePresetScope,
  isThemePresetVisibility,
  updateThemePresetRequestSchema,
  updateThemePresetVisibilityRequestSchema,
  validateThemePresetDocument,
} from './theme-preset'

const v2doc = {
  format: 'ficus-custom-theme',
  version: 2,
  name: 'Mine',
  base: 'iris',
  variants: { light: {}, dark: {} },
}
const v1doc = {
  format: 'ficus-custom-theme',
  version: 1,
  name: 'Mine',
  base: 'iris',
  appearance: 'dark',
  overrides: {},
}

test('validateThemePresetDocument accepts a v2 document object or JSON string, normalizing v1', () => {
  expect(validateThemePresetDocument(v2doc).ok).toBe(true)
  expect(validateThemePresetDocument(JSON.stringify(v2doc)).ok).toBe(true)
  const v1result = validateThemePresetDocument(v1doc)
  expect(v1result.ok).toBe(true)
  if (v1result.ok) expect(v1result.document.version).toBe(2)
})

test('validateThemePresetDocument rejects missing, malformed and invalid documents', () => {
  expect(validateThemePresetDocument(null).ok).toBe(false)
  expect(validateThemePresetDocument(undefined).ok).toBe(false)
  expect(validateThemePresetDocument({ ...v2doc, base: 'not-a-theme' }).ok).toBe(false)
  expect(
    validateThemePresetDocument({ ...v2doc, variants: { light: { '--color-primary': 'url(x)' }, dark: {} } }).ok
  ).toBe(false)
})

test('isThemePresetVisibility recognizes only the two Phase-1 states', () => {
  expect(isThemePresetVisibility('private')).toBe(true)
  expect(isThemePresetVisibility('instance')).toBe(true)
  expect(isThemePresetVisibility('public')).toBe(false)
  expect(isThemePresetVisibility(undefined)).toBe(false)
})

test('request schemas accept exactly their documented shape', () => {
  expect(createThemePresetRequestSchema.safeParse({ document: v2doc }).success).toBe(true)
  expect(createThemePresetRequestSchema.safeParse({ document: v2doc, visibility: 'instance' }).success).toBe(false)
  expect(createThemePresetRequestSchema.safeParse({}).success).toBe(false)
  expect(updateThemePresetRequestSchema.safeParse({ revision: 1, document: v2doc }).success).toBe(true)
  expect(updateThemePresetRequestSchema.safeParse({ document: v2doc }).success).toBe(false)
  expect(updateThemePresetRequestSchema.safeParse({ revision: -1, document: v2doc }).success).toBe(false)
  expect(updateThemePresetRequestSchema.safeParse({ revision: 1.5, document: v2doc }).success).toBe(false)
  expect(deleteThemePresetRequestSchema.safeParse({ revision: 1 }).success).toBe(true)
  expect(deleteThemePresetRequestSchema.safeParse({}).success).toBe(false)
})

test('a per-user cap constant exists for the route to enforce', () => {
  expect(THEME_PRESET_MAX_PER_USER).toBe(50)
})

test('isThemePresetScope recognizes exactly the three Phase-2 list scopes', () => {
  expect(isThemePresetScope('mine')).toBe(true)
  expect(isThemePresetScope('shared')).toBe(true)
  expect(isThemePresetScope('all')).toBe(true)
  expect(isThemePresetScope('everyone')).toBe(false)
  expect(isThemePresetScope(undefined)).toBe(false)
})

test('the visibility-change request schema accepts exactly revision + visibility', () => {
  expect(updateThemePresetVisibilityRequestSchema.safeParse({ revision: 1, visibility: 'instance' }).success).toBe(true)
  expect(updateThemePresetVisibilityRequestSchema.safeParse({ revision: 1, visibility: 'private' }).success).toBe(true)
  expect(updateThemePresetVisibilityRequestSchema.safeParse({ revision: 1, visibility: 'public' }).success).toBe(false)
  expect(updateThemePresetVisibilityRequestSchema.safeParse({ visibility: 'instance' }).success).toBe(false)
  expect(
    updateThemePresetVisibilityRequestSchema.safeParse({ revision: 1, visibility: 'instance', document: {} }).success
  ).toBe(false)
})
