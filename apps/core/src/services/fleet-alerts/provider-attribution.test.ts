import { describe, expect, test } from 'bun:test'
import type { ProviderHealthRecord, ProviderRoute } from '@ficus/shared/provider-health'
import { blockedDemandProvider, getDemandProviderChains } from './provider-attribution'

import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, modelTiers, squads, workflowBindings, workStreams } from '../../db/schema'
import { selectModelSpec } from '../model-selection/select-model'
import { providerRouteDecision } from '../provider-health/routing'
import type { AccountStoreV1 } from '../agent/account-store'

const NOW = 1000
const failure: ProviderHealthRecord = {
  provider: 'anthropic',
  accountId: 'a',
  kind: 'rate-limit',
  since: 1,
  retryAt: 2000,
  message: 'private payload',
}
const route: ProviderRoute = { provider: 'anthropic', accountId: 'a', credentialUsable: true }

describe('demand provider causality', () => {
  test('requires all known demand routes to share an active routing blockage', () => {
    expect(blockedDemandProvider([[route], [route]], [failure], NOW)).toBe(failure)
    for (const chains of [
      [],
      [[]],
      [[{ ...route, credentialUsable: false }]],
      [[route], []],
      [[route], [{ provider: 'openai', credentialUsable: true }]],
    ]) {
      expect(blockedDemandProvider(chains, [failure], NOW)).toBeUndefined()
    }
  })
  test('uses account specificity and recovery exactly as routeDecision does', () => {
    const wide = { ...failure, accountId: undefined }
    expect(blockedDemandProvider([[route]], [wide], NOW)).toBe(wide)
    expect(blockedDemandProvider([[{ ...route, accountId: 'b' }]], [failure], NOW)).toBeUndefined()
    expect(blockedDemandProvider([[route]], [wide, { ...failure, lastSuccessAt: 2 }], NOW)).toBeUndefined()
    expect(blockedDemandProvider([[route]], [wide, { ...failure, retryAt: NOW }], NOW)).toBeUndefined()
  })
  test('historical unresolved health and auth errors are not routing cooldowns', () => {
    for (const record of [
      { ...failure, retryAt: NOW },
      { ...failure, retryAt: undefined },
      { ...failure, kind: 'expired-oauth' as const },
      { ...failure, kind: 'invalid-credential' as const },
    ]) {
      expect(blockedDemandProvider([[route]], [record], NOW)).toBeUndefined()
      expect(record.lastSuccessAt).toBeUndefined()
    }
  })
  test('does not collapse different blocked providers or accounts into one categorical cause', () => {
    const other = { ...failure, accountId: 'b' }
    expect(blockedDemandProvider([[route, { ...route, accountId: 'b' }]], [failure, other], NOW)).toBeUndefined()
    expect(
      blockedDemandProvider(
        [[route, { provider: 'openai', credentialUsable: true }]],
        [failure, { ...failure, provider: 'openai', accountId: undefined }],
        NOW
      )
    ).toBeUndefined()
  })
})

// Keep configuration injected: these tests never read real provider credentials.
const store: AccountStoreV1 = {
  version: 1,
  accounts: {
    anthropic: [{ id: 'a', enabled: true, credential: { type: 'api_key', key: 'test-only' } }],
    openai: [{ id: 'b', enabled: true, credential: { type: 'api_key', key: 'test-only' } }],
  },
}

test('demand routing uses agent overrides, live tiers, and immutable workflow type snapshots', async () => {
  const squadId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const typeId = `attribution-${crypto.randomUUID()}`
  const tier = `tier-${crypto.randomUUID()}`
  const streamId = crypto.randomUUID()
  const anthropic = 'anthropic:claude-sonnet-4-5'
  const openai = 'openai:gpt-5'
  const snapshot = { count: 1, firstDemandAt: new Date(1), agentIds: [agentId] }
  const adapter = {
    accountStore: store,
    hasConfiguredAuth: () => false,
    selectModel: (spec: string) =>
      selectModelSpec(spec, {
        isProviderConfigured: () => true,
        isProviderDisabled: () => false,
        isProviderHealthy: (provider) =>
          providerRouteDecision(provider, store, [failure], false, NOW)?.state === 'ready',
      }),
  }
  await db.insert(squads).values({ id: squadId, name: typeId, purpose: 'attribution test' })
  try {
    await db.insert(modelTiers).values({ slug: tier, label: tier, chain: anthropic })
    const [type] = await db
      .insert(agentTypes)
      .values({ id: typeId, name: typeId, model: '', tier, systemPrompt: 'test' })
      .returning()
    await db.insert(agents).values({ id: agentId, squadId, agentTypeId: typeId, status: 'idle' })
    expect(await getDemandProviderChains(snapshot, adapter)).toEqual([[route]])
    await db.update(agents).set({ modelOverride: openai }).where(eq(agents.id, agentId))
    expect(await getDemandProviderChains(snapshot, adapter)).toEqual([])
    await db.update(agents).set({ modelOverride: null }).where(eq(agents.id, agentId))
    await db
      .update(modelTiers)
      .set({ chain: `${anthropic},${openai}` })
      .where(eq(modelTiers.slug, tier))
    expect(await getDemandProviderChains(snapshot, adapter)).toEqual([])
    await db.insert(workStreams).values({ id: streamId, squadId, title: 'snapshot route' })
    await db.insert(workflowBindings).values({
      agentId,
      workStreamId: streamId,
      participantId: 'engineer',
      bindingKey: 'engineer',
      agentSnapshot: { ...type!, model: anthropic, tier: null },
    })
    // The mutable type has a healthy fallback, but this flow's frozen snapshot does not.
    expect(await getDemandProviderChains(snapshot, adapter)).toEqual([[route]])
    await db
      .update(agents)
      .set({ modelOverride: `${anthropic},${openai}` })
      .where(eq(agents.id, agentId))
    expect(await getDemandProviderChains(snapshot, adapter)).toEqual([])
    await db.update(agents).set({ modelOverride: 'anthropic:missing-model' }).where(eq(agents.id, agentId))
    expect(await getDemandProviderChains(snapshot, adapter)).toEqual([])
  } finally {
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    await db.delete(modelTiers).where(eq(modelTiers.slug, tier))
  }
})
