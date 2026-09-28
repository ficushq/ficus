import { describe, expect, test } from 'bun:test'
import { computeWorkStreamElapsedMs } from './workStreamRuntime'
import type { WorkStream } from '@ficus/shared'

const baseWs = {
  id: 'ws-1',
  squadId: 's',
  title: 't',
  description: '',
  status: 'active',
  derivedState: 'in_progress',
  assigneeAgentId: null,
  ownerAgentId: null,
  agentIds: ['a'],
  dependsOn: [],
  handoffMessage: null,
  files: [],
  response: null,
  metadata: {},
  completionMode: 'pr-merge',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as WorkStream

describe('computeWorkStreamElapsedMs', () => {
  test('returns 0 when there is no runtime field', () => {
    expect(computeWorkStreamElapsedMs(baseWs, Date.now())).toBe(0)
  })

  test('returns settled totalMs when activeCount is zero', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 12_345, activeCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T00:01:00Z'))).toBe(12_345)
  })

  test('adds activeCount * (now - computedAt) when there are active executions', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, computedAt: '2026-01-01T00:00:00Z' },
    }
    const now = Date.parse('2026-01-01T00:00:05Z')
    expect(computeWorkStreamElapsedMs(ws, now)).toBe(1000 + 2 * 5_000)
  })

  test('clamps negative deltas (clock skew) to zero', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 7_000, activeCount: 1, computedAt: '2026-01-01T00:01:00Z' },
    }
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(computeWorkStreamElapsedMs(ws, now)).toBe(7_000)
  })
})
