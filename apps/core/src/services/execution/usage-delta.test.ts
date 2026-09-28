import { describe, test, expect } from 'bun:test'
import type { SessionUsage } from '@ficus/shared'
import { subtractTokens, withUsageDelta, withoutDelta, type UsageBaseline } from './usage-delta'

function usage(total: number, cost: number): SessionUsage {
  return {
    stats: {
      userMessages: 1,
      assistantMessages: 1,
      totalMessages: 2,
      tokens: { input: total / 10, output: total / 10, cacheRead: total * 0.8, cacheWrite: 0, total },
      cost,
    },
    context: null,
  }
}

describe('subtractTokens', () => {
  test('subtracts each field independently', () => {
    expect(
      subtractTokens(
        { input: 100, output: 50, cacheRead: 900, cacheWrite: 10, total: 1060 },
        { input: 40, output: 20, cacheRead: 300, cacheWrite: 4, total: 364 }
      )
    ).toEqual({ input: 60, output: 30, cacheRead: 600, cacheWrite: 6, total: 696 })
  })

  test('treats a missing baseline as zero (first capture of a fresh session)', () => {
    expect(subtractTokens({ input: 5, output: 3, cacheRead: 1, cacheWrite: 0, total: 9 }, undefined)).toEqual({
      input: 5,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      total: 9,
    })
  })

  test('clamps a counter that went backwards to zero rather than emitting a negative', () => {
    expect(
      subtractTokens(
        { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
        { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 }
      )
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
  })
})

describe('withUsageDelta', () => {
  test('keeps stats cumulative and reports only this execution in delta', () => {
    const current = usage(500_000, 4.5)
    const result = withUsageDelta(current, { kind: 'captured', snapshot: usage(200_000, 1.5) })
    expect(result.stats.tokens.total).toBe(500_000)
    expect(result.stats.cost).toBe(4.5)
    expect(result.delta!.tokens.total).toBe(300_000)
    expect(result.delta!.cost).toBeCloseTo(3.0, 6)
  })

  test('a pending baseline emits NO delta — persistence before baseline capture falls back to legacy semantics', () => {
    const result = withUsageDelta(usage(1_000_000, 9), { kind: 'pending' }) // resumed session, not yet baselined
    expect(result.delta).toBeUndefined()
    expect(result.stats.tokens.total).toBe(1_000_000) // cumulative stats stay truthful
  })

  test('a captured zero baseline (fresh session) attributes the whole capture to this execution', () => {
    const result = withUsageDelta(usage(1_000, 0.25), { kind: 'captured', snapshot: usage(0, 0) })
    expect(result.delta!.tokens.total).toBe(1_000)
    expect(result.delta!.cost).toBeCloseTo(0.25, 6)
  })

  test('summing deltas over a session equals the final cumulative total', () => {
    // A fresh session initializes its baseline by capturing the session's zero
    // stats right after it opens (pi reports zeros for a new session).
    const captures = [usage(100, 1), usage(450, 4), usage(900, 9)]
    let baseline: UsageBaseline = { kind: 'captured', snapshot: usage(0, 0) }
    let summed = 0
    for (const capture of captures) {
      summed += withUsageDelta(capture, baseline).delta!.tokens.total
      baseline = { kind: 'captured', snapshot: capture }
    }
    expect(summed).toBe(900)
  })
})

describe('withoutDelta', () => {
  test('strips the per-execution delta, keeping cumulative stats and context', () => {
    const u = withUsageDelta(usage(500, 5), { kind: 'captured', snapshot: usage(200, 2) })
    const stripped = withoutDelta(u)
    expect(stripped.delta).toBeUndefined()
    expect(stripped.stats).toEqual(u.stats)
    expect(stripped.context).toEqual(u.context)
  })

  test('is a no-op on snapshots that never had a delta', () => {
    const u = usage(10, 0.1)
    expect(withoutDelta(u)).toBe(u)
  })
})
