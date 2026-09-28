import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AgentType } from '@ficus/shared'
import { AgentSession } from '../AgentSession'
import { Squad } from '../Squad'
import { SquadManagerRunner } from './squad-manager-runner'
import * as tools from '../../tools'
import * as cliHelp from '../../lib/utils/cli-help'
import * as prompts from '../../lib/prompts'
import * as memoryPaths from '../../services/memory/paths'
import { MONOREPO_ROOT } from '../../lib/paths'

const TEST_SQUAD_ID = '00000000-0000-4000-8000-000000000103'

/** The real squad-rules.md include, inlined into the manager systemPrompt at load time. */
const SQUAD_RULES_INCLUDE = readFileSync(join(MONOREPO_ROOT, 'config/agent-types/shared/squad-rules.md'), 'utf-8')

let squadSandboxCalls: unknown[] = []
let lightSandboxCalls: unknown[] = []
let codingToolCalls: unknown[] = []
let squadBashCalls: unknown[] = []

class TestableSquadManagerRunner extends SquadManagerRunner {
  assistantDelegate = false
  protected override async isAssistantDelegate() {
    return this.assistantDelegate
  }

  exposeCreateSession(): Promise<AgentSession> {
    return this.createSession()
  }

  protected override ensureSquadSandbox(squad: any): Promise<string> {
    squadSandboxCalls.push(squad)
    return Promise.resolve('/tmp/squad-ws')
  }

  protected ensureLightSandbox(args: any): Promise<string> {
    lightSandboxCalls.push(args)
    return Promise.resolve('/tmp/light-ws')
  }

  protected override createCodingTools(
    workspacePath: string,
    sandboxId: string,
    tauToken?: string,
    squadId?: string
  ): any[] {
    codingToolCalls.push([workspacePath, sandboxId, tauToken, squadId])
    return [{ name: 'bash' }]
  }

  protected createSquadBashTool(
    warmSandboxId: string,
    workspaceHostPath: string,
    squadId: string,
    tauToken?: string
  ): any {
    squadBashCalls.push([warmSandboxId, workspaceHostPath, squadId, tauToken])
    return { name: 'squad_bash', key: 'squad_bash' }
  }
}

function makeAgentType(overrides: Partial<AgentType> = {}): AgentType {
  return {
    id: 'manager',
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Manager',
    description: null,
    systemPrompt: 'You manage the squad. {{squad.context}}',
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
  }
}

function capturedToolNames(createSpy: any): string[] {
  const config = createSpy.mock.calls[0]?.[0]
  return [...(config.tools.core ?? []), ...(config.tools.available ?? [])].map((tool: any) => tool.name)
}

describe('SquadManagerRunner typeContext injection', () => {
  let sessionSpy: any
  let squadFindSpy: any
  let resolveSkillPathsSpy: any
  let spies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    squadSandboxCalls = []
    lightSandboxCalls = []
    codingToolCalls = []
    squadBashCalls = []
    sessionSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as any)
    spies.push(sessionSpy)
    spies.push(spyOn(tools, 'getShortTermMemory').mockResolvedValue(''))
    spies.push(spyOn(cliHelp, 'getSquadManagerCliHelp').mockResolvedValue('cli'))
    spies.push(spyOn(prompts, 'buildActiveSchedulesPrompt').mockResolvedValue(''))
    spies.push(spyOn(memoryPaths, 'readSquadMemoryFile').mockReturnValue(''))
    resolveSkillPathsSpy = spyOn(SquadManagerRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(undefined)
    spies.push(resolveSkillPathsSpy)
    spies.push(spyOn(SquadManagerRunner.prototype as any, 'resolveExtensionPaths').mockReturnValue(undefined))
  })

  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies = []
    squadFindSpy?.mockRestore()
  })

  it('includes global + manager type-specific context in the system prompt', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: 'GLOBAL-CTX-MARKER',
      typeContext: { manager: 'MANAGER-CTX-MARKER' },
      sandboxId: 'sbx',
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: (id: string) => (id === 'manager' ? 'MANAGER-CTX-MARKER' : null),
      withRelationships: async () =>
        ({
          relationships: {
            reportsTo: [],
            collaborates: [],
            dependsOn: [],
            reportedBy: [],
            dependedOnBy: [],
          },
        }) as any,
    } as any)

    const agent = {
      id: 'm1',
      agentTypeId: 'manager',
      squadId: TEST_SQUAD_ID,
      metadata: null,
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      getSandboxId: async () => 'agent_manager_m1',
      getEffectiveModelSpec: async (m: string) => m,
    } as any
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      agent,
      makeAgentType()
    )
    await runner.exposeCreateSession()

    const systemPrompt = sessionSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('GLOBAL-CTX-MARKER')
    expect(systemPrompt).toContain('MANAGER-CTX-MARKER')
    // Current Time is removed — it changed every turn and defeated prompt caching.
    expect(systemPrompt).not.toContain('Current Time')
    // Work Streams are removed — their frequent status/assignee churn defeated
    // prompt caching. The manager queries live state via the workstream CLI/tools.
    expect(systemPrompt).not.toContain('Work Streams')
    // Squad Agents are removed — agent status churn defeated prompt caching.
    // The manager can query live agent state via the squad/agent CLI/tools.
    expect(systemPrompt).not.toContain('Squad Agents')
    // The squad runtime block (squad_bash + /private) must reach the manager prompt.
    expect(systemPrompt).toContain('squad_bash')
    expect(systemPrompt).toContain('/private')
  })

  it('does not add Type-Specific Context section when absent', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: 'GLOBAL-CTX',
      typeContext: null,
      sandboxId: 'sbx',
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
      withRelationships: async () =>
        ({
          relationships: {
            reportsTo: [],
            collaborates: [],
            dependsOn: [],
            reportedBy: [],
            dependedOnBy: [],
          },
        }) as any,
    } as any)

    const agent = {
      id: 'm1',
      agentTypeId: 'manager',
      squadId: TEST_SQUAD_ID,
      metadata: null,
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      getSandboxId: async () => 'agent_manager_m1',
      getEffectiveModelSpec: async (m: string) => m,
    } as any
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      agent,
      makeAgentType()
    )
    await runner.exposeCreateSession()

    const systemPrompt = sessionSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('GLOBAL-CTX')
    expect(systemPrompt).not.toContain('Type-Specific Context')
  })

  it('uses the per-agent light id (getSandboxId) for coding tools and session sandbox, not squad.sandboxId', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: 'CTX',
      typeContext: null,
      sandboxId: 'squad-sandbox-x',
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
      withRelationships: async () =>
        ({
          relationships: {
            reportsTo: [],
            collaborates: [],
            dependsOn: [],
            reportedBy: [],
            dependedOnBy: [],
          },
        }) as any,
    } as any)

    const agent = {
      id: 'm1',
      agentTypeId: 'manager',
      squadId: TEST_SQUAD_ID,
      metadata: null,
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      getSandboxId: async () => 'agent_manager_m1',
      getEffectiveModelSpec: async (m: string) => m,
    } as any
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      agent,
      makeAgentType()
    )
    await runner.exposeCreateSession()

    const lightId = 'agent_manager_m1'

    // ensureSquadSandbox (warm box) must still be called
    expect(squadSandboxCalls).toHaveLength(1)

    // ensureLightSandbox must be called with the light id and squadId
    expect(lightSandboxCalls).toHaveLength(1)
    expect(lightSandboxCalls[0]).toMatchObject({ sandboxId: lightId, workspaceId: lightId, squadId: TEST_SQUAD_ID })

    // createCodingTools must receive the light id as sandboxId and the squad id as 4th arg
    expect(codingToolCalls).toContainEqual(['/tmp/light-ws', lightId, undefined, TEST_SQUAD_ID])

    // resolveSkillPaths must be called with the light id (not squad.sandboxId)
    expect(resolveSkillPathsSpy.mock.calls[0]?.[0]).toBe(lightId)

    // AgentSession.create sandbox.sandboxId must be the light id
    const sessionConfig = sessionSpy.mock.calls[0][0]
    expect(sessionConfig.sandbox.sandboxId).toBe(lightId)
  })

  it('registers squad_bash bound to the warm squad box', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: '',
      typeContext: null,
      sandboxId: `squad_${TEST_SQUAD_ID}`,
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
      withRelationships: async () =>
        ({
          relationships: {
            reportsTo: [],
            collaborates: [],
            dependsOn: [],
            reportedBy: [],
            dependedOnBy: [],
          },
        }) as any,
    } as any)

    const agent = {
      id: 'm1',
      agentTypeId: 'manager',
      squadId: TEST_SQUAD_ID,
      metadata: null,
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      getSandboxId: async () => 'agent_manager_m1',
      getEffectiveModelSpec: async (m: string) => m,
    } as any
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      agent,
      makeAgentType()
    )
    await runner.exposeCreateSession()

    expect((squadBashCalls[0] as any[])[0]).toBe(`squad_${TEST_SQUAD_ID}`)
    expect((squadBashCalls[0] as any[])[2]).toBe(TEST_SQUAD_ID)
    expect(capturedToolNames(sessionSpy)).toEqual(expect.arrayContaining(['squad_bash']))
  })
  it('gives channel consultants reply tools and asks questions in the channel', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: '',
      typeContext: null,
      sandboxId: `squad_${TEST_SQUAD_ID}`,
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
      withRelationships: async () =>
        ({
          relationships: {
            reportsTo: [],
            collaborates: [],
            dependsOn: [],
            reportedBy: [],
            dependedOnBy: [],
          },
        }) as any,
    } as any)

    const agent = {
      id: 'm1',
      agentTypeId: 'consultant',
      context: { type: 'consultant', channelInstance: { id: 'test-channel', provider: 'telegram' } },
      squadId: TEST_SQUAD_ID,
      metadata: null,
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      getSandboxId: async () => 'agent_manager_m1',
      getEffectiveModelSpec: async (m: string) => m,
    } as any
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      agent,
      makeAgentType({ id: 'consultant' })
    )
    await runner.exposeCreateSession()

    expect(capturedToolNames(sessionSpy)).toEqual(
      expect.arrayContaining(['channel_respond', 'channel_send', 'channel_edit', 'set_agent_purpose'])
    )
    expect(capturedToolNames(sessionSpy)).not.toContain('ask_human')
    expect(sessionSpy.mock.calls[0][0].systemPrompt).toContain('External channel conversation')
  })
})

describe('SquadManagerRunner placeholder interpolation', () => {
  let sessionSpy: any
  let squadFindSpy: any
  let spies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    squadSandboxCalls = []
    lightSandboxCalls = []
    codingToolCalls = []
    squadBashCalls = []
    sessionSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as any)
    spies.push(sessionSpy)
    spies.push(spyOn(tools, 'getShortTermMemory').mockResolvedValue(''))
    spies.push(spyOn(cliHelp, 'getSquadManagerCliHelp').mockResolvedValue('CLI-REFERENCE-MARKER'))
    spies.push(spyOn(prompts, 'buildActiveSchedulesPrompt').mockResolvedValue(''))
    spies.push(spyOn(memoryPaths, 'readSquadMemoryFile').mockReturnValue(''))
    spies.push(spyOn(SquadManagerRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(undefined))
    spies.push(spyOn(SquadManagerRunner.prototype as any, 'resolveExtensionPaths').mockReturnValue(undefined))
  })

  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies = []
    squadFindSpy?.mockRestore()
  })

  function makeMockSquad() {
    return {
      id: TEST_SQUAD_ID,
      name: 'Test Squad',
      purpose: 'testing',
      defaultAgents: [],
      context: 'squad-context-line',
      typeContext: null,
      sandboxId: 'sbx',
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
      withRelationships: async () =>
        ({
          relationships: {
            reportsTo: [],
            collaborates: [],
            dependsOn: [],
            reportedBy: [],
            dependedOnBy: [],
          },
        }) as any,
    } as any
  }

  function makeMockAgent() {
    return {
      id: 'm1',
      agentTypeId: 'manager',
      squadId: TEST_SQUAD_ID,
      metadata: null,
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      getSandboxId: async () => 'agent_manager_m1',
      getEffectiveModelSpec: async (m: string) => m,
    } as any
  }

  for (const delegated of [false, true]) {
    it(`only offers ask_human for direct consultants (delegate=${delegated})`, async () => {
      squadFindSpy = spyOn(Squad, 'find').mockResolvedValue(makeMockSquad())
      const agent = { ...makeMockAgent(), agentTypeId: 'consultant' }
      const runner = new TestableSquadManagerRunner(
        { id: 'e1', agentId: agent.id, message: 'go', imageIds: null } as any,
        agent,
        makeAgentType({ id: 'consultant' })
      )
      runner.assistantDelegate = delegated
      await runner.exposeCreateSession()
      expect(capturedToolNames(sessionSpy).includes('ask_human')).toBe(!delegated)
      expect(capturedToolNames(sessionSpy)).toContain('set_agent_purpose')
    })
  }

  it('leaves no raw {{...}} placeholders when using the real squad-rules include', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue(makeMockSquad())

    // Mirror production: the squad-rules.md include is appended to the manager
    // systemPrompt at agent-type load time. Use the real include content so the
    // test tracks every placeholder that file actually contains.
    const agentType = makeAgentType({ systemPrompt: 'You manage the squad.\n\n' + SQUAD_RULES_INCLUDE })

    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      makeMockAgent(),
      agentType
    )
    await runner.exposeCreateSession()

    const systemPrompt = sessionSpy.mock.calls[0][0].systemPrompt
    // No unresolved template placeholders should leak into the final prompt.
    expect(systemPrompt).not.toMatch(/\{\{[^}]+\}\}/)
  })

  it('interpolates {{manager.id}} to the squad managerAgentId', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue(makeMockSquad())

    const agentType = makeAgentType({ systemPrompt: 'Hand work to the manager: {{manager.id}}.' })
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      makeMockAgent(),
      agentType
    )
    await runner.exposeCreateSession()

    const systemPrompt = sessionSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('Hand work to the manager: m1.')
  })

  it('interpolates the CLI reference into the prompt (cliHelp placeholder)', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue(makeMockSquad())

    const agentType = makeAgentType({ systemPrompt: 'You manage the squad.\n\n' + SQUAD_RULES_INCLUDE })
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      makeMockAgent(),
      agentType
    )
    await runner.exposeCreateSession()

    const systemPrompt = sessionSpy.mock.calls[0][0].systemPrompt
    // The cliHelp placeholder must resolve to the actual CLI reference content.
    expect(systemPrompt).toContain('CLI-REFERENCE-MARKER')
  })

  it('interpolates agent type identity placeholders', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue(makeMockSquad())

    const agentType = makeAgentType({
      systemPrompt: 'You manage the squad.\n\n' + SQUAD_RULES_INCLUDE,
    })
    const runner = new TestableSquadManagerRunner(
      { id: 'e1', agentId: 'm1', message: 'go', imageIds: null } as any,
      makeMockAgent(),
      agentType
    )
    await runner.exposeCreateSession()

    const systemPrompt = sessionSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('Manager (manager)')
  })
})
