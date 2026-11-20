import { describe, expect, test } from 'bun:test'
import {
  applyDetectedPlan,
  detectClaudeCodePlan,
  detectCodexPlan,
  detectedPlanFor,
  effectiveMonthlyPrice,
  subscriptionFee,
  type AccountSubscription,
} from './subscription-plan'

const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
const codexToken = (plan: string) => jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })

describe('plan detection', () => {
  test('reads the ChatGPT plan from a Codex access token', () => {
    expect(detectCodexPlan(codexToken('pro'))).toBe('pro')
    expect(detectCodexPlan(codexToken('Plus'))).toBe('plus')
    expect(detectCodexPlan(codexToken('team'))).toBe('business')
    // The claim names the Pro tier: prolite is Pro 100, pro is Pro 200, promax is Pro 500.
    expect(detectCodexPlan(codexToken('prolite'))).toBe('prolite')
    expect(detectCodexPlan(codexToken('promax'))).toBe('promax')
    expect(detectCodexPlan(jwt({ sub: 'x' }))).toBeUndefined()
    expect(detectCodexPlan('not-a-jwt')).toBeUndefined()
    expect(detectCodexPlan('a.%%%.c')).toBeUndefined()
    expect(detectCodexPlan(undefined)).toBeUndefined()
  })

  test("Claude Code's max does not say 5x or 20x, so no plan is guessed", () => {
    expect(detectClaudeCodePlan('max')).toEqual({ detectedPlan: 'max' })
    expect(detectClaudeCodePlan('pro')).toEqual({ plan: 'pro', detectedPlan: 'pro' })
    expect(detectClaudeCodePlan('something')).toEqual({ detectedPlan: 'something' })
    expect(detectClaudeCodePlan(undefined)).toBeUndefined()
  })

  test('only Codex OAuth and Claude Code accounts are detected', () => {
    const oauth = { credential: { type: 'oauth', access: codexToken('plus') } }
    expect(detectedPlanFor('openai-codex', oauth)).toEqual({ plan: 'plus', detectedPlan: 'plus' })
    expect(detectedPlanFor('github-copilot', oauth)).toBeUndefined()
    expect(detectedPlanFor('anthropic', { kind: 'claude-code' }, 'team')).toEqual({
      plan: 'team',
      detectedPlan: 'team',
    })
  })

  test('a detected plan never overrides an admin choice, and an unchanged one writes nothing', () => {
    const account: { subscription?: AccountSubscription } = {}
    expect(applyDetectedPlan(account, { plan: 'plus', detectedPlan: 'plus' }, 1)).toBe(true)
    expect(account.subscription).toEqual({ plan: 'plus', planSource: 'detected', detectedPlan: 'plus', detectedAt: 1 })
    expect(applyDetectedPlan(account, { plan: 'plus', detectedPlan: 'plus' }, 2)).toBe(false)

    account.subscription = { plan: 'max-20x', planSource: 'manual', detectedPlan: 'max' }
    expect(applyDetectedPlan(account, { detectedPlan: 'max' }, 3)).toBe(false)
    expect(applyDetectedPlan(account, { plan: 'pro', detectedPlan: 'pro' }, 4)).toBe(true)
    expect(account.subscription).toMatchObject({ plan: 'max-20x', planSource: 'manual', detectedPlan: 'pro' })
  })

  test('a detected Pro tier is priced, and never replaces a Pro tier an admin chose', () => {
    const account: { subscription?: AccountSubscription } = {}
    const signIn = { credential: { type: 'oauth', access: codexToken('prolite') } }
    expect(applyDetectedPlan(account, detectedPlanFor('openai-codex', signIn), 1)).toBe(true)
    expect(account.subscription).toMatchObject({ plan: 'prolite', planSource: 'detected' })
    expect(effectiveMonthlyPrice('openai-codex', account.subscription)).toEqual({ monthlyUsd: 100, source: 'default' })

    account.subscription = { plan: 'promax', planSource: 'manual', detectedPlan: 'pro' }
    const refreshed = { credential: { type: 'oauth', access: codexToken('pro') } }
    expect(applyDetectedPlan(account, detectedPlanFor('openai-codex', refreshed), 2)).toBe(false)
    expect(account.subscription).toMatchObject({ plan: 'promax', planSource: 'manual' })
    expect(effectiveMonthlyPrice('openai-codex', account.subscription)).toEqual({ monthlyUsd: 500, source: 'default' })
  })
})

describe('monthly price', () => {
  test('an override wins, then the plan default, else unknown', () => {
    expect(effectiveMonthlyPrice('anthropic', { plan: 'max-20x', monthlyPriceUsd: 180 })).toEqual({
      monthlyUsd: 180,
      source: 'custom',
    })
    expect(effectiveMonthlyPrice('anthropic', { plan: 'max-20x' })).toEqual({ monthlyUsd: 200, source: 'default' })
    expect(effectiveMonthlyPrice('openai-codex', { plan: 'enterprise' })).toEqual({ monthlyUsd: null, source: null })
    expect(effectiveMonthlyPrice('openai-codex', { plan: 'prolite' })).toEqual({ monthlyUsd: 100, source: 'default' })
    // An account stored as pro before the tiers existed keeps the $200 price with no migration.
    expect(effectiveMonthlyPrice('openai-codex', { plan: 'pro' })).toEqual({ monthlyUsd: 200, source: 'default' })
    expect(effectiveMonthlyPrice('openai-codex', { plan: 'promax' })).toEqual({ monthlyUsd: 500, source: 'default' })
    expect(effectiveMonthlyPrice('anthropic', { detectedPlan: 'max' })).toEqual({ monthlyUsd: null, source: null })
    expect(effectiveMonthlyPrice('anthropic', undefined)).toEqual({ monthlyUsd: null, source: null })
  })
})

describe('subscriptionFee', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`)

  test('a whole calendar month counts the full fee', () => {
    expect(subscriptionFee({ monthlyUsd: 200, from: day('2026-09-01'), to: day('2026-10-01') })).toBe(200)
    expect(subscriptionFee({ monthlyUsd: 200, from: day('2026-02-01'), to: day('2026-03-01') })).toBe(200)
  })

  test('other ranges are prorated by day within each month', () => {
    // 15 of September's 30 days.
    expect(subscriptionFee({ monthlyUsd: 200, from: day('2026-09-01'), to: day('2026-09-16') })).toBe(100)
    // Sep 16–30 (15/30) + Oct 1–15 (15/31).
    expect(subscriptionFee({ monthlyUsd: 31, from: day('2026-09-16'), to: day('2026-10-16') })).toBe(
      Math.round(((31 * 15) / 30) * 100 + 15 * 100) / 100
    )
  })

  test('a partial day counts as a whole day', () => {
    const noon = new Date('2026-09-10T12:00:00Z')
    expect(subscriptionFee({ monthlyUsd: 30, from: day('2026-09-01'), to: noon })).toBe(10)
  })

  test('clips to when the account was active, and an unknown price counts nothing', () => {
    expect(
      subscriptionFee({
        monthlyUsd: 300,
        from: day('2026-09-01'),
        to: day('2026-10-01'),
        activeFrom: day('2026-09-21'),
      })
    ).toBe(100)
    expect(subscriptionFee({ monthlyUsd: null, from: day('2026-09-01'), to: day('2026-10-01') })).toBe(0)
    expect(
      subscriptionFee({ monthlyUsd: 20, from: day('2026-09-01'), to: day('2026-10-01'), activeFrom: day('2026-11-01') })
    ).toBe(0)
  })
})
