import { describe, it, expect, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { MockAgentSession, TestAgentRunner as TestRunner } from '../../services/execution/test-helpers'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'
import { Execution } from '../Execution'
import { db } from '../../db'
import { agents, agentTypes as agentTypeRows, executions } from '../../db/schema'
import { turnHooks } from '../../services/turn-hooks'
import { isSessionActive } from '../../services/execution/session-state'

// ---------------------------------------------------------------------------
// Covers a review-identified gap: AgentRunner.completeNormally's hook-halt
// branch (hookResult.action === 'halt') calls execution.transitionTo({kind:
// 'completed', usage, agent: {status, questionData}}) — but no prior test
// exercised that branch end-to-end against real DB-backed entities. The one
// existing halt test in base.test.ts seeds pending human messages so
// requeueIfPendingMessagesRemain short-circuits before the halt branch runs,
// and its mock Execution has no transitionTo at all.
// ---------------------------------------------------------------------------

describe('AgentRunner.completeNormally() hook-halt transitionTo path', () => {
  async function setup(): Promise<{
    agentTypeId: string
    agent: Agent
    execution: Execution
    mockSession: MockAgentSession
    runner: TestRunner
  }> {
    const agentTypeId = `halt-branch-${crypto.randomUUID()}`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Halt Branch Test Agent',
      systemPrompt: 'You are a test agent.',
    })
    const agent = await Agent.create({ agentTypeId })
    const execution = await agent.queueExecution({ message: 'trigger halt' })
    await execution.start()
    // Direct runner harness: no pickup transaction exists to create a durable
    // admission reservation, so explicitly exercise the supported legacy/no-token path.
    execution.runnerClaimToken = null
    execution.runnerClaimGeneration = null

    const mockSession = new MockAgentSession()
    const runner = new TestRunner(execution, agent, await AgentType.mustFind(agentTypeId), mockSession)

    return { agentTypeId, agent, execution, mockSession, runner }
  }

  async function cleanup(agentId: string, agentTypeId: string): Promise<void> {
    await db.delete(executions).where(eq(executions.agentId, agentId))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agentTypeRows).where(eq(agentTypeRows.id, agentTypeId))
  }

  it('completes the execution and carries the hook status + questionData onto the agent', async () => {
    const { agentTypeId, agent, execution, mockSession, runner } = await setup()
    const questionData = {
      questions: [
        {
          id: 'test-halt',
          type: 'select' as const,
          question: 'q',
          optional: false,
          options: [{ value: 'A', label: 'A' }],
        },
      ],
    }
    const runSpy = spyOn(turnHooks, 'run').mockResolvedValue({
      action: 'halt',
      status: 'waiting-input',
      updates: { questionData },
    })

    try {
      await runner.run()
      // Confirm the initial queued human message so requeueIfPendingMessagesRemain
      // returns false and completeNormally reaches the hook-halt branch.
      const pending = await agent.listPendingHumanMessages()
      expect(pending).toHaveLength(1)
      const receipt = mockSession.pi.persistUserPrompt('initial-user-entry')
      expect(pending[0]!.metadata?.sessionDelivery?.id).toBe(receipt.deliveryId)
      await runner.waitForPersistence()
      // Assert consumption before settlement; otherwise an idle/retry branch can
      // accidentally satisfy the hook/hold assertions without acknowledging input.
      expect(await Agent.findMessage(pending[0]!.id)).toMatchObject({
        pending: false,
        metadata: {
          executionId: execution.id,
          sessionEntryId: receipt.entryId,
          streamGroupId: `${execution.id}:session:${receipt.entryId}:0`,
          sessionDelivery: { id: receipt.deliveryId, executionId: execution.id },
        },
      })
      expect(await agent.listPendingHumanMessages()).toHaveLength(0)
      mockSession.pi.simulateNormalEnd('halted response')

      await runner.waitForCompletion()
      const executionAfter = await Execution.mustFind(execution.id)
      expect(executionAfter.status).toBe('completed')
      expect(executionAfter.usage).toBeTruthy()

      const agentAfter = await Agent.mustFind(agent.id)
      expect(agentAfter.status).toBe('waiting-input')
      expect(agentAfter.questionData).toEqual(questionData)
    } finally {
      // Also drain settlement on assertion failures before deleting fixture rows.
      if (isSessionActive(agent.id)) {
        mockSession.pi.simulateNormalEnd('fixture cleanup')
        await runner.waitForCompletion()
      }
      runSpy.mockRestore()
      await cleanup(agent.id, agentTypeId)
    }
  })

  it('carries the hook status without touching existing questionData when no updates are given', async () => {
    const { agentTypeId, agent, execution, mockSession, runner } = await setup()
    const staleQuestionData = {
      questions: [{ id: 'pre-existing', type: 'select' as const, question: 'stale?', options: [{ value: 'X' }] }],
    }
    await Agent.update(agent.id, { questionData: staleQuestionData })
    await agent.reload()
    expect(agent.questionData).toEqual(staleQuestionData)

    const runSpy = spyOn(turnHooks, 'run').mockResolvedValue({
      action: 'halt',
      status: 'idle',
    })

    try {
      await runner.run()
      // Confirm the initial queued human message so requeueIfPendingMessagesRemain
      // returns false and completeNormally reaches the hook-halt branch.
      const pending = await agent.listPendingHumanMessages()
      expect(pending).toHaveLength(1)
      const receipt = mockSession.pi.persistUserPrompt('initial-user-entry')
      expect(pending[0]!.metadata?.sessionDelivery?.id).toBe(receipt.deliveryId)
      await runner.waitForPersistence()
      // Assert consumption before settlement; otherwise an idle/retry branch can
      // accidentally satisfy the hook/hold assertions without acknowledging input.
      expect(await Agent.findMessage(pending[0]!.id)).toMatchObject({
        pending: false,
        metadata: {
          executionId: execution.id,
          sessionEntryId: receipt.entryId,
          streamGroupId: `${execution.id}:session:${receipt.entryId}:0`,
          sessionDelivery: { id: receipt.deliveryId, executionId: execution.id },
        },
      })
      expect(await agent.listPendingHumanMessages()).toHaveLength(0)
      mockSession.pi.simulateNormalEnd('halted response')

      await runner.waitForCompletion()
      const executionAfter = await Execution.mustFind(execution.id)
      expect(executionAfter.status).toBe('completed')

      const agentAfter = await Agent.mustFind(agent.id)
      expect(agentAfter.status).toBe('idle')
      // No `updates` on the hook result means questionData is omitted from the
      // disposition entirely (not explicitly nulled) — the prior value survives.
      expect(agentAfter.questionData).toEqual(staleQuestionData)
    } finally {
      // Also drain settlement on assertion failures before deleting fixture rows.
      if (isSessionActive(agent.id)) {
        mockSession.pi.simulateNormalEnd('fixture cleanup')
        await runner.waitForCompletion()
      }
      runSpy.mockRestore()
      await cleanup(agent.id, agentTypeId)
    }
  })
})
