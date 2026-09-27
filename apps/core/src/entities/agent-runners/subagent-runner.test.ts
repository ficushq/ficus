import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, inArray, or } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, inbox } from '../../db/schema'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'
import { AgentSession } from '../AgentSession'
import { Execution } from '../Execution'
import { InboxMessage } from '../InboxMessage'
import { Squad } from '../Squad'
import { Subagent } from '../Subagent'
import { SubagentRunner } from './subagent-runner'
import * as sandboxModule from '../../services/sandbox'

let subagentWorkspaceCalls: unknown[] = []
let soloWorkspaceCalls: unknown[] = []
let squadSandboxCalls: unknown[] = []
let squadBashCalls: unknown[][] = []
let sandboxEnsureOrder: string[] = []
let subagentIntegrationTools: any[] = []

class TestSubagentRunner extends SubagentRunner {
  public async deliver(
    resultStatus: 'completed' | 'failed' | 'stopped',
    content: string,
    options?: { completion?: 'explicit' | 'fallback'; status?: 'completed' | 'blocked' }
  ): Promise<void> {
    await this.deliverResultAndSelfTerminate(resultStatus, content, options)
  }

  public requestCompletion(result: string, status?: 'completed' | 'blocked'): void {
    this.completion = { requested: true, result, status }
  }

  public async complete(response: string): Promise<void> {
    this.buffer = { push() {}, close() {}, fail() {} } as any
    await this.onComplete(response, undefined, {} as any)
  }

  public coreToolNames(): string[] {
    return this.createCoreTools({ todoTools: [], shortTermMemoryTools: [] }).map((tool) => tool.name)
  }

  public async systemPromptText(): Promise<string> {
    return this.buildSubagentSystemPrompt()
  }

  public async revivedAfterCompletion(): Promise<boolean> {
    return this.wasRevivedAfterCompletion()
  }

  public exposeCreateSession(scope: any = null): Promise<AgentSession> {
    return this.createSession(scope)
  }

  protected ensureSquadSandbox(squad: any, scope: any, setupProgress?: any): Promise<string> {
    squadSandboxCalls.push({ squad, scope, setupProgress })
    sandboxEnsureOrder.push('squad')
    return Promise.resolve('/tmp/squad-workspace')
  }

  protected createSquadBashTool(...args: any[]): any {
    squadBashCalls.push(args)
    return { name: 'squad_bash', label: 'squad_bash' }
  }

  protected override async resolveIntegrationTools() {
    return subagentIntegrationTools
  }

  protected ensureLightSandbox(args: any): Promise<string> {
    subagentWorkspaceCalls.push(args)
    sandboxEnsureOrder.push('light')
    return Promise.resolve('/tmp/subagent-workspace')
  }

  protected ensureSoloSandbox(args: any): Promise<string> {
    soloWorkspaceCalls.push(args)
    return Promise.resolve('/tmp/solo-workspace')
  }
}

describe('SubagentRunner result delivery', () => {
  let testAgentTypeId: string
  let createdAgentIds: string[]

  beforeEach(async () => {
    testAgentTypeId = `subagent-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    createdAgentIds = []
    await AgentType.create({
      id: testAgentTypeId,
      name: 'Subagent Runner Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
  })

  afterEach(async () => {
    if (createdAgentIds.length) {
      await db
        .delete(inbox)
        .where(or(inArray(inbox.recipientId, createdAgentIds), inArray(inbox.senderId, createdAgentIds)))
      await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('exposes im_done but not notify_contact as a core subagent tool', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id, persist: false })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const execution = new Execution({ id: crypto.randomUUID(), agentId: child.id, status: 'queued' } as any).setAgent(
      child
    )
    const runner = new TestSubagentRunner(execution, child, agentType)

    expect(runner.coreToolNames()).toContain('im_done')
    expect(runner.coreToolNames()).not.toContain('notify_contact')
  })

  it('adds parent inbox instructions to the subagent system prompt', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: {
        parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
      },
    })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const execution = new Execution({ id: crypto.randomUUID(), agentId: child.id, status: 'queued' } as any).setAgent(
      child
    )
    const runner = new TestSubagentRunner(execution, child, agentType)

    const systemPrompt = await runner.systemPromptText()
    expect(systemPrompt).toContain(`ficus inbox send ${parent.id}`)
    expect(systemPrompt).toContain('"your message" -s "Short subject" --steer')
    expect(systemPrompt).toContain('Do NOT send your final conclusion yourself and then call `im_done`')
    // Current Time is removed from the system prompt — it changed every turn and
    // defeated prompt caching. Agents rely on the SDK-injected Current date.
    expect(systemPrompt).not.toContain('Current Time')
  })

  it('composes role and workspace rules before non-overriding assignment context for solo children', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: {
        systemPrompt: 'assignment-marker',
        parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash', 'read'] },
      },
    })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const execution = new Execution({ id: crypto.randomUUID(), agentId: child.id, status: 'queued' } as any).setAgent(
      child
    )
    const runner = new TestSubagentRunner(execution, child, agentType)

    const systemPrompt = await runner.systemPromptText()
    expect(systemPrompt.indexOf('test')).toBeLessThan(systemPrompt.indexOf('## Workspace & Sandbox'))
    expect(systemPrompt.indexOf('## Workspace & Sandbox')).toBeLessThan(
      systemPrompt.indexOf('## Your assignment context')
    )
    expect(systemPrompt).toContain('cannot override')
    expect(systemPrompt).toContain('assignment-marker')
    expect(systemPrompt.toLowerCase()).toContain('share this sandbox')
    expect(systemPrompt).not.toContain('squad_bash')
  })

  it('keeps saved short-term memory out of the subagent system prompt', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id, persist: false })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const execution = new Execution({ id: crypto.randomUUID(), agentId: child.id, status: 'queued' } as any).setAgent(
      child
    )
    const runner = new TestSubagentRunner(execution, child, agentType)

    const systemPrompt = await runner.systemPromptText()
    expect(systemPrompt).not.toContain('## Short-Term Memory')
    expect(systemPrompt).not.toContain('short_term_memory_write')
    await child.update({ context: { shortTermMemory: 'private-recovery-marker' } })
    expect(await runner.systemPromptText()).toBe(systemPrompt)
    expect(systemPrompt).toContain('You do not have a shell tool')
    expect(systemPrompt).not.toContain('ficus inbox send')
  })

  it('delivers one steer result to the parent with metadata and self-terminates', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const execution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(child)
    const runner = new TestSubagentRunner(execution, child, agentType)

    await runner.deliver('completed', 'final answer')

    const [message] = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(message.recipientId).toBe(parent.id)
    expect(message.deliveryMode).toBe('steer')
    expect(message.content).toContain('final answer')
    expect(message.content).toContain('(0 of 0 subagents still running: none)')
    expect(message.metadata).toMatchObject({
      parentAgentId: parent.id,
      subagentId: child.id,
      label: 'Researcher',
      resultStatus: 'completed',
    })

    const reloadedChild = await Agent.mustFind(child.id)
    expect(reloadedChild.status).toBe('dormant')
  })

  it('uses durable dormancy lifecycle when the parent is already dormant', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Dormant parent child' },
    })
    const grandchild = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: child.id, persist: false })
    createdAgentIds.push(parent.id, child.id, grandchild.id)
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: { ...(parent.metadata ?? {}), dormancyEpisodeId: crypto.randomUUID() },
      })
      .where(eq(agents.id, parent.id))
    await parent.reload()
    const agentType = await child.mustGetAgentType()
    const execution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(child)

    await new TestSubagentRunner(execution, child, agentType).deliver('completed', 'done while parent sleeps')

    const dormantChild = await Agent.mustFind(child.id)
    expect(dormantChild.status).toBe('dormant')
    expect(dormantChild.metadata).toMatchObject({
      completionDelivered: true,
      resultStatus: 'completed',
      dormancyEpisodeId: expect.any(String),
    })
    expect(dormantChild.metadata).not.toHaveProperty('dormancyCompletionPending')
    expect((await Agent.mustFind(grandchild.id)).status).toBe('dormant')
  })

  it('uses dormant then final lifecycle when the parent is terminated', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id, persist: false })
    createdAgentIds.push(parent.id, child.id)
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, parent.id))
    const agentType = await child.mustGetAgentType()
    const execution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(child)

    await new TestSubagentRunner(execution, child, agentType).deliver('completed', 'orphaned result')

    const finalChild = await Agent.mustFind(child.id)
    expect(finalChild.status).toBe('terminated')
    expect(finalChild.metadata).toMatchObject({ completionDelivered: true, resultStatus: 'completed' })
    expect(finalChild.metadata).not.toHaveProperty('finalCleanupPending')
  })

  it('delivers explicit completion result metadata from im_done on turn completion', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const execution = await child.queueExecution({ message: 'do work' })
    await child.confirmAllPendingMessages()
    const agentType = await child.mustGetAgentType()
    const runner = new TestSubagentRunner(execution, child, agentType)
    runner.requestCompletion('explicit final', 'blocked')

    await runner.complete('ordinary assistant tail')

    const [message] = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(message.content).toContain('explicit final')
    expect(message.content).not.toContain('ordinary assistant tail')
    expect(message.metadata).toMatchObject({
      completion: 'explicit',
      status: 'blocked',
      resultStatus: 'completed',
    })

    const reloadedChild = await Agent.mustFind(child.id)
    expect(reloadedChild.status).toBe('dormant')
  })

  it('falls back to the assistant response for a single-shot subagent without im_done', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const execution = await child.queueExecution({ message: 'do work' })
    await child.confirmAllPendingMessages()
    const agentType = await child.mustGetAgentType()
    const runner = new TestSubagentRunner(execution, child, agentType)

    await runner.complete('fallback final')

    const [message] = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(message.content).toContain('fallback final')
    expect(message.metadata).toMatchObject({ completion: 'fallback', resultStatus: 'completed' })

    const reloadedChild = await Agent.mustFind(child.id)
    expect(reloadedChild.status).toBe('dormant')
  })

  it('yields without delivering when the subagent messaged its parent this turn', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const execution = await child.queueExecution({ message: 'continue' })
    await child.confirmAllPendingMessages()
    const agentType = await child.mustGetAgentType()
    const runner = new TestSubagentRunner(execution, child, agentType)
    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: parent.id,
      senderType: 'agent',
      senderId: child.id,
      content: 'intermediate question',
      deliveryMode: 'steer',
    })

    await runner.complete('intermediate response')

    const messages = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('intermediate question')
    const reloadedChild = await Agent.mustFind(child.id)
    expect(reloadedChild.terminatedAt).toBeNull()
    expect(reloadedChild.status).toBe('idle')
  })

  it('does not deliver more than one result for duplicate delivery attempts', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const execution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(child)
    const runner = new TestSubagentRunner(execution, child, agentType)

    await runner.deliver('completed', 'first result', { completion: 'explicit' })
    await runner.deliver('failed', 'second result', { completion: 'fallback' })

    const messages = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('first result')

    const reloadedChild = await Agent.mustFind(child.id)
    expect((reloadedChild.metadata as any).completionDelivered).toBe(true)
  })

  it('delivers again after a terminated subagent is revived', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const firstExecution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(child)
    const firstRunner = new TestSubagentRunner(firstExecution, child, agentType)
    await firstRunner.deliver('completed', 'first result', { completion: 'explicit', status: 'completed' })

    await Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'continue' })
    const revivedChild = await Agent.mustFind(child.id)
    const secondExecution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(revivedChild)
    const secondRunner = new TestSubagentRunner(secondExecution, revivedChild, agentType)

    await secondRunner.deliver('completed', 'second result', { completion: 'explicit', status: 'completed' })

    const messages = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(messages).toHaveLength(2)
    expect(messages.some((message) => message.content.includes('first result'))).toBe(true)
    expect(messages.some((message) => message.content.includes('second result'))).toBe(true)
  })

  it('falls back when only old subagent-to-parent messages exist from before this turn', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)
    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: parent.id,
      senderType: 'agent',
      senderId: child.id,
      content: 'old intermediate message',
      deliveryMode: 'steer',
    })

    const execution = await child.queueExecution({ message: 'continue' })
    await child.confirmAllPendingMessages()
    const agentType = await child.mustGetAgentType()
    const runner = new TestSubagentRunner(execution, child, agentType)

    await runner.complete('fallback after old message')

    const messages = await db.select().from(inbox).where(eq(inbox.senderId, child.id))
    expect(messages).toHaveLength(2)
    expect(messages.some((message) => message.content.includes('old intermediate message'))).toBe(true)
    expect(messages.some((message) => message.content.includes('fallback after old message'))).toBe(true)
  })

  it('detects a revival race from a sandbox-waiting execution and pending message', async () => {
    const parent = await Agent.create({ agentTypeId: testAgentTypeId })
    const child = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parent.id,
      persist: false,
      metadata: { label: 'Researcher' },
    })
    createdAgentIds.push(parent.id, child.id)

    const agentType = await child.mustGetAgentType()
    const oldExecution = new Execution({
      id: crypto.randomUUID(),
      agentId: child.id,
      status: 'completed',
    } as any).setAgent(child)
    const runner = new TestSubagentRunner(oldExecution, child, agentType)

    const waitingExecution = await child.queueExecution({ message: 'revived work' })
    await waitingExecution.update({ status: 'waiting-sandbox' })

    expect(await runner.revivedAfterCompletion()).toBe(true)
  })
})

describe('SubagentRunner.createSession squad workspace', () => {
  const TEST_SQUAD_ID = '00000000-0000-4000-8000-000000000201'
  let sessionCreateSpy: any
  let squadFindSpy: any
  let spies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    subagentWorkspaceCalls = []
    soloWorkspaceCalls = []
    squadSandboxCalls = []
    squadBashCalls = []
    sandboxEnsureOrder = []
    subagentIntegrationTools = []
    sessionCreateSpy = spyOn(AgentSession, 'create').mockResolvedValue({} as AgentSession)
    spies.push(sessionCreateSpy)
    spies.push(spyOn(SubagentRunner.prototype as any, 'resolveSkillPaths').mockResolvedValue(undefined))
    spies.push(spyOn(SubagentRunner.prototype as any, 'resolveExtensionPaths').mockReturnValue(undefined))
    spies.push(
      spyOn(sandboxModule, 'createCodingTools').mockReturnValue(
        ['bash', 'read', 'write', 'edit', 'parent_extra'].map((name) => ({ name })) as any
      )
    )
    spies.push(
      spyOn(Agent, 'find').mockImplementation(
        async (id: string) => ({ id, squadId: id === 'parent-1' ? TEST_SQUAD_ID : null }) as any
      )
    )
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: TEST_SQUAD_ID,
      sandboxId: 'squad_legacy_sandbox',
    } as any)
  })

  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies = []
    squadFindSpy?.mockRestore()
  })

  it.each(['missing', 'terminated', 'cyclic', 'cross-squad'])(
    'rejects %s ancestry before sandbox or toolkit side effects',
    async (kind) => {
      const agentId = `invalid-${kind}`
      let sandboxResolutionCalls = 0
      const mockAgent = {
        id: agentId,
        agentTypeId: 'subagent-type',
        squadId: TEST_SQUAD_ID,
        parentAgentId: 'invalid-parent',
        metadata: null,
        modelOverride: null,
        selectedModel: null,
        resolveLiveSandboxOwner: async () => {
          throw new Error(`Invalid sandbox ancestry: ${kind}`)
        },
        getSandboxId: async () => {
          sandboxResolutionCalls += 1
          return 'must-not-resolve'
        },
      } as any
      const mockAgentType = {
        id: 'subagent-type',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'test',
        toolsAllow: null,
        toolsDeny: null,
      } as any
      const runner = new TestSubagentRunner(
        { id: `exec-${kind}`, agentId, message: 'do work', startedAt: new Date() } as any,
        mockAgent,
        mockAgentType
      )

      await expect(runner.exposeCreateSession()).rejects.toThrow(`Invalid sandbox ancestry: ${kind}`)
      expect(sandboxResolutionCalls).toBe(0)
      expect(subagentWorkspaceCalls).toEqual([])
      expect(soloWorkspaceCalls).toEqual([])
      expect(squadSandboxCalls).toEqual([])
      expect((sandboxModule.createCodingTools as ReturnType<typeof spyOn>).mock.calls).toEqual([])
      expect(sessionCreateSpy).not.toHaveBeenCalled()
    }
  )

  it('squad subagent ensures the warm box before the inherited light box and receives squad_bash', async () => {
    const agentId = 'subagent-abc'
    const lightId = 'agent_engineer_parent-1'
    const mockAgent = {
      id: agentId,
      agentTypeId: 'subagent-type',
      squadId: TEST_SQUAD_ID,
      parentAgentId: 'parent-1',
      metadata: {
        parentExecutionContext: {
          version: 1,
          squadId: TEST_SQUAD_ID,
          environmentToolNames: ['bash', 'read', 'write', 'squad_bash', 'webfetch'],
        },
      },
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      resolveLiveSandboxOwner: async () => ({ id: 'parent-1', squadId: TEST_SQUAD_ID }),
      getSandboxId: async () => lightId,
      getEffectiveModelSpec: async (m: string) => m,
      mustGetAgentType: async () => ({
        id: 'subagent-type',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'test',
        earlyMarginTokens: null,
        inFlightMarginTokens: null,
        toolsAllow: null,
        toolsDeny: null,
      }),
    } as any
    const mockAgentType = {
      id: 'subagent-type',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
      earlyMarginTokens: null,
      inFlightMarginTokens: null,
      toolsAllow: null,
      toolsDeny: ['write'],
    } as any
    const mockExecution = { id: 'exec-1', agentId, message: 'do work', startedAt: new Date() } as any
    const runner = new TestSubagentRunner(mockExecution, mockAgent, mockAgentType)
    subagentIntegrationTools = [{ name: 'child_extra' }]

    const admissionScope = {
      assertActive() {},
      // Pass-through runEffect: base.createPiSession routes session creation
      // through AdmissionScope.runEffect (inflight primitives); the fake only
      // needs to invoke the operation.
      runEffect: (_spec: unknown, operation: (context: unknown) => Promise<unknown>) =>
        operation({ signal: new AbortController().signal }),
    } as any
    await runner.exposeCreateSession(admissionScope)

    expect(squadSandboxCalls).toHaveLength(1)
    expect(sandboxEnsureOrder).toEqual(['squad', 'light'])
    const warmProgress = (squadSandboxCalls[0] as any).setupProgress
    expect(warmProgress).toEqual(expect.any(Function))

    // ensureLightSandbox must be called with squadId set (per-agent workspace with squad context)
    expect(subagentWorkspaceCalls).toHaveLength(1)
    expect(subagentWorkspaceCalls[0]).toMatchObject({
      sandboxId: lightId,
      workspaceId: lightId,
      squadId: TEST_SQUAD_ID,
      admissionScope,
    })
    expect((subagentWorkspaceCalls[0] as any).setupProgress).toBe(warmProgress)

    // createCodingTools must receive the squad id as the 4th arg
    const codingCalls = (sandboxModule.createCodingTools as ReturnType<typeof spyOn>).mock.calls
    expect(codingCalls).toHaveLength(1)
    expect(codingCalls[0][3]).toBe(TEST_SQUAD_ID)

    // session sandbox must carry sandboxId and squadId
    const sessionConfig = sessionCreateSpy.mock.calls[0][0]
    expect(sessionConfig.sandbox.sandboxId).toBe(lightId)
    expect(sessionConfig.sandbox.squadId).toBe(TEST_SQUAD_ID)
    expect(sessionConfig.tools.available.map((tool: any) => tool.name)).toEqual([
      'bash',
      'read',
      'webfetch',
      'squad_bash',
    ])
    expect(sessionConfig.systemPrompt).toContain('`bash`')
    expect(sessionConfig.systemPrompt).toContain('`read`')
    expect(sessionConfig.systemPrompt).not.toContain('`write`')
    expect(sessionConfig.systemPrompt).not.toContain('`edit`')
    expect(sessionConfig.systemPrompt).toContain('squad_bash')
    expect(sessionConfig.systemPrompt).toContain('SHARED squad sandbox')
    expect(sessionConfig.systemPrompt).toContain('via the bash tool')
    expect(sessionConfig.systemPrompt.toLowerCase()).toContain('share this sandbox')
    expect(squadBashCalls[0]).toEqual([
      'squad_legacy_sandbox',
      '/tmp/subagent-workspace',
      TEST_SQUAD_ID,
      undefined,
      agentId,
      'exec-1',
    ])
  })

  it('ensures the shared box before the light box for inherited shared file tools without squad_bash', async () => {
    const agentId = 'subagent-file-only'
    const lightId = 'agent_parent-file-only'
    const mockAgent = {
      id: agentId,
      agentTypeId: 'subagent-type',
      squadId: TEST_SQUAD_ID,
      parentAgentId: 'parent-1',
      metadata: {
        parentExecutionContext: { version: 1, squadId: TEST_SQUAD_ID, environmentToolNames: ['read'] },
      },
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      resolveLiveSandboxOwner: async () => ({ id: 'parent-1', squadId: TEST_SQUAD_ID }),
      getSandboxId: async () => lightId,
      getEffectiveModelSpec: async (m: string) => m,
    } as any
    const mockAgentType = {
      id: 'subagent-type',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
      earlyMarginTokens: null,
      inFlightMarginTokens: null,
      toolsAllow: null,
      toolsDeny: null,
    } as any
    const runner = new TestSubagentRunner(
      { id: 'exec-file-only', agentId, message: 'inspect', startedAt: new Date() } as any,
      mockAgent,
      mockAgentType
    )

    await runner.exposeCreateSession()

    expect(sandboxEnsureOrder).toEqual(['squad', 'light'])
    expect(squadBashCalls).toEqual([])
    const sessionConfig = sessionCreateSpy.mock.calls[0][0]
    expect(sessionConfig.tools.available.map((tool: any) => tool.name)).toEqual(['read'])
    expect(sessionConfig.systemPrompt).toContain('`read`')
    expect(sessionConfig.systemPrompt).not.toContain('squad_bash')
  })

  it('solo subagent does NOT pass squadId to createCodingTools or session sandbox', async () => {
    const agentId = 'subagent-solo'
    const lightId = 'agent_engineer_solo-sandbox'
    const mockAgent = {
      id: agentId,
      agentTypeId: 'subagent-type',
      squadId: null,
      parentAgentId: 'parent-solo',
      metadata: {
        parentExecutionContext: {
          version: 1,
          squadId: null,
          environmentToolNames: ['bash', 'read'],
        },
      },
      modelOverride: null,
      selectedModel: null,
      getOrCreateToken: async () => undefined,
      resolveLiveSandboxOwner: async () => ({ id: 'parent-solo', squadId: null }),
      getSandboxId: async () => lightId,
      getEffectiveModelSpec: async (m: string) => m,
      mustGetAgentType: async () => ({
        id: 'subagent-type',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'test',
        earlyMarginTokens: null,
        inFlightMarginTokens: null,
        toolsAllow: null,
        toolsDeny: null,
      }),
    } as any
    const mockAgentType = {
      id: 'subagent-type',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
      earlyMarginTokens: null,
      inFlightMarginTokens: null,
      toolsAllow: null,
      toolsDeny: null,
    } as any
    const mockExecution = { id: 'exec-solo', agentId, message: 'do work', startedAt: new Date() } as any
    const runner = new TestSubagentRunner(mockExecution, mockAgent, mockAgentType)

    await runner.exposeCreateSession()

    // Solo subagent: uses the solo sandbox seam, NOT the squad ensureLightSandbox one,
    // and passes no squadId in the ensure args.
    expect(subagentWorkspaceCalls).toHaveLength(0)
    expect(soloWorkspaceCalls).toHaveLength(1)
    expect(soloWorkspaceCalls[0]).toMatchObject({
      sandboxId: lightId,
      workspaceId: lightId,
      admissionScope: null,
      setupProgress: expect.any(Function),
    })
    expect((soloWorkspaceCalls[0] as { squadId?: string }).squadId).toBeUndefined()

    // createCodingTools must NOT receive a squadId (4th arg undefined)
    const codingCalls = (sandboxModule.createCodingTools as ReturnType<typeof spyOn>).mock.calls
    expect(codingCalls).toHaveLength(1)
    expect(codingCalls[0][3]).toBeUndefined()

    // session sandbox must NOT carry squadId
    const sessionConfig = sessionCreateSpy.mock.calls[0][0]
    expect(sessionConfig.sandbox.sandboxId).toBe(lightId)
    expect(sessionConfig.sandbox.squadId).toBeUndefined()
    expect(sessionConfig.tools.available.map((tool: any) => tool.name)).toEqual(['bash', 'read'])
    expect(sessionConfig.systemPrompt).toContain('`bash`')
    expect(sessionConfig.systemPrompt).toContain('`read`')
    expect(sessionConfig.systemPrompt).not.toContain('`write`')
    expect(sessionConfig.systemPrompt).not.toContain('squad_bash')
    expect(sessionConfig.systemPrompt).toContain('no shared squad workspace')
  })
})
