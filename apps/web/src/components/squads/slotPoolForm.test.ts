import { describe, expect, test } from 'bun:test'
import {
  formatSlotAge,
  formatSlotTimeout,
  normalizeSlotKey,
  normalizeSlotUsage,
  parseSlotCapacity,
  parseSlotTimeout,
  slotKeyError,
  slotUsageError,
} from './slotPoolForm'

describe('slot pool form validation mirrors the server', () => {
  test('keys are trimmed, lowercased and must match the pool key pattern', () => {
    expect(normalizeSlotKey('  Shared-Box  ')).toBe('shared-box')
    expect(slotKeyError('shared-box-intensive')).toBeNull()
    expect(slotKeyError('  Tests.v2_a  ')).toBeNull()
    expect(slotKeyError('')).toBe('Key is required.')
    expect(slotKeyError('2fast')).not.toBeNull()
    expect(slotKeyError('has space')).not.toBeNull()
    expect(slotKeyError(`a${'b'.repeat(64)}`)).not.toBeNull()
    expect(slotKeyError(`a${'b'.repeat(63)}`)).toBeNull()
  })

  test('capacity is a whole number from 1 to 1000', () => {
    expect(parseSlotCapacity('1')).toBe(1)
    expect(parseSlotCapacity(' 1000 ')).toBe(1000)
    for (const bad of ['0', '1001', '1.5', '-1', '', 'two']) expect(parseSlotCapacity(bad)).toBeNull()
  })

  test('timeouts accept s/m/h/d or bare minutes, bounded to 1m-24h', () => {
    expect(parseSlotTimeout('45m')).toBe(45 * 60_000)
    expect(parseSlotTimeout('45')).toBe(45 * 60_000)
    expect(parseSlotTimeout('2H')).toBe(2 * 3_600_000)
    expect(parseSlotTimeout('60s')).toBe(60_000)
    expect(parseSlotTimeout('1d')).toBe(86_400_000)
    expect(parseSlotTimeout('24h')).toBe(86_400_000)
    for (const bad of ['59s', '25h', '2d', '', '1.5h', 'soon']) expect(parseSlotTimeout(bad)).toBeNull()
  })

  test('guidance is bounded after trimming and blank means none', () => {
    expect(slotUsageError(`  ${'x'.repeat(1000)}  `)).toBeNull()
    expect(slotUsageError('x'.repeat(1001))).toContain('1000')
    expect(normalizeSlotUsage('   ')).toBeNull()
    expect(normalizeSlotUsage('  Claim first.  ')).toBe('Claim first.')
  })

  test('durations and ages format compactly', () => {
    expect(formatSlotTimeout(45 * 60_000)).toBe('45m')
    expect(formatSlotTimeout(3_600_000)).toBe('1h')
    expect(formatSlotTimeout(90_000)).toBe('90s')
    expect(formatSlotTimeout(86_400_000)).toBe('1d')
    expect(formatSlotAge(42_000)).toBe('42s')
    expect(formatSlotAge(12 * 60_000)).toBe('12m')
    expect(formatSlotAge(3 * 3_600_000)).toBe('3h')
  })
})
