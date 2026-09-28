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
import { isSessionActive, isSessionHeldFor } from '../../services/execution/session-state'

function persistUser(mockSession: MockAgentSession, content: string, entryId = `entry-${Date.now()}`): void {
  const message = { role: 'user', content }
  mockSession.pi.emit({ type: 'message_end', message } as any)
  mockSession.pi.emit({ type: 'session_message_persisted', message, entryId, sessionFile: 'test.jsonl' } as any)
}

async function waitForTerminalExecution(id: string): Promise<Execution> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const execution = await Execution.mustFind(id)
    if (execution.status !== 'running' || Date.now() > deadline) return execution
    await new Promise((r) => setTimeout(r, 10))
  }
}

class TestRunner extends AgentRunner {
  constructor(
    execution: Execution,
    agent: Agent,
    agentType: AgentType,
    private readonly mockSession: MockAgentSession
  ) {
    super(execution, agent, agentType)
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
      persistUser(mockSession, 'trigger')
      await new Promise((r) => setTimeout(r, 0))
      mockSession.pi.simulateNormalEnd('done')

      const after = await waitForTerminalExecution(execution.id)
      expect(after.status).toBe('completed')
      expect(sessionActiveDuringHooks).toBe(false) // the session really was gone…
      expect(heldDuringHooks).toBe(true) // …but the execution stayed held (the sweep must skip it)
      // Released once settlement is DONE. The hold is cleared in completeNormally's
      // finally, i.e. after the terminal CAS AND the post-terminal work that
      // follows it (inbox retry, backoff resets), so it can lag the row's status
      // flip by a beat — poll for it rather than asserting the exact instant.
      const clearedBy = Date.now() + 5_000
      while (isSessionHeldFor(agent.id, execution.id) && Date.now() < clearedBy) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(isSessionHeldFor(agent.id, execution.id)).toBe(false)
    } finally {
      runSpy.mockRestore()
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypeRows).where(eq(agentTypeRows.id, agentTypeId))
    }
  })
})
