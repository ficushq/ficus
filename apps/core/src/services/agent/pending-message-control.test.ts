import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlledPiSession } from '../../test-utils/controlled-pi-session'
import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { db, agents, agentTypes, messages, chatSendReceipts } from '../../db'
import { updateUnclaimedMessage, updateClaimedMessage } from './pending-message-control'
import { handleControlSignal } from '../execution/control-signals'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { withChatQueueState } from '../chat/queued-messages'
import { setDatabaseQueryObserverForTest } from '../../db'

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
  await db.insert(chatSendReceipts).values({
    agentId: agent.id,
    clientId: 'cancel-one',
    requestHash: 'hash',
    state: 'accepted',
    disposition: 'intervention',
    messageId: first.id,
  })
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

it('lets inbox deliveries change mode but never cancel, and leaves monitor deliveries untouched', async () => {
  const inbox = await agent.recordMessage({
    role: 'human',
    content: 'From the inbox',
    pending: true,
    metadata: { source: 'inbox', deliveryMode: 'follow-up', inboxMessageIds: ['inbox-1'] },
  })
  const monitor = await agent.recordMessage({
    role: 'human',
    content: 'Monitor event',
    pending: true,
    metadata: { source: 'monitor', deliveryMode: 'steer' },
  })
  expect(await updateUnclaimedMessage(agent.id, inbox.id, 'cancel')).toBe('not_allowed')
  expect(await updateUnclaimedMessage(agent.id, inbox.id, 'steer')).toBe('updated')
  expect(await updateUnclaimedMessage(agent.id, monitor.id, 'follow-up')).toBe('not_allowed')
  expect(await updateUnclaimedMessage(agent.id, monitor.id, 'cancel')).toBe('not_allowed')
  const rows = await db.select().from(messages).where(eq(messages.agentId, agent.id))
  expect(rows.map((row) => row.id).toSorted()).toEqual([inbox.id, monitor.id].toSorted())
  expect(rows.find((row) => row.id === inbox.id)!.metadata).toMatchObject({ source: 'inbox', deliveryMode: 'steer' })
  expect(rows.find((row) => row.id === monitor.id)!.metadata).toMatchObject({ deliveryMode: 'steer' })
})

it('protects an active turn opening message, then lets it be edited once the turn is stopped unstarted', async () => {
  const execution = await agent.queueExecution({ message: 'nudge', metadata: { clientId: crypto.randomUUID() } })
  const [opening] = (await agent.listMessages()).messages
  expect(await updateUnclaimedMessage(agent.id, opening!.id, 'cancel')).toBe('not_pending')
  await execution.requestStopWithSignal()
  expect(await updateUnclaimedMessage(agent.id, opening!.id, 'follow-up')).toBe('updated')
  expect(await updateUnclaimedMessage(agent.id, opening!.id, 'cancel')).toBe('updated')
  expect((await agent.listMessages()).messages).toEqual([])
})

it('never edits a queued question answer, which is always delivered as an interrupt', async () => {
  const answer = await agent.recordMessage({
    role: 'human',
    content: 'Answer to your question',
    pending: true,
    metadata: {
      source: 'inbox',
      deliveryMode: 'steer',
      inboxMessageSummaries: [
        {
          id: crypto.randomUUID(),
          senderType: 'user',
          senderId: crypto.randomUUID(),
          subject: 'Answer to your question',
          preview: 'Yes',
          questionAnswer: { questionId: crypto.randomUUID() } as never,
        },
      ],
    },
  })
  for (const operation of ['follow-up', 'steer', 'cancel'] as const)
    expect(await updateUnclaimedMessage(agent.id, answer.id, operation)).toBe('not_allowed')
  const [row] = await db.select().from(messages).where(eq(messages.id, answer.id))
  expect(row!.metadata).toMatchObject({ deliveryMode: 'steer' })
})

it('requires the exact live SDK claim and rolls back after ownership changes', async () => {
  const message = await agent.recordMessage({
    role: 'human',
    content: 'hello',
    pending: true,
    metadata: { deliveryMode: 'steer' },
  })
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
  const message = await agent.recordMessage({
    role: 'human',
    content: 'hello',
    pending: true,
    metadata: { deliveryMode: 'steer' },
  })
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

for (const originalMode of ['steer', 'follow-up'] as const) {
  it(`replays the original accepted ${originalMode} send after switching, without reverting the edit`, async () => {
    await agent.queueExecution({ message: 'initial' })
    const options = { deliveryMode: originalMode, metadata: { clientId: 'switch-replay' } }
    const accepted = await agent.sendMessage('queued request', options)
    const message = await agent.findHumanMessageByClientId('switch-replay')
    const editedMode = originalMode === 'steer' ? 'follow-up' : 'steer'
    expect(await updateUnclaimedMessage(agent.id, message!.id, editedMode)).toBe('updated')
    expect(await agent.sendMessage('queued request', options)).toEqual(accepted)
    const matching = (await agent.listMessages()).messages.filter((m) => m.metadata?.clientId === 'switch-replay')
    expect(matching).toHaveLength(1)
    expect(matching[0]!.id).toBe(message!.id)
    expect(matching[0]!.metadata?.deliveryMode).toBe(editedMode)
    await expect(agent.sendMessage('changed content', options)).rejects.toThrow('different payload')
    await expect(agent.sendMessage('queued request', { ...options, deliveryMode: editedMode })).rejects.toThrow(
      'different payload'
    )
    // Cancellation retains the same immutable receipt too.
    expect(await updateUnclaimedMessage(agent.id, message!.id, 'cancel')).toBe('updated')
    expect(await agent.sendMessage('queued request', options)).toMatchObject({ success: true, queued: false })
    expect(await agent.findHumanMessageByClientId('switch-replay')).toBeNull()
  })
}

it('preserves sub-millisecond database FIFO through claims and real SDK mode switching', async () => {
  // Allocate B's sequence first, but give A the earlier timestamp within the same millisecond.
  const second = await agent.recordMessage({
    role: 'human',
    content: 'B',
    pending: true,
    metadata: { deliveryMode: 'follow-up' },
  })
  const first = await agent.recordMessage({
    role: 'human',
    content: 'A',
    pending: true,
    metadata: { deliveryMode: 'follow-up' },
  })
  await db
    .update(messages)
    .set({ createdAt: sql`'2026-10-28 00:00:00.000100'::timestamp` })
    .where(eq(messages.id, first.id))
  await db
    .update(messages)
    .set({ createdAt: sql`'2026-10-28 00:00:00.000200'::timestamp` })
    .where(eq(messages.id, second.id))
  const rows = await agent.listPendingInterventionsForSessionDelivery()
  expect(rows.map((m) => m.id)).toEqual([first.id, second.id])
  expect(rows[0]!.createdAt).toEqual(rows[1]!.createdAt) // JS Date cannot distinguish these.
  const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const root = mkdtempSync(join(tmpdir(), 'pi-db-queue-order-'))
  const { session, ...fixture } = await controlledPiSession(root)
  const run = session.prompt('start', { deliveryId: 'initial' })
  try {
    await fixture.waitForRequest(1)
    const deliveryIds: string[] = []
    for (const row of rows) {
      const claimed = await agent.claimPendingInterventionForSessionDelivery(row.id, owner)
      const queueOrder = (claimed as typeof claimed & { deliveryOrder: string }).deliveryOrder
      expect(queueOrder).toContain(row.id === first.id ? '.000100:' : '.000200:')
      deliveryIds.push(claimed!.metadata!.sessionDelivery!.id)
      await session.followUp(claimed!.content, undefined, { deliveryId: deliveryIds.at(-1), queueOrder })
    }
    for (const operation of ['steer', 'follow-up'] as const) {
      expect(
        await updateClaimedMessage({
          agentId: agent.id,
          messageId: first.id,
          executionId: owner.executionId,
          operation,
          session: { pi: session } as any,
          stillOwned: () => true,
          expiresAt: Date.now() + 10_000,
        })
      ).toBe('updated')
    }
    expect(session.getFollowUpMessages()).toEqual(['A', 'B'])
    fixture.reply(0)
    await fixture.waitForRequest(2)
    fixture.reply(1)
    await fixture.waitForRequest(3)
    fixture.reply(2)
    await run
    expect(fixture.requestDeliveryIds.at(-1)).toEqual(['initial', ...deliveryIds])
  } finally {
    await session.abort()
    await run.catch(() => {})
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const clientId of ['primary', undefined]) {
  it(`preserves an initial prompt while canceling an identical intervention (${clientId ?? 'legacy'})`, async () => {
    await agent.sendMessage('identical', { metadata: clientId ? { clientId } : undefined })
    await agent.sendMessage('identical', { deliveryMode: 'follow-up' })
    const rows = (await agent.listMessages()).messages.filter((row) => row.role === 'human')
    expect(rows).toHaveLength(2)
    expect(await updateUnclaimedMessage(agent.id, rows[0]!.id, 'cancel')).toBe('not_pending')
    expect(await updateUnclaimedMessage(agent.id, rows[1]!.id, 'cancel')).toBe('updated')
    expect((await agent.listMessages()).messages.map((row) => row.id)).toEqual([rows[0]!.id])
  })
}

it('resolves receipt-less history once per execution and refreshes the identity on each read', async () => {
  await agent.sendMessage('same')
  for (let i = 0; i < 8; i++) await agent.sendMessage(i % 2 ? 'different' : 'same')
  const history = (await agent.listMessages()).messages
  const queries: string[] = []
  setDatabaseQueryObserverForTest((query) => queries.push(query))
  try {
    const result = await withChatQueueState(agent.id, history)
    expect(result.map((message) => message.queued)).toEqual([false, ...Array(8).fill(true)])
    expect(queries.filter((query) => query.includes('from "executions"'))).toHaveLength(1)
    expect(queries.filter((query) => query.includes('from "messages"'))).toHaveLength(1)
    expect(queries.find((query) => query.includes('from "messages"'))).toContain(
      'order by "messages"."created_at" asc, "messages"."enqueue_order" asc'
    )
    // No cross-request cache: the next refresh must consult the database again.
    queries.length = 0
    const refreshed = await withChatQueueState(agent.id, history)
    expect(refreshed).toEqual(result)
    expect(queries.filter((query) => query.includes('from "executions"'))).toHaveLength(1)
  } finally {
    setDatabaseQueryObserverForTest(undefined)
  }
})
