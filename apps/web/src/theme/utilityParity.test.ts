import { expect, test } from 'bun:test'
import { compileUtilities, utilityDeclarations } from '../test/tailwind'
import { STATUS_TOKENS, validateThemeTokenOverrides } from '@ficus/shared'
import fixture from './fixtures/legacy-utility-colors.json'
import { palettes, tokenRgba } from './test/builtins'

// Frozen before the final sweep. The legacy names are test data, not a palette
// shipped to consumers; authored CSS scopes remain the runtime source of truth.
test('remaining utility ramps preserve their original concrete colors and are complete in every scope', () => {
  for (const [name, { hex }] of Object.entries(fixture)) {
    const token = `--${name}`
    const expected = hex
      .slice(1)
      .match(/../g)!
      .map((part) => parseInt(part, 16))
    for (const palette of palettes) expect(tokenRgba(palette.tokens, token)).toEqual(expected)
  }
})
test('every migrated ramp compiles to a real token utility with alpha composition', async () => {
  const classes = Object.keys(fixture).flatMap((name) => [`text-${name}`, `bg-${name}/30`])
  const result = await compileUtilities(classes)
  expect([...utilityDeclarations(result).keys()].sort()).toEqual(classes.sort())
  for (const name of Object.keys(fixture)) expect(result.toString()).toContain(`var(--${name})`)
})
test('status ramp overrides cannot bypass atomic status coherence', () => {
  expect(STATUS_TOKENS).toContain('--status-danger-600')
  expect(validateThemeTokenOverrides(['--status-danger-600']).ok).toBe(false)
  expect(validateThemeTokenOverrides(STATUS_TOKENS).ok).toBe(true)
})
