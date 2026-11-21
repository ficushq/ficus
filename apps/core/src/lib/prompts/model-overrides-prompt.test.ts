import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { MONOREPO_ROOT } from '../paths'
import { resolveAgentModelSpec, validateModelSpecList } from '../utils/model-spec'
import { buildModelOverridePrompt, MODEL_OVERRIDE_PROMPT_PROVIDERS } from './model-overrides-prompt'

const MODEL_TIERS_DIR = join(MONOREPO_ROOT, 'config/model-tiers')

function shippedTierChainEntries(): Array<{ tier: string; provider: string; model: string }> {
  return readdirSync(MODEL_TIERS_DIR)
    .filter((file) => file.endsWith('.yaml'))
    .flatMap((file) => {
      const { slug, chain } = yaml.load(readFileSync(join(MODEL_TIERS_DIR, file), 'utf8')) as {
        slug: string
        chain: string
      }
      return chain.split(',').map((entry) => {
        const [provider, model] = entry.trim().split(':')
        return { tier: slug, provider: provider!, model: model! }
      })
    })
}

describe('buildModelOverridePrompt', () => {
  test('only advertises models that exist in the bundled SDK catalog', () => {
    for (const { provider, models } of MODEL_OVERRIDE_PROMPT_PROVIDERS) {
      for (const model of models) {
        expect(() => resolveAgentModelSpec(`${provider}:${model}`, undefined)).not.toThrow()
      }
    }
  })

  test('advertises every model a shipped tier uses for the listed providers', () => {
    const advertised = new Map<string, readonly string[]>(
      MODEL_OVERRIDE_PROMPT_PROVIDERS.map(({ provider, models }) => [provider, models])
    )
    const entries = shippedTierChainEntries()
    expect(entries.length).toBeGreaterThan(0)
    const missing = entries
      .filter(({ provider, model }) => advertised.has(provider) && !advertised.get(provider)!.includes(model))
      .map(({ tier, provider, model }) => `${tier}: ${provider}:${model}`)
    expect(missing).toEqual([])
  })

  test('uses a priority-list example that resolves against the bundled SDK catalog', () => {
    const example = buildModelOverridePrompt().match(/priority list of candidates, e\.g\. `([^`]+)`/)?.[1]
    expect(example).toBeTruthy()
    expect(example!.split(',')).toHaveLength(3)
    expect(() => validateModelSpecList(example!)).not.toThrow()
  })
})
