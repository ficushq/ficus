import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, chatSendReceipts, executions, messages } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { readSessionDeliveryReceipts } from './session-delivery-receipts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('sessionDeliveredExecutionPromptEntryIds', () => {
  let typeId: string
  let agent: Agent
  let dir: string

  beforeEach(async () => {
    typeId = `execution-prompt-${crypto.randomUUID()}`
    await AgentType.create({ id: typeId, name: 'Execution prompt', model: 'test:model', systemPrompt: 'test' })
    agent = await Agent.create({ agentTypeId: typeId })
    dir = mkdtempSync(join(tmpdir(), 'execution-prompt-'))
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.agentTypeId, typeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  function sessionFile(entries: unknown[]): string {
    const file = join(dir, 'session.jsonl')
    const header = { type: 'session', id: 'session-1' }
    writeFileSync(file, [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join(''))
    return file
  }

  async function claimOwnPrompt(executionId: string) {
    const owner = { executionId, generation: crypto.randomUUID() }
    const [claimed] = await agent.claimInitialPendingMessagesForSessionDelivery(owner)
    expect(claimed?.metadata?.executionId).toBe(executionId)
    return { claimed: claimed!, owner }
  }

  it('is empty while the queued prompt row is pending and holds its session entry once acknowledged', async () => {
    const execution = await agent.queueExecution({ message: 'original task text' })
    expect(execution.message).toBe('original task text')
    expect(await agent.sessionDeliveredExecutionPromptEntryIds(execution.id)).toEqual([])

    const { claimed, owner } = await claimOwnPrompt(execution.id)
    // Claimed but not yet appended: still not in the session.
    expect(await agent.sessionDeliveredExecutionPromptEntryIds(execution.id)).toEqual([])

    const deliveryId = claimed.metadata!.sessionDelivery!.id
    await agent.confirmSessionDelivery(deliveryId, owner, 'entry-1', { executionId: execution.id, streamGroupId: 'g' })
    expect(await agent.sessionDeliveredExecutionPromptEntryIds(execution.id)).toEqual(['entry-1'])
    // Another execution's prompt is not this one.
    expect(await agent.sessionDeliveredExecutionPromptEntryIds(crypto.randomUUID())).toEqual([])
  })

  it('counts a prompt that hard-interruption reconciliation finds appended to the session', async () => {
    const appended = await agent.queueExecution({ message: 'appended before the crash' })
    const { claimed } = await claimOwnPrompt(appended.id)
    const deliveryId = claimed.metadata!.sessionDelivery!.id
    const file = sessionFile([
      {
        type: 'message',
        id: 'entry-appended',
        deliveryId,
        message: { role: 'user', content: 'appended before the crash' },
      },
    ])
    await agent.reconcileSessionDeliveries((ids) => readSessionDeliveryReceipts(file, ids))
    expect(await agent.sessionDeliveredExecutionPromptEntryIds(appended.id)).toEqual(['entry-appended'])
  })

  it('releases a prompt that never reached the session before a hard interruption', async () => {
    const lost = await agent.queueExecution({ message: 'lost before the crash' })
    await claimOwnPrompt(lost.id)
    await agent.reconcileSessionDeliveries((ids) => readSessionDeliveryReceipts(sessionFile([]), ids))
    expect(await agent.sessionDeliveredExecutionPromptEntryIds(lost.id)).toEqual([])
    // Released, so the resumed run claims and sends it again.
    const [reclaimed] = await agent.claimInitialPendingMessagesForSessionDelivery({
      executionId: lost.id,
      generation: crypto.randomUUID(),
    })
    expect(reclaimed?.content).toBe('lost before the crash')
  })
})
