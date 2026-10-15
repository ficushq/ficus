import { describe, expect, test } from 'bun:test'
import { priceUsage, type ModelLookup, type PricedModel } from './pricing'

const sonnet = {
  id: 'claude-sonnet-4-5',
  provider: 'anthropic',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as unknown as PricedModel
const unpriced = { id: 'local', provider: 'x', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as PricedModel
const lookupModel: ModelLookup = (provider, model) =>
  provider === 'anthropic' && model === 'claude-sonnet-4-5' ? sonnet : model === 'local' ? unpriced : undefined
const deps = { lookupModel }
const sonnetCall = { feature: 'agent-turn', provider: 'anthropic', model: 'claude-sonnet-4-5' } as const

describe('priceUsage', () => {
  test('api billing bills the list price', () => {
    expect(priceUsage({ ...sonnetCall, billing: 'api', tokens: { input: 1_000_000 } }, deps)).toEqual({
      costNanodollars: 3_000_000_000,
      listCostNanodollars: 3_000_000_000,
      costEstimated: false,
    })
  })

  test('counts output and cache tokens at their own rates', () => {
    const priced = priceUsage(
      { ...sonnetCall, billing: 'api', tokens: { output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 } },
      deps
    )
    expect(priced.listCostNanodollars).toBe(15_000_000_000 + 300_000_000 + 3_750_000_000)
  })

  test('subscription bills 0 and keeps the list price', () => {
    expect(priceUsage({ ...sonnetCall, billing: 'subscription', tokens: { input: 1_000_000 } }, deps)).toEqual({
      costNanodollars: 0,
      listCostNanodollars: 3_000_000_000,
      costEstimated: false,
    })
  })

  test('the Claude Code bridge is priced as Anthropic', () => {
    const priced = priceUsage(
      { ...sonnetCall, provider: 'claude-code', billing: 'subscription', tokens: { input: 1_000_000 } },
      deps
    )
    expect(priced.listCostNanodollars).toBe(3_000_000_000)
  })

  test('self-hosted bills 0 with no list price', () => {
    expect(priceUsage({ ...sonnetCall, billing: 'self-hosted', tokens: { input: 10 } }, deps)).toEqual({
      costNanodollars: 0,
      listCostNanodollars: null,
      costEstimated: false,
    })
  })

  test('an unknown or unpriced model is estimated at 0', () => {
    const unknown = { feature: 'agent-turn', provider: 'x', model: 'y', billing: 'api', tokens: { input: 10 } } as const
    expect(priceUsage(unknown, deps)).toEqual({ costNanodollars: 0, listCostNanodollars: null, costEstimated: true })
    expect(priceUsage({ ...unknown, model: 'local' }, deps).listCostNanodollars).toBeNull()
  })

  test('unknown billing bills the list price as an estimate', () => {
    expect(priceUsage({ ...sonnetCall, billing: 'unknown', tokens: { input: 1_000_000 } }, deps)).toEqual({
      costNanodollars: 3_000_000_000,
      listCostNanodollars: 3_000_000_000,
      costEstimated: true,
    })
  })

  test('caller-supplied list cost wins and rounds to nanodollars', () => {
    const priced = priceUsage({ ...sonnetCall, billing: 'api', tokens: { input: 1 }, listCostUsd: 0.0123456789 }, deps)
    expect(priced.listCostNanodollars).toBe(12_345_679)
    expect(priced.costNanodollars).toBe(12_345_679)
  })

  test('an explicit null list cost means no known price, without a lookup', () => {
    const priced = priceUsage({ ...sonnetCall, billing: 'api', tokens: { input: 1_000_000 }, listCostUsd: null }, deps)
    expect(priced).toEqual({ costNanodollars: 0, listCostNanodollars: null, costEstimated: true })
  })

  test('estimated tokens mark the cost estimated', () => {
    const priced = priceUsage({ ...sonnetCall, billing: 'api', tokens: { input: 10 }, tokensEstimated: true }, deps)
    expect(priced.costEstimated).toBe(true)
  })

  test('service prices: whisper minutes, embedding tokens, tts characters', () => {
    const none = () => undefined
    expect(
      priceUsage(
        {
          feature: 'transcription',
          provider: 'openai',
          model: 'whisper-1',
          billing: 'api',
          units: { audioSeconds: 120 },
        },
        { lookupModel: none }
      ).costNanodollars
    ).toBe(12_000_000)
    expect(
      priceUsage(
        {
          feature: 'embedding:index',
          provider: 'openai',
          model: 'text-embedding-3-small',
          billing: 'api',
          tokens: { input: 1_000_000 },
        },
        { lookupModel: none }
      ).costNanodollars
    ).toBe(20_000_000)
    expect(
      priceUsage(
        {
          feature: 'tts',
          provider: 'google',
          model: 'en-US-Chirp3-HD-Aoede',
          billing: 'api',
          units: { characters: 1_000_000 },
        },
        { lookupModel: none }
      ).costNanodollars
    ).toBe(30_000_000_000)
  })
})
