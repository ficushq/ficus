import { describe, expect, test } from 'bun:test'
import {
  featureLabel,
  INFERENCE_FEATURES,
  planLabel,
  SPEND_DIMENSION_FILTER,
  SPEND_DIMENSIONS,
  SUBSCRIPTION_PLANS,
  subscriptionPlansFor,
} from './inference-usage'

describe('inference usage registry', () => {
  test('labels known features and purpose-qualified ones', () => {
    expect(featureLabel('agent-turn')).toBe('Agent turns')
    expect(featureLabel('embedding:search')).toBe('Memory search')
    expect(featureLabel('decision:tool-results')).toBe('Tool result firewall')
    expect(featureLabel('decision:not-a-purpose')).toBe('not-a-purpose')
    expect(featureLabel('lite:reply-suggestions')).toBe('Reply suggestions · Lite tier')
    expect(featureLabel('something-new')).toBe('something-new')
  })

  test('every feature id is unique and kebab-case', () => {
    const ids = INFERENCE_FEATURES.map((feature) => feature.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z-]*(:[a-z-]+)?$/)
  })

  test('plan table has a label for every plan and labels unknown plans by id', () => {
    for (const plans of Object.values(SUBSCRIPTION_PLANS)) {
      for (const plan of Object.values(plans)) expect(plan.label.length).toBeGreaterThan(0)
    }
    expect(planLabel('anthropic', 'max-20x')).toBe('Claude Max 20x')
    expect(planLabel('claude-code', 'max-5x')).toBe('Claude Max 5x')
    expect(planLabel('openai-codex', 'pro')).toBe('ChatGPT Pro 200')
    expect(planLabel('xai', 'whatever')).toBe('whatever')
    expect(subscriptionPlansFor('xai')).toBeUndefined()
  })

  test('ChatGPT Pro has three tiers, keyed by the Codex plan claim, and a stored pro stays the $200 tier', () => {
    const plans = subscriptionPlansFor('openai-codex')!
    const pro = Object.entries(plans).filter(([, plan]) => plan.label.startsWith('ChatGPT Pro'))
    expect(pro).toEqual([
      ['prolite', { label: 'ChatGPT Pro 100', monthlyUsd: 100 }],
      ['pro', { label: 'ChatGPT Pro 200', monthlyUsd: 200 }],
      ['promax', { label: 'ChatGPT Pro 500', monthlyUsd: 500 }],
    ])
    // Picker order is the table's order: individual plans cheapest first, then the Business seats.
    expect(Object.keys(plans)).toEqual([
      'free',
      'go',
      'plus',
      'prolite',
      'pro',
      'promax',
      'business',
      'self_serve_business_prolite',
      'enterprise',
      'edu',
    ])
  })

  test('ChatGPT Go and both Business seats are priced, keyed by the Codex plan claim', () => {
    const plans = subscriptionPlansFor('openai-codex')!
    expect(plans.go).toEqual({ label: 'ChatGPT Go', monthlyUsd: 8 })
    // A Standard Business seat signs in as `team`, which detection maps to `business`.
    expect(plans.business).toEqual({ label: 'ChatGPT Business', monthlyUsd: 25 })
    expect(plans.self_serve_business_prolite).toEqual({ label: 'ChatGPT Business Premium', monthlyUsd: 125 })
    expect(planLabel('openai-codex', 'self_serve_business_prolite')).toBe('ChatGPT Business Premium')
    // A claim value the table does not know is shown by its id, never as a free plan.
    expect(planLabel('openai-codex', 'self_serve_business_usage_based')).toBe('self_serve_business_usage_based')
    expect(plans.self_serve_business_usage_based).toBeUndefined()
  })

  test('every spend dimension has a filter', () => {
    for (const dimension of SPEND_DIMENSIONS) expect(SPEND_DIMENSION_FILTER[dimension]).toBeTruthy()
  })
})
