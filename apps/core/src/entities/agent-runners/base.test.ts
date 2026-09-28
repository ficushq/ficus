import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import type { SessionUsage, MessageMetadata, Message } from '@ficus/shared'
import { AgentRunner, getSquadAgentTypeSkills } from './base'
import { MockAgentSession, makeAgent, makeAgentType } from '../../services/execution/test-helpers'
import { StreamBuffer } from '../../services/streaming/buffer'
import * as sessionState from '../../services/execution/session-state'
import * as modelSelection from '../../services/model-selection'
import * as accountStore from '../../services/agent/account-store'
import { getModelRuntime, refreshModelRuntime } from '../../services/agent/auth-backend'
import * as AgentModule from '../Agent'
import { providerHealth } from '../../services/provider-health/registry'
import { Image } from '../Image'
import { AgentSession } from '../AgentSession'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'
import { Execution } from '../Execution'
import { db } from '../../db'
import {
  agents,
  agentTypes as agentTypeRows,
  executions,
  messages,
  secrets as secretRows,
  skills as skillRows,
} from '../../db/schema'
import * as inboxDelivery from '../../services/inbox/inboxDelivery'
import { Skill } from '../Skill'
import * as rbacPermissions from '../../services/rbac/permissions'
import { turnHooks } from '../../services/turn-hooks'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { classifyProviderError } from '../../lib/error'
import { META_COUNT, META_LAST_AT } from '../../services/sandbox/restart/types'
import { SessionMessagePersistence } from './session-message-persistence'
import { executionLifecycleRegistry } from '../../services/execution/lifecycle-registry'
import { getSecretStore, resetSecretStore } from '../../services/secrets'
import { STORED_SECRET_TOOL_REFUSAL } from '../../services/security/stored-secret-tool-containment'
import { getSettingsStore } from '../../services/settings'
import {
  isolateOpenRouterTestState,
  restoreOpenRouterTestState,
  type OpenRouterTestStateSnapshot,
} from '../../test-utils/openrouter-test-state'

function assistantMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
  }
}

function persistAssistant(mockSession: MockAgentSession, text: string, entryId = `entry-${Date.now()}`): void {
  const message = assistantMessage(text)
  mockSession.pi.emit({ type: 'message_end', message } as any)
  mockSession.pi.emit({ type: 'session_message_persisted', message, entryId, sessionFile: 'test.jsonl' } as any)
}

function persistUser(mockSession: MockAgentSession, content: string, entryId = `entry-${Date.now()}`): void {
  const message = { role: 'user', content }
  mockSession.pi.emit({ type: 'message_end', message } as any)
  mockSession.pi.emit({ type: 'session_message_persisted', message, entryId, sessionFile: 'test.jsonl' } as any)
}

async function waitForCondition(check: () => Promise<boolean>, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition')
}

// ---------------------------------------------------------------------------
// Mock Execution factory
// ---------------------------------------------------------------------------

function makeExecution(overrides: Partial<Execution> = {}, agentRef?: { current: any }): Execution {
  // Use 'any' to bypass private property restrictions in mock
  const exec: any = {
    id: 'exec-test-1',
    agentId: 'test-agent-1',
    status: 'running',
    message: 'test',
    imageIds: null,
    usage: null,
    error: null,
    startedAt: new Date(),
    endedAt: null,
    // Allow tests to set a "next status" that reload() will apply
    _nextStatus: null as string | null,
    _agent: null as any,
    ...overrides,
  }

  // Add instance methods
  exec.update = async (input: any) => {
    Object.assign(exec, input)
    return exec
  }
  exec.reload = async () => {
    // If a next status was set by the test, apply it
    if (exec._nextStatus) {
      exec.status = exec._nextStatus
      exec._nextStatus = null
    }
    return exec
  }
  exec.toJson = () => ({ ...exec })

  // Transition methods - need access to agent
  exec.mustGetAgent = async () => {
    if (exec._agent) return exec._agent
    if (agentRef?.current) {
      exec._agent = agentRef.current
      return exec._agent
    }
    throw new Error('Agent not set on mock execution')
  }
  exec.setAgent = (agent: any) => {
    exec._agent = agent
    return exec
  }
  exec.start = async () => {
    if (exec.status !== 'queued') return false
    exec.status = 'running'
    const agent = await exec.mustGetAgent()
    await agent.update({ status: 'active' })
    return true
  }
  exec.complete = async (usage?: any) => {
    exec.status = 'completed'
    exec.endedAt = new Date()
    exec.usage = usage ?? null
    const agent = await exec.mustGetAgent()
    await agent.update({ status: 'idle' })
  }
  exec.fail = async (error: string) => {
    exec.status = 'failed'
    exec.endedAt = new Date()
    exec.error = error
    const agent = await exec.mustGetAgent()
    await agent.update({ status: 'idle' })
  }
  exec.stop = async () => {
    exec.status = 'stopped'
    exec.endedAt = new Date()
    const agent = await exec.mustGetAgent()
    await agent.update({ status: 'idle' })
  }
  exec.requestStop = async () => {
    exec.status = 'stopping'
  }

  return exec as Execution
}

// ---------------------------------------------------------------------------
// Concrete test subclass
// ---------------------------------------------------------------------------

interface DeferredWaiter<T> {
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: T) => void
}

class TestRunner extends AgentRunner {
  mockSession: MockAgentSession
  completeCalls: Array<{ response: string; metadata?: MessageMetadata; usage: SessionUsage }> = []
  /** Captures audit writes through the protected seam so symbolic IDs never reach UUID columns. */
  storedSecretAudits: Array<{ agentId: string; executionId: string; secretKey: string; outcome: string }> = []
  // Test seams for the sandbox-wait-indicator timing (see "execution_phase" describe block below).
  // Real timers only: setupOperationDelaysMs reports blocking sandbox work, while
  // postSandboxDelayMs simulates unrelated session construction after setup is current.
  setupOperationDelaysMs: number[] = []
  postSandboxDelayMs = 0
  failSession = false
  failSessionMessage = 'sandbox ensure failed'
  stopCalledAfterSystemMessage = false
  private failoverAttemptWaiters: Array<DeferredWaiter<boolean>> = []
  private executionFailureWaiters: Array<DeferredWaiter<void>> = []
  private stopSettlementWaiters: Array<DeferredWaiter<void>> = []

  constructor(execution: Execution, agent: any, agentType: any, mockSession: MockAgentSession) {
    super(execution, agent, agentType)
    this.mockSession = mockSession

    const failExecution = execution.fail.bind(execution)
    execution.fail = async (error: string, admissionLease) => {
      try {
        return await failExecution(error, admissionLease)
      } finally {
        this.settleNextWaiter(this.executionFailureWaiters, undefined)
      }
    }

    const stopExecution = execution.stop.bind(execution)
    execution.stop = async () => {
      this.stopCalledAfterSystemMessage = (agent.recordMessage as any).mock.calls.some(
        (call: any[]) => call[0]?.content === '[System] Agent was stopped.'
      )
      await stopExecution()
    }
  }

  protected async createSession(): Promise<AgentSession> {
    await this.withSandboxSetupBatch(async () => {
      await Promise.all(
        this.setupOperationDelaysMs.map(async (delayMs, index) => {
          const operationId = `test-setup-${index}`
          this.sandboxSetupProgress({
            type: 'started',
            operationId,
            sandboxId: this.agent.id,
            reason: 'runtime_start',
          })
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          this.sandboxSetupProgress({
            type: 'finished',
            operationId,
            sandboxId: this.agent.id,
            outcome: this.failSession ? 'failed' : 'ready',
          })
        })
      )
      if (this.failSession) throw new Error(this.failSessionMessage)
    })
    if (this.postSandboxDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.postSandboxDelayMs))
    }
    return this.mockSession as any
  }

  protected override recordStoredSecretToolAudit(input: {
    agentId: string
    executionId: string
    secretKey: string
    outcome: string
  }): Promise<void> {
    this.storedSecretAudits.push(input)
    return Promise.resolve()
  }

  async waitForPersistence(): Promise<void> {
    await this.persistence.waitForAll()
  }

  waitForNextFailoverAttempt(candidateDiagnostics?: () => unknown): Promise<boolean> {
    return this.createWaiter(this.failoverAttemptWaiters, 'Failover did not settle', candidateDiagnostics)
  }

  waitForNextExecutionFailure(): Promise<void> {
    return this.createWaiter(this.executionFailureWaiters, 'Execution failure did not settle')
  }

  async beginFailoverTurn(priorityList: string, selectedSpec: string): Promise<void> {
    await this.failover.beginTurn(priorityList, selectedSpec)
  }

  get failoverCountThisTurn(): number {
    return (this.failover as any).failoverCountThisTurn
  }

  waitForNextStopSettlement(): Promise<void> {
    return this.createWaiter(this.stopSettlementWaiters, 'Stop settlement did not complete')
  }

  cleanupPendingWaiters(): void {
    for (const waiter of [
      ...this.failoverAttemptWaiters,
      ...this.executionFailureWaiters,
      ...this.stopSettlementWaiters,
    ]) {
      clearTimeout(waiter.timeout)
    }
    this.failoverAttemptWaiters.length = 0
    this.executionFailureWaiters.length = 0
    this.stopSettlementWaiters.length = 0
  }

  private createWaiter<T>(
    waiters: Array<DeferredWaiter<T>>,
    timeoutMessage: string,
    candidateDiagnostics?: () => unknown
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const waiter: DeferredWaiter<T> = {
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(
            new Error(
              `${timeoutMessage}: ${JSON.stringify({
                currentSelectedSpec: (this as any).currentSelectedSpec,
                setModelAttempts: this.mockSession.pi.setModelCalls.length,
                promptAttempts: this.mockSession.pi.promptCalls.length,
                executionStatus: this.execution.status,
                candidateDiagnostics: candidateDiagnostics?.(),
              })}`
            )
          )
        }, 2_000),
        resolve,
      }
      waiters.push(waiter)
    })
  }

  private settleNextWaiter<T>(waiters: Array<DeferredWaiter<T>>, value: T): void {
    const waiter = waiters.shift()
    if (!waiter) return
    clearTimeout(waiter.timeout)
    waiter.resolve(value)
  }

  protected override async attemptFailover(error: unknown): Promise<boolean> {
    try {
      const result = await super.attemptFailover(error)
      this.settleNextWaiter(this.failoverAttemptWaiters, result)
      return result
    } catch (error) {
      this.settleNextWaiter(this.failoverAttemptWaiters, false)
      throw error
    }
  }

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    this.completeCalls.push({ response, metadata, usage: sessionUsage })
  }

  protected override async onStopCleanup(): Promise<void> {
    this.settleNextWaiter(this.stopSettlementWaiters, undefined)
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AgentRunner (base class)', () => {
  let mockSession: MockAgentSession
  let agent: ReturnType<typeof makeAgent>
  let agentType: ReturnType<typeof makeAgentType>
  let execution: Execution
  let runner: TestRunner
  // Agent ref for mock execution to access
  const agentRef: { current: any } = { current: null }

  // Spies
  let registerSessionSpy: any
  let removeSessionSpy: any
  let isSessionActiveSpy: any
  let createBufferSpy: any
  let recordMessageSpy: any
  let listMessagesSpy: any
  let updateExecutionSpy: any
  let updateAgentSpy: any
  let listPendingHumanMessagesSpy: any
  let markPendingHumanMessagesStrandedRetrySpy: any
  let listPendingInterventionsForSessionDeliverySpy: any
  let claimInitialPendingMessagesForSessionDeliverySpy: any
  let claimPendingInterventionForSessionDeliverySpy: any
  let resetPendingInterventionSessionDeliverySpy: any
  let queueExecutionSpy: any
  let deliverInboxMessagesToAgentSpy: any
  let resolvePermissionsSpy: any
  let loadImagesSpy: any
  let markImagesUsedSpy: any
  let markImagesFailedSpy: any

  beforeEach(() => {
    mockSession = new MockAgentSession()
    agent = makeAgent()
    agentRef.current = agent
    agentType = makeAgentType()
    execution = makeExecution({ agentId: agent.id }, agentRef)

    // Mock session-state
    const buffer = new StreamBuffer()
    createBufferSpy = spyOn(sessionState, 'createBuffer').mockReturnValue(buffer)
    registerSessionSpy = spyOn(sessionState, 'registerSession').mockImplementation(() => {})
    removeSessionSpy = spyOn(sessionState, 'removeSession').mockImplementation(() => {})
    isSessionActiveSpy = spyOn(sessionState, 'isSessionActive').mockReturnValue(true)

    // Mock agent messages methods
    recordMessageSpy = spyOn(agent, 'recordMessage').mockResolvedValue({
      id: 'msg-1',
      agentId: agent.id,
      role: 'assistant',
      content: '',
      metadata: null,
      pending: false,
      createdAt: new Date(),
    } as Message)
    listMessagesSpy = spyOn(agent, 'listMessages').mockResolvedValue({
      messages: [],
      pagination: { hasMore: false, totalCount: 0 },
    })
    listPendingHumanMessagesSpy = spyOn(agent, 'listPendingHumanMessages').mockResolvedValue([])
    markPendingHumanMessagesStrandedRetrySpy = spyOn(agent, 'markPendingHumanMessagesStrandedRetry').mockResolvedValue()
    listPendingInterventionsForSessionDeliverySpy = spyOn(
      agent,
      'listPendingInterventionsForSessionDelivery'
    ).mockResolvedValue([])
    claimInitialPendingMessagesForSessionDeliverySpy = spyOn(
      agent,
      'claimInitialPendingMessagesForSessionDelivery'
    ).mockResolvedValue([])
    claimPendingInterventionForSessionDeliverySpy = spyOn(agent, 'claimPendingInterventionForSessionDelivery')
    resetPendingInterventionSessionDeliverySpy = spyOn(
      agent,
      'resetPendingInterventionSessionDelivery'
    ).mockResolvedValue()
    queueExecutionSpy = spyOn(agent, 'queueExecution').mockResolvedValue(makeExecution({ status: 'queued' }, agentRef))
    deliverInboxMessagesToAgentSpy = spyOn(inboxDelivery, 'deliverInboxMessagesToAgent').mockResolvedValue()

    // Spy on execution.update
    updateExecutionSpy = spyOn(execution, 'update')

    // Mock agents - update the agent object when static update is called
    updateAgentSpy = spyOn(Agent, 'update').mockImplementation(async (id: string, updates: any) => {
      Object.assign(agent, updates)
      return agent as any
    })

    // Mock Image entity static methods
    loadImagesSpy = spyOn(Image, 'loadManyForAgent').mockResolvedValue([])
    markImagesUsedSpy = spyOn(Image, 'markManyUsed').mockResolvedValue(undefined as any)
    markImagesFailedSpy = spyOn(Image, 'markManyFailed').mockResolvedValue(undefined as any)

    runner = new TestRunner(execution, agent, agentType, mockSession)
  })

  afterEach(() => {
    runner?.cleanupPendingWaiters()
    // Restore all spies
    registerSessionSpy?.mockRestore()
    removeSessionSpy?.mockRestore()
    isSessionActiveSpy?.mockRestore()
    createBufferSpy?.mockRestore()
    recordMessageSpy?.mockRestore()
    listMessagesSpy?.mockRestore()
    updateExecutionSpy?.mockRestore()
    updateAgentSpy?.mockRestore()
    loadImagesSpy?.mockRestore()
    markImagesUsedSpy?.mockRestore()
    markImagesFailedSpy?.mockRestore()
    listPendingHumanMessagesSpy?.mockRestore()
    markPendingHumanMessagesStrandedRetrySpy?.mockRestore()
    listPendingInterventionsForSessionDeliverySpy?.mockRestore()
    claimInitialPendingMessagesForSessionDeliverySpy?.mockRestore()
    claimPendingInterventionForSessionDeliverySpy?.mockRestore()
    resetPendingInterventionSessionDeliverySpy?.mockRestore()
    queueExecutionSpy?.mockRestore()
    deliverInboxMessagesToAgentSpy?.mockRestore()
    resolvePermissionsSpy?.mockRestore()
    eventEmitter.removeAllListeners()
  })

  describe('resolveSkillRefs()', () => {
    async function seedGatedSkills(): Promise<void> {
      await db.delete(skillRows)
      await Skill.upsert({ id: 'open-skill', name: 'Open', content: '# Open\n' })
      await Skill.upsert({
        id: 'logs-skill',
        name: 'Logs',
        content: '# Logs\n',
        requiredPermission: 'system:logs',
      })
      await Skill.upsert({
        id: 'secrets-skill',
        name: 'Secrets',
        content: '# Secrets\n',
        requiredPermission: 'secrets:read',
      })
      Skill.invalidateCache()
    }

    it('keeps ungated skills and drops gated skills the agent lacks', async () => {
      await seedGatedSkills()
      agentType.skills = ['open-skill', 'logs-skill', 'secrets-skill']
      resolvePermissionsSpy = spyOn(rbacPermissions, 'resolvePermissions').mockResolvedValue([])

      const refs = await (runner as any).resolveSkillRefs()

      expect(refs).toEqual(['open-skill'])
      expect(resolvePermissionsSpy).toHaveBeenCalledWith({ type: 'agent', agentId: agent.id, squadId: null }, undefined)
    })

    it('includes a gated skill when the agent holds the permission', async () => {
      await seedGatedSkills()
      agentType.skills = ['open-skill', 'logs-skill', 'secrets-skill']
      resolvePermissionsSpy = spyOn(rbacPermissions, 'resolvePermissions').mockResolvedValue(['system:logs'])

      const refs = await (runner as any).resolveSkillRefs()

      expect(refs).toEqual(['open-skill', 'logs-skill'])
    })

    it('keeps missing skill refs and avoids permission lookup when no referenced skills are gated', async () => {
      await db.delete(skillRows)
      await Skill.upsert({ id: 'open-skill', name: 'Open', content: '# Open\n' })
      Skill.invalidateCache()
      agentType.skills = ['open-skill', 'missing-skill']
      resolvePermissionsSpy = spyOn(rbacPermissions, 'resolvePermissions').mockResolvedValue([])

      const refs = await (runner as any).resolveSkillRefs()

      expect(refs).toEqual(['open-skill', 'missing-skill'])
      expect(resolvePermissionsSpy).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // run() lifecycle
  // ---------------------------------------------------------------------------

  describe('run()', () => {
    it('exposes runner-owned maintenance fallback that settles persistence before lifecycle', async () => {
      const lifecycle = executionLifecycleRegistry.registerProvisional(execution.id, agent.id, 0)
      lifecycle.markRunnerStarted()
      const order: string[] = []
      let waitStarted!: () => void
      const started = new Promise<void>((resolve) => (waitStarted = resolve))
      let settlePersistence!: () => void
      const persistenceGate = new Promise<void>((resolve) => (settlePersistence = resolve))
      const markSpy = spyOn(SessionMessagePersistence.prototype, 'markActiveToolAborted').mockImplementation(
        async () => void order.push('active-tool-aborted')
      )
      const waitSpy = spyOn(SessionMessagePersistence.prototype, 'waitForAll').mockImplementation(async () => {
        order.push('persistence-wait-started')
        waitStarted()
        await persistenceGate
        order.push('persistence-settled')
      })

      try {
        await runner.run()
        const fallback = lifecycle.runFallbackSettlement()
        await started
        expect(executionLifecycleRegistry.get(execution.id)).toBe(lifecycle)
        settlePersistence()
        expect(await fallback).toBe(true)

        expect(order).toEqual(['active-tool-aborted', 'persistence-wait-started', 'persistence-settled'])
        // Persistence settlement alone cannot remove the lifecycle while the
        // original runner/setup path is still alive.
        expect(executionLifecycleRegistry.get(execution.id)).toBe(lifecycle)
        lifecycle.markRunnerFinished()
        expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
      } finally {
        markSpy.mockRestore()
        waitSpy.mockRestore()
        lifecycle.settle()
      }
    })

    it('registers session and pushes agent event', async () => {
      await runner.run()

      expect(registerSessionSpy).toHaveBeenCalledTimes(1)
      const registeredSession = registerSessionSpy.mock.calls[0]
      expect(registeredSession[0]).toBe(agent.id)
    })

    it('sends prompt to session', async () => {
      await runner.run()

      expect(mockSession.pi.promptCalls).toHaveLength(1)
      expect(mockSession.pi.promptCalls[0].text).toBe('test')
    })

    it('uses claimed pending messages as the initial prompt', async () => {
      const normalMessage = {
        id: 'normal-message',
        agentId: agent.id,
        role: 'human',
        content: 'normal queued message',
        metadata: null,
        pending: true,
        createdAt: new Date(),
      } as Message
      const steerMessage = {
        id: 'steer-message',
        agentId: agent.id,
        role: 'human',
        content: 'steer content',
        metadata: { deliveryMode: 'steer' },
        pending: true,
        createdAt: new Date(),
      } as Message
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([normalMessage, steerMessage])

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(mockSession.pi.promptCalls[0]?.text).toBe('normal queued message\n\nsteer content')
      expect(mockSession.pi.steerCalls).toEqual([])
      expect(listMessagesSpy).not.toHaveBeenCalled()
    })

    it('drains pending interventions from the DB queue after session registration', async () => {
      const steer = {
        id: 'pending-steer',
        agentId: agent.id,
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
        createdAt: new Date(),
      } as Message
      const followUp = {
        ...steer,
        id: 'pending-follow-up',
        content: 'queued follow-up',
        metadata: { deliveryMode: 'follow-up' },
      } as Message
      listPendingInterventionsForSessionDeliverySpy.mockResolvedValue([steer, followUp])
      claimPendingInterventionForSessionDeliverySpy.mockResolvedValueOnce(steer).mockResolvedValueOnce(followUp)

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(listPendingInterventionsForSessionDeliverySpy).toHaveBeenCalled()
      expect(claimPendingInterventionForSessionDeliverySpy.mock.calls.map((call: any[]) => call[0])).toEqual([
        'pending-steer',
        'pending-follow-up',
      ])
      expect(mockSession.pi.steerCalls).toEqual(['queued steer'])
      expect(mockSession.pi.followUpCalls).toEqual(['queued follow-up'])
    })

    it('delivers a pending steer exactly once as the initial prompt', async () => {
      const steer = {
        id: 'pending-steer',
        agentId: agent.id,
        role: 'human',
        content: 'do X',
        metadata: { deliveryMode: 'steer' },
        pending: true,
        createdAt: new Date(),
      } as Message
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([steer])

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(mockSession.pi.promptCalls).toHaveLength(1)
      expect(mockSession.pi.promptCalls[0].text).toBe('do X')
      expect(mockSession.pi.steerCalls).toEqual([])
    })

    it('claims all immediate pending messages into the initial prompt', async () => {
      const currentPrompt = {
        id: 'current-prompt',
        agentId: agent.id,
        role: 'human',
        content: 'test',
        metadata: null,
        pending: true,
        createdAt: new Date(),
      } as Message
      const queuedMessage = {
        id: 'queued-message',
        agentId: agent.id,
        role: 'human',
        content: 'queued after prompt',
        metadata: null,
        pending: true,
        createdAt: new Date(),
      } as Message
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([currentPrompt, queuedMessage])
      const confirmByIdSpy = spyOn(agent, 'confirmPendingMessage').mockResolvedValue(null as any)

      await runner.run()
      persistUser(mockSession, 'test\n\nqueued after prompt')
      await new Promise((r) => setTimeout(r, 50))

      expect(claimInitialPendingMessagesForSessionDeliverySpy).toHaveBeenCalledTimes(1)
      expect(claimPendingInterventionForSessionDeliverySpy).not.toHaveBeenCalled()
      expect(mockSession.pi.promptCalls).toHaveLength(1)
      expect(mockSession.pi.promptCalls[0].text).toBe('test\n\nqueued after prompt')
      expect(mockSession.pi.steerCalls).toEqual([])
      expect(confirmByIdSpy).toHaveBeenCalledTimes(2)
      const identities = confirmByIdSpy.mock.calls.map(([, identity]) => identity)
      expect(identities[0]).toEqual({ executionId: 'exec-test-1', streamGroupId: expect.any(String) })
      expect(identities[1]).toEqual(identities[0])
      expect(confirmByIdSpy.mock.calls.map(([messageId]) => messageId)).toEqual(['current-prompt', 'queued-message'])
      confirmByIdSpy.mockRestore()
    })

    it('drains newly-created pending interventions from the DB queue while the session is active', async () => {
      const steer = {
        id: 'pending-steer',
        agentId: agent.id,
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
        createdAt: new Date(),
      } as Message
      listPendingInterventionsForSessionDeliverySpy.mockResolvedValueOnce([]).mockResolvedValueOnce([steer])
      claimPendingInterventionForSessionDeliverySpy.mockResolvedValueOnce(steer)

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))
      eventEmitter.emit('message.created', { agentId: agent.id, messageId: steer.id })
      await new Promise((r) => setTimeout(r, 0))

      expect(mockSession.pi.steerCalls).toEqual(['queued steer'])
    })

    it('starts pending-message delivery only after the initial prompt call', async () => {
      const steer = {
        id: 'pending-steer',
        agentId: agent.id,
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
        createdAt: new Date(),
      } as Message
      const callOrder: string[] = []
      listPendingInterventionsForSessionDeliverySpy.mockResolvedValue([steer])
      claimPendingInterventionForSessionDeliverySpy.mockResolvedValueOnce(steer)
      mockSession.pi.prompt = mock(async (text: string, options?: any) => {
        callOrder.push('prompt')
        mockSession.pi.promptCalls.push({ text, options })
      }) as any
      mockSession.pi.steer = mock(async (text: string) => {
        callOrder.push(`steer:${text}`)
        mockSession.pi.steerCalls.push(text)
      }) as any

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(callOrder).toEqual(['prompt', 'steer:queued steer'])
    })

    it('does not bulk-confirm pending rows on first neutral-prompt output before the drain claims them', async () => {
      let releaseList: (messages: Message[]) => void = () => {}
      listPendingInterventionsForSessionDeliverySpy.mockImplementation(
        () => new Promise<Message[]>((resolve) => (releaseList = resolve))
      )
      const confirmAllSpy = spyOn(agent, 'confirmAllPendingMessages').mockResolvedValue(0)

      try {
        await runner.run()
        mockSession.pi.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'neutral prompt output' },
        } as any)
        await new Promise((r) => setTimeout(r, 0))

        expect(confirmAllSpy).not.toHaveBeenCalled()
      } finally {
        releaseList([])
        await new Promise((r) => setTimeout(r, 0))
        confirmAllSpy.mockRestore()
      }
    })

    it('resets injectedAt and handles the drain rejection when SDK injection fails', async () => {
      const steer = {
        id: 'pending-steer',
        agentId: agent.id,
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
        createdAt: new Date(),
      } as Message
      listPendingInterventionsForSessionDeliverySpy.mockResolvedValue([steer])
      claimPendingInterventionForSessionDeliverySpy.mockResolvedValueOnce(steer)
      mockSession.pi.steer = mock(async () => {
        throw new Error('sdk rejected steer')
      }) as any

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(resetPendingInterventionSessionDeliverySpy).toHaveBeenCalledWith('pending-steer')
      expect(mockSession.pi.steer).toHaveBeenCalledWith('queued steer', undefined)
    })

    it('skips pending intervention queue delivery when the session is no longer active', async () => {
      isSessionActiveSpy.mockReturnValue(false)
      listPendingInterventionsForSessionDeliverySpy.mockResolvedValue([
        {
          id: 'pending-steer',
          agentId: agent.id,
          role: 'human',
          content: 'queued steer',
          metadata: { deliveryMode: 'steer' },
          pending: true,
          createdAt: new Date(),
        } as Message,
      ])

      await runner.run()
      await (runner as any).interventionQueue.drainQueue()

      expect(listPendingInterventionsForSessionDeliverySpy).not.toHaveBeenCalled()
      expect(mockSession.pi.steerCalls).toEqual([])
    })

    it('disposes the session if setup fails before session registration', async () => {
      let disposed = false
      ;(mockSession as any).dispose = () => {
        disposed = true
      }
      spyOn(agent, 'getEffectiveModelSpec').mockRejectedValue(new Error('model selection failed'))

      await expect(runner.run()).rejects.toThrow('model selection failed')

      expect(registerSessionSpy).not.toHaveBeenCalled()
      expect(removeSessionSpy).toHaveBeenCalledWith(agent.id)
      expect(disposed).toBe(true)
    })

    it('never aborts, drops, or fails an execution because of secret-shaped tool output', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      await runner.run()
      const credential = `sk-${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`

      mockSession.pi.emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-credential',
        toolName: 'generated-tool',
        result: credential,
        isError: false,
      } as AgentSessionEvent)

      // Redaction happens inbound, at the tool boundary, and only ever replaces
      // substrings. Nothing downstream may cancel the call or fail the run.
      expect(execution.status).toBe('running')
      expect(mockSession.pi.abortCalled).toBe(false)
      expect(mockSession.pi.abortBashCalled).toBe(false)
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(events.some((event) => event.type === 'tool_end')).toBe(true)
    })

    it('completes normally after refusing a stored-value tool call', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      const syntheticValue = `CANARY_SECRET_${randomUUID()}`
      const originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
      const originalSecretRows = await db.select().from(secretRows)
      spyOn(agent, 'getEffectiveModelSpec').mockResolvedValue('anthropic:claude-sonnet-4-5')

      const survivalRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          this.completeCalls.push({ response, metadata, usage: sessionUsage })
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)
      const toolBody = mock(async () => ({ content: [{ type: 'text', text: 'must not run' }] }))

      try {
        process.env.FICUS_ENCRYPTION_KEY = 'a'.repeat(64)
        await db.delete(secretRows)
        resetSecretStore()
        await getSecretStore().initialize()
        await getSecretStore().set('SYNTHETIC_KEY', syntheticValue, 'test')

        await survivalRunner.run()

        // Pi dispatches the validated tool call; only a genuinely installed
        // pre-call guard can refuse it before the tool body runs.
        const hook = (mockSession.pi as any).agent?.beforeToolCall
        expect(typeof hook).toBe('function')
        const decision = await hook({
          assistantMessage: { role: 'assistant' },
          toolCall: { type: 'toolCall', id: 'call-survival', name: 'generated-tool', arguments: {} },
          args: { command: syntheticValue },
          context: {},
        })
        if (!decision?.block) await toolBody()

        expect(toolBody).toHaveBeenCalledTimes(0)
        expect(decision).toEqual({ block: true, reason: STORED_SECRET_TOOL_REFUSAL })
        expect(survivalRunner.storedSecretAudits).toEqual([
          { agentId: agent.id, executionId: execution.id, secretKey: 'SYNTHETIC_KEY', outcome: 'denied' },
        ])
        expect(JSON.stringify({ decision, audits: survivalRunner.storedSecretAudits })).not.toContain(syntheticValue)

        // Pi turns the block into an error tool result carrying the refusal and
        // the model continues to a normal terminal turn.
        mockSession.pi.emit({
          type: 'tool_execution_start',
          toolCallId: 'call-survival',
          toolName: 'generated-tool',
        } as any)
        mockSession.pi.emit({
          type: 'tool_execution_end',
          toolCallId: 'call-survival',
          toolName: 'generated-tool',
          result: STORED_SECRET_TOOL_REFUSAL,
          isError: true,
        } as any)
        mockSession.pi.simulateNormalEnd('Understood — I will not retry that value.')

        await survivalRunner.waitForPersistence()
        await waitForCondition(async () => survivalRunner.completeCalls.length > 0)
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(survivalRunner.completeCalls).toHaveLength(1)
        expect(execution.status).toBe('completed')
        expect(agent.status).toBe('idle')
        expect(mockSession.pi.abortCalled).toBe(false)
        expect(mockSession.pi.abortBashCalled).toBe(false)
        expect(events.some((event) => event.type === 'error')).toBe(false)
        expect(events.some((event) => event.type === 'tool_end')).toBe(true)
        expect(events.some((event) => event.type === 'done')).toBe(true)
      } finally {
        delete process.env.FICUS_ENCRYPTION_KEY
        if (originalEncryptionKey !== undefined) process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
        await db.delete(secretRows)
        if (originalSecretRows.length > 0) await db.insert(secretRows).values(originalSecretRows)
        resetSecretStore()
      }
    })

    it('keeps the deleted global fail-execution secret path absent', () => {
      const runnerSource = readFileSync(new URL('./base.ts', import.meta.url), 'utf8')
      const wrapperSource = readFileSync(
        new URL('../../services/security/tool-output-redaction.ts', import.meta.url),
        'utf8'
      )
      for (const source of [runnerSource, wrapperSource]) {
        expect(source).not.toContain('handleStoredSecretDetection')
        expect(source).not.toContain('tool-payload-redactor')
        expect(source).not.toContain('SafeDetection')
      }
    })

    it('records one already_executed audit per stored key from base session options', async () => {
      spyOn(agent, 'getEffectiveModelSpec').mockResolvedValue('anthropic:claude-sonnet-4-5')

      const options = await (runner as any).buildBaseSessionOptions({
        systemPrompt: 'system prompt',
        skillPaths: [],
        extensionPaths: [],
        sandboxId: 'sandbox-id',
        workspacePath: '/tmp/generated-workspace',
        tools: {},
      })

      await options.onStoredToolResult!({ toolCallId: 'call-opts', storedKeys: ['SYNTHETIC_A', 'SYNTHETIC_B'] })
      await options.onStoredToolResult!({ toolCallId: 'call-opts', storedKeys: ['SYNTHETIC_A'] })

      // One row per key, deduplicated per call, always already_executed (the
      // original tool has run by the time the inbound boundary reports), and
      // never the tool-call id or any payload material.
      expect(runner.storedSecretAudits).toEqual([
        { agentId: agent.id, executionId: execution.id, secretKey: 'SYNTHETIC_A', outcome: 'already_executed' },
        { agentId: agent.id, executionId: execution.id, secretKey: 'SYNTHETIC_B', outcome: 'already_executed' },
      ])
      expect(JSON.stringify(runner.storedSecretAudits)).not.toContain('call-opts')
    })

    it('emits a system_message when the session reports a switch-back', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      mockSession.switchedBack = {
        from: 'zai:glm-5-turbo',
        to: 'anthropic:claude-haiku-4-5',
        reason: 'higher-priority-recovered',
      }

      await runner.run()

      const sysMsg = events.find((event) => event.type === 'system_message')
      expect(sysMsg).toBeTruthy()
      expect(sysMsg.text).toContain('switched back')
      expect(sysMsg.text).toContain('anthropic')
      expect(mockSession.pi.setModelCalls).toHaveLength(0)
    })

    it('drives precompaction onSettled on agent_settled and does not own the lifecycle sink', async () => {
      const onSettled = mock(() => {})
      const precompaction = { onSettled, onLifecycle: undefined as unknown }
      ;(mockSession as any).precompaction = precompaction

      await runner.run()
      mockSession.pi.emit({ type: 'agent_end', messages: [assistantMessage('done')] } as any)
      mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)

      // The runner calls onSettled in its gated agent_settled branch...
      expect(onSettled).toHaveBeenCalledTimes(1)
      // ...and never assigns the lifecycle sink (that is now process-wide).
      expect(precompaction.onLifecycle).toBeUndefined()
    })

    it('does not emit a switch-back message when no switch-back occurred', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)

      await runner.run()

      expect(events.find((event) => event.type === 'system_message')).toBeUndefined()
    })

    it('attaches claimed pending-row images to the initial prompt', async () => {
      const fakeImages = [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
      const pendingImageMessage = {
        id: 'pending-image-message',
        agentId: agent.id,
        role: 'human',
        content: 'look at this',
        metadata: { imageIds: ['img-1'] },
        pending: true,
        createdAt: new Date(),
      } as Message
      execution.imageIds = ['img-1']
      loadImagesSpy.mockResolvedValue(fakeImages)
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([pendingImageMessage])

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(mockSession.pi.promptCalls[0].text).toBe('look at this')
      expect(mockSession.pi.promptCalls[0].options).toEqual({ images: fakeImages })
      expect(loadImagesSpy).toHaveBeenCalledWith(['img-1'], agent)
      expect(mockSession.pi.steerCalls).toEqual([])
    })

    it('marks initial prompt message images used after successful SDK injection', async () => {
      const pendingImageMessage = {
        id: 'pending-image-message',
        agentId: agent.id,
        role: 'human',
        content: 'look at this',
        metadata: { imageIds: ['img-1'] },
        pending: true,
        createdAt: new Date(),
      } as Message
      loadImagesSpy.mockResolvedValue([{ type: 'image', data: 'abc', mimeType: 'image/png' }])
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([pendingImageMessage])

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(markImagesUsedSpy).toHaveBeenCalledWith(['img-1'])
    })

    it('marks claimed initial prompt images failed when prompt delivery fails', async () => {
      const pendingImageMessage = {
        id: 'pending-image-message',
        agentId: agent.id,
        role: 'human',
        content: '',
        metadata: { imageIds: ['img-1'] },
        pending: true,
        createdAt: new Date(),
      } as Message
      loadImagesSpy.mockResolvedValue([{ type: 'image', data: 'abc', mimeType: 'image/png' }])
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([pendingImageMessage])
      mockSession.pi.promptError = new Error('API error')

      await runner.run()

      expect(markImagesFailedSpy).toHaveBeenCalledWith(['img-1'])
      expect(resetPendingInterventionSessionDeliverySpy).toHaveBeenCalledWith('pending-image-message')
    })
  })

  // ---------------------------------------------------------------------------
  // Sandbox-wait indicator: a debounced execution_phase marker on the same stream, so the UI can
  // distinguish "waiting for the sandbox" from generic thinking dots (see combine.ts / ChatView).
  // ---------------------------------------------------------------------------

  describe('execution_phase (sandbox wait indicator)', () => {
    const phaseNames = (events: any[]) =>
      events.filter((event) => event.type === 'execution_phase').map((event) => event.phase)

    it('emits no execution_phase events when reported setup work resolves before the wait window', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      ;(runner as any).sandboxWaitDelayMs = 20
      runner.setupOperationDelaysMs = [1]

      await runner.run()

      expect(phaseNames(events)).toEqual([])
    })

    it('does not emit while slow non-sandbox session setup follows a current sandbox', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      ;(runner as any).sandboxWaitDelayMs = 10
      runner.postSandboxDelayMs = 60

      await runner.run()

      expect(phaseNames(events)).toEqual([])
    })

    it('emits waiting_sandbox then sandbox_ready for reported work past the wait window', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      ;(runner as any).sandboxWaitDelayMs = 10
      runner.setupOperationDelaysMs = [60]

      await runner.run()

      expect(phaseNames(events)).toEqual(['waiting_sandbox', 'sandbox_ready'])
    })

    it('keeps waiting until all overlapping operation IDs finish', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      ;(runner as any).sandboxWaitDelayMs = 10
      runner.setupOperationDelaysMs = [1, 60]

      await runner.run()

      expect(phaseNames(events)).toEqual(['waiting_sandbox', 'sandbox_ready'])
    })

    it('emits no sandbox_ready when a reported setup batch fails after waiting', async () => {
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)
      ;(runner as any).sandboxWaitDelayMs = 10
      runner.setupOperationDelaysMs = [60]
      runner.failSession = true

      await expect(runner.run()).rejects.toThrow('sandbox ensure failed')

      expect(phaseNames(events)).toEqual(['waiting_sandbox'])
      expect(removeSessionSpy).toHaveBeenCalledWith(agent.id)
    })
  })

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  describe('event handling', () => {
    it('calls onComplete on agent_settled with full accumulated response', async () => {
      await runner.run()
      mockSession.pi.simulateNormalEnd('Hello world')

      await new Promise((r) => setTimeout(r, 100))

      expect(runner.completeCalls).toHaveLength(1)
      // Content accumulates across turns — agent_settled finalizes everything
      expect(runner.completeCalls[0].response).toBe('Hello world')
    })

    it('saves assistant response after Pi session persistence before user steer', async () => {
      await runner.run()

      // First turn: assistant responds
      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'first part' },
      } as any)
      mockSession.pi.emit({ type: 'turn_end' } as any)

      // No save yet — turn_end alone doesn't flush
      await new Promise((r) => setTimeout(r, 50))
      const earlyAssistantSave = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'first part'
      )
      expect(earlyAssistantSave).toBeFalsy()

      // Pi confirms the assistant turn was persisted to its session file.
      persistAssistant(mockSession, 'first part')

      await new Promise((r) => setTimeout(r, 50))

      const turnSave = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'first part'
      )
      expect(turnSave).toBeTruthy()

      // User message delivered (steer) → confirms the pending human message.
      persistUser(mockSession, 'do this instead')

      // Second turn: assistant responds again, then the session settles
      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'second part' },
      } as any)
      persistAssistant(mockSession, 'second part')
      mockSession.pi.emit({ type: 'agent_end', messages: [assistantMessage('second part')] } as any)
      mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)

      await new Promise((r) => setTimeout(r, 100))

      // onComplete gets only the second turn's content
      expect(runner.completeCalls).toHaveLength(1)
      expect(runner.completeCalls[0].response).toBe('second part')
    })

    it('tries to confirm the pending message at the SDK persisted user event boundary', async () => {
      const tryConfirmSpy = spyOn(agent, 'tryConfirmPendingMessage').mockResolvedValue(null as any)
      const confirmByIdSpy = spyOn(agent, 'confirmPendingMessage')

      await runner.run()
      persistUser(mockSession, 'serialized differently')
      await new Promise((r) => setTimeout(r, 50))

      expect(tryConfirmSpy).toHaveBeenCalledWith('serialized differently', {
        executionId: 'exec-test-1',
        streamGroupId: expect.any(String),
      })
      expect(confirmByIdSpy).not.toHaveBeenCalled()

      tryConfirmSpy.mockRestore()
      confirmByIdSpy.mockRestore()
    })

    it('confirms each persisted queued user message in Pi session order', async () => {
      const tryConfirmSpy = spyOn(agent, 'tryConfirmPendingMessage').mockResolvedValue(null as any)

      await runner.run()
      persistUser(mockSession, 'batched steer one')
      persistUser(mockSession, 'batched steer two')
      persistUser(mockSession, 'queued follow-up one')
      await new Promise((r) => setTimeout(r, 50))

      expect(tryConfirmSpy.mock.calls.map((call) => call[0])).toEqual([
        'batched steer one',
        'batched steer two',
        'queued follow-up one',
      ])

      tryConfirmSpy.mockRestore()
    })

    it('keeps follow-ups pending on first output, then confirms them when Pi persists the user turn', async () => {
      const testAgentTypeId = `runner-followup-${crypto.randomUUID()}`
      await AgentType.create({
        id: testAgentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Runner Follow-up Test Agent',
        systemPrompt: 'You are a test agent.',
      })
      const dbAgent = await Agent.create({ agentTypeId: testAgentTypeId })
      const dbAgentId = dbAgent.id
      // Keep this DB-backed agent isolated from the suite-level Agent.update spy
      // used by the mock-agent tests above.
      dbAgent.update = async (updates: any) => {
        Object.assign(dbAgent, updates)
        return dbAgent
      }
      let dbRunner: TestRunner | undefined

      try {
        const dbExecution = makeExecution({ id: crypto.randomUUID(), agentId: dbAgent.id }, { current: dbAgent })
        dbRunner = new TestRunner(dbExecution, dbAgent, makeAgentType({ id: testAgentTypeId }), mockSession)
        const originalConfirmAll = dbAgent.confirmAllPendingMessages.bind(dbAgent)
        let confirmAllCalls = 0
        dbAgent.confirmAllPendingMessages = async () => {
          confirmAllCalls++
          return originalConfirmAll()
        }
        await dbRunner.run()
        expect(confirmAllCalls).toBe(0)

        const steer = await dbAgent.recordMessage({
          role: 'human',
          content: 'Interrupt: change priority',
          metadata: { deliveryMode: 'steer' },
          pending: true,
        })
        const followUp = await dbAgent.recordMessage({
          role: 'human',
          content: 'Follow-up: after this response',
          metadata: { deliveryMode: 'follow-up' },
          pending: true,
        })
        expect((await dbAgent.listPendingHumanMessages()).map((message) => message.id).sort()).toEqual(
          [steer.id, followUp.id].sort()
        )
        await waitForCondition(async () => {
          const claimed = await db
            .select({ id: messages.id, injectedAt: messages.injectedAt })
            .from(messages)
            .where(inArray(messages.id, [steer.id, followUp.id]))
          return claimed.length === 2 && claimed.every((message) => message.injectedAt !== null)
        })

        mockSession.pi.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'steer response' },
        } as any)
        await dbRunner.waitForPersistence()

        expect(confirmAllCalls).toBe(0)
        expect((await Agent.findMessage(steer.id))?.pending).toBe(true)
        expect((await Agent.findMessage(followUp.id))?.pending).toBe(true)

        persistUser(mockSession, 'Interrupt: change priority')
        await dbRunner.waitForPersistence()
        expect((await Agent.findMessage(steer.id))?.pending).toBe(false)
        expect((await Agent.findMessage(followUp.id))?.pending).toBe(true)

        persistAssistant(mockSession, 'steer response')
        await dbRunner.waitForPersistence()
        const assistant = (await dbAgent.listMessages()).messages.find(
          (message) => message.role === 'assistant' && message.content === 'steer response'
        )
        expect(assistant).toBeTruthy()

        persistUser(mockSession, 'Follow-up: after this response')
        await dbRunner.waitForPersistence()

        const confirmedFollowUp = await Agent.findMessage(followUp.id)
        expect(confirmedFollowUp?.pending).toBe(false)
        expect(confirmedFollowUp?.createdAt.toISOString()).toBe(followUp.createdAt.toISOString())
        expect(new Date(confirmedFollowUp!.metadata!.consumedAt!).getTime()).toBeGreaterThanOrEqual(
          assistant!.createdAt.getTime()
        )
      } finally {
        sessionState.removeSession(dbAgentId)
        await dbRunner?.waitForPersistence()
        await db.delete(messages).where(eq(messages.agentId, dbAgentId))
        await db.delete(executions).where(eq(executions.agentId, dbAgentId))
        await db.delete(agents).where(eq(agents.id, dbAgentId))
        await db.delete(agentTypeRows).where(eq(agentTypeRows.id, testAgentTypeId))
      }
    })

    it('stamps stranded follow-up consumption when a requeued execution first outputs', async () => {
      const testAgentTypeId = `runner-stranded-followup-${crypto.randomUUID()}`
      await AgentType.create({
        id: testAgentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Runner Stranded Follow-up Test Agent',
        systemPrompt: 'You are a test agent.',
      })
      const dbAgent = await Agent.create({ agentTypeId: testAgentTypeId })
      const dbAgentId = dbAgent.id
      // Keep this DB-backed agent isolated from the suite-level Agent.update spy
      // used by the mock-agent tests above.
      dbAgent.update = async (updates: any) => {
        Object.assign(dbAgent, updates)
        return dbAgent
      }
      let firstRunner: TestRunner | undefined
      let retryRunner: TestRunner | undefined

      try {
        const firstExecution = makeExecution({ id: crypto.randomUUID(), agentId: dbAgent.id }, { current: dbAgent })
        firstRunner = new (class extends TestRunner {
          protected override async onComplete(
            response: string,
            metadata: MessageMetadata | undefined,
            sessionUsage: SessionUsage
          ): Promise<void> {
            await this.completeNormally(response, metadata, sessionUsage)
          }
        })(firstExecution, dbAgent, makeAgentType({ id: testAgentTypeId }), mockSession)
        const originalConfirmAll = dbAgent.confirmAllPendingMessages.bind(dbAgent)
        dbAgent.confirmAllPendingMessages = async () => originalConfirmAll()
        await firstRunner.run()

        const followUp = await dbAgent.recordMessage({
          role: 'human',
          content: 'Stranded follow-up',
          metadata: { deliveryMode: 'follow-up' },
          pending: true,
        })
        await waitForCondition(async () => Boolean((await Agent.findMessage(followUp.id))?.injectedAt))

        mockSession.pi.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'settled response' },
        } as any)
        persistAssistant(mockSession, 'settled response')
        mockSession.pi.emit({ type: 'agent_end', messages: [assistantMessage('settled response')] } as any)
        mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)
        await firstRunner.waitForPersistence()
        await waitForCondition(async () => {
          const [persistedFollowUp, queuedExecutions, agentMessages] = await Promise.all([
            Agent.findMessage(followUp.id),
            Execution.list({ agentId: dbAgent.id, status: 'queued' }),
            dbAgent.listMessages(),
          ])
          return (
            persistedFollowUp?.metadata?.strandedPendingRetryCount === 1 &&
            queuedExecutions.length > 0 &&
            agentMessages.messages.some(
              (message) => message.role === 'assistant' && message.content === 'settled response'
            )
          )
        })

        const assistant = (await dbAgent.listMessages()).messages.find(
          (message) => message.role === 'assistant' && message.content === 'settled response'
        )
        expect(assistant).toBeTruthy()
        const strandedFollowUp = await Agent.findMessage(followUp.id)
        expect(strandedFollowUp?.pending).toBe(true)
        expect(strandedFollowUp?.metadata?.strandedPendingRetryCount).toBe(1)

        const [queuedExecution] = await Execution.list({ agentId: dbAgent.id, status: 'queued' })
        expect(queuedExecution).toBeTruthy()
        queuedExecution.setAgent(dbAgent)
        const retrySession = new MockAgentSession()
        retryRunner = new TestRunner(queuedExecution, dbAgent, makeAgentType({ id: testAgentTypeId }), retrySession)
        await retryRunner.run()
        await waitForCondition(async () => Boolean((await Agent.findMessage(followUp.id))?.injectedAt))

        retrySession.pi.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'retry response' },
        } as any)
        expect((await Agent.findMessage(followUp.id))?.pending).toBe(true)

        persistUser(retrySession, 'Stranded follow-up')
        await retryRunner.waitForPersistence()

        const confirmedFollowUp = await Agent.findMessage(followUp.id)
        expect(confirmedFollowUp?.pending).toBe(false)
        expect(confirmedFollowUp?.createdAt.toISOString()).toBe(followUp.createdAt.toISOString())
        expect(new Date(confirmedFollowUp!.metadata!.consumedAt!).getTime()).toBeGreaterThanOrEqual(
          followUp.createdAt.getTime()
        )
      } finally {
        sessionState.removeSession(dbAgentId)
        await firstRunner?.waitForPersistence()
        await retryRunner?.waitForPersistence()
        await db.delete(messages).where(eq(messages.agentId, dbAgentId))
        await db.delete(executions).where(eq(executions.agentId, dbAgentId))
        await db.delete(agents).where(eq(agents.id, dbAgentId))
        await db.delete(agentTypeRows).where(eq(agentTypeRows.id, testAgentTypeId))
      }
    })

    it('does not flush on turn_end without persisted session message', async () => {
      await runner.run()

      // Text + turn_end (e.g. after tool execution mid-turn)
      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial text' },
      } as any)
      mockSession.pi.emit({ type: 'turn_end' } as any)

      await new Promise((r) => setTimeout(r, 50))

      // No assistant message saved yet
      const assistantSaves = recordMessageSpy.mock.calls.filter(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'partial text'
      )
      expect(assistantSaves).toHaveLength(0)

      // persisted session message gets the full accumulated content
      persistAssistant(mockSession, 'partial text')
      mockSession.pi.emit({ type: 'agent_end', messages: [assistantMessage('partial text')] } as any)
      mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)
      await new Promise((r) => setTimeout(r, 100))

      expect(runner.completeCalls).toHaveLength(1)
      expect(runner.completeCalls[0].response).toBe('partial text')
    })

    it('waits for AgentSession settled event before completing a run', async () => {
      await runner.run()

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'settled response' },
      } as any)
      persistAssistant(mockSession, 'settled response')
      mockSession.pi.emit({ type: 'turn_end' } as any)
      mockSession.pi.emit({ type: 'agent_end', messages: [assistantMessage('settled response')] } as any)

      await new Promise((r) => setTimeout(r, 50))
      expect(runner.completeCalls).toHaveLength(0)

      mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)

      await new Promise((r) => setTimeout(r, 50))
      expect(runner.completeCalls).toHaveLength(1)
      expect(runner.completeCalls[0].response).toBe('settled response')
    })

    it('saves assistant response to the DB only after Pi session persistence before compaction messages', async () => {
      await runner.run()

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial before compaction' },
      } as any)
      mockSession.pi.emit({ type: 'turn_end' } as any)
      mockSession.pi.emit({ type: 'compaction_start', reason: 'threshold' } as any)

      await new Promise((r) => setTimeout(r, 50))
      let saved = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'partial before compaction'
      )
      expect(saved).toBeFalsy()

      persistAssistant(mockSession, 'partial before compaction')
      await new Promise((r) => setTimeout(r, 50))

      saved = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'partial before compaction'
      )
      expect(saved).toBeTruthy()
    })
    it('keeps a pre-existing provider episode unresolved when the turn settles with an error', async () => {
      providerHealth.recordFailure(providerHealth.captureAttempt('anthropic'), {
        kind: 'rate-limit',
        retryAt: Date.now() + 60_000,
      })
      await runner.run()

      mockSession.pi.simulateErrorEnd('Connection failed')

      await new Promise((r) => setTimeout(r, 10))

      expect(execution.status).toBe('failed')
      expect(agent.status).toBe('idle')
      expect(providerHealth.getRecord('anthropic')?.lastSuccessAt).toBeUndefined()
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
    })

    it('ignores events when session is no longer active', async () => {
      await runner.run()
      isSessionActiveSpy.mockReturnValue(false)

      mockSession.pi.simulateNormalEnd('should be ignored')

      await new Promise((r) => setTimeout(r, 10))

      expect(runner.completeCalls).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // completeNormally()
  // ---------------------------------------------------------------------------

  describe('completeNormally()', () => {
    it('removes session, saves message, updates statuses', async () => {
      await runner.run()

      // Call completeNormally directly via onComplete that delegates
      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')

      await new Promise((r) => setTimeout(r, 50))

      expect(removeSessionSpy).toHaveBeenCalledWith(agent.id)
      // Verify final state
      expect(execution.status).toBe('completed')
      expect(agent.status).toBe('idle')
    })

    it('requeues when pending messages remain even if original execution message is null', async () => {
      execution.message = null
      listPendingHumanMessagesSpy.mockResolvedValue([
        {
          id: 'pending-1',
          agentId: agent.id,
          role: 'human',
          content: 'missed steer',
          metadata: { deliveryMode: 'steer' },
          pending: true,
          createdAt: new Date(),
        } satisfies Message,
      ])

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')
      await new Promise((r) => setTimeout(r, 50))

      expect(markPendingHumanMessagesStrandedRetrySpy).toHaveBeenCalledWith(['pending-1'])
      expect(queueExecutionSpy).toHaveBeenCalledWith({})
    })

    it('keeps retrying stranded pending messages until the retry budget is exhausted', async () => {
      listPendingHumanMessagesSpy.mockResolvedValue([
        {
          id: 'pending-1',
          agentId: agent.id,
          role: 'human',
          content: 'missed steer',
          metadata: { deliveryMode: 'steer', strandedPendingRetryCount: 1 },
          pending: true,
          createdAt: new Date(),
        } satisfies Message,
      ])

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')
      await new Promise((r) => setTimeout(r, 50))

      expect(markPendingHumanMessagesStrandedRetrySpy).toHaveBeenCalledWith(['pending-1'])
      expect(queueExecutionSpy).toHaveBeenCalledWith({})
    })

    it('stops requeueing stranded pending messages only after the retry budget is exhausted', async () => {
      listPendingHumanMessagesSpy.mockResolvedValue([
        {
          id: 'pending-1',
          agentId: agent.id,
          role: 'human',
          content: 'missed steer',
          metadata: { deliveryMode: 'steer', strandedPendingRetryCount: 3 },
          pending: true,
          createdAt: new Date(),
        } satisfies Message,
      ])

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')
      await new Promise((r) => setTimeout(r, 50))

      expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
      expect(queueExecutionSpy).not.toHaveBeenCalled()
      expect(recordMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'assistant', metadata: { isSystem: true } })
      )
    })

    it('requeues stranded pending messages before applying a halt hook result', async () => {
      const runSpy = spyOn(turnHooks, 'run').mockResolvedValue({ action: 'halt', status: 'waiting-input' })
      listPendingHumanMessagesSpy.mockResolvedValue([
        {
          id: 'pending-1',
          agentId: agent.id,
          role: 'human',
          content: 'missed steer',
          metadata: { deliveryMode: 'steer' },
          pending: true,
          createdAt: new Date(),
        } satisfies Message,
      ])

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')
      await new Promise((r) => setTimeout(r, 50))

      expect(markPendingHumanMessagesStrandedRetrySpy).toHaveBeenCalledWith(['pending-1'])
      expect(queueExecutionSpy).toHaveBeenCalledWith({})
      expect(agent.status).not.toBe('waiting-input')

      runSpy.mockRestore()
    })

    it('skips saving message when response is empty and no metadata', async () => {
      await runner.run()

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()

      // Simulate agent_end with no text
      mockSession.pi.emit({ type: 'agent_end', messages: [] } as any)

      await new Promise((r) => setTimeout(r, 50))

      // addMessage should not be called for assistant (only system messages from stop etc.)
      const assistantCalls = recordMessageSpy.mock.calls.filter((c: any) => c[0].role === 'assistant')
      expect(assistantCalls).toHaveLength(0)
    })

    it('recovers only the matching route after a genuinely successful settled turn', async () => {
      const attempt = providerHealth.captureAttempt('anthropic')
      providerHealth.recordFailure(attempt, { kind: 'rate-limit', retryAt: Date.now() + 1 })
      await new Promise((resolve) => setTimeout(resolve, 5))

      await runner.run()
      expect(providerHealth.getRecord('anthropic')?.lastSuccessAt).toBeUndefined()

      mockSession.pi.simulateNormalEnd('done')
      await new Promise((resolve) => setTimeout(resolve, 50))

      const record = providerHealth.getRecord('anthropic')
      expect(record?.lastSuccessAt).toBeGreaterThan(record!.since)
    })

    it('keeps settlement fail-open when provider success recording throws', async () => {
      const attempt = providerHealth.captureAttempt('anthropic')
      providerHealth.recordFailure(attempt, { kind: 'rate-limit', retryAt: Date.now() + 1 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const successSpy = spyOn(providerHealth, 'recordSuccess').mockImplementation(() => {
        throw new Error('settings unavailable')
      })

      try {
        await runner.run()
        mockSession.pi.simulateNormalEnd('done')
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(runner.completeCalls).toHaveLength(1)
      } finally {
        successSpy.mockRestore()
      }
    })

    it('resets the auto-restart backoff metadata on a successful turn', async () => {
      agent.metadata = { name: 'Test', autoRestartCount: 3, lastAutoRestartAt: Date.now() } as any

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')
      await new Promise((r) => setTimeout(r, 50))

      expect(agent.metadata).not.toHaveProperty('autoRestartCount')
      expect(agent.metadata).not.toHaveProperty('lastAutoRestartAt')
      // Other metadata is preserved.
      expect((agent.metadata as any)?.name).toBe('Test')
    })

    it('resets sandbox-restart backoff metadata on a successful turn', async () => {
      agent.metadata = { name: 'Test', [META_COUNT]: 2, [META_LAST_AT]: Date.now() } as any

      const delegatingRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)

      await delegatingRunner.run()
      mockSession.pi.simulateNormalEnd('done')
      await new Promise((r) => setTimeout(r, 50))

      expect(agent.metadata).not.toHaveProperty(META_COUNT)
      expect(agent.metadata).not.toHaveProperty(META_LAST_AT)
      expect((agent.metadata as any)?.name).toBe('Test')
    })
  })

  // ---------------------------------------------------------------------------
  // Task 8: done event enumerates turn row ids
  // ---------------------------------------------------------------------------

  describe('done event enumerates turn row ids', () => {
    it('done.messageIds contains both M1 and M2 row ids for a tool turn', async () => {
      // Arrange: fresh runner with its own buffer so we can inspect pushed events
      const localBuffer = new StreamBuffer()
      const bufferedEvents: any[] = []
      localBuffer.subscribe((e) => bufferedEvents.push(e))
      createBufferSpy.mockReturnValue(localBuffer)

      // Record message spy returns distinct IDs for M1 (pre-tool) and M2 (post-tool)
      const m1Id = 'msg-m1-tool-pre'
      const m2Id = 'msg-m2-tool-post'
      let assistantCallCount = 0
      recordMessageSpy.mockImplementation(async (input: any) => {
        if (input.role === 'assistant') {
          assistantCallCount++
          const id = assistantCallCount === 1 ? m1Id : m2Id
          return {
            id,
            agentId: agent.id,
            role: 'assistant',
            content: input.content ?? '',
            metadata: input.metadata ?? null,
            pending: false,
            createdAt: new Date(),
          }
        }
        return {
          id: `other-${Date.now()}`,
          agentId: agent.id,
          role: input.role,
          content: '',
          metadata: null,
          pending: false,
          createdAt: new Date(),
        }
      })

      // Use a delegating runner that calls completeNormally (which calls saveAndPushDone)
      const localRunner = new (class extends TestRunner {
        protected override async onComplete(
          response: string,
          metadata: MessageMetadata | undefined,
          sessionUsage: SessionUsage
        ): Promise<void> {
          await this.completeNormally(response, metadata, sessionUsage)
        }
      })(execution, agent, agentType, mockSession)
      await localRunner.run()

      // Simulate a tool turn: text delta + tool call -> M1 persisted, then tool
      // result updates M1 in place, then post-tool text -> M2 persisted.
      const toolCallId = 'tc-1'

      // Pre-tool: text delta populates the collector, then session_message_persisted
      // for the assistant message that includes the tool call (M1 row).
      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Using bash tool' },
      } as any)
      const m1Message = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Using bash tool' },
          { type: 'toolCall', id: toolCallId, toolName: 'bash', input: {} },
        ],
        stopReason: 'tool_use',
      }
      mockSession.pi.emit({ type: 'message_end', message: m1Message } as any)
      mockSession.pi.emit({
        type: 'session_message_persisted',
        message: m1Message,
        entryId: 'entry-m1',
        sessionFile: 'test.jsonl',
      } as any)
      await new Promise((r) => setTimeout(r, 30))

      // Tool result (updates M1 in place — same id, no new row)
      const toolResultMessage = { role: 'toolResult', toolCallId, content: 'output' }
      mockSession.pi.emit({ type: 'message_end', message: toolResultMessage } as any)
      mockSession.pi.emit({
        type: 'session_message_persisted',
        message: toolResultMessage,
        entryId: 'entry-tr1',
        sessionFile: 'test.jsonl',
      } as any)
      await new Promise((r) => setTimeout(r, 30))

      // Post-tool: text delta populates the collector, then session_message_persisted
      // for the post-tool assistant message (M2 row).
      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done with tool' },
      } as any)
      const m2Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done with tool' }],
        stopReason: 'end_turn',
      }
      mockSession.pi.emit({ type: 'message_end', message: m2Message } as any)
      mockSession.pi.emit({
        type: 'session_message_persisted',
        message: m2Message,
        entryId: 'entry-m2',
        sessionFile: 'test.jsonl',
      } as any)
      await new Promise((r) => setTimeout(r, 30))

      // Settle the agent
      mockSession.pi.emit({ type: 'agent_end', messages: [m2Message] } as any)
      mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)
      await new Promise((r) => setTimeout(r, 100))

      // Assert
      const done = bufferedEvents.find((e: any) => e.type === 'done')
      expect(done?.type).toBe('done')
      if (done?.type === 'done') {
        expect(done.streamGroupId).toBeDefined()
        expect(new Set(done.messageIds)).toEqual(new Set([m1Id, m2Id]))
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  describe('handleStop', () => {
    it('saves stop messages and marks execution stopped', async () => {
      // Set next status to 'stopping' so reload() will pick it up
      ;(execution as any)._nextStatus = 'stopping'

      await runner.run()
      mockSession.pi.simulateNormalEnd('partial work')

      await new Promise((r) => setTimeout(r, 50))

      // Should have saved system agent stopped message
      const systemMsgCall = recordMessageSpy.mock.calls.find((c: any) => c[0].content === '[System] Agent was stopped.')
      expect(systemMsgCall).toBeTruthy()

      // Verify final state
      expect(execution.status).toBe('stopped')
      expect(agent.status).toBe('idle')
    })

    it('skips onComplete when stopping', async () => {
      ;(execution as any)._nextStatus = 'stopping'

      await runner.run()
      mockSession.pi.simulateNormalEnd('partial')

      await new Promise((r) => setTimeout(r, 50))

      expect(runner.completeCalls).toHaveLength(0)
    })

    it('preserves pending work without requeueing or retrying inbox delivery', async () => {
      const pendingMessage = {
        id: 'pending-1',
        agentId: agent.id,
        role: 'human',
        content: 'stranded pending content',
        pending: true,
        metadata: {},
        createdAt: new Date(),
      } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])

      expect(execution.status).toBe('running')
      expect(execution.agentId).toBe(agent.id)
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      ;(execution as any)._nextStatus = 'stopping'
      await runner.run()
      expect(registerSessionSpy).toHaveBeenCalledWith(
        agent.id,
        expect.objectContaining({ agentId: agent.id, executionId: execution.id })
      )

      const stopSettled = runner.waitForNextStopSettlement()
      mockSession.pi.simulateNormalEnd('partial')
      await stopSettled

      expect(execution.id).toBe('exec-test-1')
      expect(execution.status).toBe('stopped')
      expect(runner.stopCalledAfterSystemMessage).toBe(true)
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      expect(listPendingHumanMessagesSpy).toHaveBeenCalledTimes(2)
      expect(queueExecutionSpy).not.toHaveBeenCalled()
      expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
      expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
    })

    it('settles a stop requested while persisted turn work is still draining', async () => {
      const pendingMessage = { id: 'pending-during-persistence', pending: true } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      let releasePersistence!: () => void
      let persistenceStarted!: () => void
      const persistenceGate = new Promise<void>((resolve) => (releasePersistence = resolve))
      const started = new Promise<void>((resolve) => (persistenceStarted = resolve))
      const waitSpy = spyOn(SessionMessagePersistence.prototype, 'waitForAll').mockImplementation(async () => {
        persistenceStarted()
        await persistenceGate
      })
      ;(execution as any)._nextStatus = 'stopping'

      try {
        await runner.run()
        const stopSettled = runner.waitForNextStopSettlement()
        mockSession.pi.simulateNormalEnd('partial')
        await started
        expect(execution.status).toBe('running')
        releasePersistence()
        await stopSettled

        expect(execution.status).toBe('stopped')
        expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
        expect(listPendingHumanMessagesSpy).toHaveBeenCalledTimes(2)
        expect(queueExecutionSpy).not.toHaveBeenCalled()
        expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
        expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
      } finally {
        releasePersistence!()
        waitSpy.mockRestore()
      }
    })

    it('settles a stop requested after turn persistence but before the status check', async () => {
      const pendingMessage = { id: 'pending-after-persistence', pending: true } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      let releaseReload!: () => void
      let reloadStarted!: () => void
      const reloadGate = new Promise<void>((resolve) => (releaseReload = resolve))
      const started = new Promise<void>((resolve) => (reloadStarted = resolve))
      const originalReload = execution.reload.bind(execution)
      const reloadSpy = spyOn(execution, 'reload').mockImplementation(async () => {
        reloadStarted()
        await reloadGate
        return originalReload()
      })

      try {
        await runner.run()
        const stopSettled = runner.waitForNextStopSettlement()
        mockSession.pi.simulateNormalEnd('partial')
        await started
        expect(execution.status).toBe('running')
        ;(execution as any)._nextStatus = 'stopping'
        releaseReload()
        await stopSettled

        expect(execution.status).toBe('stopped')
        expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
        expect(listPendingHumanMessagesSpy).toHaveBeenCalledTimes(2)
        expect(queueExecutionSpy).not.toHaveBeenCalled()
        expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
        expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
      } finally {
        releaseReload!()
        reloadSpy.mockRestore()
      }
    })

    it('handles a duplicate settled event without stopping or retrying twice', async () => {
      const pendingMessage = { id: 'pending-duplicate-stop', pending: true } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      ;(execution as any)._nextStatus = 'stopping'
      const stopSpy = spyOn(execution, 'stop')
      const originalReload = execution.reload.bind(execution)
      let reloadCount = 0
      let duplicateStatusChecked!: () => void
      const duplicateChecked = new Promise<void>((resolve) => (duplicateStatusChecked = resolve))
      const reloadSpy = spyOn(execution, 'reload').mockImplementation(async () => {
        const result = await originalReload()
        reloadCount += 1
        if (reloadCount === 2) duplicateStatusChecked()
        return result
      })

      try {
        await runner.run()
        const stopSettled = runner.waitForNextStopSettlement()
        mockSession.pi.simulateNormalEnd('partial')
        await stopSettled

        mockSession.pi.simulateNormalEnd('duplicate')
        await duplicateChecked

        expect(execution.status).toBe('stopped')
        expect(reloadSpy).toHaveBeenCalledTimes(2)
        expect(stopSpy).toHaveBeenCalledTimes(1)
        expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
        expect(listPendingHumanMessagesSpy).toHaveBeenCalledTimes(2)
        expect(queueExecutionSpy).not.toHaveBeenCalled()
        expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
        expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
      } finally {
        reloadSpy.mockRestore()
        stopSpy.mockRestore()
      }
    })

    it('ignores stop settlement from a stale superseded runner', async () => {
      const pendingMessage = { id: 'pending-stale', pending: true } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])
      ;(execution as any)._nextStatus = 'stopping'
      await runner.run()
      isSessionActiveSpy.mockReturnValue(false)

      mockSession.pi.simulateNormalEnd('stale')

      expect(execution.status).toBe('running')
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      expect(queueExecutionSpy).not.toHaveBeenCalled()
      expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
    })

    it('settles cancellation after an aborted compaction without retrying pending work', async () => {
      const pendingMessage = { id: 'pending-cancelled', pending: true } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])
      await runner.run()
      ;(execution as any)._nextStatus = 'stopping'
      const stopSettled = runner.waitForNextStopSettlement()

      mockSession.pi.simulateCompactionStartThenAbort()
      mockSession.pi.simulateCompactionAborted()
      await stopSettled

      expect(execution.status).toBe('stopped')
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      expect(queueExecutionSpy).not.toHaveBeenCalled()
      expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
      expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
    })

    it('preserves pending work and suppresses retries when stop persistence fails', async () => {
      const pendingMessage = { id: 'pending-on-failure', pending: true } as Message
      listPendingHumanMessagesSpy.mockResolvedValue([pendingMessage])
      recordMessageSpy.mockRejectedValueOnce(new Error('stop message persistence failed'))
      ;(execution as any)._nextStatus = 'stopping'
      await runner.run()
      const stopSettled = runner.waitForNextStopSettlement()

      mockSession.pi.simulateNormalEnd('partial')
      await stopSettled

      expect(execution.status).toBe('stopped')
      expect(await agent.listPendingHumanMessages()).toEqual([pendingMessage])
      expect(queueExecutionSpy).not.toHaveBeenCalled()
      expect(deliverInboxMessagesToAgentSpy).not.toHaveBeenCalled()
      expect(markPendingHumanMessagesStrandedRetrySpy).not.toHaveBeenCalled()
    })

    it('naturally picks up preserved pending content with the next inbox wake', async () => {
      const stranded = {
        id: 'stranded',
        agentId: agent.id,
        role: 'human',
        content: 'stranded pending content',
        metadata: {},
        pending: true,
        createdAt: new Date(),
      } as Message
      const fresh = {
        id: 'fresh',
        agentId: agent.id,
        role: 'human',
        content: 'fresh inbox content',
        metadata: {},
        pending: true,
        createdAt: new Date(),
      } as Message
      claimInitialPendingMessagesForSessionDeliverySpy.mockResolvedValue([stranded, fresh])

      await runner.run()
      await new Promise((r) => setTimeout(r, 0))

      expect(mockSession.pi.promptCalls[0].text).toBe('stranded pending content\n\nfresh inbox content')
      expect(mockSession.pi.steerCalls).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // onError
  // ---------------------------------------------------------------------------

  describe('onError', () => {
    it('removes session, marks execution failed and agent idle', async () => {
      mockSession.pi.promptError = new Error('Connection failed')

      await runner.run()

      expect(removeSessionSpy).toHaveBeenCalledWith(agent.id)
      // Verify final state
      expect(execution.status).toBe('failed')
      expect(agent.status).toBe('idle')
    })
  })

  // ---------------------------------------------------------------------------
  // Usage baseline lifecycle (per-execution delta accounting)
  // ---------------------------------------------------------------------------

  describe('usage baseline lifecycle', () => {
    function resumedUsage(total: number, cost: number): SessionUsage {
      return {
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2,
          tokens: { input: total / 10, output: total / 10, cacheRead: total * 0.8, cacheWrite: 0, total },
          cost,
        },
        context: null,
      }
    }

    it('captureUsage before baseline capture emits no delta on a resumed session', () => {
      // The session is open but this execution's baseline has not been captured
      // yet (the pre-baseline persistence window). The capture must carry the
      // cumulative stats with NO delta so the row falls back to legacy MAX()
      // semantics instead of double-counting the resumed session.
      ;(runner.mockSession as any).captureUsage = () => resumedUsage(900_000, 9)
      ;(runner as any).session = runner.mockSession

      const early = (runner as any).captureUsage()

      expect(early.delta).toBeUndefined()
      expect(early.stats.tokens.total).toBe(900_000)
    })

    it('after the baseline is captured the delta is the step from it', () => {
      let current = resumedUsage(900_000, 9)
      ;(runner.mockSession as any).captureUsage = () => current
      ;(runner as any).session = runner.mockSession
      ;(runner as any).initializeUsageBaseline()

      current = resumedUsage(1_000_000, 10)
      const late = (runner as any).captureUsage()

      expect(late.delta!.tokens.total).toBe(100_000)
      expect(late.delta!.cost).toBeCloseTo(1, 6)
      expect(late.stats.tokens.total).toBe(1_000_000)
    })

    it('a fresh (zero) baseline still attributes the whole capture to the execution', () => {
      ;(runner as any).session = runner.mockSession
      // MockAgentSession.captureUsage returns all zeros — a brand-new session.
      ;(runner as any).initializeUsageBaseline()
      ;(runner.mockSession as any).captureUsage = () => resumedUsage(5_000, 0.5)

      const captured = (runner as any).captureUsage()

      expect(captured.delta!.tokens.total).toBe(5_000)
      expect(captured.delta!.cost).toBeCloseTo(0.5, 6)
    })

    it('captureUsage before session creation throws a descriptive error', () => {
      expect(() => (runner as any).captureUsage()).toThrow(/before the session was created/)
    })

    it('settlement writes the agent row without delta while the execution row keeps it', async () => {
      let current = resumedUsage(900_000, 9)
      ;(mockSession as any).captureUsage = () => current
      await runner.run() // baseline captured at 900k (resumed session)

      current = resumedUsage(1_000_000, 10)
      mockSession.pi.emit({ type: 'agent_settled', outcome: 'complete', retried: false, compacted: false } as any)
      await new Promise((r) => setTimeout(r, 150))

      // The execution-side usage (complete -> executions.usage, done event)
      // keeps its per-execution delta.
      expect(runner.completeCalls).toHaveLength(1)
      expect(runner.completeCalls[0]!.usage.delta!.tokens.total).toBe(100_000)
      expect(runner.completeCalls[0]!.usage.stats.tokens.total).toBe(1_000_000)

      // The agent row is a session-cumulative snapshot: every sessionUsage
      // patch written to it must be delta-free.
      const sessionUsagePatches = updateAgentSpy.mock.calls
        .map((call: any[]) => call[1]?.sessionUsage)
        .filter((usage: unknown) => usage !== undefined)
      expect(sessionUsagePatches.length).toBeGreaterThan(0)
      for (const patch of sessionUsagePatches) {
        expect(patch.delta).toBeUndefined()
        expect(patch.stats.tokens.total).toBe(1_000_000)
        expect(patch.stats.cost).toBeCloseTo(10, 6)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Stop during compaction (bug fix)
  // ---------------------------------------------------------------------------

  describe('stop during compaction', () => {
    it('finalizes stop when compaction_end fires with aborted=true', async () => {
      await runner.run()

      mockSession.pi.simulateCompactionStartThenAbort()
      ;(execution as any)._nextStatus = 'stopping'
      mockSession.pi.simulateCompactionAborted()

      await new Promise((r) => setTimeout(r, 50))

      expect(removeSessionSpy).toHaveBeenCalledWith(agent.id)
      expect(execution.status).toBe('stopped')
      expect(agent.status).toBe('idle')
    })

    it('does not trigger handler for non-transitional statuses', async () => {
      await runner.run()

      mockSession.pi.emit({ type: 'agent_end', messages: [] } as any)
      mockSession.pi.emit({ type: 'compaction_start', reason: 'threshold' } as any)
      mockSession.pi.simulateCompactionSuccess()

      await new Promise((r) => setTimeout(r, 50))

      expect(execution.status).not.toBe('stopped')
    })

    it('logs a warning and surfaces compaction_end errors as a system message', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)

      await runner.run()

      mockSession.pi.emit({
        type: 'compaction_end',
        reason: 'overflow',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: 'Context overflow recovery failed: summarize request too large',
      } as any)
      await new Promise((r) => setTimeout(r, 10))

      // The stream buffer already carries the failure into the live chat (via
      // StreamEventCollector) — this pins that regression. The new behavior
      // under test is the server-side log, which is what makes the failure
      // diagnosable after the fact (the #625 gap).
      const systemMessages = events.filter((event) => event.type === 'system_message')
      expect(systemMessages.some((event) => event.text.includes('Compaction failed'))).toBe(true)

      const warnedCompactionFailure = warnSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' &&
            arg.includes('Compaction failed') &&
            arg.includes('Context overflow recovery failed: summarize request too large')
        )
      )
      expect(warnedCompactionFailure).toBe(true)
      warnSpy.mockRestore()
    })

    it('does not log or emit a compaction_end system message when there is no error', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((event) => events.push(event))
      createBufferSpy.mockReturnValue(buffer)

      await runner.run()

      mockSession.pi.simulateCompactionSuccess(false)
      await new Promise((r) => setTimeout(r, 10))

      const systemMessages = events.filter((event) => event.type === 'system_message')
      expect(systemMessages.some((event) => event.text.includes('Compaction failed'))).toBe(false)
      expect(warnSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes('Compaction failed')))).toBe(
        false
      )
      warnSpy.mockRestore()
    })

    it('rotates streamGroupId when compaction retries mid-turn so pre/post halves do not collide', async () => {
      await runner.run()

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'pre-compaction text' },
      } as any)
      persistAssistant(mockSession, 'pre-compaction text')
      await new Promise((r) => setTimeout(r, 50))

      const preGroupSaved = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'pre-compaction text'
      )!
      const preStreamGroupId = preGroupSaved[0].metadata.streamGroupId

      mockSession.pi.emit({ type: 'compaction_start', reason: 'threshold' } as any)
      mockSession.pi.simulateCompactionSuccess(true)

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'post-compaction text' },
      } as any)
      persistAssistant(mockSession, 'post-compaction text')
      await new Promise((r) => setTimeout(r, 50))

      const postGroupSaved = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'post-compaction text'
      )!

      expect(preStreamGroupId).toBeDefined()
      expect(postGroupSaved[0].metadata.streamGroupId).toBeDefined()
      expect(postGroupSaved[0].metadata.streamGroupId).not.toBe(preStreamGroupId)
    })

    it('persists a context-compacted system message between the pre and post compaction groups', async () => {
      await runner.run()

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'pre-compaction text' },
      } as any)
      persistAssistant(mockSession, 'pre-compaction text')
      await new Promise((r) => setTimeout(r, 50))

      mockSession.pi.emit({ type: 'compaction_start', reason: 'threshold' } as any)
      mockSession.pi.simulateCompactionSuccess(true)

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'post-compaction text' },
      } as any)
      persistAssistant(mockSession, 'post-compaction text')
      await new Promise((r) => setTimeout(r, 50))

      const assistantSaves = recordMessageSpy.mock.calls
        .map((c: any) => c[0])
        .filter((input: any) => input.role === 'assistant')
      const systemSave = assistantSaves.find(
        (input: any) => input.content === '[System] Context compacted — continuing...'
      )
      const postSave = assistantSaves.find((input: any) => input.content === 'post-compaction text')

      expect(assistantSaves.map((input: any) => input.content)).toEqual([
        'pre-compaction text',
        '[System] Context compacted — continuing...',
        'post-compaction text',
      ])
      expect(systemSave?.metadata).toMatchObject({
        source: 'compaction',
        systemMessageKey: `compaction:${postSave.metadata.streamGroupId}`,
      })
      expect(systemSave?.metadata?.executionId).toBeUndefined()
      expect(systemSave?.metadata?.streamGroupId).toBeUndefined()
    })

    it('finalizes the current turn when threshold compaction settles without retry', async () => {
      await runner.run()

      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'finished response' },
      } as any)
      persistAssistant(mockSession, 'finished response')
      mockSession.pi.emit({ type: 'turn_end' } as any)
      mockSession.pi.emit({ type: 'agent_end', messages: [assistantMessage('finished response')] } as any)
      mockSession.pi.emit({ type: 'compaction_start', reason: 'threshold' } as any)

      await new Promise((r) => setTimeout(r, 50))
      expect(runner.completeCalls).toHaveLength(0)

      mockSession.pi.simulateCompactionSuccess(false)

      await new Promise((r) => setTimeout(r, 50))

      expect(runner.completeCalls).toHaveLength(1)
      expect(runner.completeCalls[0].response).toBe('finished response')
      const saved = recordMessageSpy.mock.calls.find(
        (c: any) => c[0].role === 'assistant' && c[0].content === 'finished response'
      )
      expect(saved).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // Runtime model/provider failover
  // ---------------------------------------------------------------------------

  describe('attemptFailover (runtime failover)', () => {
    let selectModelSpy: any
    let setAgentSelectedModelSpy: any
    let openRouterTestState: OpenRouterTestStateSnapshot

    beforeEach(async () => {
      openRouterTestState = await isolateOpenRouterTestState()
      // Avoid DB/auth in selection by stubbing the env-aware selector.
      selectModelSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnv')
      setAgentSelectedModelSpy = spyOn(AgentModule, 'setAgentSelectedModel').mockResolvedValue(undefined)
    })

    afterEach(async () => {
      selectModelSpy?.mockRestore()
      setAgentSelectedModelSpy?.mockRestore()
      await restoreOpenRouterTestState(openRouterTestState)
    })

    it('clears and exactly restores all ambient OpenRouter selection state', async () => {
      const originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
      const originalSecretRows = await db.select().from(secretRows)
      try {
        process.env.FICUS_ENCRYPTION_KEY = 'a'.repeat(64)
        resetSecretStore()
        await getSecretStore().initialize()
        await getSecretStore().set('OPENROUTER_TEST_SENTINEL', 'unchanged', 'test')
        const [sentinelBefore] = await db
          .select()
          .from(secretRows)
          .where(eq(secretRows.key, 'OPENROUTER_TEST_SENTINEL'))
        await accountStore.writeAccountStore(
          {
            version: 1,
            accounts: {
              zai: [{ id: 'ambient-zai', enabled: true, credential: { type: 'api_key', key: 'sk-ambient' } }],
            },
          },
          'test'
        )
        await getSettingsStore().set('OPENROUTER_TIER_EXPANSION_ENABLED', 'true', 'test')
        await getSettingsStore().set('DISABLED_PROVIDERS', JSON.stringify(['zai', 'openrouter']), 'test')
        providerHealth.markAccountExhausted('anthropic', 'ambient-health', { reason: 'rate-limit' })
        const healthBefore = providerHealth.snapshotRecords()
        await refreshModelRuntime()

        const ambientState = await isolateOpenRouterTestState()
        try {
          expect(accountStore.readAccountStore().accounts).toEqual({})
          expect(modelSelection.isOpenRouterTierExpansionEnabled()).toBe(false)
          expect(modelSelection.getDisabledProviders()).toEqual(new Set())
          expect(providerHealth.snapshotRecords()).toEqual([])
          expect((await getModelRuntime()).hasConfiguredAuth('zai')).toBe(false)
        } finally {
          await restoreOpenRouterTestState(ambientState)
        }

        expect(accountStore.readAccountStore().accounts.zai?.[0]?.id).toBe('ambient-zai')
        expect(modelSelection.isOpenRouterTierExpansionEnabled()).toBe(true)
        expect(modelSelection.getDisabledProviders()).toEqual(new Set(['zai', 'openrouter']))
        expect(providerHealth.snapshotRecords()).toEqual(healthBefore)
        expect((await getModelRuntime()).hasConfiguredAuth('zai')).toBe(true)
        const [sentinelAfter] = await db.select().from(secretRows).where(eq(secretRows.key, 'OPENROUTER_TEST_SENTINEL'))
        expect(sentinelAfter).toEqual(sentinelBefore)
      } finally {
        await db.delete(secretRows)
        if (originalSecretRows.length > 0) await db.insert(secretRows).values(originalSecretRows)
        resetSecretStore()
        if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
        else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
      }
    })

    function explicitProviderFailoverSelection(exhausted: string, selected: string) {
      const exhaustedProvider = exhausted.split(':', 1)[0]
      const selectedProvider = selected.split(':', 1)[0]
      expect(selected).not.toBe(exhausted)
      expect(selectedProvider).not.toBe(exhaustedProvider)
      return {
        selected,
        candidates: [
          { spec: exhausted, provider: exhaustedProvider, usable: false, reason: 'provider-exhausted' as const },
          { spec: selected, provider: selectedProvider, usable: true },
        ],
      }
    }

    function explicitProviderFailoverSequence(specs: string[]) {
      const providers = specs.map((spec) => spec.split(':', 1)[0])
      expect(specs.length).toBeGreaterThan(1)
      expect(new Set(specs).size).toBe(specs.length)
      expect(new Set(providers).size).toBe(specs.length)
      const outcomes: Array<{
        selected: string
        candidates: ReturnType<typeof explicitProviderFailoverSelection>['candidates']
      }> = []
      let selectedIndex = 1
      return {
        outcomes,
        select: () => {
          const selected = specs[selectedIndex]
          const candidates = specs.slice(0, selectedIndex + 1).map((spec, index) => ({
            spec,
            provider: providers[index],
            usable: index === selectedIndex,
            ...(index < selectedIndex ? { reason: 'provider-exhausted' as const } : {}),
          }))
          const outcome = { selected, candidates }
          outcomes.push(outcome)
          selectedIndex += 1
          return outcome
        },
      }
    }

    it('cancels unresolved failover diagnostics during cleanup', () => {
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout')
      try {
        void runner.waitForNextFailoverAttempt().catch(() => {})
        void runner.waitForNextExecutionFailure().catch(() => {})
        void runner.waitForNextStopSettlement().catch(() => {})

        runner.cleanupPendingWaiters()

        expect(clearTimeoutSpy).toHaveBeenCalledTimes(3)

        // A later stop has no stale waiter to resolve or timer to clear.
        void execution.stop()
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(3)
      } finally {
        clearTimeoutSpy.mockRestore()
      }
    })

    it('fails over a settled socket-close on the first turn without output', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      await runner.run()
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      const failoverAttempt = runner.waitForNextFailoverAttempt()
      mockSession.pi.simulateErrorEnd('The socket connection was closed unexpectedly')

      expect(await failoverAttempt).toBe(true)
      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      expect(mockSession.pi.promptCalls).toHaveLength(2)
      expect(execution.status).not.toBe('failed')
    })

    it('fails over to the next candidate on an exhaustion error (settled-run path)', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      await runner.run()
      // run() captures priorityList/currentSelectedSpec from the agent; override
      // them post-run to exercise a multi-candidate failover without DB/auth.
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      // The settled error surfaces as collector.lastError → handleAgentEnd → attemptFailover.
      const failoverAttempt = runner.waitForNextFailoverAttempt()
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      await failoverAttempt

      // Marked the exhausted provider unhealthy.
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
      // Switched the session model to the next candidate (context preserved).
      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      // Persisted the new selectedModel.
      expect(setAgentSelectedModelSpy).toHaveBeenCalledWith(agent.id, ZAI)
      // Re-dispatched the same turn.
      expect(mockSession.pi.promptCalls).toHaveLength(2)
      // currentSelectedSpec updated.
      expect((runner as any).currentSelectedSpec).toBe(ZAI)
    })

    it('fails over from a direct 429 to the same model via OpenRouter with effort and catalog window metadata', async () => {
      const DIRECT = 'anthropic:claude-sonnet-5:high'
      const OPENROUTER = 'openrouter:anthropic/claude-sonnet-5:high'
      selectModelSpy.mockRestore()
      selectModelSpy = undefined
      await modelSelection.setOpenRouterTierExpansionEnabled(true)
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a' } }],
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      })
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
      const selectAccountSpy = mock()
      try {
        await runner.run()
        ;(runner as any).priorityList = DIRECT
        ;(runner as any).currentSelectedSpec = DIRECT
        ;(mockSession as any).accountId = 'a1'
        ;(mockSession as any).authBackend = { selectAccount: selectAccountSpy }
        const failoverAttempt = runner.waitForNextFailoverAttempt()
        mockSession.pi.simulateErrorEnd('429 Too Many Requests')
        await failoverAttempt

        expect(providerHealth.isAccountHealthy('anthropic', 'a1')).toBe(false)
        expect(selectAccountSpy).toHaveBeenCalledWith('openrouter', 'or1')
        expect((runner as any).currentSelectedSpec).toBe(OPENROUTER)
        expect(setAgentSelectedModelSpy).toHaveBeenCalledWith(agent.id, OPENROUTER)
        expect(mockSession.pi.setModelCalls[0]).toMatchObject({
          provider: 'openrouter',
          id: 'anthropic/claude-sonnet-5',
          contextWindow: 1_000_000,
          compat: {
            openRouterRouting: {
              only: ['anthropic'],
              order: ['anthropic'],
              allow_fallbacks: false,
              require_parameters: true,
            },
          },
        })
        expect(mockSession.pi.promptCalls).toHaveLength(2)
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })

    it('fails over when OpenRouter reports that the pinned endpoint has no allowed providers', async () => {
      const OPENROUTER = 'openrouter:anthropic/claude-sonnet-5:high'
      const ZAI = 'zai:glm-5.2:high'
      selectModelSpy.mockRestore()
      selectModelSpy = undefined
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
          zai: [{ id: 'z1', enabled: true, credential: { type: 'api_key', key: 'sk-z' } }],
        },
      })
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
      try {
        await runner.run()
        ;(mockSession as any).accountId = 'or1'
        ;(mockSession as any).authBackend = { selectAccount: mock() }
        await runner.beginFailoverTurn(`${OPENROUTER},${ZAI}`, OPENROUTER)

        const failoverAttempt = runner.waitForNextFailoverAttempt()
        mockSession.pi.simulateErrorEnd('No allowed providers available for this model')
        expect(await failoverAttempt).toBe(true)

        expect(providerHealth.isAccountHealthy('openrouter', 'or1')).toBe(true)
        expect((runner as any).currentSelectedSpec).toBe(ZAI)
        expect(mockSession.pi.setModelCalls).toHaveLength(1)
        expect(mockSession.pi.promptCalls).toHaveLength(2)
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })

    for (const [status, phrase] of [
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [504, 'Gateway Timeout'],
      [507, 'Insufficient Storage'],
    ] as const) {
      it(`fails over an active OpenRouter selection on generic ${status}`, async () => {
        const ANTHROPIC = 'anthropic:claude-sonnet-5:high'
        const ZAI = 'zai:glm-5.2:high'
        const OPENROUTER = 'openrouter:anthropic/claude-sonnet-5:high'
        selectModelSpy.mockRestore()
        selectModelSpy = undefined
        await modelSelection.setOpenRouterTierExpansionEnabled(true)
        const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
          version: 1,
          accounts: {
            openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
            zai: [{ id: 'z1', enabled: true, credential: { type: 'api_key', key: 'sk-z' } }],
          },
        })
        const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
        const selectAccountSpy = mock()
        try {
          await runner.run()
          ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
          ;(runner as any).currentSelectedSpec = OPENROUTER
          ;(mockSession as any).accountId = 'or1'
          ;(mockSession as any).authBackend = { selectAccount: selectAccountSpy }
          const failoverAttempt = runner.waitForNextFailoverAttempt()
          mockSession.pi.simulateErrorEnd(`OpenAI API error (${status}): ${phrase}`)
          await failoverAttempt

          expect(providerHealth.isAccountHealthy('openrouter', 'or1')).toBe(true)
          expect(selectAccountSpy).toHaveBeenCalledWith('zai', 'z1')
          expect((runner as any).currentSelectedSpec).toBe(ZAI)
          expect(mockSession.pi.setModelCalls).toHaveLength(1)
          expect(mockSession.pi.promptCalls).toHaveLength(2)
        } finally {
          readAccountStoreSpy.mockRestore()
          mutateAccountStoreSpy.mockRestore()
        }
      })
    }

    it('rotates to the next account before failing over to another provider', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const selectAccountSpy = mock()
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          anthropic: [
            { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } },
            { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'sk-2' } },
          ],
        },
      } as any)
      // The lastUsedAt stamp persists through the transactional
      // mutateAccountStore (row-locked mutateSecret — it never routes through
      // writeAccountStore), so the persistence seam to observe is the mutate
      // entry point itself.
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)

      try {
        await runner.run()
        ;(runner as any).priorityList = ANTHROPIC
        ;(runner as any).currentSelectedSpec = ANTHROPIC
        ;(mockSession as any).accountId = 'a1'
        ;(mockSession as any).authBackend = { selectAccount: selectAccountSpy }

        const failoverAttempt = runner.waitForNextFailoverAttempt()
        mockSession.pi.simulateErrorEnd('rate limit exceeded')
        await failoverAttempt

        expect(providerHealth.isAccountHealthy('anthropic', 'a1')).toBe(false)
        expect(selectAccountSpy).toHaveBeenCalledWith('anthropic', 'a2')
        expect((mockSession as any).accountId).toBe('a2')
        expect(mockSession.pi.setModelCalls).toHaveLength(0)
        expect(selectModelSpy).not.toHaveBeenCalled()
        expect(mockSession.pi.promptCalls).toHaveLength(2)
        expect(mutateAccountStoreSpy).toHaveBeenCalled()
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })

    it('selects and reloads the next provider account during provider failover', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const OPENAI = 'openai:gpt-4o'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, OPENAI))
      const selectAccountSpy = mock()
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a1' } }],
          openai: [{ id: 'o1', enabled: true, credential: { type: 'api_key', key: 'sk-o1' } }],
        },
      } as any)
      // See the rotation test above: persistence happens via the transactional
      // mutateAccountStore, not writeAccountStore.
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)

      try {
        await runner.run()
        ;(runner as any).priorityList = `${ANTHROPIC},${OPENAI}`
        ;(runner as any).currentSelectedSpec = ANTHROPIC
        ;(mockSession as any).accountId = 'a1'
        ;(mockSession as any).authBackend = { selectAccount: selectAccountSpy }

        const failoverAttempt = runner.waitForNextFailoverAttempt()
        mockSession.pi.simulateErrorEnd('rate limit exceeded')
        await failoverAttempt

        expect(mockSession.pi.setModelCalls).toHaveLength(1)
        expect(selectAccountSpy).toHaveBeenCalledWith('openai', 'o1')
        expect((mockSession as any).accountId).toBe('o1')
        expect((runner as any).currentSelectedSpec).toBe(OPENAI)
        expect(mutateAccountStoreSpy).toHaveBeenCalled()
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })

    it('honors an explicit reset timestamp in the error as the provider retryAt (not the default cooldown)', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      // A hard weekly/monthly limit whose reset is ~1.7 days out — far beyond
      // any default cooldown. The provider must stay exhausted until then.
      const resetMs = Date.now() + 40 * 60 * 60 * 1000
      const resetIso = new Date(resetMs).toISOString()

      await runner.run()
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      const failoverAttempt = runner.waitForNextFailoverAttempt()
      mockSession.pi.simulateErrorEnd(`429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${resetIso}`)
      await failoverAttempt

      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
      // retryAt is the parsed reset, not Date.now() + a 30-60min default cooldown.
      expect(providerHealth.getHealth('anthropic').retryAt).toBe(Date.parse(resetIso))
    })

    it('falls back to onError (waiting-input) when no candidate is usable', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      // Re-selection throws (no usable candidate).
      selectModelSpy.mockImplementation(() => {
        throw new (class extends Error {
          candidates: any[] = []
        })('No usable model')
      })

      await runner.run()
      ;(runner as any).priorityList = ANTHROPIC
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      const errorSettlement = runner.waitForNextExecutionFailure()
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      await errorSettlement

      // No model switch happened.
      expect(mockSession.pi.setModelCalls).toHaveLength(0)
      // Execution failed → waiting-input path (rate-limit system message).
      expect(execution.status).toBe('failed')
      // Provider still marked exhausted even though failover didn't proceed.
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
    })

    it('does not fail over for non-exhaustion errors', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      await runner.run()
      ;(runner as any).priorityList = ANTHROPIC
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      const errorSettlement = runner.waitForNextExecutionFailure()
      mockSession.pi.simulateErrorEnd('some tool error')
      await errorSettlement

      expect(mockSession.pi.setModelCalls).toHaveLength(0)
      expect(setAgentSelectedModelSpy).not.toHaveBeenCalled()
      expect(execution.status).toBe('failed')
      // No provider was marked exhausted.
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(true)
    })

    it('fails over on a thrown prompt transport reset before output', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))
      let firstPrompt = true
      spyOn(mockSession.pi, 'prompt').mockImplementation(async (text: string, options?: any) => {
        mockSession.pi.promptCalls.push({ text, options })
        if (firstPrompt) {
          firstPrompt = false
          throw new Error('fetch failed', {
            cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
          })
        }
      })

      const failoverAttempt = runner.waitForNextFailoverAttempt()
      await runner.run()

      expect(await failoverAttempt).toBe(true)
      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      expect(mockSession.pi.promptCalls).toHaveLength(2)
      expect(execution.status).not.toBe('failed')
    })

    it('terminalizes a socket-close after assistant output without replaying', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      await runner.run()
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      mockSession.pi.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
        message: assistantMessage('partial'),
      } as any)
      const errorSettlement = runner.waitForNextExecutionFailure()
      mockSession.pi.simulateErrorEnd('The socket connection was closed unexpectedly')
      await errorSettlement

      expect(mockSession.pi.setModelCalls).toHaveLength(0)
      expect(mockSession.pi.promptCalls).toHaveLength(1)
      expect(execution.error).toBe('Provider transport failure: The socket connection was closed unexpectedly')
    })

    it('terminalizes a socket-close after a tool starts without replaying', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      await runner.run()
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      mockSession.pi.emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'echo side-effect' },
      } as any)
      const errorSettlement = runner.waitForNextExecutionFailure()
      mockSession.pi.simulateErrorEnd('The socket connection was closed unexpectedly')
      await errorSettlement

      expect(mockSession.pi.setModelCalls).toHaveLength(0)
      expect(mockSession.pi.promptCalls).toHaveLength(1)
      expect(execution.error).toBe('Provider transport failure: The socket connection was closed unexpectedly')
    })

    it('fails over on a thrown prompt() exhaustion error (sendPrompt catch path)', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))
      // First prompt throws an exhaustion error; the re-dispatched prompt succeeds.
      let firstPrompt = true
      spyOn(mockSession.pi, 'prompt').mockImplementation(async (text: string, options?: any) => {
        mockSession.pi.promptCalls.push({ text, options })
        if (firstPrompt) {
          firstPrompt = false
          throw new Error('rate limit exceeded')
        }
      })

      const failoverAttempt = runner.waitForNextFailoverAttempt()
      await runner.run()
      await failoverAttempt

      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      expect(setAgentSelectedModelSpy).toHaveBeenCalledWith(agent.id, ZAI)
      expect(mockSession.pi.promptCalls).toHaveLength(2)
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
    })

    it('preserves a structured generic 5xx from prompt rejection through real failover classification', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))
      let firstPrompt = true
      spyOn(mockSession.pi, 'prompt').mockImplementation(async (text: string, options?: any) => {
        mockSession.pi.promptCalls.push({ text, options })
        if (firstPrompt) {
          firstPrompt = false
          throw Object.assign(new Error('neutral upstream failure'), { status: 502 })
        }
      })

      const failoverAttempt = runner.waitForNextFailoverAttempt()
      await runner.run()
      await failoverAttempt

      expect(providerHealth.getHealth('anthropic').lastObservedStatus).toBe(502)
      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      expect(setAgentSelectedModelSpy).toHaveBeenCalledWith(agent.id, ZAI)
      expect(mockSession.pi.promptCalls).toHaveLength(2)
    })

    it('uses the real health-aware selector through direct A, direct B, OpenRouter A, and OpenRouter B', async () => {
      const A = 'anthropic:claude-sonnet-5:high'
      const B = 'zai:glm-5.2:high'
      const OR_A = 'openrouter:anthropic/claude-sonnet-5:high'
      const OR_B = 'openrouter:z-ai/glm-5.2:high'
      const chain = `${A},${B}`
      selectModelSpy.mockRestore()
      selectModelSpy = undefined
      await modelSelection.setOpenRouterTierExpansionEnabled(true)
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a' } }],
          zai: [{ id: 'z1', enabled: true, credential: { type: 'api_key', key: 'sk-z' } }],
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      })
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
      const selectAccountSpy = mock()
      try {
        expect(modelSelection.resolveModelCandidatesForCurrentEnv(chain)).toEqual([A, B, OR_A, OR_B])
        await runner.run()
        ;(mockSession as any).accountId = 'a1'
        ;(mockSession as any).authBackend = { selectAccount: selectAccountSpy }
        await runner.beginFailoverTurn(chain, A)

        for (const [error, expected] of [
          ['429 Too Many Requests', B],
          ['429 Too Many Requests', OR_A],
          ['OpenAI API error (502): Bad Gateway', OR_B],
        ] as const) {
          const failoverAttempt = runner.waitForNextFailoverAttempt()
          mockSession.pi.simulateErrorEnd(error)
          expect(await failoverAttempt).toBe(true)
          expect((runner as any).currentSelectedSpec).toBe(expected)
        }
        expect(providerHealth.isAccountHealthy('openrouter', 'or1')).toBe(true)
        expect(mockSession.pi.setModelCalls).toHaveLength(3)

        const exhaustedChainAttempt = runner.waitForNextFailoverAttempt()
        mockSession.pi.simulateErrorEnd('OpenAI API error (503): Service Unavailable')
        expect(await exhaustedChainAttempt).toBe(false)
        expect((runner as any).currentSelectedSpec).toBe(OR_B)
        expect(mockSession.pi.setModelCalls).toHaveLength(3)
        expect(providerHealth.isAccountHealthy('openrouter', 'or1')).toBe(true)
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })

    it('keeps an OpenRouter 429 account-scoped instead of advancing to another shadow', async () => {
      const A = 'anthropic:claude-sonnet-5:high'
      const B = 'zai:glm-5.2:high'
      const OR_A = 'openrouter:anthropic/claude-sonnet-5:high'
      selectModelSpy.mockRestore()
      selectModelSpy = undefined
      await modelSelection.setOpenRouterTierExpansionEnabled(true)
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      })
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
      try {
        await runner.run()
        ;(mockSession as any).accountId = 'or1'
        ;(mockSession as any).authBackend = { selectAccount: mock() }
        await runner.beginFailoverTurn(`${A},${B}`, OR_A)

        const failoverAttempt = runner.waitForNextFailoverAttempt()
        mockSession.pi.simulateErrorEnd('429 Too Many Requests')
        expect(await failoverAttempt).toBe(false)
        expect(providerHealth.isAccountHealthy('openrouter', 'or1')).toBe(false)
        expect(mockSession.pi.setModelCalls).toHaveLength(0)
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })

    it('respects the per-turn failover cap', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      const OPENAI = 'openai-codex:gpt-5.6-sol'
      // Re-selection returns the next explicitly ordered provider candidate.
      const selectionSequence = explicitProviderFailoverSequence([ANTHROPIC, ZAI, OPENAI])
      selectModelSpy.mockImplementation(selectionSequence.select)

      await runner.run()
      // Reset the turn boundary with the three-candidate chain so its resolved
      // space and budget are captured together, as they are in production.
      await runner.beginFailoverTurn(`${ANTHROPIC},${ZAI},${OPENAI}`, ANTHROPIC)

      // First error → failover to zai, re-dispatch.
      const failoverAttempt = runner.waitForNextFailoverAttempt(() => selectionSequence.outcomes)
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      await failoverAttempt

      // The re-dispatched prompt settled; emit a second exhaustion error on zai.
      const secondFailoverAttempt = runner.waitForNextFailoverAttempt(() => selectionSequence.outcomes)
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      await secondFailoverAttempt

      // With a 3-candidate list the cap is 3 failovers; two should have occurred.
      expect(mockSession.pi.setModelCalls).toHaveLength(2)
      expect((runner as any).currentSelectedSpec).toBe(OPENAI)
      // Both exhausted providers are unhealthy.
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
      expect(providerHealth.isProviderHealthy('zai')).toBe(false)
    })

    it('stops failing over at the exact per-turn cap and resets the budget for a new turn', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      const OPENAI = 'openai-codex:gpt-5.6-sol'
      const GEMINI = 'google:gemini-2.5-pro'
      const candidates = [ANTHROPIC, ZAI, OPENAI, GEMINI]
      const capPriorityList = `${ANTHROPIC},${ZAI}`
      const cap = 2

      // Keep returning valid, distinct replacements beyond the cap. The selector
      // must not independently terminate the failover loop.
      expect(candidates.length).toBeGreaterThan(cap)
      expect(new Set(candidates).size).toBe(candidates.length)
      expect(candidates.every((spec) => spec.includes(':'))).toBe(true)
      expect(classifyProviderError('rate limit exceeded')).not.toBeNull()
      const selectionSequence = explicitProviderFailoverSequence(candidates)
      selectModelSpy.mockImplementation(selectionSequence.select)

      await runner.run()
      await runner.beginFailoverTurn(capPriorityList, ANTHROPIC)

      for (const expectedSpec of [ZAI, OPENAI]) {
        const failoverAttempt = runner.waitForNextFailoverAttempt(() => selectionSequence.outcomes)
        mockSession.pi.simulateErrorEnd('rate limit exceeded')
        expect(await failoverAttempt).toBe(true)
        expect((runner as any).currentSelectedSpec).toBe(expectedSpec)
      }

      expect(selectionSequence.outcomes).toHaveLength(cap)
      for (const [index, outcome] of selectionSequence.outcomes.entries()) {
        expect(outcome.selected).toBe(candidates[index + 1])
        expect(outcome.candidates.find(({ spec }) => spec === outcome.selected)?.usable).toBe(true)
      }
      expect(runner.failoverCountThisTurn).toBe(cap)
      expect(selectModelSpy).toHaveBeenCalledTimes(cap)
      expect(mockSession.pi.setModelCalls).toHaveLength(cap)

      // A further retryable error is refused by the production cap before the
      // still-valid selector can return GEMINI.
      const cappedAttempt = runner.waitForNextFailoverAttempt(() => selectionSequence.outcomes)
      const errorSettlement = runner.waitForNextExecutionFailure()
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      expect(await cappedAttempt).toBe(false)
      await errorSettlement

      expect(selectModelSpy).toHaveBeenCalledTimes(cap)
      expect(mockSession.pi.setModelCalls).toHaveLength(cap)
      expect((runner as any).currentSelectedSpec).toBe(OPENAI)
      expect(execution.status).toBe('failed')
      expect(execution.error).toBe('rate limit exceeded')

      // beginTurn is the documented reset boundary: the same coordinator gets a
      // fresh budget and can consume the next valid replacement.
      await runner.beginFailoverTurn(capPriorityList, OPENAI)
      expect(runner.failoverCountThisTurn).toBe(0)
      expect(await (runner as any).attemptFailover('rate limit exceeded')).toBe(true)
      expect(selectModelSpy).toHaveBeenCalledTimes(cap + 1)
      expect(mockSession.pi.setModelCalls).toHaveLength(cap + 1)
      expect((runner as any).currentSelectedSpec).toBe(GEMINI)
    })

    it('shares the cap across overlapping failover attempts in one turn', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      await runner.run()
      await runner.beginFailoverTurn(ANTHROPIC, ANTHROPIC)

      const attempts = await Promise.all([
        (runner as any).attemptFailover('rate limit exceeded'),
        (runner as any).attemptFailover('rate limit exceeded'),
      ])

      expect(attempts).toEqual([true, false])
      expect(runner.failoverCountThisTurn).toBe(1)
      expect(selectModelSpy).toHaveBeenCalledTimes(1)
      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      expect((runner as any).currentSelectedSpec).toBe(ZAI)
    })

    it('shares the cap with a reentrant error from the replacement prompt', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      await runner.run()
      await runner.beginFailoverTurn(ANTHROPIC, ANTHROPIC)
      spyOn(mockSession.pi, 'prompt').mockRejectedValue(new Error('rate limit exceeded'))

      const errorSettlement = runner.waitForNextExecutionFailure()
      expect(await (runner as any).attemptFailover('rate limit exceeded')).toBe(true)
      await errorSettlement

      expect(runner.failoverCountThisTurn).toBe(1)
      expect(selectModelSpy).toHaveBeenCalledTimes(1)
      expect(mockSession.pi.setModelCalls).toHaveLength(1)
      expect(execution.error).toBe('rate limit exceeded')
    })

    it('falls through to onError when setModel rejects during failover (settled-run path)', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))
      // setModel rejects — failover should not throw uncaught.
      spyOn(mockSession.pi, 'setModel').mockRejectedValue(new Error('auth removed mid-switch'))

      await runner.run()
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      const errorSettlement = runner.waitForNextExecutionFailure()
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      await errorSettlement

      // Fallthrough: execution failed, agent idle — no unhandled rejection.
      expect(execution.status).toBe('failed')
      expect(agent.status).toBe('idle')
      // Provider was still marked exhausted (before the setModel attempt).
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
    })

    it('falls through to onError when setModel rejects during failover (sendPrompt catch path)', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))
      spyOn(mockSession.pi, 'setModel').mockRejectedValue(new Error('auth removed mid-switch'))
      // First prompt throws an exhaustion error.
      let firstPrompt = true
      spyOn(mockSession.pi, 'prompt').mockImplementation(async (text: string, options?: any) => {
        mockSession.pi.promptCalls.push({ text, options })
        if (firstPrompt) {
          firstPrompt = false
          throw new Error('rate limit exceeded')
        }
      })

      const errorSettlement = runner.waitForNextExecutionFailure()
      await runner.run()
      await errorSettlement

      // setModel failed → no re-dispatch, falls through to onError.
      expect(mockSession.pi.promptCalls).toHaveLength(1)
      expect(execution.status).toBe('failed')
    })

    it('emits a system_message announcing the failover', async () => {
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))

      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((e) => events.push(e))
      createBufferSpy.mockReturnValue(buffer)

      await runner.run()
      ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
      ;(runner as any).currentSelectedSpec = ANTHROPIC
      const failoverAttempt = runner.waitForNextFailoverAttempt()
      mockSession.pi.simulateErrorEnd('rate limit exceeded')
      await failoverAttempt

      const sysMsg = events.find((e) => e.type === 'system_message')
      expect(sysMsg).toBeTruthy()
      expect(sysMsg.text).toContain('anthropic')
      expect(sysMsg.text).toContain(ZAI)
      expect(sysMsg.text).toContain('retry in')
    })

    it('announces the account cooldown when the failure was recorded against an account', async () => {
      // OAuth/account failures are recorded per ACCOUNT, so the provider-level
      // record stays empty; reading only `getHealth(provider)` made every such
      // failover announce a bogus "retry in ~1m" no matter how long the real
      // cooldown was.
      const ANTHROPIC = 'anthropic:claude-haiku-4-5'
      const ZAI = 'zai:glm-5-turbo'
      selectModelSpy.mockReturnValue(explicitProviderFailoverSelection(ANTHROPIC, ZAI))
      const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a' } }],
        },
      })
      const mutateAccountStoreSpy = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)

      const buffer = new StreamBuffer()
      const events: any[] = []
      buffer.subscribe((e) => events.push(e))
      createBufferSpy.mockReturnValue(buffer)

      try {
        await runner.run()
        ;(runner as any).priorityList = `${ANTHROPIC},${ZAI}`
        ;(runner as any).currentSelectedSpec = ANTHROPIC
        ;(mockSession as any).accountId = 'a1'
        ;(mockSession as any).authBackend = { selectAccount: mock() }
        const failoverAttempt = runner.waitForNextFailoverAttempt()
        // The codex client's friendly plan-limit string → plan-credit, 30m cooldown.
        mockSession.pi.simulateErrorEnd('You have hit your ChatGPT usage limit (plus plan).')
        await failoverAttempt

        // Only the account record exists — the provider record is empty.
        expect(providerHealth.isAccountHealthy('anthropic', 'a1')).toBe(false)
        const sysMsg = events.find((e) => e.type === 'system_message')
        expect(sysMsg.text).toContain('retry in ~30m')
        expect(sysMsg.text).not.toContain('~1m')
      } finally {
        readAccountStoreSpy.mockRestore()
        mutateAccountStoreSpy.mockRestore()
      }
    })
  })
})

it('getSquadAgentTypeSkills returns squad-scoped extra skills for an agent type', () => {
  expect(
    getSquadAgentTypeSkills(
      { agentTypeSkills: { engineer: ['ops-skill', 'deploy-skill'], reviewer: ['review-skill'] } },
      'engineer'
    )
  ).toEqual(['ops-skill', 'deploy-skill'])
})

describe('buildBaseSessionOptions tool policy', () => {
  function makeRunner(agentTypeOverrides: Partial<ReturnType<typeof makeAgentType>> = {}) {
    const agent = makeAgent()
    const agentType = makeAgentType(agentTypeOverrides)
    const agentRef: { current: any } = { current: agent }
    const execution = makeExecution({ agentId: agent.id }, agentRef)
    const runner = new TestRunner(execution, agent, agentType, new MockAgentSession())
    spyOn(agent, 'getEffectiveModelSpec').mockResolvedValue('anthropic:claude-sonnet-4-5')
    return runner
  }

  const baseOpts = {
    systemPrompt: 'sp',
    skillPaths: undefined,
    extensionPaths: undefined,
    sandboxId: 'agent_x',
    workspacePath: '/private',
  }

  it("applies the agent type's toolsAllow/toolsDeny to every session", async () => {
    const runner = makeRunner({ toolsAllow: ['read', 'bash'], toolsDeny: ['write'] })
    const tool = { name: 'read' } as any

    const options = await (runner as any).buildBaseSessionOptions({
      ...baseOpts,
      tools: { core: [], available: [tool] },
    })

    expect(options.tools.allow).toEqual(['read', 'bash'])
    expect(options.tools.deny).toEqual(['write'])
    expect(options.tools.available).toEqual([tool])
  })

  it('leaves allow/deny unset when the agent type declares no policy', async () => {
    const runner = makeRunner({ toolsAllow: null, toolsDeny: null })

    const options = await (runner as any).buildBaseSessionOptions({
      ...baseOpts,
      tools: { core: [], available: [] },
    })

    expect(options.tools.allow).toBeUndefined()
    expect(options.tools.deny).toBeUndefined()
  })
})
