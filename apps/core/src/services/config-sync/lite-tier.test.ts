import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { getModels } from '@earendil-works/pi-ai/compat'
import { MONOREPO_ROOT } from '../../lib/paths'

interface TierYaml {
  slug: string
  label: string
  description?: string
  chain: string
  sortOrder: number
}

const readTier = (slug: string) =>
  yaml.load(readFileSync(join(MONOREPO_ROOT, 'config/model-tiers', `${slug}.yaml`), 'utf8')) as TierYaml

const lite = readTier('lite')
const entries = lite.chain.split(',').map((entry) => {
  const [provider, modelId, thinkingLevel] = entry.trim().split(':')
  return { provider, modelId, thinkingLevel }
})
const catalogModel = (provider: string, modelId: string) =>
  (getModels(provider as never) as Array<{ id: string; cost: { input: number; output: number } }>).find(
    (model) => model.id === modelId
  )

describe('the shipped Lite tier', () => {
  test('is the cheapest tier, listed before Fast', () => {
    expect(lite.slug).toBe('lite')
    expect(lite.label).toBe('Lite')
    expect(lite.description).toBeTruthy()
    expect(lite.sortOrder).toBeLessThan(readTier('fast').sortOrder)
  })

  test('tries Haiku, then GPT-6 Luna, then a zai model, all without thinking', () => {
    expect(entries.map(({ provider, modelId }) => `${provider}:${modelId}`).slice(0, 2)).toEqual([
      'anthropic:claude-haiku-4-5',
      'openai-codex:gpt-6-luna',
    ])
    expect(entries[2].provider).toBe('zai')
    for (const entry of entries) expect(entry.thinkingLevel).toBe('off')
  })

  test('every model exists in the catalog', () => {
    for (const { provider, modelId } of entries) expect(catalogModel(provider, modelId)).toBeDefined()
  })

  test('its zai model is the cheapest priced zai model in the catalog', () => {
    const priced = (getModels('zai' as never) as Array<{ id: string; cost: { input: number; output: number } }>)
      .filter((model) => model.cost.input > 0 && model.cost.output > 0)
      .sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))
    expect(entries[2].modelId).toBe(priced[0].id)
  })

  test('no shipped agent type uses it, so no agent’s model changes', () => {
    const dir = join(MONOREPO_ROOT, 'config/agent-types')
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
      const type = yaml.load(readFileSync(join(dir, file), 'utf8')) as { tier?: string }
      expect(`${file}: ${type?.tier}`).not.toBe(`${file}: lite`)
    }
  })
})
