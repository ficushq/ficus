import { describe, expect, test } from 'bun:test'
import type { ProviderHealthRecord, ProviderRoute } from '@ficus/shared/provider-health'
import { aggregateRouteDecision, routeSwitchBackEligible } from './routing'

const route = (accountId?: string, credentialUsable = true): ProviderRoute => ({
  provider: 'anthropic',
  ...(accountId ? { accountId } : {}),
  credentialUsable,
})
const cooling = (accountId: string | undefined, retryAt: number): ProviderHealthRecord => ({
  provider: 'anthropic',
  ...(accountId ? { accountId } : {}),
  kind: 'rate-limit',
  message: 'Provider rate limit reached.',
  since: 1_000,
  retryAt,
})

describe('provider route aggregation', () => {
  test('is ready when one usable sibling account is ready', () => {
    expect(aggregateRouteDecision([route('a1'), route('a2')], [cooling('a1', 61_000)], 1_000)).toEqual({
      state: 'ready',
    })
  })

  test('uses the earliest retry when every usable account is cooling', () => {
    expect(
      aggregateRouteDecision([route('a1'), route('a2')], [cooling('a1', 61_000), cooling('a2', 31_000)], 1_000)
    ).toEqual({ state: 'cooldown', retryAt: 31_000 })
  })

  test('applies provider health to an env-only route', () => {
    expect(aggregateRouteDecision([route()], [cooling(undefined, 61_000)], 1_000)).toEqual({
      state: 'cooldown',
      retryAt: 61_000,
    })
  })

  test('excludes disabled or unusable credentials and reports no configured route', () => {
    expect(aggregateRouteDecision([route('a1', false)], [], 1_000)).toBeNull()
    expect(aggregateRouteDecision([], [], 1_000)).toBeNull()
  })

  test('does not apply a stability lockout to observational credential failures', () => {
    const record = { ...cooling('a1', 61_000), kind: 'expired-oauth' as const, retryAt: undefined }
    expect(routeSwitchBackEligible([route('a1')], [record], 30_000, 1_000)).toBe(true)
  })

  test('requires the cooldown plus stability window before time-based switch-back', () => {
    const records = [cooling('a1', 61_000)]
    expect(routeSwitchBackEligible([route('a1')], records, 30_000, 90_999)).toBe(false)
    expect(routeSwitchBackEligible([route('a1')], records, 30_000, 91_000)).toBe(true)
  })
})
