import { expect, test } from 'bun:test'
import { safeDerivationDiagnostic } from './diagnostics'

test('keeps an exception name and local stack locations but no message or arbitrary stack text', () => {
  const error = new TypeError('SYNTHETIC_PRIVATE_SENTINEL ghp_abcdefghijklmnopqrstuvwxyz0123')
  error.stack += '\nSYNTHETIC_PRIVATE_SENTINEL\n    at provider (https://provider.invalid/private-secret:1:2)'
  const safe = safeDerivationDiagnostic(error)
  expect(safe.name).toBe('TypeError')
  expect(safe.stack).toContain('apps/core/src/services/public-voice/diagnostics.test.ts:')
  expect(JSON.stringify(safe)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL')
  expect(JSON.stringify(safe)).not.toContain('ghp_')
  expect(JSON.stringify(safe)).not.toContain('provider.invalid')
})
test('non-errors and forged exception names never become free-form log fields', () => {
  expect(safeDerivationDiagnostic('private sentinel')).toEqual({ name: 'NonErrorThrown', stack: '' })
  const error = new Error('private sentinel')
  error.name = 'private sentinel'
  error.stack = 'private sentinel'
  expect(safeDerivationDiagnostic(error)).toEqual({ name: 'Error', stack: '' })
})
