import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { AgentType, AgentTypeIntegrationPolicyV1 } from '@ficus/shared'
import { IntegrationRuntimeGate } from '../../services/integrations/runtime-gate'
import { integrationRegistry } from '../../services/integrations/runtime'
import type { BigbrainAgentToolFactory } from '../../services/integrations/bigbrain/plugin'
import { BIGBRAIN_SHARED_TOOL_NAMES } from '../../services/integrations/bigbrain/shared-tools'
import type { BigbrainToolContext } from '../../services/integrations/bigbrain/tools'
import { filterToolsByPolicy } from '../../lib/tools'
import {
  AUTOMATIC_BIGBRAIN_POLICY,
  AUTOMATIC_BIGBRAIN_PROMPT_HINT,
  allowsBigbrainIntegrationTools,
  automaticBigbrainToolNames,
  deploymentOAuthAuthorityForProvider,
} from './base'
import { ArtifactBuilderRunner } from './artifact-builder-runner'
import { SquadManagerRunner } from './squad-manager-runner'
import { SquadWorkerRunner } from './squad-worker-runner'
import { SubagentRunner } from './subagent-runner'

const policy = {
  version: 1,
  allow: { bigbrain: ['agent_tools'] },
} satisfies AgentTypeIntegrationPolicyV1

test('integration tools require both type capability and explicit tool allow', () => {
  expect(allowsBigbrainIntegrationTools(['bigbrain_search_vault'], policy)).toBe(true)
  expect(allowsBigbrainIntegrationTools([], policy)).toBe(false)
  expect(allowsBigbrainIntegrationTools(['bigbrain_search_vault'], null)).toBe(false)
  expect(allowsBigbrainIntegrationTools(['bigbrain_search_vault'], { version: 1, allow: { bigbrain: [] } })).toBe(false)
  expect(allowsBigbrainIntegrationTools(['other_tool'], policy)).toBe(false)
})

test('automatic tool names follow the runner grant minus tools.deny', () => {
  expect(automaticBigbrainToolNames('none', null)).toEqual([])
  expect(automaticBigbrainToolNames('read', null)).not.toContain('bigbrain_drop')
  expect(automaticBigbrainToolNames('read_and_drop', null)).toContain('bigbrain_drop')
  expect(automaticBigbrainToolNames('read_and_drop', ['bigbrain_shared_*', 'bigbrain_drop'])).toEqual([
    'bigbrain_load_memory',
    'bigbrain_search_vault',
    'bigbrain_read_note',
  ])
  expect(automaticBigbrainToolNames('read_and_drop', ['bigbrain_*'])).toEqual([])
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
    'bigbrain_load_memory',
    'bigbrain_search_vault',
    'bigbrain_read_note',
    'bigbrain_drop',
  ])
})

// ---------------------------------------------------------------------------
// Automatic BigBrain tools for squad managers, consultants and squad workers
// ---------------------------------------------------------------------------

type ProbeResult = { available: { name: string }[]; automatic: { name: string }[] }

const LOCAL_READ = ['bigbrain_load_memory', 'bigbrain_search_vault', 'bigbrain_read_note']
const SHARED_READ = [...BIGBRAIN_SHARED_TOOL_NAMES]

/** A stand-in for the BigBrain plugin's agent tool factory: the deployment decides the tool set. */
function fakeFactory(mode: 'managed' | 'local', readable: boolean | Error = true) {
  const contexts: BigbrainToolContext[] = []
  const readabilityChecks: BigbrainToolContext[] = []
  const factory: BigbrainAgentToolFactory = {
    createTools(context) {
      contexts.push(context)
      const names = mode === 'managed' ? SHARED_READ : [...LOCAL_READ, 'bigbrain_drop']
      return names.map((name) => ({ key: name, name }) as never)
    },
    async hasReadableVault(context) {
      readabilityChecks.push(context)
      if (readable instanceof Error) throw readable
      return readable
    },
  }
  return { factory, contexts, readabilityChecks }
}

function probeAgentType(overrides: Partial<AgentType> = {}): AgentType {
  return {
    id: 'probe',
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Probe',
    description: null,
    systemPrompt: 'You are a probe.',
    includes: [],
    skills: null,
    extensions: null,
    toolsAllow: null,
    toolsDeny: null,
    earlyMarginTokens: null,
    inFlightMarginTokens: null,
    yamlFieldOverrides: [],
    hasTemplate: false,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentType
}

function probeAgent(agentTypeId: string, squadId: string | null = 'squad-1') {
  return { id: `agent-${agentTypeId}`, agentTypeId, squadId, selectedModel: null, metadata: null } as any
}

const execution = { id: 'execution-1', agentId: 'agent', message: 'm', imageIds: null } as any

class WorkerProbe extends SquadWorkerRunner {
  probe() {
    return this.resolveIntegrationTools() as Promise<ProbeResult>
  }
  sessionOptions(systemPrompt: string) {
    return this.buildBaseSessionOptions({
      systemPrompt,
      skillPaths: undefined,
      extensionPaths: undefined,
      model: 'anthropic:claude-sonnet-4-5' as never,
      tools: { core: [{ name: 'memory_search' } as never], available: [{ name: 'bash' } as never] },
    })
  }
}
class ManagerProbe extends SquadManagerRunner {
  probe() {
    return this.resolveIntegrationTools() as Promise<ProbeResult>
  }
}
class SubagentProbe extends SubagentRunner {
  probe() {
    return this.resolveIntegrationTools() as Promise<ProbeResult>
  }
}
class ArtifactBuilderProbe extends ArtifactBuilderRunner {
  probe() {
    return this.resolveIntegrationTools() as Promise<ProbeResult>
  }
}

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name)

describe('automatic BigBrain tools', () => {
  let pluginSpy: ReturnType<typeof spyOn> | undefined
  function install(factory: BigbrainAgentToolFactory | undefined) {
    pluginSpy = spyOn(integrationRegistry, 'plugin').mockImplementation(((key: string) =>
      key === 'bigbrain' && factory ? ({ runtime: { agentTools: factory } } as never) : undefined) as never)
  }
  afterEach(() => {
    pluginSpy?.mockRestore()
    pluginSpy = undefined
  })

  test('a squad worker whose tools.allow omits BigBrain gets the five shared read tools and nothing else', async () => {
    const fake = fakeFactory('managed')
    install(fake.factory)
    const runner = new WorkerProbe(execution, probeAgent('engineer'), probeAgentType({ toolsAllow: ['read', 'bash'] }))
    const result = await runner.probe()
    expect(names(result.automatic)).toEqual(SHARED_READ)
    expect(result.available).toEqual([])
    // The automatic tools run under the runner's grant, never the (absent) type opt-in.
    expect(fake.readabilityChecks[0]?.agent).toEqual({
      id: 'agent-engineer',
      squadId: 'squad-1',
      integrationCapabilities: AUTOMATIC_BIGBRAIN_POLICY,
    })
    expect(fake.contexts.every((context) => context.squadId === 'squad-1')).toBe(true)
  })

  test('automatic tools bypass tools.allow in the session and add the prompt hint', async () => {
    install(fakeFactory('managed').factory)
    const runner = new WorkerProbe(execution, probeAgent('engineer'), probeAgentType({ toolsAllow: ['read', 'bash'] }))
    const options = await runner.sessionOptions('Base prompt.')
    const effective = [
      ...(options.tools?.core ?? []),
      ...filterToolsByPolicy(options.tools?.available ?? [], options.tools?.allow, options.tools?.deny),
    ].map((tool) => tool.name)
    expect(effective).toEqual(['memory_search', ...SHARED_READ, 'bash'])
    expect(options.systemPrompt).toBe(`Base prompt.\n\n${AUTOMATIC_BIGBRAIN_PROMPT_HINT}`)
    expect(AUTOMATIC_BIGBRAIN_PROMPT_HINT).toContain('bigbrain_*')
    expect(AUTOMATIC_BIGBRAIN_PROMPT_HINT).toContain('separate from squad memory')
  })

  test('no prompt hint and no tools when the squad has no readable vault', async () => {
    install(fakeFactory('managed', false).factory)
    const runner = new WorkerProbe(execution, probeAgent('engineer'), probeAgentType())
    const options = await runner.sessionOptions('Base prompt.')
    expect(options.systemPrompt).toBe('Base prompt.')
    expect(names(options.tools?.core as never)).toEqual(['memory_search'])
    expect(names(options.tools?.available as never)).toEqual(['bash'])
  })

  test.each(['manager', 'consultant'])(
    'a %s on the local connector gets the three read tools plus bigbrain_drop',
    async (agentTypeId) => {
      install(fakeFactory('local').factory)
      const runner = new ManagerProbe(execution, probeAgent(agentTypeId), probeAgentType({ id: agentTypeId }))
      const result = await runner.probe()
      expect(names(result.automatic)).toEqual([...LOCAL_READ, 'bigbrain_drop'])
      expect(result.available).toEqual([])
    }
  )

  test('a squad worker on the local connector gets only the three read tools', async () => {
    install(fakeFactory('local').factory)
    const result = await new WorkerProbe(execution, probeAgent('engineer'), probeAgentType()).probe()
    expect(names(result.automatic)).toEqual(LOCAL_READ)
    expect(result.available).toEqual([])
  })

  test('managers on managed shared vaults stay read-only', async () => {
    install(fakeFactory('managed').factory)
    const result = await new ManagerProbe(execution, probeAgent('manager'), probeAgentType({ id: 'manager' })).probe()
    expect(names(result.automatic)).toEqual(SHARED_READ)
  })

  test('tools.deny removes automatic tools, including through a wildcard', async () => {
    install(fakeFactory('local').factory)
    const dropDenied = await new ManagerProbe(
      execution,
      probeAgent('manager'),
      probeAgentType({ id: 'manager', toolsDeny: ['bigbrain_drop'] })
    ).probe()
    expect(names(dropDenied.automatic)).toEqual(LOCAL_READ)

    const fake = fakeFactory('managed')
    pluginSpy?.mockRestore()
    install(fake.factory)
    const allDenied = await new ManagerProbe(
      execution,
      probeAgent('manager'),
      probeAgentType({ id: 'manager', toolsDeny: ['bigbrain_*'] })
    ).probe()
    expect(allDenied).toEqual({ available: [], automatic: [] })
    // Fully opted out: the squad's vaults are not even consulted.
    expect(fake.readabilityChecks).toEqual([])
  })

  test('no BigBrain tools when the squad has no readable vault, the check fails, or the plugin is missing', async () => {
    for (const readable of [false, new Error('database unavailable')]) {
      install(fakeFactory('local', readable).factory)
      expect(await new ManagerProbe(execution, probeAgent('manager'), probeAgentType()).probe()).toEqual({
        available: [],
        automatic: [],
      })
      pluginSpy?.mockRestore()
    }
    install(undefined)
    expect(await new WorkerProbe(execution, probeAgent('engineer'), probeAgentType()).probe()).toEqual({
      available: [],
      automatic: [],
    })
  })

  test('agents outside a squad get no BigBrain tools', async () => {
    const fake = fakeFactory('local')
    install(fake.factory)
    expect(await new WorkerProbe(execution, probeAgent('engineer', null), probeAgentType()).probe()).toEqual({
      available: [],
      automatic: [],
    })
    expect(fake.readabilityChecks).toEqual([])
  })

  test('the explicit opt-in path is unchanged for a non-squad runner', async () => {
    const fake = fakeFactory('local')
    install(fake.factory)
    const optedIn = await new ArtifactBuilderProbe(
      execution,
      probeAgent('artifact-builder-default'),
      probeAgentType({ toolsAllow: ['bigbrain_search_vault'], integrationCapabilities: policy })
    ).probe()
    // All factory tools are offered as `available`, then narrowed by tools.allow in the session.
    expect(names(optedIn.available)).toEqual([...LOCAL_READ, 'bigbrain_drop'])
    expect(optedIn.automatic).toEqual([])
    expect(fake.readabilityChecks).toEqual([])
    expect(fake.contexts[0]?.agent.integrationCapabilities).toEqual(policy)

    const notOptedIn = await new ArtifactBuilderProbe(
      execution,
      probeAgent('artifact-builder-default'),
      probeAgentType({ toolsAllow: ['bigbrain_search_vault'] })
    ).probe()
    expect(notOptedIn).toEqual({ available: [], automatic: [] })
  })

  test('a squad worker can still opt in to bigbrain_drop explicitly on top of the automatic reads', async () => {
    install(fakeFactory('local').factory)
    const result = await new WorkerProbe(
      execution,
      probeAgent('engineer'),
      probeAgentType({ toolsAllow: ['read', 'bigbrain_drop'], integrationCapabilities: policy })
    ).probe()
    expect(names(result.automatic)).toEqual(LOCAL_READ)
    // Explicit tools not already offered automatically; tools.allow keeps only bigbrain_drop.
    expect(names(result.available)).toEqual(['bigbrain_drop'])
  })

  test('subagents get no automatic BigBrain tools of their own', async () => {
    const fake = fakeFactory('local')
    install(fake.factory)
    const result = await new SubagentProbe(
      execution,
      probeAgent('subagent'),
      probeAgentType({ id: 'subagent' })
    ).probe()
    expect(result).toEqual({ available: [], automatic: [] })
    expect(fake.readabilityChecks).toEqual([])
  })
})
