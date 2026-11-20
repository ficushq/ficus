import { describe, expect, test } from 'bun:test'
import type { ProviderAccountEntry, ProviderAuthEntry } from '../../api/providerAuth'
import {
  assignCompatibleProvider,
  disabledProviderIds,
  modelChainWarnings,
  NO_USABLE_PROVIDER_WARNING,
  withTierPosition,
} from './modelTierUi'
describe('inline tier assignment', () => {
  test('uses the same chain representation as tier editing for Primary', () =>
    expect(withTierPosition('openai:gpt:high,zai:glm:high', 'openai-compatible:qwen', 'primary')).toBe(
      'openai-compatible:qwen,openai:gpt:high,zai:glm:high'
    ))
  test('uses explicit last fallback position without duplicating entries', () =>
    expect(withTierPosition('openai-compatible:qwen,openai:gpt:high', 'openai-compatible:qwen', 'fallback')).toBe(
      'openai:gpt:high,openai-compatible:qwen'
    ))
})
test('inline assignment writes previewed chains through the tier write path', async () => {
  const writes: string[] = []
  const { assignCompatibleProvider } = await import('./modelTierUi')
  await assignCompatibleProvider({
    tiers: [{ slug: 'fast', chain: 'openai:gpt:low' }],
    spec: 'local:qwen',
    position: 'primary',
    add: async () => {},
    update: async (tier) => {
      writes.push(tier.chain)
    },
    rollbackProvider: async () => {},
  })
  expect(writes).toEqual(['local:qwen,openai:gpt:low'])
})

describe('inline assignment compensation', () => {
  const tiers = [
    { slug: 'fast', chain: 'old-fast' },
    { slug: 'deep', chain: 'old-deep' },
  ]
  test('restores tiers and removes provider after update failure', async () => {
    const writes: string[] = []
    let deleted = false
    await expect(
      assignCompatibleProvider({
        tiers,
        spec: 'local:qwen',
        position: 'primary',
        add: async () => {},
        update: async (tier) => {
          writes.push(`${tier.slug}:${tier.chain}`)
          if (tier.slug === 'deep' && tier.chain !== 'old-deep') throw new Error('write failed')
        },
        rollbackProvider: async () => {
          deleted = true
        },
      })
    ).rejects.toThrow('fully rolled back')
    expect(writes).toContain('fast:old-fast')
    expect(writes).toContain('deep:old-deep')
    expect(deleted).toBe(true)
  })
  test('retains provider when tier restore fails', async () => {
    let deleted = false
    await expect(
      assignCompatibleProvider({
        tiers,
        spec: 'local:qwen',
        position: 'primary',
        add: async () => {},
        update: async (tier) => {
          if (tier.slug === 'deep' && tier.chain !== 'old-deep') throw new Error('write failed')
          if (tier.slug === 'fast' && tier.chain === 'old-fast') throw new Error('restore failed')
        },
        rollbackProvider: async () => {
          deleted = true
        },
      })
    ).rejects.toThrow('tiers fast could not be restored; provider retained')
    expect(deleted).toBe(false)
  })
  test('reports provider removal failure precisely', async () => {
    await expect(
      assignCompatibleProvider({
        tiers,
        spec: 'local:qwen',
        position: 'primary',
        add: async () => {},
        update: async (tier) => {
          if (tier.slug === 'deep' && tier.chain !== 'old-deep') throw new Error('write failed')
        },
        rollbackProvider: async () => {
          throw new Error('delete failed')
        },
      })
    ).rejects.toThrow('provider removal failed; provider retained')
  })
})

describe('modelChainWarnings', () => {
  const provider = (name: string, patch: Partial<ProviderAuthEntry> = {}): ProviderAuthEntry => ({
    provider: name,
    type: 'api_key',
    hasCredential: true,
    configured: true,
    disabled: false,
    health: 'available',
    ...patch,
  })

  test('a disabled provider is not reported as unhealthy while the chain has a usable entry', () =>
    expect(
      modelChainWarnings('zai:glm-5.3:high,openai:gpt-5:high', [
        provider('zai', { disabled: true }),
        provider('openai'),
      ])
    ).toEqual([]))

  test('a disabled provider that is also exhausted still produces no entry warning', () =>
    expect(
      modelChainWarnings('zai:glm-5.3,openai:gpt-5', [
        provider('zai', { disabled: true, health: 'exhausted' }),
        provider('openai'),
      ])
    ).toEqual([]))

  test('an exhausted enabled provider is reported as unhealthy', () =>
    expect(
      modelChainWarnings('zai:glm-5.3,openai:gpt-5', [provider('zai', { health: 'exhausted' }), provider('openai')])
    ).toEqual(['zai:glm-5.3 provider is unhealthy']))

  test('an unauthenticated provider adds no entry warning while another entry is usable', () =>
    expect(
      modelChainWarnings('zai:glm-5.3,openai:gpt-5', [provider('zai', { configured: false }), provider('openai')])
    ).toEqual([]))

  test('an all-disabled chain gets one chain-level warning', () =>
    expect(modelChainWarnings('zai:glm-5.3:high,zai:glm-4.6:low', [provider('zai', { disabled: true })])).toEqual([
      NO_USABLE_PROVIDER_WARNING,
    ]))

  test('a chain of disabled, unauthenticated and exhausted entries gets the chain-level warning', () =>
    expect(
      modelChainWarnings('zai:glm-5.3,anthropic:claude,openai:gpt-5', [
        provider('zai', { disabled: true }),
        provider('anthropic', { configured: false }),
        provider('openai', { health: 'exhausted' }),
      ])
    ).toEqual(['openai:gpt-5 provider is unhealthy', NO_USABLE_PROVIDER_WARNING]))

  test('providers missing from the list are not assumed broken (for example while loading)', () =>
    expect(modelChainWarnings('zai:glm-5.3,openai:gpt-5', [])).toEqual([]))

  test('the tool capability warning skips disabled providers', () => {
    const noTools = (name: string, disabled: boolean) =>
      provider(name, {
        disabled,
        accounts: [
          {
            id: 'a',
            enabled: true,
            type: 'api_key',
            model: 'qwen',
            capabilities: { tools: false } as ProviderAccountEntry['capabilities'],
          },
        ],
      })
    expect(modelChainWarnings('local:qwen,openai:gpt-5', [noTools('local', true), provider('openai')])).toEqual([])
    expect(modelChainWarnings('local:qwen,openai:gpt-5', [noTools('local', false), provider('openai')])).toEqual([
      'local:qwen lacks tool capability',
    ])
  })
})

test('disabledProviderIds lists only providers turned off', () =>
  expect(
    disabledProviderIds([
      { provider: 'zai', type: 'api_key', hasCredential: true, configured: true, disabled: true },
      { provider: 'openai', type: 'api_key', hasCredential: true, configured: true, disabled: false },
    ])
  ).toEqual(['zai']))
