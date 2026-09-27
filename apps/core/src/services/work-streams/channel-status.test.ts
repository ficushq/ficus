import { describe, expect, test } from 'bun:test'
import { formatChannelWorkStreamStatus } from './channel-status'

const stream = (id: string, title: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title,
  status: 'active' as const,
  derivedState: 'idle' as const,
  createdAt: new Date(`2026-01-${id.padStart(2, '0')}T00:00:00Z`),
  ...overrides,
})

describe('formatChannelWorkStreamStatus', () => {
  test('uses canonical review, wait, progress, idle, and queue boundaries before capping', () => {
    const result = formatChannelWorkStreamStatus(
      [
        stream('06', 'Unpositioned queue', { status: 'queued' }),
        stream('04', 'Idle'),
        stream('03', 'Progress', { derivedState: 'in_progress' }),
        stream('05', 'Positioned queue', { status: 'queued', queuePosition: 1 }),
        stream('02', 'Wait', { derivedState: 'blocked' }),
        stream('01', 'Review', { derivedState: 'in_review' }),
      ],
      'slack'
    )
    expect([...result.matchAll(/\*\*(.*?)\*\*/g)].slice(1).map((match) => match[1])).toEqual([
      'Review',
      'Wait',
      'Progress',
      'Idle',
      'Positioned queue',
      'Unpositioned queue',
    ])
  })

  test('caps the display at ten and reports every omitted row with an action', () => {
    const result = formatChannelWorkStreamStatus(
      Array.from({ length: 12 }, (_, i) => stream(`${i + 1}`, `Work ${i}`)),
      'slack'
    )
    expect(result.match(/\*\*Work /g)?.length).toBe(10)
    expect(result).toContain('2 more not shown')
    expect(result).toContain('ficus workstream list')
  })

  test.each(['slack', 'discord'] as const)('%s preserves truthful omission within its provider budget', (provider) => {
    const result = formatChannelWorkStreamStatus(
      Array.from({ length: 12 }, (_, i) => stream(`${i + 1}`, `${i}-${'x'.repeat(900)}`)),
      provider
    )
    expect(result.length).toBeLessThanOrEqual(provider === 'discord' ? 2000 : 3000)
    const shown = result.match(/^💤 /gm)?.length ?? 0
    expect(result).toContain(`${12 - shown} more not shown`)
    expect(result).toContain('ficus workstream list')
  })
})
