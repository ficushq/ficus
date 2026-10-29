import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { agentTypes, agents, messages, chatSendReceipts } from '../../db/schema'
import { db } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { handleControlSignal } from './control-signals'
import { withChatQueueState } from '../chat/queued-messages'
import { registerSession, removeSession } from './session-state'
import { AgentSession } from '../../entities/AgentSession'
import * as sessionFiles from '../../lib/infra/session-files'

describe('control signal clear-queue', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let agent: Agent

  beforeEach(async () => {
    testPrefix = `control-signal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Control Signal Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    agent = await Agent.create({ agentTypeId: testAgentTypeId })
  })

  afterEach(async () => {
    mock.restore()
    removeSession(agent.id)
    const agentRows = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    const agentIds = agentRows.map((row) => row.id)
    if (agentIds.length > 0) {
      await db.delete(chatSendReceipts).where(inArray(chatSendReceipts.agentId, agentIds))
      await db.delete(messages).where(inArray(messages.agentId, agentIds))
      await db.delete(agents).where(inArray(agents.id, agentIds))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    eventEmitter.removeAllListeners()
  })

  it('ignores a delayed execution-scoped stop after resume replaced the active turn', async () => {
    const abort = mock(async () => {})
    registerSession(agent.id, {
      executionId: 'resumed-execution',
      session: { pi: { abort, isBashRunning: false } },
    } as any)
    await handleControlSignal({ action: 'stop', agentId: agent.id, executionId: 'paused-execution' })
    expect(abort).not.toHaveBeenCalled()
  })

  it('ignores clear requests on a worker with no active session', async () => {
    await agent.recordMessage({ role: 'human', content: 'queued steer', pending: true })
    const queueCleared: unknown[] = []
    eventEmitter.on('agent.queue-cleared', (event) => queueCleared.push(event))

    await handleControlSignal({ action: 'clear-queue', agentId: agent.id })

    const remainingPending = (await agent.listMessages()).messages.filter((message) => message.pending)
    expect(queueCleared).toEqual([])
    expect(remainingPending).toHaveLength(1)
  })

  it('ignores stale or expired clears and echoes the owning request identity', async () => {
    const updateQueuedMessage = mock(async () => true)
    const executionId = crypto.randomUUID()
    await agent.recordMessage({
      role: 'human',
      content: 'queued steer',
      pending: true,
      metadata: { deliveryMode: 'steer' },
    })
    registerSession(agent.id, { executionId, session: { pi: { updateQueuedMessage } } } as any)
    const acknowledgements: unknown[] = []
    const off = eventEmitter.on('agent.queue-cleared', (event) => acknowledgements.push(event))
    try {
      await handleControlSignal({ action: 'clear-queue', agentId: agent.id, executionId: 'old' })
      await handleControlSignal({ action: 'clear-queue', agentId: agent.id, executionId, expiresAt: Date.now() - 1 })
      expect(updateQueuedMessage).not.toHaveBeenCalled()
      expect(acknowledgements).toEqual([])
      expect((await agent.listMessages()).messages.filter((message) => message.pending)).toHaveLength(1)
      await handleControlSignal({ action: 'clear-queue', agentId: agent.id, executionId, requestId: 'request-1' })
      expect(acknowledgements).toMatchObject([{ executionId, requestId: 'request-1', owned: true, ok: true }])
    } finally {
      off()
    }
  })

  it('acks with ok:false instead of going silent when canceling from the SDK queue throws', async () => {
    // The API blocks on this ack. A throw that escaped the handler used to
    // strand it for the full 10s timeout, after which it deleted the DB rows
    // itself and reported success — while the SDK queue it cannot reach still
    // held the messages, so the agent answered them anyway.
    const message = await agent.recordMessage({
      role: 'human',
      content: 'queued steer',
      pending: true,
      metadata: { deliveryMode: 'steer' },
    })
    const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    await agent.claimPendingInterventionForSessionDelivery(message.id, owner)
    const updateQueuedMessage = mock(async () => {
      throw new Error('pi SDK exploded')
    })
    const queueCleared: { ok?: boolean; code?: string }[] = []
    eventEmitter.on('agent.queue-cleared', (event) => queueCleared.push(event))
    registerSession(agent.id, {
      agentId: agent.id,
      executionId: owner.executionId,
      collector: {} as any,
      buffer: {} as any,
      session: { pi: { updateQueuedMessage } } as any,
    })

    // It must not reject either — an unhandled rejection in the notification
    // handler is the same silence by another name.
    await handleControlSignal({ action: 'clear-queue', agentId: agent.id })

    expect(queueCleared).toHaveLength(1)
    expect(queueCleared[0]).toMatchObject({ ok: false, code: 'worker_error', owned: true })
    expect(await Agent.findMessage(message.id)).not.toBeNull()
  })

  it('cancels only user-sent messages, leaving inbox and monitor deliveries queued in the session', async () => {
    const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    const record = async (content: string, metadata: Record<string, unknown>) => {
      const message = await agent.recordMessage({
        role: 'human',
        content,
        pending: true,
        metadata: { deliveryMode: 'steer', ...metadata },
      })
      return (await agent.claimPendingInterventionForSessionDelivery(message.id, owner))!
    }
    const mine = await record('mine', {})
    const inbox = await record('inbox', { source: 'inbox' })
    const monitor = await record('monitor', { source: 'monitor' })
    await agent.recordMessage({
      role: 'human',
      content: 'unclaimed inbox',
      pending: true,
      metadata: { source: 'inbox' },
    })
    const canceledDeliveryIds: string[] = []
    const updateQueuedMessage = mock(async (deliveryId: string, _operation: string, commit: () => Promise<void>) => {
      canceledDeliveryIds.push(deliveryId)
      await commit()
      return true
    })
    const acks: unknown[] = []
    eventEmitter.on('agent.queue-cleared', (event) => acks.push(event))
    registerSession(agent.id, { executionId: owner.executionId, session: { pi: { updateQueuedMessage } } } as any)

    await handleControlSignal({ action: 'clear-queue', agentId: agent.id })

    expect(canceledDeliveryIds).toEqual([mine.metadata!.sessionDelivery!.id])
    expect(acks).toMatchObject([{ cleared: 1, deleted: 1, owned: true, ok: true }])
    const remaining = (await agent.listMessages()).messages.map((message) => message.content).toSorted()
    expect(remaining).toEqual(['inbox', 'monitor', 'unclaimed inbox'])
    expect(inbox.id).toBeTruthy()
    expect(monitor.id).toBeTruthy()
  })

  it('deletes unclaimed pending rows and acks clear-queue when this worker owns the session', async () => {
    await agent.recordMessage({
      role: 'human',
      content: 'queued steer',
      pending: true,
      metadata: { deliveryMode: 'steer' },
    })
    await agent.recordMessage({
      role: 'human',
      content: 'queued follow-up',
      pending: true,
      metadata: { deliveryMode: 'follow-up' },
    })
    await agent.recordMessage({ role: 'human', content: 'already delivered', pending: false })
    const updateQueuedMessage = mock(async () => true)
    const queueCleared: unknown[] = []
    eventEmitter.on('agent.queue-cleared', (event) => queueCleared.push(event))
    registerSession(agent.id, {
      agentId: agent.id,
      executionId: crypto.randomUUID(),
      collector: {} as any,
      buffer: {} as any,
      session: {
        pi: { updateQueuedMessage },
      } as any,
    })

    await handleControlSignal({ action: 'clear-queue', agentId: agent.id })

    const remainingMessages = (await agent.listMessages()).messages
    // Nothing was claimed into the session, so nothing needs an SDK cancel.
    expect(updateQueuedMessage).not.toHaveBeenCalled()
    expect(queueCleared).toMatchObject([{ agentId: agent.id, cleared: 0, deleted: 2, owned: true, ok: true }])
    expect(remainingMessages.map((message) => message.content)).toEqual(['already delivered'])
  })

  it('clears receipt-backed chat input without allowing a delayed send retry to enqueue it again', async () => {
    const execution = await agent.queueExecution({ message: 'initial turn' })
    const initial = (await agent.listMessages()).messages[0]!
    await agent.confirmPendingMessage(initial.id)
    const clientId = crypto.randomUUID()
    const options = { metadata: { clientId }, deliveryMode: 'follow-up' as const }
    await agent.sendMessage('cancel me', options)
    const [receipt] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
    expect(receipt?.messageId).toBeTruthy()
    const owner = { generation: crypto.randomUUID(), executionId: execution.id }
    const claimed = await agent.claimPendingInterventionForSessionDelivery(receipt!.messageId!, owner)
    // This is the production regression: a durable acceptance receipt protects
    // the message from the old blanket DELETE.
    await expect(db.delete(messages).where(eq(messages.id, receipt!.messageId!)).execute()).rejects.toThrow()

    const updateQueuedMessage = mock(async (_deliveryId: string, _operation: string, commit: () => Promise<void>) => {
      await commit()
      return true
    })
    registerSession(agent.id, {
      executionId: execution.id,
      session: { pi: { updateQueuedMessage } },
    } as any)
    const acks: unknown[] = []
    const unsubscribe = eventEmitter.on('agent.queue-cleared', (event) => acks.push(event))
    try {
      await handleControlSignal({ action: 'clear-queue', agentId: agent.id })
      expect(acks).toEqual([{ agentId: agent.id, cleared: 1, deleted: 1, owned: true, ok: true }])
      expect(await Agent.findMessage(receipt!.messageId!)).toBeNull()
      expect(
        await agent.confirmSessionDelivery(claimed!.metadata!.sessionDelivery!.id, owner, 'late-entry', {
          executionId: execution.id,
          streamGroupId: 'late-group',
        })
      ).toEqual([])
      const [tombstone] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
      expect(tombstone).toEqual({ ...receipt, messageId: null })
      expect(await agent.sendMessage('cancel me', options)).toMatchObject({ success: true, queued: false })
      expect((await agent.listMessages()).messages.map((message) => message.content)).toEqual(['initial turn'])
      await expect(agent.sendMessage('different payload', options)).rejects.toThrow()
      // Deliberately submitting the restored draft is a new send identity.
      await agent.sendMessage('cancel me', { ...options, metadata: { clientId: crypto.randomUUID() } })
      expect((await agent.listMessages()).messages.filter((message) => message.pending)).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  it('keeps a queued turn opening message through Clear, then clears it once the turn is stopped', async () => {
    // Clearing the opening message of a turn that has not started would not cancel it: the execution keeps
    // its own copy of the text and sends it anyway. Clear leaves it until the turn ends.
    const clientId = crypto.randomUUID()
    const execution = await agent.queueExecution({ message: 'nudge', metadata: { clientId } })
    const steer = await agent.sendMessage('also this', {
      deliveryMode: 'steer',
      metadata: { clientId: crypto.randomUUID() },
    })
    expect(steer.success).toBe(true)
    const shown = await withChatQueueState(agent.id, (await agent.listMessages()).messages)
    expect(shown.map((message) => [message.content, message.queued])).toEqual([
      ['nudge', false],
      ['also this', true],
    ])

    expect(await agent.clearQueue()).toMatchObject({ ok: true, deleted: 1, code: 'no_active_execution' })
    expect((await agent.listMessages()).messages.map((message) => message.content)).toEqual(['nudge'])

    // A turn stopped before it started leaves its opening message as ordinary, clearable queued input.
    await execution.requestStopWithSignal()
    const afterStop = await withChatQueueState(agent.id, (await agent.listMessages()).messages)
    expect(afterStop.map((message) => message.queued)).toEqual([true])
    expect(await agent.clearQueue()).toMatchObject({ ok: true, deleted: 1 })
    expect((await agent.listMessages()).messages).toEqual([])
    // The accepted receipt stays a tombstone, so a delayed retry cannot resurrect the cleared text.
    expect((await agent.queueExecution({ message: 'nudge', metadata: { clientId } })).id).toBe(execution.id)
    expect((await agent.listMessages()).messages).toEqual([])
  })
})

describe('manual compaction usage refresh', () => {
  let testAgentTypeId: string
  let agent: Agent

  beforeEach(async () => {
    const testPrefix = `compact-usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Compact Usage Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    agent = await Agent.create({ agentTypeId: testAgentTypeId })
  })

  afterEach(async () => {
    mock.restore()
    const agentRows = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    const agentIds = agentRows.map((row) => row.id)
    if (agentIds.length > 0) {
      await db.delete(messages).where(inArray(messages.agentId, agentIds))
      await db.delete(agents).where(inArray(agents.id, agentIds))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    eventEmitter.removeAllListeners()
  })

  it('persists a fresh usage snapshot from the compacted session after manual compaction', async () => {
    // A session file must appear to exist so the handler does not bail with 'no-session'.
    spyOn(sessionFiles, 'findSessionFile').mockReturnValue('/tmp/fake-session.jsonl')

    const compactedUsage = {
      stats: { userMessages: 1, assistantMessages: 1, totalMessages: 2, tokens: { total: 50_000 }, cost: 0 },
      context: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
    }
    const compactSpy = mock(async () => {})
    const createSpy = spyOn(AgentSession, 'create').mockResolvedValue({
      pi: { compact: compactSpy },
      captureUsage: () => compactedUsage,
    } as never)

    await handleControlSignal({ action: 'compact', agentId: agent.id, message: 'summarize' })

    // Compaction ran, and the post-compaction usage was persisted on the agent
    // (the same field the UI reads), not left stale at the pre-compaction value.
    expect(compactSpy).toHaveBeenCalledTimes(1)
    const reloaded = await Agent.find(agent.id)
    expect(reloaded?.sessionUsage?.context?.percent).toBe(25)
    expect(reloaded?.sessionUsage?.context?.tokens).toBe(50_000)

    // The throwaway compaction session must opt out of precompaction so it does
    // not spuriously start (and immediately abort) a background bake.
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ precompaction: false }))
    // Its summary is recorded in the inference cost ledger as the agent's compaction.
    const options = (
      createSpy.mock.calls[0] as unknown as [{ usage: { feature: string; attribution: () => unknown } }]
    )[0]
    expect(options.usage.feature).toBe('compaction')
    expect(options.usage.attribution()).toMatchObject({ agentId: agent.id })
  })

  it('does not overwrite usage when there is no session to compact', async () => {
    spyOn(sessionFiles, 'findSessionFile').mockReturnValue(null)
    const createSpy = spyOn(AgentSession, 'create')

    await handleControlSignal({ action: 'compact', agentId: agent.id, message: 'summarize' })

    expect(createSpy).not.toHaveBeenCalled()
    const reloaded = await Agent.find(agent.id)
    expect(reloaded?.sessionUsage ?? null).toBeNull()
  })
})
