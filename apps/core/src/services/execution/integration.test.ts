import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq, sql, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, chatSendReceipts, executions, messages, sandboxProvisionRecoveries } from '../../db/schema'
import { AgentType } from '../../entities/AgentType'
import { MockAgentSession, makeAgentType, TestAgentRunner } from './test-helpers'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { removeSession } from './session-state'
import { handleControlSignal } from './control-signals'
import { tryPickupExecutionsForTest } from '../../worker'
import * as agentRunners from '../../entities/agent-runners'
import { SandboxProvisionError } from '../sandbox/k8s/provision-errors'
import { streamManager } from '../streaming/buffer'

describe('Agent Runner Integration', () => {
  let testPrefix: string
  let agentTypeId: string
  let mockSession: MockAgentSession
  let factorySpy: any

  beforeEach(async () => {
    testPrefix = `runner-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    agentTypeId = `${testPrefix}-type`
    mockSession = new MockAgentSession()

    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Runner Type',
      systemPrompt: 'You are a test agent.',
    })
  })

  afterEach(async () => {
    factorySpy?.mockRestore()
    // Clean up test data
    await db
      .delete(messages)
      .where(eq(messages.agentId, '___never_match___'))
      .catch(() => {})
    // Agent-specific cleanup done per-test via agentId
  })

  async function createTestAgent(): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId })
    await agent.update({ status: 'active' })
    return agent
  }

  async function createTestExecution(agentId: string, overrides: Record<string, any> = {}): Promise<Execution> {
    const [row] = await db
      .insert(executions)
      .values({
        agentId,
        status: 'running',
        message: 'Test message',
        ...overrides,
      })
      .returning()
    return await Execution.mustFind(row.id)
  }

  async function cleanup(agentId: string, runner?: TestAgentRunner) {
    removeSession(agentId)
    await runner?.waitForPersistence()
    await db
      .delete(messages)
      .where(eq(messages.agentId, agentId))
      .catch(() => {})
    await db
      .delete(executions)
      .where(eq(executions.agentId, agentId))
      .catch(() => {})
    await db
      .delete(agents)
      .where(eq(agents.id, agentId))
      .catch(() => {})
  }

  it('preserves a recoverable sandbox setup refusal as the same waiting execution', async () => {
    const agent = await createTestAgent()
    const execution = await createTestExecution(agent.id)
    const error = new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'safe', 5_000, {
      scope: 'scope',
      sandboxKey: 'box',
      reasonCode: 'unschedulable_capacity',
      circuitVersion: 2,
      refusalId: crypto.randomUUID(),
    })
    class RecoverableSetupRunner extends TestAgentRunner {
      constructor() {
        super(execution, agent, new AgentType({ id: agentTypeId } as any), mockSession)
        this.sandboxWaitDelayMs = 5
      }

      protected override async createSession() {
        return this.withSandboxSetupBatch(async () => {
          const operationId = crypto.randomUUID()
          this.sandboxSetupProgress({
            type: 'started',
            operationId,
            sandboxId: 'box',
            reason: 'runtime_start',
          })
          await Bun.sleep(20)
          this.sandboxSetupProgress({ type: 'finished', operationId, sandboxId: 'box', outcome: 'failed' })
          throw error
        })
      }
    }
    const runner = new RecoverableSetupRunner()
    factorySpy = spyOn(agentRunners, 'createRunner').mockResolvedValue(runner)

    await execution.setAgent(agent).run()

    await execution.reload()
    expect(execution.status).toBe('waiting-sandbox')
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
    expect(recovery).toMatchObject({ executionId: execution.id, refusalId: error.provision!.refusalId })
    const events = streamManager.get(execution.id)?.subscribe(() => {}) ?? []
    const phases = events.filter((event) => event.type === 'execution_phase').map((event) => event.phase)
    expect(phases).toEqual(['waiting_sandbox', 'sandbox_recovery_wait'])
    expect(phases).not.toContain('sandbox_ready')
    expect(events.some((event) => event.type === 'error' || event.type === 'done')).toBe(false)
    expect(streamManager.get(execution.id)?.status).toBe('done')

    await cleanup(agent.id)
  })

  const WAIT_FOR_POLL_MS = 20

  /** The 20ms poll keeps bounded settlement assertions responsive. */
  async function waitFor(check: () => Promise<boolean>, attempts = 100): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_POLL_MS))
    }
    throw new Error('Timed out waiting for condition')
  }

  describe('worker pickup during compaction', () => {
    it('does not pick up queued execution while agent is compacting; picks up after finishCompaction', async () => {
      // pickupQueuedExecutions() sweeps the WHOLE executions table (production-
      // correct: one worker owns the instance). Under a shared test DB that
      // means a stray `queued` row leaked by another test (or a concurrent
      // local process) gets swept too and really spawned — "Unexpected agent
      // type" + a burned 5s budget (catalogued CI flake, 3 hits). Sweep the
      // strays first so this test's row is the only candidate.
      await db
        .delete(chatSendReceipts)
        .where(
          inArray(
            chatSendReceipts.executionId,
            db.select({ id: executions.id }).from(executions).where(eq(executions.status, 'queued'))
          )
        )
      await db.delete(executions).where(eq(executions.status, 'queued'))
      const agent = await Agent.create({ agentTypeId })
      await agent.update({ status: 'compacting' })
      const agentId = agent.id
      const exec = await agent.queueExecution({ message: 'after compaction' })
      const targetRunIds: string[] = []
      let stubRunCompleted = false
      const runSpy = spyOn(Execution.prototype, 'run').mockImplementation(function (this: Execution) {
        // A non-target row here is a stray from a concurrent process (the
        // sweep above cleared pre-existing ones) — never spawn it for real.
        if (this.id !== exec.id) return Promise.resolve()
        targetRunIds.push(this.id)
        stubRunCompleted = true
        return Promise.resolve()
      })

      try {
        await tryPickupExecutionsForTest()
        const stillQueued = await Execution.mustFind(exec.id)
        expect(stillQueued.status).toBe('queued')
        expect(targetRunIds).toEqual([])

        await agent.finishCompaction()
        await tryPickupExecutionsForTest()
        expect((await Execution.mustFind(exec.id)).status).toBe('running')
        expect(targetRunIds).toEqual([exec.id])
        expect(stubRunCompleted).toBe(true)
      } finally {
        const targetCallsBeforeCleanup = targetRunIds.length
        try {
          removeSession(agentId)
          await cleanup(agentId)
          await Promise.resolve()
          expect(targetRunIds).toHaveLength(targetCallsBeforeCleanup)
          expect(stubRunCompleted).toBe(targetCallsBeforeCleanup > 0)
        } finally {
          runSpy.mockRestore()
        }
      }
    })

    it('watchdog clears stale compacting agents so queued executions can be picked up', async () => {
      // pickupQueuedExecutions() sweeps the WHOLE executions table (production-
      // correct: one worker owns the instance). Under a shared test DB that
      // means a stray `queued` row leaked by another test (or a concurrent
      // local process) gets swept too and really spawned — "Unexpected agent
      // type" + a burned 5s budget (catalogued CI flake, 3 hits). Sweep the
      // strays first so this test's row is the only candidate.
      await db
        .delete(chatSendReceipts)
        .where(
          inArray(
            chatSendReceipts.executionId,
            db.select({ id: executions.id }).from(executions).where(eq(executions.status, 'queued'))
          )
        )
      await db.delete(executions).where(eq(executions.status, 'queued'))
      const agent = await Agent.create({ agentTypeId })
      await agent.update({ status: 'compacting' })
      const exec = await agent.queueExecution({ message: 'queued behind stuck compact' })
      await db
        .update(agents)
        .set({ updatedAt: sql`now() - interval '400 seconds'` })
        .where(eq(agents.id, agent.id))
      const targetRunIds: string[] = []
      let stubRunCompleted = false
      const runSpy = spyOn(Execution.prototype, 'run').mockImplementation(function (this: Execution) {
        // A non-target row here is a stray from a concurrent process (the
        // sweep above cleared pre-existing ones) — never spawn it for real.
        if (this.id !== exec.id) return Promise.resolve()
        targetRunIds.push(this.id)
        stubRunCompleted = true
        return Promise.resolve()
      })

      try {
        await tryPickupExecutionsForTest()
        const stillQueued = await Execution.mustFind(exec.id)
        expect(stillQueued.status).toBe('queued')
        expect(targetRunIds).toEqual([])

        const { runQueueWatchdogOnce } = await import('./queue-watchdog')
        await runQueueWatchdogOnce()

        await tryPickupExecutionsForTest()
        expect((await Execution.mustFind(exec.id)).status).toBe('running')
        expect(targetRunIds).toEqual([exec.id])
        expect(stubRunCompleted).toBe(true)
      } finally {
        const targetCallsBeforeCleanup = targetRunIds.length
        try {
          removeSession(agent.id)
          await cleanup(agent.id)
          await Promise.resolve()
          expect(targetRunIds).toHaveLength(targetCallsBeforeCleanup)
          expect(stubRunCompleted).toBe(targetCallsBeforeCleanup > 0)
        } finally {
          runSpy.mockRestore()
        }
      }
    })
  })

  // ---------------------------------------------------------------------------
  // GenericRunner end-to-end
  // ---------------------------------------------------------------------------

  describe('GenericRunner lifecycle', () => {
    it('completes execution and saves assistant message', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId)
      let runner: TestAgentRunner | undefined

      try {
        const agentType = makeAgentType({ id: agentTypeId })

        runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()

        // Simulate normal completion
        mockSession.pi.simulateNormalEnd('Here is my response')

        await runner.waitForPersistence()
        await waitFor(async () => {
          const [settledExecution, settledAgent, settledMessages] = await Promise.all([
            execution.reload(),
            Agent.find(agentId),
            agent.listMessages(),
          ])
          return (
            settledExecution?.status === 'completed' &&
            settledAgent?.status === 'idle' &&
            settledMessages.messages.some(
              (message) => message.role === 'assistant' && message.content === 'Here is my response'
            )
          )
        })

        // Verify execution is completed
        const exec = await execution.reload()
        expect(exec?.status).toBe('completed')
        expect(exec?.endedAt).toBeTruthy()

        // Verify agent is idle
        const updatedAgent = await Agent.find(agentId)
        expect(updatedAgent?.status).toBe('idle')

        // Verify messages saved
        const msgs = await agent.listMessages()
        // turn_end saves partial, then completeNormally might save again if there's remainder
        // At minimum we should have the turn_end partial save
        const assistantMsgs = msgs.messages.filter((m) => m.role === 'assistant')
        expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)
        expect(assistantMsgs[0].content).toBe('Here is my response')
      } finally {
        await cleanup(agentId, runner)
      }
    })

    it('handles prompt with message from execution record', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId, { message: 'What is 2+2?' })

      try {
        const agentType = makeAgentType({ id: agentTypeId })

        const runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()

        // Verify the prompt sent to the session
        expect(mockSession.pi.promptCalls).toHaveLength(1)
        expect(mockSession.pi.promptCalls[0].text).toBe('What is 2+2?')
      } finally {
        await cleanup(agentId)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Cancel flow
  // ---------------------------------------------------------------------------

  describe('stop flow', () => {
    it('aborts an active bash tool before aborting the session on stop signal', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId)

      try {
        const agentType = makeAgentType({ id: agentTypeId })
        const runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()
        await execution.update({ status: 'stopping' })
        Object.defineProperty(mockSession.pi, 'isBashRunning', { get: () => true })

        await handleControlSignal({ action: 'stop', agentId })

        expect(mockSession.pi.abortBashCalled).toBe(true)
        expect(mockSession.pi.abortCalled).toBe(true)
      } finally {
        removeSession(agentId)
        await cleanup(agentId)
      }
    })

    it('marks execution stopped with system message', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId)
      let runner: TestAgentRunner | undefined

      try {
        // Set to stopping (simulates what stopExecution does)
        await execution.update({ status: 'stopping' })

        const agentType = makeAgentType({ id: agentTypeId })

        runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()

        // Simulate agent_end (from session.abort())
        mockSession.pi.simulateNormalEnd('partial work before stop')

        await runner.waitForPersistence()
        await waitFor(async () => {
          const [settledExecution, settledAgent, settledMessages] = await Promise.all([
            execution.reload(),
            Agent.find(agentId),
            agent.listMessages(),
          ])
          return (
            settledExecution?.status === 'stopped' &&
            settledAgent?.status === 'idle' &&
            settledMessages.messages.some((message) => message.content === '[System] Agent was interrupted.')
          )
        })

        // Verify execution is stopped
        const exec = await execution.reload()
        expect(exec?.status).toBe('stopped')

        // Verify agent is idle
        const updatedAgent = await Agent.find(agentId)
        expect(updatedAgent?.status).toBe('idle')

        // Verify system message saved
        const msgs = await agent.listMessages()
        const systemMsg = msgs.messages.find((m) => m.content === '[System] Agent was interrupted.')
        expect(systemMsg).toBeTruthy()
      } finally {
        await cleanup(agentId, runner)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Error flow
  // ---------------------------------------------------------------------------

  describe('error flow', () => {
    it('marks execution failed when prompt throws rate limit error', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId)
      let runner: TestAgentRunner | undefined

      try {
        const agentType = makeAgentType({ id: agentTypeId })

        mockSession.pi.promptError = new Error('API rate limit')

        runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()

        await waitFor(async () => {
          const [settledExecution, settledAgent] = await Promise.all([execution.reload(), Agent.find(agentId)])
          return settledExecution?.status === 'failed' && settledAgent?.status === 'waiting-input'
        })

        const exec = await execution.reload()
        expect(exec?.status).toBe('failed')

        const updatedAgent = await Agent.find(agentId)
        expect(updatedAgent?.status).toBe('waiting-input')
      } finally {
        await cleanup(agentId, runner)
      }
    })

    it('marks execution failed when prompt throws non-rate-limit error', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId)
      let runner: TestAgentRunner | undefined

      try {
        const agentType = makeAgentType({ id: agentTypeId })

        mockSession.pi.promptError = new Error('Connection refused')

        runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()

        await waitFor(async () => {
          const [settledExecution, settledAgent] = await Promise.all([execution.reload(), Agent.find(agentId)])
          return settledExecution?.status === 'failed' && settledAgent?.status === 'idle'
        })

        const exec = await execution.reload()
        expect(exec?.status).toBe('failed')

        const updatedAgent = await Agent.find(agentId)
        expect(updatedAgent?.status).toBe('idle')
      } finally {
        await cleanup(agentId, runner)
      }
    })

    it('marks execution failed on SDK error during streaming', async () => {
      const agent = await createTestAgent()
      const agentId = agent.id
      const execution = await createTestExecution(agentId)

      try {
        const agentType = makeAgentType({ id: agentTypeId })

        const runner = new TestAgentRunner(execution, agent!, agentType, mockSession)
        await runner.run()

        mockSession.pi.simulateErrorEnd('Max retries exceeded')

        await new Promise((r) => setTimeout(r, 200))

        const exec = await execution.reload()
        expect(exec?.status).toBe('failed')

        const updatedAgent = await Agent.find(agentId)
        expect(updatedAgent?.status).toBe('idle')
      } finally {
        await cleanup(agentId)
      }
    })
  })
})
