import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Agent } from '@ficus/shared'
import { isModelPriorityList, parseDisplayModelPriorityList, parseDisplayModelSpec } from '../lib/displayModelSpec'
import { integrationQueryKeys, queryKeys } from '../queryKeys'
import { AgentInfoPanel } from './AgentInfoPanel'
import { acquireDomHarness } from '../test/domHarness'
import type { IntegrationConnection } from '../api/integrations'
import type { AgentTypeConfig } from '../api/config'

type AgentModelTypeInfo = Pick<AgentTypeConfig, 'model' | 'tier' | 'resolvedChain' | 'provenance'>

/**
 * The panel embeds <AgentSandboxControls>, which calls useQuery, so a
 * QueryClient must be in context. Static render runs no effects, so the
 * sandbox query never fetches and the child renders null — leaving these
 * model-info assertions unaffected.
 */
function renderPanel(
  agent: Agent,
  agentType: AgentModelTypeInfo | null = baseAgentType,
  configureClient?: (client: QueryClient) => void
): string {
  const client = new QueryClient()
  configureClient?.(client)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentInfoPanel agent={agent} agentType={agentType} />
    </QueryClientProvider>
  )
}

const baseAgent: Agent = {
  id: 'agent-1',
  agentTypeId: 'engineer',
  squadId: 'squad-1',
  parentAgentId: null,
  status: 'idle',
  persist: false,
  modelOverride: null,
  configuredModel: 'anthropic:claude-sonnet-4-5:high',
  metadata: null,
  context: {},
  questionData: null,
  sessionUsage: null,
  terminatedAt: null,
  lastMessageAt: null,
  lastHumanMessageAt: null,
  amtpHandle: null,
  identityPublicKey: null,
  inboundOpen: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

const baseAgentType: AgentModelTypeInfo = {
  model: 'anthropic:claude-sonnet-4-5',
  tier: null,
  resolvedChain: 'anthropic:claude-sonnet-4-5',
  provenance: 'type override',
}

const STANDARD_CHAIN = 'openai-codex:gpt-5.6-sol:medium,anthropic:claude-sonnet-5:high,zai:glm-5.3:high'

describe('parseDisplayModelSpec', () => {
  test('parses provider, model id, and thinking level from colon specs', () => {
    expect(parseDisplayModelSpec('anthropic:claude-sonnet-4-5:high')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'high',
    })
  })

  test('parses provider, model id, and thinking level from slash specs', () => {
    expect(parseDisplayModelSpec('zai/glm-5.2:xhigh')).toEqual({
      provider: 'zai',
      modelId: 'glm-5.2',
      thinkingLevel: 'xhigh',
    })
  })

  test('preserves colons in model ids when suffix is not a thinking level', () => {
    expect(parseDisplayModelSpec('custom:model:preview')).toEqual({
      provider: 'custom',
      modelId: 'model:preview',
      thinkingLevel: undefined,
    })
  })
})

describe('isModelPriorityList / parseDisplayModelPriorityList', () => {
  test('detects a single spec vs a priority list', () => {
    expect(isModelPriorityList('anthropic:claude-sonnet-4-5')).toBe(false)
    expect(isModelPriorityList('zai:glm-5.2:high,anthropic:claude-sonnet-4-6')).toBe(true)
  })

  test('parses every candidate preserving order', () => {
    expect(parseDisplayModelPriorityList('zai:glm-5.2:high,anthropic:claude-sonnet-4-6')).toEqual([
      { provider: 'zai', modelId: 'glm-5.2', thinkingLevel: 'high' },
      { provider: 'anthropic', modelId: 'claude-sonnet-4-6', thinkingLevel: undefined },
    ])
  })
})

describe('AgentInfoPanel', () => {
  test('a Standard-type child shows its explicit override before a model is selected', () => {
    const agent: Agent = {
      ...baseAgent,
      parentAgentId: 'parent-1',
      modelOverride: 'openai:gpt-5.3-codex',
      configuredModel: 'openai:gpt-5.3-codex',
      selectedModel: undefined,
    }
    const html = renderPanel(agent, {
      ...baseAgentType,
      model: '',
      tier: 'standard',
      resolvedChain: STANDARD_CHAIN,
      provenance: 'via tier: standard',
    })

    expect(html).toContain('Configured chain')
    expect(html).toContain('openai:gpt-5.3-codex')
    expect(html).toContain('Agent override')
    expect(html).not.toContain('Model tier: standard')
    expect(html).not.toContain('Active model')
  })

  test('an inherited child labels the full parent chain instead of Standard', () => {
    const inheritedChain = 'openai-codex:gpt-5.6-sol:high,anthropic:claude-opus-5:high'
    const agent: Agent = {
      ...baseAgent,
      parentAgentId: 'parent-1',
      modelOverride: inheritedChain,
      configuredModel: inheritedChain,
      selectedModel: undefined,
      metadata: { inheritModel: true },
    }
    const html = renderPanel(agent, {
      ...baseAgentType,
      model: '',
      tier: 'standard',
      resolvedChain: STANDARD_CHAIN,
      provenance: 'via tier: standard',
    })

    expect(html).toContain(inheritedChain)
    expect(html).toContain('Inherited parent chain')
    expect(html).not.toContain('Model tier: standard')
  })

  test('tier-resolved agents show the authoritative chain, source, and active model', () => {
    const agent: Agent = { ...baseAgent, configuredModel: null, selectedModel: 'openai-codex:gpt-5.6-sol:medium' }
    const html = renderPanel(agent, {
      ...baseAgentType,
      model: '',
      tier: 'standard',
      resolvedChain: STANDARD_CHAIN,
      provenance: 'via tier: standard',
    })

    expect(html).toContain('Active model')
    expect(html).toContain('openai-codex:gpt-5.6-sol:medium')
    expect(html).toContain(STANDARD_CHAIN)
    expect(html).toContain('Model tier: standard')
  })
})

const bigbrainConnection: IntegrationConnection = {
  id: 'connection-1',
  providerKey: 'bigbrain',
  adapterVersion: 1,
  displayName: 'Bigbrain',
  configuration: { version: 1, apiBase: 'https://brain.example' },
  credentialConfigured: true,
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: [],
  validatedAt: '2026-01-01',
  validationExpiresAt: '2026-01-02',
  lastErrorCode: null,
  usage: { squadCount: 1, squads: [{ id: 'squad-1', name: 'Research' }] },
}

describe('AgentInfoPanel external-export query gating', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let client: QueryClient | undefined
  let requests: string[]
  let oldFetch: typeof globalThis.fetch

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost',
      beforeUnmount: async () => {
        await client?.cancelQueries()
        client?.clear()
      },
    })
    ;({ container, root } = dom.createRoot())
    requests = []
    oldFetch = globalThis.fetch
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requests.push(url)
      return Response.json(url.includes('/external-export') ? { state: 'disabled' } : null)
    }) as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = oldFetch
    await dom.cleanup()
    client = undefined
  })

  async function renderLive({
    agent = baseAgent,
    permissions = ['integrations:read', 'integrations:export'],
    assignment,
    connections = [],
  }: {
    agent?: Agent
    permissions?: string[]
    assignment?: IntegrationConnection | null
    connections?: IntegrationConnection[]
  }) {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.auth.permissions(undefined), { permissions: [] })
    client.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions })
    if (assignment !== undefined) {
      client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), {
        providerKey: 'bigbrain',
        assignment,
        connections,
      })
    }

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentInfoPanel agent={agent} agentType={baseAgentType} />
        </QueryClientProvider>
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return client
  }

  test.each([
    ['unconfigured', null],
    ['disabled', { ...bigbrainConnection, enabled: false }],
  ] as const)('does not fetch external-export status when Bigbrain assignment is %s', async (_state, assignment) => {
    const queryClient = await renderLive({ assignment })

    expect(container.textContent).not.toContain('External conversation export')
    expect(requests.some((url) => url.includes('/external-export'))).toBe(false)
    expect(queryClient.getQueryState(integrationQueryKeys.export(baseAgent.id))).toBeUndefined()
  })

  test('does not query integrations or external-export without read permission', async () => {
    const queryClient = await renderLive({ permissions: ['integrations:export'] })

    expect(container.textContent).not.toContain('External conversation export')
    expect(requests.some((url) => url.includes('/squads/squad-1/integrations'))).toBe(false)
    expect(requests.some((url) => url.includes('/external-export'))).toBe(false)
    expect(queryClient.getQueryState(integrationQueryKeys.export(baseAgent.id))).toBeUndefined()
  })

  test('an enabled but unassigned pool connection does not expose export consent', async () => {
    const queryClient = await renderLive({ assignment: null, connections: [bigbrainConnection] })

    expect(container.textContent).not.toContain('External conversation export')
    expect(requests.some((url) => url.includes('/external-export'))).toBe(false)
    expect(queryClient.getQueryState(integrationQueryKeys.export(baseAgent.id))).toBeUndefined()
  })

  test('fetches export status for the assigned enabled Bigbrain connection on a root agent', async () => {
    const queryClient = await renderLive({ assignment: bigbrainConnection })

    expect(container.textContent).toContain('External conversation export')
    expect(requests.some((url) => url.includes('/agents/agent-1/external-export'))).toBe(true)
    expect(queryClient.getQueryState(integrationQueryKeys.export(baseAgent.id))).toBeDefined()
  })

  test('does not fetch export status for a child agent', async () => {
    const childAgent = { ...baseAgent, parentAgentId: 'parent-1' }
    const queryClient = await renderLive({ agent: childAgent, assignment: bigbrainConnection })

    expect(container.textContent).not.toContain('External conversation export')
    expect(requests.some((url) => url.includes('/external-export'))).toBe(false)
    expect(queryClient.getQueryState(integrationQueryKeys.export(baseAgent.id))).toBeUndefined()
  })
})
