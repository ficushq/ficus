import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { db, agents, agentTypes, messages, chatSendReceipts } from '../../db'
import { updateUnclaimedMessage, updateClaimedMessage } from './pending-message-control'
import { handleControlSignal } from '../execution/control-signals'
import { eventEmitter } from '../../lib/infra/event-emitter'

let agent: Agent
let typeId: string
beforeEach(async () => {
  typeId = `queue-edit-${crypto.randomUUID()}`
  await AgentType.create({
    id: typeId,
    name: 'Queue edit test',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test',
  })
  agent = await Agent.create({ agentTypeId: typeId })
})
afterEach(async () => {
  await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
  await db.delete(messages).where(eq(messages.agentId, agent.id))
  await db.delete(agents).where(eq(agents.id, agent.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
})

it('cancels only the selected row and preserves its accepted send tombstone', async () => {
  const first = await agent.recordMessage({ role: 'human', content: 'same', pending: true })
  const second = await agent.recordMessage({ role: 'human', content: 'same', pending: true })
  await db
    .insert(chatSendReceipts)
    .values({ agentId: agent.id, clientId: 'cancel-one', requestHash: 'hash', state: 'accepted', messageId: first.id })
  expect(await updateUnclaimedMessage(agent.id, first.id, 'cancel')).toBe('updated')
  const remaining = await db.select().from(messages).where(eq(messages.agentId, agent.id))
  expect(remaining.map((row) => row.id)).toEqual([second.id])
  const [receipt] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
  expect(receipt!.messageId).toBeNull()
  expect(receipt!.state).toBe('accepted')
})

it('switches without changing FIFO keys or attachments, and refuses consumed or other-agent rows', async () => {
  const message = await agent.recordMessage({
    role: 'human',
    content: 'hello',
    pending: true,
    metadata: { deliveryMode: 'follow-up', imageIds: ['image'] },
  })
  const [before] = await db.select().from(messages).where(eq(messages.id, message.id))
  expect(await updateUnclaimedMessage(agent.id, message.id, 'steer')).toBe('updated')
  const [after] = await db.select().from(messages).where(eq(messages.id, message.id))
  expect(after!.createdAt).toEqual(before!.createdAt)
  expect(after!.enqueueOrder).toBe(before!.enqueueOrder)
  expect(after!.metadata).toMatchObject({ deliveryMode: 'steer', imageIds: ['image'] })
  expect(await updateUnclaimedMessage(crypto.randomUUID(), message.id, 'cancel')).toBe('not_pending')
  await db.update(messages).set({ pending: false }).where(eq(messages.id, message.id))
  expect(await updateUnclaimedMessage(agent.id, message.id, 'cancel')).toBe('not_pending')
})

it('requires the exact live SDK claim and rolls back after ownership changes', async () => {
  const message = await agent.recordMessage({ role: 'human', content: 'hello', pending: true })
  const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const claimed = await agent.claimPendingInterventionForSessionDelivery(message.id, owner)
  expect(await updateUnclaimedMessage(agent.id, message.id, 'cancel')).toBe('claimed')
  const updateQueuedMessage = mock(async (_id: string, _mode: string, commit: () => Promise<void>) => {
    await commit()
    return true
  })
  const input = {
    agentId: agent.id,
    messageId: message.id,
    executionId: owner.executionId,
    operation: 'cancel' as const,
    session: { pi: { updateQueuedMessage } } as any,
    stillOwned: () => false,
    expiresAt: Date.now() + 10_000,
  }
  await expect(updateClaimedMessage(input)).rejects.toThrow('changed')
  expect(await db.select().from(messages).where(eq(messages.id, message.id))).toHaveLength(1)
  expect(await updateClaimedMessage({ ...input, stillOwned: () => true })).toBe('updated')
  expect(updateQueuedMessage.mock.calls[1]![0]).toBe(claimed!.metadata!.sessionDelivery!.id)
})

it('does not acknowledge or mutate a queue on a worker that does not own the execution', async () => {
  const message = await agent.recordMessage({ role: 'human', content: 'hello', pending: true })
  const received: unknown[] = []
  const unsubscribe = eventEmitter.on('agent.queue-message-updated', (event) => received.push(event))
  try {
    await handleControlSignal({
      action: 'update-pending-message',
      agentId: agent.id,
      messageId: message.id,
      executionId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      operation: 'cancel',
      expiresAt: Date.now() + 10_000,
    })
    expect(received).toEqual([])
    expect(await db.select().from(messages).where(eq(messages.id, message.id))).toHaveLength(1)
  } finally {
    unsubscribe()
  }
})
