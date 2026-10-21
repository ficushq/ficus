import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BigbrainClient } from './client'
import { expect, test } from 'bun:test'
import { BigbrainError } from './errors'
import { createBigbrainTools, hasReadableLocalVault, BIGBRAIN_TOOL_NAMES } from './tools'
import { IntegrationRuntimeGate } from '../runtime-gate'
import type { AssignedIntegrationConnectionRecord } from '../connection-repository'
import { bigbrainPlugin } from './plugin'

const secret = 'fixture-bearer'
test('defines four stable server-bound tools without credential parameters', () => {
  const tools = createBigbrainTools({
    agent: {
      id: 'agent',
      squadId: 'squad',
      integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
    },
    squadId: 'squad',
    gate: { check: async () => ({ allowed: false, code: 'connection_disabled' }) } as any,
    credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
    audit: { record: async () => {} },
    connections: { disableRuntimeAuthFailure: async () => false },
  })
  expect(tools.map((tool) => tool.name)).toEqual([
    'bigbrain_load_memory',
    'bigbrain_search_vault',
    'bigbrain_read_note',
    'bigbrain_drop',
  ])
  expect(BIGBRAIN_TOOL_NAMES).toHaveLength(4)
  expect(JSON.stringify(tools.map((tool) => tool.parameters))).not.toContain('credential')
  expect(JSON.stringify(tools.map((tool) => tool.parameters))).not.toContain('apiBase')
  expect(JSON.stringify(tools.map((tool) => tool.parameters)).toLowerCase()).not.toContain('squadid')
})

test('does not fetch or disclose secrets when a runtime gate denies', async () => {
  let fetches = 0
  const tools = createBigbrainTools({
    agent: { id: 'agent', squadId: 'squad', integrationCapabilities: null },
    squadId: 'squad',
    gate: { check: async () => ({ allowed: false, code: 'capability_not_allowed' }) } as any,
    credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
    audit: { record: async () => {} },
    connections: { disableRuntimeAuthFailure: async () => false },
    client: () => {
      fetches++
      throw new Error('should not create client')
    },
  })
  const result = await tools[0]!.execute(
    'call',
    { query: 'test' },
    undefined as any,
    undefined as any,
    undefined as any
  )
  expect(fetches).toBe(0)
  expect(JSON.stringify(result)).not.toContain(secret)
})

test('disables the exact material revision on runtime authentication failure', async () => {
  const disables: unknown[] = []
  const tools = createBigbrainTools({
    agent: {
      id: 'agent',
      squadId: 'squad',
      integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
    },
    squadId: 'squad',
    gate: {
      check: async () => ({
        allowed: true,
        connection: {
          id: 'connection',
          squadId: 'squad',
          credentialRef: 'credential',
          materialRevision: 'revision-a',
          configuration: { version: 1, apiBase: 'https://brain.example' },
        },
      }),
    } as any,
    credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
    audit: { record: async () => {} },
    connections: {
      disableRuntimeAuthFailure: async (input) => {
        disables.push(input)
        return true
      },
    },
    client: () =>
      ({
        searchVault: async () => {
          throw new BigbrainError('invalid_auth')
        },
      }) as any,
  })

  await tools[1]!.execute('call', { query: 'test' }, undefined as any, undefined as any, undefined as any)
  expect(disables).toEqual([{ id: 'connection', materialRevision: 'revision-a' }])
})

test.each(['disable', 'revision'] as const)(
  'rechecks %s after MCP initialization before sending a tool request',
  async (change) => {
    let initialized = false
    let dispatched = 0
    const [local, remote] = InMemoryTransport.createLinkedPair()
    const server = new Server({ name: 'synthetic', version: '1' }, { capabilities: { tools: {} } })
    server.oninitialized = () => {
      initialized = true
    }
    server.setRequestHandler(CallToolRequestSchema, () => {
      dispatched++
      return { content: [{ type: 'text', text: '' }] }
    })
    await server.connect(remote)
    const tools = createBigbrainTools({
      agent: {
        id: 'agent',
        squadId: 'squad',
        integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
      },
      squadId: 'squad',
      gate: {
        check: async () =>
          initialized && change === 'disable'
            ? { allowed: false, code: 'connection_disabled' }
            : {
                allowed: true,
                connection: {
                  id: 'connection',
                  credentialRef: 'private',
                  materialRevision: initialized ? 'changed' : 'original',
                  configuration: { version: 2 },
                },
              },
      } as any,
      credentials: { get: () => 'aabb0011', set: async () => {}, delete: async () => {} },
      connections: { disableRuntimeAuthFailure: async () => false },
      audit: { record: async () => {} },
      client: (options) => new BigbrainClient({ ...options, transport: async () => local }),
    })
    try {
      const result = await tools[0].execute('call', {}, undefined as any, undefined as any, undefined as any)
      expect(JSON.stringify(result)).toContain('unavailable')
      expect(dispatched).toBe(0)
    } finally {
      await server.close()
    }
  }
)

test('a local vault is readable only when the gate admits the attached connection with the search scope', async () => {
  const now = new Date()
  const connection: AssignedIntegrationConnectionRecord = {
    id: 'connection',
    squadId: 'squad',
    providerKey: 'bigbrain',
    adapterVersion: 2,
    clientAuthority: 'local',
    authorizationFlowId: null,
    displayName: 'Local',
    configuration: { version: 2 },
    credentialRef: 'credential',
    materialRevision: 'revision',
    validatedRevision: 'revision',
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: ['mcp:load_memory', 'mcp:search_vault', 'mcp:read_note', 'mcp:drop'],
    validatedAt: now,
    validationExpiresAt: new Date(now.getTime() + 60_000),
    lastErrorCode: null,
    updatedAt: now,
  }
  const readable = (assigned: AssignedIntegrationConnectionRecord | null, capabilities: unknown = undefined) =>
    hasReadableLocalVault({
      agent: {
        id: 'agent',
        squadId: 'squad',
        integrationCapabilities: (capabilities === undefined
          ? { version: 1, allow: { bigbrain: ['agent_tools'] } }
          : capabilities) as never,
      },
      squadId: 'squad',
      gate: new IntegrationRuntimeGate({
        currentAuthority: () => undefined,
        repository: { getAssigned: async () => assigned },
        now: () => now,
        supportedAdapterVersion: () => 2,
        supportedConfigVersion: () => 2,
      }),
      credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
      audit: { record: async () => {} },
      connections: { disableRuntimeAuthFailure: async () => false },
    })

  expect(await readable(connection)).toBe(true)
  // Nothing attached; disabled (the provider or the connection); unhealthy; unauthenticated; stale; no read scope.
  expect(await readable(null)).toBe(false)
  expect(await readable({ ...connection, enabled: false })).toBe(false)
  expect(await readable({ ...connection, healthState: 'unreachable' })).toBe(false)
  expect(await readable({ ...connection, authState: 'invalid' })).toBe(false)
  expect(await readable({ ...connection, validationExpiresAt: new Date(now.getTime() - 1) })).toBe(false)
  expect(await readable({ ...connection, grantedScopes: ['mcp:drop'] })).toBe(false)
  // The gate's capability check still applies to whatever policy the caller runs under.
  expect(await readable(connection, null)).toBe(false)
})

test('the plugin uses the local readability check outside Ficus Cloud', async () => {
  const previousManaged = process.env.FICUS_MANAGED
  delete process.env.FICUS_MANAGED
  try {
    const checks: unknown[] = []
    const result = await bigbrainPlugin.runtime.agentTools!.hasReadableVault({
      agent: {
        id: 'agent',
        squadId: 'squad',
        integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
      },
      squadId: 'squad',
      gate: {
        check: async (input: unknown) => (checks.push(input), { allowed: false, code: 'connection_unavailable' }),
      } as any,
      credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
      audit: { record: async () => {} },
      connections: { disableRuntimeAuthFailure: async () => false },
    })
    expect(result).toBe(false)
    expect(checks).toEqual([expect.objectContaining({ provider: 'bigbrain', requiredScope: 'mcp:search_vault' })])
  } finally {
    if (previousManaged !== undefined) process.env.FICUS_MANAGED = previousManaged
  }
})
