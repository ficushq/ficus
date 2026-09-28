import { describe, expect, test } from 'bun:test'
import { getModels, getProviders } from '@earendil-works/pi-ai/compat'
import {
  openRouterEndpointForDirectProvider,
  openRouterEndpointForModelId,
  parseOpenRouterDirectSpec,
} from '@ficus/shared/openrouter-tier-expansion'
import { expandOpenRouterFallbacks, inspectOpenRouterFallbacks, openRouterSpecForDirect } from './openrouter-expansion'

describe('OpenRouter tier-chain expansion', () => {
  test('maps provider slugs mechanically, including exceptions, and preserves reasoning effort', () => {
    expect(openRouterSpecForDirect('anthropic:claude-sonnet-5:high')).toBe('openrouter:anthropic/claude-sonnet-5:high')
    expect(openRouterSpecForDirect('openai-codex:gpt-5.6-sol:xhigh')).toBe('openrouter:openai/gpt-5.6-sol:xhigh')
    expect(openRouterSpecForDirect('zai:glm-5.3:low')).toBe('openrouter:z-ai/glm-5.3:low')
  })

  test('supports canonical slash syntax and skips authored OpenRouter candidates', () => {
    expect(openRouterSpecForDirect('anthropic/claude-sonnet-5:high')).toBe('openrouter:anthropic/claude-sonnet-5:high')
    const chain = 'anthropic/claude-sonnet-5:high,openrouter:anthropic/claude-sonnet-5:high'
    expect(inspectOpenRouterFallbacks(chain)).toEqual({ fallbacks: [], invalid: [] })
    expect(expandOpenRouterFallbacks(chain, { enabled: true, routeReady: true })).toBe(chain)
  })

  test('validates explicit endpoint mappings for every mechanically intersecting direct family', () => {
    expect(
      inspectOpenRouterFallbacks('google:gemini-2.5-pro:high,deepseek:deepseek-v4-flash,xiaomi:mimo-v2.5-pro').fallbacks
    ).toEqual([
      'openrouter:google/gemini-2.5-pro:high',
      'openrouter:deepseek/deepseek-v4-flash',
      'openrouter:xiaomi/mimo-v2.5-pro',
    ])
  })

  test('has a verified endpoint for every exact mechanical intersection in the Pi catalogs', () => {
    const openRouterIds = new Set(getModels('openrouter').map((model) => model.id))
    for (const provider of getProviders().filter((provider) => provider !== 'openrouter')) {
      const intersections = getModels(provider)
        .map((model) => parseOpenRouterDirectSpec(openRouterSpecForDirect(`${provider}:${model.id}`)).modelId)
        .filter((modelId) => openRouterIds.has(modelId))
      if (!intersections.length) continue
      expect(openRouterEndpointForDirectProvider(provider)).toBeDefined()
      for (const modelId of intersections) expect(openRouterEndpointForModelId(modelId)).toBeDefined()
    }
  })

  test('returns the authored chain byte-for-byte when expansion is disabled or unavailable', () => {
    const chain = ' anthropic:claude-sonnet-5:high , zai:glm-5.3:low '
    expect(expandOpenRouterFallbacks(chain, { enabled: false, routeReady: true })).toBe(chain)
    expect(expandOpenRouterFallbacks(chain, { enabled: true, routeReady: false })).toBe(chain)
  })

  test('appends shadows after every direct candidate in authored vendor order', () => {
    const chain = 'openai-codex:gpt-5.6-sol:medium,anthropic:claude-sonnet-5:high,zai:glm-5.2:low'
    expect(expandOpenRouterFallbacks(chain, { enabled: true, routeReady: true })).toBe(
      `${chain},openrouter:openai/gpt-5.6-sol:medium,openrouter:anthropic/claude-sonnet-5:high,openrouter:z-ai/glm-5.2:low`
    )
  })

  test('reports and omits catalog-absent entries instead of producing a runtime 404 candidate', () => {
    expect(inspectOpenRouterFallbacks('anthropic:claude-sonnet-5:high,zai:unroutable:low')).toEqual({
      fallbacks: ['openrouter:anthropic/claude-sonnet-5:high'],
      invalid: [{ source: 'zai:unroutable:low', modelId: 'z-ai/unroutable', reason: 'unavailable' }],
    })
    expect(expandOpenRouterFallbacks('zai:unroutable:low', { enabled: true, routeReady: true })).toBe(
      'zai:unroutable:low'
    )
  })

  test('reports malformed entries and continues deriving valid neighbors', () => {
    expect(inspectOpenRouterFallbacks('malformed,anthropic:claude-sonnet-5:high,also-bad')).toEqual({
      fallbacks: ['openrouter:anthropic/claude-sonnet-5:high'],
      invalid: [
        { source: 'malformed', reason: 'malformed' },
        { source: 'also-bad', reason: 'malformed' },
      ],
    })
  })
})
