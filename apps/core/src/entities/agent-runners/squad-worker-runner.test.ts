import { flowCompletionInstructions } from '../../services/workflows/completion-prompt'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentType } from '@ficus/shared'
import { AgentSession } from '../AgentSession'
import { Squad } from '../Squad'
import { ArtifactBuilderRunner } from './artifact-builder-runner'
import { SquadWorkerRunner } from './squad-worker-runner'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from './constants'
import * as tools from '../../tools'
import * as cliHelp from '../../lib/utils/cli-help'
import * as memoryPaths from '../../services/memory/paths'
import * as prompts from '../../lib/prompts'
import { createArtifactInAgentWorkspace } from '../../services/artifacts/artifactWorkspace'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { Subagent } from '../Subagent'
import { filterToolsByPolicy } from '../../lib/tools'
import * as workflowExecution from '../../services/workflows/execution'
import { SharedPrompt } from '../SharedPrompt'

const TEST_SQUAD_ID = '00000000-0000-4000-8000-000000000102'

let testArtifactWorkspacePath = ''
let workspaceSandboxCalls: unknown[] = []
let squadSandboxCalls: unknown[] = []
let lightSandboxCalls: unknown[] = []
let codingToolCalls: unknown[] = []
let squadBashCalls: unknown[] = []
let integrationTools: any[] = []

class TestableArtifactBuilderRunner extends ArtifactBuilderRunner {
  exposeCreateSession(): Promise<AgentSession> {
    return this.createSession()
  }

  protected override ensureWorkspaceSandbox(args: any) {
    workspaceSandboxCalls.push(args)
    return Promise.resolve(testArtifactWorkspacePath)
  }

  protected override getAgentWorkspaceStoragePath(): string {
    return testArtifactWorkspacePath
  }

  protected override createCodingTools(workspacePath: string, sandboxId: string) {
    codingToolCalls.push([workspacePath, sandboxId])
    return [{ name: 'bash' }] as any
  }
}

class TestableSquadWorkerRunner extends SquadWorkerRunner {
  exposeCreateSession(): Promise<AgentSession> {
    return this.createSession()
  }

  protected override ensureSquadSandbox(squad: Squad) {
    squadSandboxCalls.push(squad)
    return Promise.resolve('/tmp/squad-workspace')
  }

  protected ensureLightSandbox(args: any) {
    lightSandboxCalls.push(args)
    return Promise.resolve('/tmp/light-workspace')
  }

  protected override createCodingTools(workspacePath: string, sandboxId: string, tauToken?: string, squadId?: string) {
    codingToolCalls.push([workspacePath, sandboxId, tauToken, squadId])
    return [{ name: 'bash' }] as any
  }

  protected createSquadBashTool(warmSandboxId: string, workspaceHostPath: string, squadId: string, tauToken?: string) {
    squadBashCalls.push([warmSandboxId, workspaceHostPath, squadId, tauToken])
    return { name: 'squad_bash', key: 'squad_bash' } as any
  }

  protected override async resolveIntegrationTools() {
    return integrationTools
  }
}

function makeAgentType(overrides: Partial<AgentType> = {}): AgentType {
  return {
    id: 'test-type',
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Test Agent',
    description: null,
    systemPrompt: 'You are a test agent.',
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

function makeTestAgent(overrides: { agentTypeId?: string; squadId?: string | null } = {}) {
  const agent = {
    id: crypto.randomUUID(),
    agentTypeId: 'worker',
    squadId: null,
    metadata: null,
    modelOverride: null,
    selectedModel: null,
    async getOrCreateToken(): Promise<string | undefined> {
      return undefined
    },
    async getSandboxId() {
      return `agent_${this.agentTypeId}_${this.id}`
    },
    async getSquad() {
      return Squad.find(this.squadId as string)
    },
    async getEffectiveModelSpec(model: string) {
      return model
    },
    get runnerType(): string {
      if (this.agentTypeId === ARTIFACT_BUILDER_AGENT_TYPE_ID) return 'artifact-builder'
      if (this.squadId) return this.agentTypeId === 'manager' ? 'squad-manager' : 'squad-worker'
      throw new Error(`Unexpected agent type: ${this.agentTypeId}`)
    },
    ...overrides,
  }
  return agent as any
}

function makeExecution(agentId: string) {
  return {
    id: 'execution-1',
    agentId,
    message: 'test',
    imageIds: null,
  } as any
}

function capturedToolNames(createSpy: any): string[] {
  const config = createSpy.mock.calls[0]?.[0]
  return [...(config.tools.core ?? []), ...(config.tools.available ?? [])].map((tool: any) => tool.name)
}

describe('SquadWorkerRunner artifact tool registration', () => {
  let agentSessionCreateSpy: any
  let getShortTermMemorySpy: any
  let getSquadWorkerCliHelpSpy: any
  let buildActiveSchedulesPromptSpy: any
  let readSquadMemoryFileSpy: any
  let squadFindSpy: any
  let artifactBuilderResolveSkillPathsSpy: any
  let artifactBuilderResolveExtensionPathsSpy: any
  let squadWorkerResolveSkillPathsSpy: any
  let squadWorkerResolveExtensionPathsSpy: any
  let artifactWorkspacePath: string

  beforeEach(async () => {
    artifactWorkspacePath = await mkdtemp(join(tmpdir(), 'tau-artifact-runner-tools-'))
    testArtifactWorkspacePath = artifactWorkspacePath
    workspaceSandboxCalls = []
    squadSandboxCalls = []
    lightSandboxCalls = []
    codingToolCalls = []
    squadBashCalls = []
    integrationTools = []
    agentSessionCreateSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as AgentSession)
    getShortTermMemorySpy = spyOn(tools, 'getShortTermMemory').mockResolvedValue('')
    getSquadWorkerCliHelpSpy = spyOn(cliHelp, 'getSquadWorkerCliHelp').mockResolvedValue('cli help')
    buildActiveSchedulesPromptSpy = spyOn(prompts, 'buildActiveSchedulesPrompt').mockResolvedValue('')
    readSquadMemoryFileSpy = spyOn(memoryPaths, 'readSquadMemoryFile').mockReturnValue('')
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'Test Squad',
      purpose: 'Test purpose',
      defaultAgents: [],
      context: '',
      sandboxId: `squad_${TEST_SQUAD_ID}`,
      managerAgentId: 'manager-1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
    } as any)
    artifactBuilderResolveSkillPathsSpy = spyOn(
      ArtifactBuilderRunner.prototype as any,
      'resolveSkillPaths'
    ).mockResolvedValue(undefined)
    artifactBuilderResolveExtensionPathsSpy = spyOn(
      ArtifactBuilderRunner.prototype as any,
      'resolveExtensionPaths'
    ).mockReturnValue(undefined)
    squadWorkerResolveSkillPathsSpy = spyOn(SquadWorkerRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(
      undefined
    )
    squadWorkerResolveExtensionPathsSpy = spyOn(
      SquadWorkerRunner.prototype as any,
      'resolveExtensionPaths'
    ).mockReturnValue(undefined)
  })

  afterEach(async () => {
    agentSessionCreateSpy?.mockRestore()
    getShortTermMemorySpy?.mockRestore()
    getSquadWorkerCliHelpSpy?.mockRestore()
    buildActiveSchedulesPromptSpy?.mockRestore()
    readSquadMemoryFileSpy?.mockRestore()
    squadFindSpy?.mockRestore()
    artifactBuilderResolveSkillPathsSpy?.mockRestore()
    artifactBuilderResolveExtensionPathsSpy?.mockRestore()
    squadWorkerResolveSkillPathsSpy?.mockRestore()
    squadWorkerResolveExtensionPathsSpy?.mockRestore()
    await rm(artifactWorkspacePath, { recursive: true, force: true })
  })

  it('does not classify artifact builders as squad workers', () => {
    const agent = makeTestAgent({ agentTypeId: 'artifact-builder-default', squadId: null })

    expect(agent.runnerType).toBe('artifact-builder')
  })

  it('composes an enabled shared prompt into the built system prompt, after the agent type prompt', async () => {
    const includeId = `test-include-${crypto.randomUUID()}`
    await SharedPrompt.upsert({ id: includeId, name: 'Test Include', content: 'INCLUDE-CONTENT-MARKER' })
    SharedPrompt.invalidateCache()
    try {
      const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
      const agentType = makeAgentType({
        id: 'worker',
        systemPrompt: 'You are a worker.',
        includes: [includeId],
      }) as AgentType
      const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

      await runner.exposeCreateSession()

      const systemPrompt = agentSessionCreateSpy.mock.calls[0][0].systemPrompt
      const ownIndex = systemPrompt.indexOf('You are a worker.')
      const includeIndex = systemPrompt.indexOf('INCLUDE-CONTENT-MARKER')
      expect(ownIndex).toBeGreaterThanOrEqual(0)
      expect(includeIndex).toBeGreaterThan(ownIndex)
    } finally {
      await SharedPrompt.delete(includeId)
    }
  })

  it('registers artifact tools for artifact builders and passes squad id through', async () => {
    const agent = makeTestAgent({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: ARTIFACT_BUILDER_AGENT_TYPE_ID }) as AgentType
    const runner = new TestableArtifactBuilderRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const expectedSandboxId = `agent_${ARTIFACT_BUILDER_AGENT_TYPE_ID}_${agent.id}`
    expect(workspaceSandboxCalls).toContainEqual({
      sandboxId: expectedSandboxId,
      workspaceId: expectedSandboxId,
      setupProgress: expect.any(Function),
    })
    expect(codingToolCalls).toContainEqual([artifactWorkspacePath, expectedSandboxId])

    expect(capturedToolNames(agentSessionCreateSpy)).toEqual(expect.arrayContaining(['artifact_publish']))
    expect(capturedToolNames(agentSessionCreateSpy)).toEqual(expect.arrayContaining(['artifact_status']))
    expect(capturedToolNames(agentSessionCreateSpy)).toEqual(expect.arrayContaining(['artifact_question']))
    expect(capturedToolNames(agentSessionCreateSpy)).not.toContain('respond_to_voice')
    expect(capturedToolNames(agentSessionCreateSpy)).not.toContain('squad_bash')

    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath: artifactWorkspacePath,
      title: 'Runner report',
      brief: 'Create report',
    })
    await writeFile(join(created.artifactPath, 'report.md'), '# Report\n')

    const publishTool = agentSessionCreateSpy.mock.calls[0][0].tools.available.find(
      (tool: any) => tool.name === 'artifact_publish'
    )
    const events: Array<{ event: string; data: unknown }> = []
    const unsubscribe = eventEmitter.onAny((event, data) => events.push({ event, data }))
    try {
      await publishTool.execute(
        'tool-1',
        {
          artifactId: created.artifactId,
          entry: { type: 'markdown', path: 'report.md' },
          changeSummary: 'Published the report.',
        },
        undefined,
        undefined,
        {} as any
      )

      expect(events).toContainEqual({ event: 'agent.updated', data: { agentId: agent.id, squadId: TEST_SQUAD_ID } })

      events.length = 0
      const statusTool = agentSessionCreateSpy.mock.calls[0][0].tools.available.find(
        (tool: any) => tool.name === 'artifact_status'
      )
      await statusTool.execute(
        'tool-2',
        { artifactId: created.artifactId, status: 'ready', summary: 'Ready for review' },
        undefined,
        undefined,
        {} as any
      )

      expect(events).toContainEqual({ event: 'agent.updated', data: { agentId: agent.id, squadId: TEST_SQUAD_ID } })
    } finally {
      unsubscribe()
    }
  })

  it('uses distinct agent workspaces for artifact builders in the same squad', async () => {
    const agentType = makeAgentType({ id: ARTIFACT_BUILDER_AGENT_TYPE_ID }) as AgentType
    const firstAgent = makeTestAgent({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, squadId: TEST_SQUAD_ID })
    const secondAgent = makeTestAgent({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, squadId: TEST_SQUAD_ID })

    await new TestableArtifactBuilderRunner(makeExecution(firstAgent.id), firstAgent, agentType).exposeCreateSession()
    await new TestableArtifactBuilderRunner(makeExecution(secondAgent.id), secondAgent, agentType).exposeCreateSession()

    expect(workspaceSandboxCalls).toEqual([
      {
        sandboxId: `agent_${ARTIFACT_BUILDER_AGENT_TYPE_ID}_${firstAgent.id}`,
        workspaceId: `agent_${ARTIFACT_BUILDER_AGENT_TYPE_ID}_${firstAgent.id}`,
        setupProgress: expect.any(Function),
      },
      {
        sandboxId: `agent_${ARTIFACT_BUILDER_AGENT_TYPE_ID}_${secondAgent.id}`,
        workspaceId: `agent_${ARTIFACT_BUILDER_AGENT_TYPE_ID}_${secondAgent.id}`,
        setupProgress: expect.any(Function),
      },
    ])
  })

  it('does not register artifact tools for squad workers', async () => {
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    expect(capturedToolNames(agentSessionCreateSpy)).not.toContain('artifact_publish')
    expect(capturedToolNames(agentSessionCreateSpy)).not.toContain('artifact_status')
    expect(capturedToolNames(agentSessionCreateSpy)).not.toContain('artifact_question')
  })

  it('registers structured human questions with the worker execution origin', async () => {
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const execution = makeExecution(agent.id)
    const factory = spyOn(tools, 'createAsyncAskHumanTool')
    try {
      const runner = new TestableSquadWorkerRunner(execution, agent, makeAgentType({ id: 'worker' }))
      await runner.exposeCreateSession()
      expect(capturedToolNames(agentSessionCreateSpy)).toContain('ask_human')
      expect(factory).toHaveBeenCalledWith({
        agentId: agent.id,
        executionId: execution.id,
        flushPersistence: expect.any(Function),
      })
    } finally {
      factory.mockRestore()
    }
  })

  it('registers squad_bash bound to the warm squad box', async () => {
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    // warm box id is squad_<squadId>, NOT the agent's light id
    expect(squadBashCalls).toHaveLength(1)
    expect((squadBashCalls[0] as any[])[0]).toBe(`squad_${TEST_SQUAD_ID}`)
    expect((squadBashCalls[0] as any[])[2]).toBe(TEST_SQUAD_ID)
    expect(capturedToolNames(agentSessionCreateSpy)).toEqual(expect.arrayContaining(['squad_bash']))
  })

  it('captures the exact final policy-filtered environment including dynamic integration tools', async () => {
    integrationTools = [{ name: 'bigbrain_search' }]
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({
      id: 'worker',
      toolsAllow: ['bash', 'squad_bash', 'bigbrain_*'],
      toolsDeny: ['squad_bash'],
    }) as AgentType
    const dispatchSpy = spyOn(Subagent, 'dispatch').mockResolvedValue({ subagents: [] })
    try {
      const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)
      await runner.exposeCreateSession()
      const config = agentSessionCreateSpy.mock.calls[0][0]
      const dispatchTool = config.tools.core.find((tool: any) => tool.name === 'dispatch')
      await dispatchTool.execute('call-1', { subagents: [{ instructions: 'inspect' }] })

      const effectiveParentNames = filterToolsByPolicy(
        config.tools.available,
        config.tools.allow,
        config.tools.deny
      ).map((tool) => tool.name)
      expect(effectiveParentNames).toEqual(['bash', 'bigbrain_search'])
      expect(dispatchSpy.mock.calls[0]?.[0].parentExecutionContext?.environmentToolNames).toEqual(effectiveParentNames)
    } finally {
      dispatchSpy.mockRestore()
    }
  })

  it('uses the per-agent light id (getSandboxId) for coding tools and session sandbox, not squad.sandboxId', async () => {
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const lightId = `agent_worker_${agent.id}`

    // ensureSquadSandbox (warm box) must still be called
    expect(squadSandboxCalls).toHaveLength(1)

    // ensureLightSandbox must be called with the light id and squadId
    expect(lightSandboxCalls).toHaveLength(1)
    expect(lightSandboxCalls[0]).toMatchObject({ sandboxId: lightId, workspaceId: lightId, squadId: TEST_SQUAD_ID })

    // createCodingTools must receive the light id as sandboxId and the squad id as 4th arg
    expect(codingToolCalls).toContainEqual(['/tmp/light-workspace', lightId, undefined, TEST_SQUAD_ID])

    // resolveSkillPaths must be called with the light id (not squad.sandboxId)
    expect(squadWorkerResolveSkillPathsSpy.mock.calls[0]?.[0]).toBe(lightId)

    // AgentSession.create sandbox.sandboxId must be the light id
    const sessionConfig = agentSessionCreateSpy.mock.calls[0][0]
    expect(sessionConfig.sandbox.sandboxId).toBe(lightId)
  })
})

describe('SquadWorkerRunner sandbox_status tool gating on runtime', () => {
  let agentSessionCreateSpy: any
  let getShortTermMemorySpy: any
  let getSquadWorkerCliHelpSpy: any
  let buildActiveSchedulesPromptSpy: any
  let readSquadMemoryFileSpy: any
  let squadFindSpy: any
  let squadWorkerResolveSkillPathsSpy: any
  let squadWorkerResolveExtensionPathsSpy: any
  const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME

  beforeEach(() => {
    squadSandboxCalls = []
    lightSandboxCalls = []
    codingToolCalls = []
    squadBashCalls = []
    integrationTools = []
    agentSessionCreateSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as AgentSession)
    getShortTermMemorySpy = spyOn(tools, 'getShortTermMemory').mockResolvedValue('')
    getSquadWorkerCliHelpSpy = spyOn(cliHelp, 'getSquadWorkerCliHelp').mockResolvedValue('cli help')
    buildActiveSchedulesPromptSpy = spyOn(prompts, 'buildActiveSchedulesPrompt').mockResolvedValue('')
    readSquadMemoryFileSpy = spyOn(memoryPaths, 'readSquadMemoryFile').mockReturnValue('')
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'Test Squad',
      purpose: 'Test purpose',
      defaultAgents: [],
      context: '',
      sandboxId: `squad_${TEST_SQUAD_ID}`,
      managerAgentId: 'manager-1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
    } as any)
    squadWorkerResolveSkillPathsSpy = spyOn(SquadWorkerRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(
      undefined
    )
    squadWorkerResolveExtensionPathsSpy = spyOn(
      SquadWorkerRunner.prototype as any,
      'resolveExtensionPaths'
    ).mockReturnValue(undefined)
  })

  afterEach(() => {
    agentSessionCreateSpy?.mockRestore()
    getShortTermMemorySpy?.mockRestore()
    getSquadWorkerCliHelpSpy?.mockRestore()
    buildActiveSchedulesPromptSpy?.mockRestore()
    readSquadMemoryFileSpy?.mockRestore()
    squadFindSpy?.mockRestore()
    squadWorkerResolveSkillPathsSpy?.mockRestore()
    squadWorkerResolveExtensionPathsSpy?.mockRestore()
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
  })

  it('does not include sandbox_status on the host runtime', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    expect(capturedToolNames(agentSessionCreateSpy)).not.toContain('sandbox_status')
  })

  it('includes sandbox_status on docker-socket', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    expect(capturedToolNames(agentSessionCreateSpy)).toContain('sandbox_status')
  })
})

describe('SquadWorkerRunner typeContext injection', () => {
  let agentSessionCreateSpy: any
  let getShortTermMemorySpy: any
  let getSquadWorkerCliHelpSpy: any
  let buildActiveSchedulesPromptSpy: any
  let readSquadMemoryFileSpy: any
  let squadFindSpy: any
  let squadWorkerResolveSkillPathsSpy: any
  let squadWorkerResolveExtensionPathsSpy: any
  let spies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    agentSessionCreateSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as any)
    getShortTermMemorySpy = spyOn(tools, 'getShortTermMemory').mockResolvedValue('')
    getSquadWorkerCliHelpSpy = spyOn(cliHelp, 'getSquadWorkerCliHelp').mockResolvedValue('cli help')
    buildActiveSchedulesPromptSpy = spyOn(prompts, 'buildActiveSchedulesPrompt').mockResolvedValue('')
    readSquadMemoryFileSpy = spyOn(memoryPaths, 'readSquadMemoryFile').mockReturnValue('')
    squadWorkerResolveSkillPathsSpy = spyOn(SquadWorkerRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(
      undefined
    )
    squadWorkerResolveExtensionPathsSpy = spyOn(
      SquadWorkerRunner.prototype as any,
      'resolveExtensionPaths'
    ).mockReturnValue(undefined)
    spies = [
      agentSessionCreateSpy,
      getShortTermMemorySpy,
      getSquadWorkerCliHelpSpy,
      buildActiveSchedulesPromptSpy,
      readSquadMemoryFileSpy,
      squadWorkerResolveSkillPathsSpy,
      squadWorkerResolveExtensionPathsSpy,
    ]
  })

  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies = []
    squadFindSpy?.mockRestore()
  })

  it('gives generalist flow workers delivery guidance only when ready, without legacy squad routing', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'Custom squad',
      defaultAgents: [],
      purpose: 'Deliver useful work',
      context: '',
      sandboxId: 'sbx',
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: () => null,
    } as any)
    const flowContext = spyOn(workflowExecution, 'flowWorkerContext')
    spies.push(flowContext)
    for (const mode of ['deliverable', 'review-approval', 'pr-merge', 'pr-auto-merge', 'direct-merge'] as const) {
      for (const phase of ['running', 'completion-ready'] as const) {
        flowContext.mockResolvedValue({
          participantId: 'generalist',
          workStreamId: 'ws-example',
          state: { status: phase, definition: { completion: { mode } } },
          deliveryInstructions: phase === 'completion-ready' ? flowCompletionInstructions(mode) : undefined,
        } as any)
        agentSessionCreateSpy.mockClear()
        const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
        const runner = new TestableSquadWorkerRunner(
          makeExecution(agent.id),
          agent,
          makeAgentType({ id: 'worker', systemPrompt: 'Domain expertise.' })
        )
        await runner.exposeCreateSession()
        const systemPrompt = agentSessionCreateSpy.mock.calls[0][0].systemPrompt
        expect(systemPrompt).not.toContain('LEGACY:')
        if (phase === 'running') {
          expect(systemPrompt).not.toContain('Delivery policy:')
          expect(systemPrompt).toContain('evidence as a string')
          expect(systemPrompt).toContain('paused or blocked by an open wait')
          expect(systemPrompt).toContain('deliveryInstructions from the response')
          continue
        }
        expect(systemPrompt).toContain(`Delivery policy: ${mode}.`)
        expect(systemPrompt).toContain('no agent role intrinsically owns PR creation')
        expect(systemPrompt).toContain('ficus workstream finish')
        expect(systemPrompt.includes('metadata.policies.allowAutoMerge')).toBe(mode === 'pr-auto-merge')
        expect(systemPrompt.includes('metadata.policies.allowDirectMerge')).toBe(mode === 'direct-merge')
        if (mode === 'pr-auto-merge' || mode === 'direct-merge') {
          expect(systemPrompt).toContain('a missing flag means permission is not granted')
          expect(systemPrompt).toContain('Do not enable that policy yourself')
        }
        if (mode === 'pr-auto-merge') {
          expect(systemPrompt).toContain('leave the PR open for a human merge')
          expect(systemPrompt).toContain('Never use --admin')
        }
        if (mode === 'direct-merge') expect(systemPrompt).toContain('authorize a revision to pr-merge')
        if (mode === 'deliverable') expect(systemPrompt).toContain('No PR, repository mutation, or additional reviewer')
      }
    }
  })

  it('includes global + worker type-specific context in the system prompt', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: 'GLOBAL-CTX',
      typeContext: { worker: 'WORKER-CTX' },
      sandboxId: 'sbx',
      managerAgentId: 'm1',
      isMemoryEnabled: false,
      getActiveAgents: async () => [],
      getTypeContext: (id: string) => (id === 'worker' ? 'WORKER-CTX' : null),
    } as any)

    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({
      id: 'worker',
      systemPrompt: 'You are a worker. {{squad.context}} wsroot:{{workspaceRoot}}/x',
    }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const systemPrompt = agentSessionCreateSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('GLOBAL-CTX')
    expect(systemPrompt).toContain('WORKER-CTX')
    // Current Time is removed — it changed every turn and defeated prompt caching.
    expect(systemPrompt).not.toContain('Current Time')
    // Squad Manager Agent should be omitted when there is no stable manager entry.
    expect(systemPrompt).not.toContain('Squad Manager Agent')
    // Runtime block must reach the system prompt unconditionally.
    expect(systemPrompt).toContain('squad_bash')
    expect(systemPrompt).toContain('/private')
    // {{workspaceRoot}} resolves to the namespaced shared workspace — no literal leak.
    expect(systemPrompt).toContain(`wsroot:/workspace/${TEST_SQUAD_ID}/x`)
    expect(systemPrompt).not.toContain('{{workspaceRoot}}')
  })

  it('includes only the manager in Squad Manager Agent without volatile status', async () => {
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      name: 'S',
      purpose: 'p',
      defaultAgents: [],
      context: 'GLOBAL-CTX',
      typeContext: null,
      sandboxId: 'sbx',
      managerAgentId: '11111111-0000-4000-8000-000000000001',
      isMemoryEnabled: false,
      getActiveAgents: async () => [
        {
          id: '11111111-0000-4000-8000-000000000001',
          agentTypeId: 'manager',
          metadata: { name: 'Pearl' },
          status: 'active',
        },
        {
          id: '22222222-0000-4000-8000-000000000002',
          agentTypeId: 'engineer',
          metadata: { name: 'Kestrel' },
          status: 'idle',
        },
      ],
      getTypeContext: () => null,
    } as any)

    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker', systemPrompt: 'You are a worker.\n{{teammates}}' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const systemPrompt = agentSessionCreateSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('## Squad Manager Agent')
    expect(systemPrompt).not.toContain('## Squad Teammates')
    expect(systemPrompt).toContain('- Pearl (manager) [11111111] — Manager')
    expect(systemPrompt).not.toContain('Kestrel')
    expect(systemPrompt).not.toContain('Worker')
    expect(systemPrompt).not.toContain('active')
    // The runtime contract may discuss idle exit; only teammate status is omitted.
    expect(systemPrompt).not.toContain('Kestrel (engineer)')
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
    } as any)

    const agent = makeTestAgent({ agentTypeId: 'worker', squadId: TEST_SQUAD_ID })
    const agentType = makeAgentType({ id: 'worker', systemPrompt: 'You are a worker.' }) as AgentType
    const runner = new TestableSquadWorkerRunner(makeExecution(agent.id), agent, agentType)

    await runner.exposeCreateSession()

    const systemPrompt = agentSessionCreateSpy.mock.calls[0][0].systemPrompt
    expect(systemPrompt).not.toContain('Type-Specific Context')
  })
})
