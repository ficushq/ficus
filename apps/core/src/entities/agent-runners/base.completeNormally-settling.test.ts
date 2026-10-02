import { describe, it, expect, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { MockAgentSession, TestAgentRunner as TestRunner } from '../../services/execution/test-helpers'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'
import { Execution } from '../Execution'
import { db } from '../../db'
import { agents, agentTypes as agentTypeRows, executions } from '../../db/schema'
import { turnHooks } from '../../services/turn-hooks'
import { isSessionActive, isSessionHeldFor } from '../../services/execution/session-state'

// ---------------------------------------------------------------------------
// The abandoned-lease sweep spares only executions THIS process holds
// (isSessionHeldFor). completeNormally tears the session down first and only
// then runs the turn hooks, saves the message and commits the terminal
// transition — a window of seconds while the row is still 'running' and the
// (effect-renewed-only) lease has expired. Observed live: the sweep re-queued 8
// live, finishing executions in 10 minutes on a single worker with no restart,
// each posting "[System] Agent recovered after a process restart." The
// settling hold must keep the execution held across that whole window.
// ---------------------------------------------------------------------------
describe('AgentRunner.completeNormally() keeps the execution held until it is terminal', () => {
  it('isSessionHeldFor stays true inside the turn-hooks window (session already gone) and clears after completion', async () => {
    const agentTypeId = `settling-${crypto.randomUUID()}`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Settling Hold Test Agent',
      systemPrompt: 'You are a test agent.',
    })
    const agent = await Agent.create({ agentTypeId })
    const execution = await agent.queueExecution({ message: 'trigger' })
    await execution.start()
    execution.runnerClaimToken = null
    execution.runnerClaimGeneration = null
    const mockSession = new MockAgentSession()
    const runner = new TestRunner(execution, agent, await AgentType.mustFind(agentTypeId), mockSession)

    let heldDuringHooks: boolean | undefined
    let sessionActiveDuringHooks: boolean | undefined
    const runSpy = spyOn(turnHooks, 'run').mockImplementation(async () => {
      // We are INSIDE the window: session torn down, row still 'running'.
      sessionActiveDuringHooks = isSessionActive(agent.id)
      heldDuringHooks = isSessionHeldFor(agent.id, execution.id)
      return { action: 'continue' } as any
    })

    try {
      await runner.run()
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
      mockSession.pi.simulateNormalEnd('done')

      await runner.waitForCompletion()
      const after = await Execution.mustFind(execution.id)
      expect(after.status).toBe('completed')
      expect(sessionActiveDuringHooks).toBe(false) // the session really was gone…
      expect(heldDuringHooks).toBe(true) // …but the execution stayed held (the sweep must skip it)
      // The completion barrier includes the settling-hold finally block.
      expect(isSessionHeldFor(agent.id, execution.id)).toBe(false)
    } finally {
      // Also drain settlement on assertion failures before deleting fixture rows.
      if (isSessionActive(agent.id)) {
        mockSession.pi.simulateNormalEnd('fixture cleanup')
        await runner.waitForCompletion()
      }
      runSpy.mockRestore()
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypeRows).where(eq(agentTypeRows.id, agentTypeId))
    }
  })
})
