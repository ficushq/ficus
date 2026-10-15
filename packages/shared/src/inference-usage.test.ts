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
    expect(planLabel('openai-codex', 'pro')).toBe('ChatGPT Pro')
    expect(planLabel('xai', 'whatever')).toBe('whatever')
    expect(subscriptionPlansFor('xai')).toBeUndefined()
  })

  test('every spend dimension has a filter', () => {
    for (const dimension of SPEND_DIMENSIONS) expect(SPEND_DIMENSION_FILTER[dimension]).toBeTruthy()
  })
})
