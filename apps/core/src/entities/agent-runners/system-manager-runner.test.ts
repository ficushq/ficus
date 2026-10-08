import { Squad } from '../Squad'
import * as permissions from '../../services/rbac/permissions'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { SystemManagerRunner } from './system-manager-runner'
import { AgentSession } from '../AgentSession'
import * as tools from '../../tools'
import { assistantEditorInstructionsByKind } from '@ficus/shared'

class TestSystemManagerRunner extends SystemManagerRunner {
  protected override async getPageEditorConversation() {
    return undefined
  }
  protected override async isAssistantDelegate() {
    return false
  }
  batches = 0
  ensured: any
  readonly order: string[] = []

  exposeCreateSession(scope: any = null) {
    return this.createSession(scope)
  }

  get progressListener() {
    return this.sandboxSetupProgress
  }

  protected override async resolveSessionPaths() {
    return {
      sandboxId: 'system_manager_user-1',
      skillPaths: undefined,
      extensionPaths: undefined,
    }
  }

  protected override ensureWorkspaceSandbox(args: any): Promise<string> {
    this.order.push('ensure')
    this.ensured = args
    return Promise.resolve('/private')
  }

  protected override async withSandboxSetupBatch<T>(operation: () => Promise<T>): Promise<T> {
    this.batches++
    return super.withSandboxSetupBatch(operation)
  }

  protected override async buildSessionToolkit() {
    return {
      ficusToken: undefined,
      baseTools: [],
      sandboxStatusTool: {} as any,
      shortTermMemoryTools: [],
    }
  }

  protected override createPiSession(): Promise<any> {
    return Promise.resolve({})
  }
}

describe('SystemManagerRunner sandbox setup', () => {
  afterEach(() => {
    ;(SystemManagerRunner.buildManagerPrompt as any).mockRestore?.()
    ;(tools.getShortTermMemory as any).mockRestore?.()
  })

  it('batches setup before prompt work and forwards its observer', async () => {
    const order: string[] = []
    spyOn(SystemManagerRunner, 'buildManagerPrompt').mockImplementation(async () => {
      order.push('prompt')
      return { systemPrompt: 'manager', model: 'anthropic:claude-sonnet-4-5' }
    })
    spyOn(tools, 'getShortTermMemory').mockResolvedValue('')
    const agent = {
      id: 'manager-1',
      squadId: null,
      selectedModel: null,
      getEffectiveModelSpec: async (model: string) => model,
      getOrCreateToken: async () => undefined,
    } as any
    const agentType = {
      id: 'system-manager',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'manager',
      toolsAllow: null,
      toolsDeny: null,
      earlyMarginTokens: null,
      inFlightMarginTokens: null,
    } as any
    const runner = new TestSystemManagerRunner({ id: 'exec-1' } as any, agent, agentType)

    await runner.exposeCreateSession(null)

    expect(runner.batches).toBe(1)
    expect(runner.ensured).toEqual({
      sandboxId: 'system_manager_user-1',
      workspaceId: 'system_manager_user-1',
      admissionScope: null,
      setupProgress: runner.progressListener,
    })
    expect(runner.order).toEqual(['ensure'])
    expect(order).toEqual(['prompt'])
  })
})

describe('SystemManagerRunner sandbox_status tool gating on runtime', () => {
  class RealToolkitSystemManagerRunner extends SystemManagerRunner {
    assistantDelegate = false
    editor: false | 'workflow' | 'theme' = false
    protected override async getPageEditorConversation() {
      return this.editor
        ? {
            id: 'conversation',
            kind: 'page-editor' as const,
            editor: { kind: this.editor, target: {}, revision: 0, document: {} },
          }
        : { id: 'conversation', kind: 'assistant' as const, editor: null }
    }
    protected override async isAssistantDelegate() {
      return this.assistantDelegate
    }

    exposeCreateSession(scope: any = null) {
      return this.createSession(scope)
    }

    protected override async resolveSessionPaths() {
      return {
        sandboxId: 'system_manager_user-1',
        skillPaths: undefined,
        extensionPaths: undefined,
      }
    }

    protected override ensureWorkspaceSandbox(): Promise<string> {
      return Promise.resolve('/private')
    }

    protected override createCodingTools() {
      return [] as any
    }
  }

  function makeAgentAndType() {
    const agent = {
      id: 'manager-1',
      squadId: null,
      selectedModel: null,
      getEffectiveModelSpec: async (model: string) => model,
      getOrCreateToken: async () => undefined,
    } as any
    const agentType = {
      id: 'system-manager',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'manager',
      toolsAllow: null,
      toolsDeny: null,
      earlyMarginTokens: null,
      inFlightMarginTokens: null,
    } as any
    return { agent, agentType }
  }

  let agentSessionCreateSpy: any
  let buildManagerPromptSpy: any
  let getShortTermMemorySpy: any
  const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME

  beforeEach(() => {
    agentSessionCreateSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as any)
    buildManagerPromptSpy = spyOn(SystemManagerRunner, 'buildManagerPrompt').mockResolvedValue({
      systemPrompt: 'manager',
      model: 'anthropic:claude-sonnet-4-5',
    })
    getShortTermMemorySpy = spyOn(tools, 'getShortTermMemory').mockResolvedValue('')
  })

  afterEach(() => {
    agentSessionCreateSpy.mockRestore()
    buildManagerPromptSpy.mockRestore()
    getShortTermMemorySpy.mockRestore()
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
  })

  function capturedToolNames(): string[] {
    const config = agentSessionCreateSpy.mock.calls[0]?.[0]
    return [...(config.tools.core ?? []), ...(config.tools.available ?? [])].map((tool: any) => tool.name)
  }

  it('does not include sandbox_status on the host runtime', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const { agent, agentType } = makeAgentAndType()
    const runner = new RealToolkitSystemManagerRunner({ id: 'exec-1' } as any, agent, agentType)

    await runner.exposeCreateSession(null)

    expect(capturedToolNames()).not.toContain('sandbox_status')
  })

  it('omits ask_human for Assistant delegates and keeps it in standalone user chats', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const { agent, agentType } = makeAgentAndType()
    const runner = new RealToolkitSystemManagerRunner({ id: 'exec-1' } as any, agent, agentType)
    await runner.exposeCreateSession(null)
    expect(capturedToolNames()).toContain('ask_human')
    const standalonePrompt = agentSessionCreateSpy.mock.calls[0][0].systemPrompt
    agentSessionCreateSpy.mockClear()
    runner.assistantDelegate = true
    await runner.exposeCreateSession(null)
    expect(capturedToolNames()).not.toContain('ask_human')
    expect(capturedToolNames()).toContain('navigate')
    expect(agentSessionCreateSpy.mock.calls[0][0].systemPrompt).toBe(standalonePrompt)
  })

  it('page editor delegates have only draft tools, without shell, dispatch, or catalog mutation tools', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const { agent, agentType } = makeAgentAndType()
    const runner = new RealToolkitSystemManagerRunner({ id: 'exec-1' } as any, agent, agentType)
    runner.assistantDelegate = true
    runner.editor = 'workflow'
    await runner.exposeCreateSession(null)
    expect(capturedToolNames()).toEqual(['read', 'edit'])
  })

  it('selects the system prompt by the open page editor draft kind', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const { agent, agentType } = makeAgentAndType()
    const runner = new RealToolkitSystemManagerRunner({ id: 'exec-1' } as any, agent, agentType)
    runner.assistantDelegate = true
    runner.editor = 'workflow'
    await runner.exposeCreateSession(null)
    expect(agentSessionCreateSpy.mock.calls[0][0].systemPrompt).toBe(assistantEditorInstructionsByKind.workflow)
    agentSessionCreateSpy.mockClear()
    runner.editor = 'theme'
    await runner.exposeCreateSession(null)
    expect(agentSessionCreateSpy.mock.calls[0][0].systemPrompt).toBe(assistantEditorInstructionsByKind.theme)
    expect(assistantEditorInstructionsByKind.theme).not.toBe(assistantEditorInstructionsByKind.workflow)
  })

  it('includes sandbox_status on docker-socket', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    const { agent, agentType } = makeAgentAndType()
    const runner = new RealToolkitSystemManagerRunner({ id: 'exec-1' } as any, agent, agentType)

    await runner.exposeCreateSession(null)

    expect(capturedToolNames()).toContain('sandbox_status')
  })
})

describe('System manager visible squad context', () => {
  it('excludes inaccessible squads and never reads their agents', async () => {
    let hiddenReads = 0
    const list = spyOn(Squad, 'list').mockResolvedValue([
      {
        id: 'visible',
        name: 'Visible squad',
        purpose: 'Visible purpose',
        status: 'active',
        managerAgentId: null,
        getActiveAgents: async () => [],
      },
      {
        id: 'hidden',
        name: 'Private squad',
        purpose: 'Private purpose',
        status: 'active',
        managerAgentId: null,
        getActiveAgents: async () => {
          hiddenReads++
          return []
        },
      },
      {
        id: 'denied',
        name: 'Denied squad',
        purpose: 'Denied purpose',
        status: 'active',
        managerAgentId: null,
        getActiveAgents: async () => {
          hiddenReads++
          return []
        },
      },
    ] as any)
    const access = spyOn(permissions, 'getAccessibleSquadIds').mockResolvedValue(['visible', 'denied'])
    const permit = spyOn(permissions, 'hasPermission').mockImplementation(
      async (_identity, _permission, squadId) => squadId === 'visible'
    )
    try {
      const result = await (SystemManagerRunner as any).buildSquadsContext({ type: 'user', userId: 'user-1' })
      expect(result).toContain('Visible squad')
      expect(result).not.toContain('Private')
      expect(result).not.toContain('Denied')
      expect(hiddenReads).toBe(0)
      const unscoped = await (SystemManagerRunner as any).buildSquadsContext()
      expect(unscoped).not.toContain('Visible squad')
      expect(list).toHaveBeenCalledTimes(1)
    } finally {
      list.mockRestore()
      access.mockRestore()
      permit.mockRestore()
    }
  })
})

describe('SystemManagerRunner Assistant routing', () => {
  const chlea = { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Chlea', purpose: 'The Chlea app' }
  class RoutingRunner extends SystemManagerRunner {
    asked: string[] = []
    constructor(routes: boolean) {
      super({ id: 'exec-1' } as any, { id: 'assistant-1', squadId: null } as any, { id: 'assistant' } as any)
      this.routesAssistantMessages = routes
      this.assistantRoutingDeps = {
        enabled: () => true,
        listSquads: async () => [chlea],
        loadContext: async () => ({ recent: [], assistantAsked: false }),
        decide: async (_purpose, request) => {
          this.asked.push((request.state as { message: string }).message)
          return { ok: false, reason: 'unavailable', errors: [] }
        },
      }
    }
    protected override assistantRoutingIdentity() {
      return { type: 'user' as const, userId: 'user-1' }
    }
    prepare(messages: any[]) {
      return this.prepareMessagesForModel(messages)
    }
  }
  const message = (id: string, content: string, source = 'user_chat') => ({
    id,
    agentId: 'assistant-1',
    role: 'human' as const,
    content,
    metadata: { source },
    pending: true,
    createdAt: new Date(),
  })

  it('routes only the latest user message of a batch; an unanswered decision changes nothing', async () => {
    const batch = [message('m-1', 'first'), message('m-2', 'second'), message('m-3', 'update', 'inbox')]
    const runner = new RoutingRunner(true)
    expect(await runner.prepare(batch)).toEqual(batch)
    expect(runner.asked).toEqual(['second'])
  })

  it('page editors and other runners are never routed', async () => {
    const runner = new RoutingRunner(false)
    const batch = [message('m-1', 'first')]
    expect(await runner.prepare(batch)).toBe(batch)
    expect(runner.asked).toEqual([])
  })
})
