import { describe, expect, test } from 'bun:test'
import { daysInRange, formatTokens, periodRange } from './spendUi'

const now = new Date('2026-03-15T18:30:00Z')

describe('periodRange', () => {
  test('rolling periods end after today (UTC) and include it', () => {
    expect(periodRange('7d', now)).toEqual({ from: '2026-03-09T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' })
    expect(periodRange('30d', now).from).toBe('2026-02-14T00:00:00.000Z')
  })

  test('calendar months follow UTC month boundaries, across a year', () => {
    expect(periodRange('month', now)).toEqual({ from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' })
    expect(periodRange('last-month', now)).toEqual({
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-03-01T00:00:00.000Z',
    })
    expect(periodRange('last-month', new Date('2026-01-03T00:00:00Z')).from).toBe('2025-12-01T00:00:00.000Z')
  })

  test('a custom range includes its last day, and never ends before it starts', () => {
    expect(periodRange('custom', now, { from: '2026-01-10', to: '2026-01-12' })).toEqual({
      from: '2026-01-10T00:00:00.000Z',
      to: '2026-01-13T00:00:00.000Z',
    })
    expect(periodRange('custom', now, { from: '2026-01-10', to: '2026-01-01' }).to).toBe('2026-01-11T00:00:00.000Z')
  })
})

test('daysInRange lists each UTC day', () => {
  expect(daysInRange('2026-02-27T00:00:00.000Z', '2026-03-02T00:00:00.000Z')).toEqual([
    '2026-02-27',
    '2026-02-28',
    '2026-03-01',
  ])
})

test('formatTokens is compact', () => {
  expect([formatTokens(950), formatTokens(12_300), formatTokens(4_560_000), formatTokens(2e9)]).toEqual([
    '950',
    '12.3k',
    '4.6M',
    '2.0B',
  ])
})
