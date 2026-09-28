import { expect, test } from 'bun:test'
import type { AgentTypeIntegrationPolicyV1 } from '@ficus/shared'
import { IntegrationRuntimeGate } from '../../services/integrations/runtime-gate'
import { allowsBigbrainIntegrationTools, deploymentOAuthAuthorityForProvider } from './base'

const policy = {
  version: 1,
  allow: { bigbrain: ['agent_tools'] },
} satisfies AgentTypeIntegrationPolicyV1

test('integration tools require both type capability and explicit tool allow', () => {
  expect(allowsBigbrainIntegrationTools(['bigbrain_search'], policy)).toBe(true)
  expect(allowsBigbrainIntegrationTools([], policy)).toBe(false)
  expect(allowsBigbrainIntegrationTools(['bigbrain_search'], null)).toBe(false)
  expect(allowsBigbrainIntegrationTools(['bigbrain_search'], { version: 1, allow: { bigbrain: [] } })).toBe(false)
  expect(allowsBigbrainIntegrationTools(['other_tool'], policy)).toBe(false)
})

test('managed registry wiring applies deployment authority only to OAuth providers', () => {
  const previousManaged = process.env.FICUS_MANAGED
  process.env.FICUS_MANAGED = '1'
  try {
    expect(deploymentOAuthAuthorityForProvider('bigbrain')).toBeUndefined()
    expect(deploymentOAuthAuthorityForProvider('notion')).toBe('platform_broker')
  } finally {
    if (previousManaged === undefined) delete process.env.FICUS_MANAGED
    else process.env.FICUS_MANAGED = previousManaged
  }
})

test('Bigbrain plugin retains the exact four integration tool names', async () => {
  const { bigbrainPlugin } = await import('../../services/integrations/bigbrain/plugin')
  const factory = bigbrainPlugin.runtime.agentTools
  expect(factory).toBeDefined()
  const tools = factory!.createTools({
    agent: { id: 'agent-1', squadId: 'squad-1', integrationCapabilities: policy },
    squadId: 'squad-1',
    gate: new IntegrationRuntimeGate({
      currentAuthority: () => 'local',
      repository: { getAssigned: async () => null },
      supportedAdapterVersion: () => 1,
      supportedConfigVersion: () => 1,
    }),
    credentials: { get: () => undefined, set: async () => {}, delete: async () => {} },
    connections: { disableRuntimeAuthFailure: async () => false },
    audit: { record: async () => {} },
  })

  expect(tools.map((tool) => tool.name)).toEqual([
    'bigbrain_search',
    'bigbrain_get_note',
    'bigbrain_get_memory',
    'bigbrain_drop_markdown',
  ])
})
