import { expect, test } from 'bun:test'
import { formatDerivationError, safeDerivationReason } from './public-voice-errors'

test('diagnostics accept only bounded server-owned reason tokens', () => {
  expect(safeDerivationReason('derivation_github_unavailable', 'http_503')).toBe('http_503')
  expect(safeDerivationReason('derivation_invalid_output', 'schema')).toBe('schema')
  expect(safeDerivationReason('derivation_model_unavailable', undefined)).toBe('unspecified')
  for (const reason of ['schema\nforged', 'http_503\n', 'SYNTHETIC_PRIVATE_TEXT', 'x'.repeat(10000), {}, null]) {
    expect(safeDerivationReason('derivation_invalid_output', reason)).toBe('unknown')
    expect(safeDerivationReason('derivation_github_unavailable', reason)).toBe('unknown')
    expect(formatDerivationError('derivation_invalid_output', { reason })).toBe(
      'derivation_invalid_output: The model returned an invalid voice draft (the validation reason is unavailable). Nothing was saved; try again.'
    )
  }
})

test('count messages never interpolate malformed values or arbitrary payload fields', () => {
  for (const details of [
    null,
    undefined,
    'text',
    { counts: null },
    { counts: { kept: -1, collected: 10 }, minimum: 8 },
    { counts: { kept: 1, collected: Infinity }, minimum: 8 },
  ]) {
    expect(formatDerivationError('derivation_too_few_samples', details)).toBe(
      'derivation_too_few_samples: Too few usable samples were found to derive a voice.'
    )
  }
  expect(formatDerivationError('forbidden', { reason: 'private' })).toBeUndefined()
  expect(safeDerivationReason('toString', 'private')).toBe('unknown')
})
