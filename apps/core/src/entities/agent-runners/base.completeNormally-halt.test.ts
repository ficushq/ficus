import { describe, it, expect, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import { AgentRunner } from './base'
import { MockAgentSession } from '../../services/execution/test-helpers'
import { AgentSession } from '../AgentSession'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'
import { Execution } from '../Execution'
import { db } from '../../db'
import { agents, agentTypes as agentTypeRows, executions } from '../../db/schema'
import { turnHooks } from '../../services/turn-hooks'

function persistUser(mockSession: MockAgentSession, content: string, entryId = `entry-${Date.now()}`): void {
  const message = { role: 'user', content }
  mockSession.pi.emit({ type: 'message_end', message } as any)
  mockSession.pi.emit({ type: 'session_message_persisted', message, entryId, sessionFile: 'test.jsonl' } as any)
}

/**
 * `simulateNormalEnd` only kicks the runner off; completeNormally then runs the
 * turn hooks and commits `transitionTo` through several real DB round trips.
 * A fixed sleep is a guess at how long that takes — it held on a developer
 * laptop and lost on the CI runner, where the shared postgres container made
 * the same work take longer than 50ms and the execution was still 'running'.
 * Wait for the terminal state instead, bounded so a genuine hang still fails.
 */
async function waitForTerminalExecution(id: string): Promise<Execution> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const execution = await Execution.mustFind(id)
    if (execution.status !== 'running' || Date.now() > deadline) return execution
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Covers a review-identified gap: AgentRunner.completeNormally's hook-halt
// branch (hookResult.action === 'halt') calls execution.transitionTo({kind:
// 'completed', usage, agent: {status, questionData}}) — but no prior test
// exercised that branch end-to-end against real DB-backed entities. The one
// existing halt test in base.test.ts seeds pending human messages so
// requeueIfPendingMessagesRemain short-circuits before the halt branch runs,
// and its mock Execution has no transitionTo at all.
// ---------------------------------------------------------------------------

class TestRunner extends AgentRunner {
  mockSession: MockAgentSession

  constructor(execution: Execution, agent: Agent, agentType: AgentType, mockSession: MockAgentSession) {
    super(execution, agent, agentType)
    this.mockSession = mockSession
  }

  protected async createSession(): Promise<AgentSession> {
    return this.mockSession as any
  }

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.completeNormally(response, metadata, sessionUsage)
  }
}

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
      persistUser(mockSession, 'trigger halt')
      await new Promise((r) => setTimeout(r, 0))
      mockSession.pi.simulateNormalEnd('halted response')

      const executionAfter = await waitForTerminalExecution(execution.id)
      expect(executionAfter.status).toBe('completed')
      expect(executionAfter.usage).toBeTruthy()

      const agentAfter = await Agent.mustFind(agent.id)
      expect(agentAfter.status).toBe('waiting-input')
      expect(agentAfter.questionData).toEqual(questionData)
    } finally {
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
      persistUser(mockSession, 'trigger halt')
      await new Promise((r) => setTimeout(r, 0))
      mockSession.pi.simulateNormalEnd('halted response')

      const executionAfter = await waitForTerminalExecution(execution.id)
      expect(executionAfter.status).toBe('completed')

      const agentAfter = await Agent.mustFind(agent.id)
      expect(agentAfter.status).toBe('idle')
      // No `updates` on the hook result means questionData is omitted from the
      // disposition entirely (not explicitly nulled) — the prior value survives.
      expect(agentAfter.questionData).toEqual(staleQuestionData)
    } finally {
      runSpy.mockRestore()
      await cleanup(agent.id, agentTypeId)
    }
  })
})
