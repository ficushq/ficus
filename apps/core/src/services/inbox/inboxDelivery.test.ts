import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { InboxMessage } from '../../entities/InboxMessage'
import { Execution } from '../../entities/Execution'
import { Image } from '../../entities/Image'
import { db } from '../../db'
import { agents, agentTypes, executions, inbox, inboxAttachments, messages } from '../../db/schema'
import { deliverInboxMessagesToAgent } from './inboxDelivery'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  completeWake,
  makeDormant,
  runDormancyCompletionSweep,
  runLegacyTerminatedAgentSweepForTest,
  setDormancyEffectHookForTest,
} from '../agent/lifecycle'

async function createInboxMessage(input: {
  recipientId: string
  content: string
  deliveryMode?: 'steer' | 'follow-up'
  subject?: string
  metadata?: Record<string, unknown>
}) {
  const [row] = await db
    .insert(inbox)
    .values({
      recipientType: 'agent',
      recipientId: input.recipientId,
      senderType: 'system',
      senderId: null,
      subject: input.subject ?? null,
      content: input.content,
      metadata: input.metadata ?? {},
      deliveryMode: input.deliveryMode ?? 'follow-up',
    })
    .returning()
  return new InboxMessage(row)
}

describe('inbox delivery service', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let agent: Agent

  beforeEach(async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    testPrefix = `inbox-delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Inbox Delivery Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    agent = await Agent.create({
      agentTypeId: testAgentTypeId,
      metadata: { name: 'InboxDeliveryAgent' },
    })
  })

  afterEach(async () => {
    mock.restore()

    const agentRows = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    const agentIds = agentRows.map((row) => row.id)

    if (agentIds.length > 0) {
      await db.delete(messages).where(inArray(messages.agentId, agentIds))
      await db.delete(executions).where(inArray(executions.agentId, agentIds))
      await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
      await db.delete(agents).where(inArray(agents.id, agentIds))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('idle agent inbox send queues an execution and emits a wake event', async () => {
    const queuedEvents: Array<{ executionId: string; agentId: string; status: string }> = []
    const unsubscribe = eventEmitter.on('execution.queued', (event) => queuedEvents.push(event))

    try {
      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'Wake immediately',
      })
    } finally {
      unsubscribe()
    }

    const queued = await Execution.list({ agentId: agent.id, status: 'queued' })
    expect(queued).toHaveLength(1)
    expect(queuedEvents).toEqual([{ executionId: queued[0].id, agentId: agent.id, status: 'queued' }])
  })

  it('keeps a system message durable without waking a dormant agent', async () => {
    await makeDormant(agent)

    const sent = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'system',
      content: 'Monitor canceled',
      metadata: { wakeEligible: true },
    })

    expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
    expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
    const persisted = await InboxMessage.mustFind(sent.id)
    expect(persisted.deliveredAt).toBeNull()
    expect(persisted.metadata.wakeEligible).toBe(false)
  })

  it('wakes a dormant agent for genuine remote correspondence', async () => {
    await makeDormant(agent)

    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'remote',
      senderId: 'amtp://peer.example/agent',
      content: 'Please investigate',
    })

    expect((await Agent.mustFind(agent.id)).status).toBe('idle')
    expect(await Execution.list({ agentId: agent.id, status: 'queued' })).toHaveLength(1)
  })

  it('redelivers wake-eligible mail after the dormancy-completion sweep converges', async () => {
    setDormancyEffectHookForTest(async (stage) => {
      if (stage === 'sandbox') throw new Error('injected teardown failure')
    })
    try {
      await expect(makeDormant(agent)).rejects.toThrow('injected teardown failure')
      const sent = await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'remote',
        senderId: 'amtp://peer.example/agent',
        content: 'Persist until teardown converges',
      })
      expect((await InboxMessage.mustFind(sent.id)).deliveredAt).toBeNull()
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      // Prefer this target within the global bounded sweep even when another
      // concurrently running test has left an eligible row behind.
      const dormant = await Agent.mustFind(agent.id)
      await db
        .update(agents)
        .set({
          dormantAt: new Date(0),
          metadata: { ...(dormant.metadata ?? {}), dormancyCompletionSweepAt: -1 },
        })
        .where(eq(agents.id, agent.id))

      setDormancyEffectHookForTest(undefined)
      await runDormancyCompletionSweep()
      expect((await InboxMessage.mustFind(sent.id)).deliveredAt).toBeInstanceOf(Date)
      expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      expect(await Execution.list({ agentId: agent.id, status: 'queued' })).toHaveLength(1)
    } finally {
      setDormancyEffectHookForTest(undefined)
    }
  })

  it('clears a stale legacy termination stamp before waking for genuine correspondence', async () => {
    await makeDormant(agent)
    await db.update(agents).set({ terminatedAt: new Date() }).where(eq(agents.id, agent.id))

    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'remote',
      senderId: 'amtp://peer.example/agent',
      content: 'Wake without legacy re-termination',
    })

    expect(await Agent.mustFind(agent.id)).toMatchObject({ status: 'idle', terminatedAt: null })
    expect(await runLegacyTerminatedAgentSweepForTest([agent.id])).toBe(0)
    expect((await Agent.mustFind(agent.id)).status).toBe('idle')
  })

  it('delivers pending housekeeping with the next genuine wake', async () => {
    await makeDormant(agent)
    const housekeeping = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'system',
      content: 'Background notice',
    })

    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'remote',
      senderId: 'amtp://peer.example/agent',
      content: 'Real work',
    })

    expect((await InboxMessage.mustFind(housekeeping.id)).deliveredAt).toBeInstanceOf(Date)
    const human = (await agent.listMessages({ role: 'human' })).messages
    expect(human).toHaveLength(1)
    expect(human[0].content).toContain('Background notice')
    expect(human[0].content).toContain('Real work')
  })

  it.each(['ensure', 'token'] as const)(
    'keeps committed inbox delivery singular when %s wake completion fails and repairs it later',
    async (failurePoint) => {
      mock.restore()
      const agentWarmup = await import('../sandbox/agent-warmup')
      let injectFailure = true
      spyOn(agentWarmup, 'ensureAgentSandbox').mockImplementation(async () => {
        if (injectFailure && failurePoint === 'ensure') throw new Error('injected ensure failure')
        return 'ensured'
      })
      spyOn(Agent.prototype, 'getOrCreateToken').mockImplementation(async () => {
        if (injectFailure && failurePoint === 'token') throw new Error('injected token failure')
        return 'ficus_agent_test'
      })
      await makeDormant(agent)
      const queuedEvents: string[] = []
      const unsubscribe = eventEmitter.on('execution.queued', ({ executionId }) => queuedEvents.push(executionId))

      let delivered!: InboxMessage
      try {
        delivered = await InboxMessage.send({
          recipientType: 'agent',
          recipientId: agent.id,
          senderType: 'remote',
          senderId: 'amtp://peer.example/agent',
          content: 'Exactly once work',
        })
      } finally {
        unsubscribe()
      }

      expect((await InboxMessage.mustFind(delivered.id)).deliveredAt).toBeInstanceOf(Date)
      expect((await agent.listMessages({ role: 'human' })).messages).toHaveLength(1)
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(1)
      expect(queuedEvents).toHaveLength(1)
      let waking = await Agent.mustFind(agent.id)
      expect((waking.metadata as Record<string, unknown>).wakeCompletionPending).toBe(true)

      injectFailure = false
      expect(await completeWake(agent.id)).toBe(true)
      waking = await Agent.mustFind(agent.id)
      expect((waking.metadata as Record<string, unknown>).wakeCompletionPending).toBeUndefined()
      expect((await agent.listMessages({ role: 'human' })).messages).toHaveLength(1)
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(1)
    }
  )

  it('allows an explicit system work delivery to wake a dormant agent', async () => {
    await makeDormant(agent)

    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'system',
      content: 'Fleet incident requires action',
      wakeEligible: true,
    })

    expect((await Agent.mustFind(agent.id)).status).toBe('idle')
    expect(await Execution.list({ agentId: agent.id, status: 'queued' })).toHaveLength(1)
  })

  it('idle/no active execution uses Agent.sendMessage path and marks delivered after success', async () => {
    const message = await createInboxMessage({ recipientId: agent.id, content: 'Wake up and review this' })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'queued',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith(expect.stringContaining('Wake up and review this'), {
      deliveryMode: 'steer',
      metadata: expect.objectContaining({
        source: 'inbox',
        deliveryMode: 'steer',
        inboxDeliveryMode: 'follow-up',
        inboxMessageIds: [message.id],
      }),
    })

    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    sendSpy.mockRestore()
  })

  it('hydrates each claimed message attachment into the prompt sent to the agent', async () => {
    const firstMessage = await createInboxMessage({ recipientId: agent.id, content: 'First attached file' })
    const secondMessage = await createInboxMessage({ recipientId: agent.id, content: 'Second attached file' })
    const firstAttachmentId = 'e1dd1330-a99d-43ea-b9d6-64cc8dc4125c'
    const secondAttachmentId = 'f2ee2441-b00e-44fb-8ae7-75dd9ed5236d'
    await db.insert(inboxAttachments).values([
      {
        id: firstAttachmentId,
        messageId: firstMessage.id,
        filename: 'first.txt',
        contentType: 'text/plain',
        byteSize: 11,
        sha256: 'a'.repeat(64),
        storagePath: '/test/first',
      },
      {
        id: secondAttachmentId,
        messageId: secondMessage.id,
        filename: 'second.json',
        contentType: 'application/json',
        byteSize: 22,
        sha256: 'b'.repeat(64),
        storagePath: '/test/second',
      },
    ])
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'queued',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const prompt = sendSpy.mock.calls[0][0]
    const blockFor = (content: string) => {
      const start = prompt.indexOf(content)
      const separator = prompt.indexOf('\n\n---\n\n', start)
      const footer = prompt.indexOf('\n\n**Mark one or more messages as read', start)
      return prompt.slice(start, separator === -1 ? footer : Math.min(separator, footer))
    }
    const firstBlock = blockFor('First attached file')
    const secondBlock = blockFor('Second attached file')
    expect(firstBlock).toContain(`ficus inbox download ${firstAttachmentId} --out '<save-path>'`)
    expect(firstBlock).not.toContain(secondAttachmentId)
    expect(secondBlock).toContain(`ficus inbox download ${secondAttachmentId} --out '<save-path>'`)
    expect(secondBlock).not.toContain(firstAttachmentId)

    sendSpy.mockRestore()
  })

  it('propagates workStreamId and squadId from source messages into delivery summaries', async () => {
    await createInboxMessage({
      recipientId: agent.id,
      content: 'Work stream handed off',
      metadata: { workStreamId: 'ws-123', squadId: 'sq-456', event: 'assigned' },
    })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'queued',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [, opts] = sendSpy.mock.calls[0]
    const summaries = (opts as { metadata: { inboxMessageSummaries: Array<Record<string, unknown>> } }).metadata
      .inboxMessageSummaries
    expect(summaries).toHaveLength(1)
    expect(summaries[0].workStreamId).toBe('ws-123')
    expect(summaries[0].squadId).toBe('sq-456')
    sendSpy.mockRestore()
  })

  it('running agent + steer messages calls Agent.sendMessage with deliveryMode steer', async () => {
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    const message = await createInboxMessage({ recipientId: agent.id, content: 'Interrupt now', deliveryMode: 'steer' })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'running',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledWith(expect.stringContaining('Interrupt now'), {
      deliveryMode: 'steer',
      metadata: expect.objectContaining({
        deliveryMode: 'steer',
        inboxDeliveryMode: 'steer',
        inboxMessageIds: [message.id],
      }),
    })

    sendSpy.mockRestore()
  })

  it('running agent + follow-up messages sends each inbox message as its own follow-up', async () => {
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    const firstMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Do this later first',
      deliveryMode: 'follow-up',
    })
    const secondMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Do this later second',
      deliveryMode: 'follow-up',
    })
    await db
      .update(inbox)
      .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(inbox.id, firstMessage.id))
    await db
      .update(inbox)
      .set({ createdAt: new Date('2026-01-01T00:00:01.000Z') })
      .where(eq(inbox.id, secondMessage.id))

    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'running',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(sendSpy.mock.calls[0]).toEqual([
      expect.stringContaining('Do this later first'),
      {
        deliveryMode: 'follow-up',
        metadata: expect.objectContaining({
          deliveryMode: 'follow-up',
          inboxDeliveryMode: 'follow-up',
          inboxMessageIds: [firstMessage.id],
        }),
      },
    ])
    expect(sendSpy.mock.calls[1]).toEqual([
      expect.stringContaining('Do this later second'),
      {
        deliveryMode: 'follow-up',
        metadata: expect.objectContaining({
          deliveryMode: 'follow-up',
          inboxDeliveryMode: 'follow-up',
          inboxMessageIds: [secondMessage.id],
        }),
      },
    ])

    sendSpy.mockRestore()
  })

  it('mixed modes sends the steer batch before individual follow-ups', async () => {
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    const steerMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Interrupt',
      deliveryMode: 'steer',
    })
    const followUpMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Later',
      deliveryMode: 'follow-up',
    })
    const secondFollowUpMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Even later',
      deliveryMode: 'follow-up',
    })
    await db
      .update(inbox)
      .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(inbox.id, steerMessage.id))
    await db
      .update(inbox)
      .set({ createdAt: new Date('2026-01-01T00:00:01.000Z') })
      .where(eq(inbox.id, followUpMessage.id))
    await db
      .update(inbox)
      .set({ createdAt: new Date('2026-01-01T00:00:02.000Z') })
      .where(eq(inbox.id, secondFollowUpMessage.id))

    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'running',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(3)
    expect(sendSpy.mock.calls.map((call) => call[1]?.deliveryMode)).toEqual(['steer', 'follow-up', 'follow-up'])
    expect(sendSpy.mock.calls.map((call) => call[1]?.metadata?.inboxMessageIds)).toEqual([
      [steerMessage.id],
      [followUpMessage.id],
      [secondFollowUpMessage.id],
    ])

    const delivered = await Promise.all([
      InboxMessage.mustFind(steerMessage.id),
      InboxMessage.mustFind(followUpMessage.id),
      InboxMessage.mustFind(secondFollowUpMessage.id),
    ])
    expect(delivered.every((item) => item.deliveredAt instanceof Date)).toBe(true)

    sendSpy.mockRestore()
  })

  it('failed send resets deliveredAt so the inbox row can retry', async () => {
    const message = await createInboxMessage({ recipientId: agent.id, content: 'This will fail' })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => {
      throw new Error('send failed')
    })

    await deliverInboxMessagesToAgent(agent.id)

    const failed = await InboxMessage.mustFind(message.id)
    expect(failed.deliveredAt).toBeNull()

    sendSpy.mockRestore()
  })

  it('adds inbox delivery to pending messages and re-emits wake when an execution is queued but not running yet', async () => {
    const [execution] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'queued', message: 'Already queued' })
      .returning()
    const queuedEvents: Array<{ executionId: string; agentId: string; status: string }> = []
    const unsubscribe = eventEmitter.on('execution.queued', (event) => queuedEvents.push(event))
    const message = await createInboxMessage({
      recipientId: agent.id,
      content: 'Queued active execution',
      deliveryMode: 'steer',
    })

    try {
      await deliverInboxMessagesToAgent(agent.id)
    } finally {
      unsubscribe()
    }

    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    const pending = await db.select().from(messages).where(eq(messages.agentId, agent.id))
    expect(pending).toHaveLength(1)
    expect(pending[0].role).toBe('human')
    expect(pending[0].pending).toBe(true)
    expect(pending[0].content).toContain('Queued active execution')
    expect(pending[0].metadata).toMatchObject({ source: 'inbox', deliveryMode: 'steer' })
    expect(queuedEvents).toEqual([{ executionId: execution.id, agentId: agent.id, status: 'queued' }])
  })

  it('preserves inbox image IDs when delivering to an already queued execution', async () => {
    const existingImage = await Image.create({
      content: { type: 'image', data: Buffer.from('existing').toString('base64'), mimeType: 'image/png' },
      agentId: agent.id,
    })
    const deliveredImage = await Image.create({
      content: { type: 'image', data: Buffer.from('delivered').toString('base64'), mimeType: 'image/png' },
      agentId: agent.id,
    })
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'queued',
        message: 'Already queued',
        imageIds: [existingImage.id],
      })
      .returning()
    const message = await createInboxMessage({
      recipientId: agent.id,
      content: 'Queued image message',
      deliveryMode: 'follow-up',
      metadata: { imageIds: [deliveredImage.id] },
    })

    await deliverInboxMessagesToAgent(agent.id)

    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    const pending = await db.select().from(messages).where(eq(messages.agentId, agent.id))
    expect(pending).toHaveLength(1)
    expect(pending[0].metadata).toMatchObject({
      source: 'inbox',
      deliveryMode: 'follow-up',
      imageIds: [deliveredImage.id],
    })

    const [updatedExecution] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(updatedExecution.imageIds).toEqual([existingImage.id, deliveredImage.id])
    await Image.deleteMany([existingImage.id, deliveredImage.id])
  })

  it('delivers idle mixed-mode messages as one steer digest before queueing execution', async () => {
    const steerMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Interrupt from idle',
      deliveryMode: 'steer',
    })
    const followUpMessage = await createInboxMessage({
      recipientId: agent.id,
      content: 'Follow up from idle',
      deliveryMode: 'follow-up',
    })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'queued',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][0]).toContain('Interrupt from idle')
    expect(sendSpy.mock.calls[0][0]).toContain('Follow up from idle')
    expect(sendSpy).toHaveBeenCalledWith(expect.any(String), {
      deliveryMode: 'steer',
      metadata: expect.objectContaining({
        source: 'inbox',
        deliveryMode: 'steer',
        inboxMessageIds: expect.arrayContaining([steerMessage.id, followUpMessage.id]),
      }),
    })

    const deliveredSteer = await InboxMessage.mustFind(steerMessage.id)
    const deliveredFollowUp = await InboxMessage.mustFind(followUpMessage.id)
    expect(deliveredSteer.deliveredAt).toBeInstanceOf(Date)
    expect(deliveredFollowUp.deliveredAt).toBeInstanceOf(Date)

    sendSpy.mockRestore()
  })

  it('marks delivery and records a pending message for a stopping execution without a control signal', async () => {
    await db.insert(executions).values({ agentId: agent.id, status: 'stopping' })
    const message = await createInboxMessage({
      recipientId: agent.id,
      content: 'Stopping active execution',
      deliveryMode: 'steer',
    })

    await deliverInboxMessagesToAgent(agent.id)

    // A stopping execution emits no control signal, so delivery is finalized
    // immediately. The message is transcribed into a pending human row that the
    // agent picks up on its next wake.
    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    const pending = await db.select().from(messages).where(eq(messages.agentId, agent.id))
    expect(pending).toHaveLength(1)
    expect(pending[0].role).toBe('human')
    expect(pending[0].pending).toBe(true)
    expect(pending[0].content).toContain('Stopping active execution')
    expect(pending[0].metadata).toMatchObject({ source: 'inbox', deliveryMode: 'steer' })
  })

  it('marks delivery success when sendMessage reports no control signal was emitted', async () => {
    // Guards the running→stopping race: even when the active execution still
    // reads as 'running', if sendMessage did not actually emit a control signal
    // the delivery must be finalized rather than left provisional.
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    const message = await createInboxMessage({
      recipientId: agent.id,
      content: 'No signal emitted',
      deliveryMode: 'steer',
    })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'running',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    sendSpy.mockRestore()
  })

  it('marks delivery success immediately even when sendMessage emits a control signal', async () => {
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    const message = await createInboxMessage({
      recipientId: agent.id,
      content: 'Signal emitted',
      deliveryMode: 'steer',
    })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'running',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    sendSpy.mockRestore()
  })

  it('prevents duplicate sends when concurrent delivery drains see the same inbox message', async () => {
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    const message = await createInboxMessage({
      recipientId: agent.id,
      content: 'Deliver once concurrently',
      deliveryMode: 'steer',
    })
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { success: true, status: 'running' }
    })

    await Promise.all([deliverInboxMessagesToAgent(agent.id), deliverInboxMessagesToAgent(agent.id)])

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    sendSpy.mockRestore()
  })

  it('retries messages whose delivery claim was reset after a previous failure', async () => {
    const message = await createInboxMessage({ recipientId: agent.id, content: 'Retry after failure' })
    await db.update(inbox).set({ deliveredAt: null }).where(eq(inbox.id, message.id))
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
      success: true,
      status: 'queued',
    }))

    await deliverInboxMessagesToAgent(agent.id)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const delivered = await InboxMessage.mustFind(message.id)
    expect(delivered.deliveredAt).toBeInstanceOf(Date)

    sendSpy.mockRestore()
  })

  it('delivers inbox message to a compacting agent (persisted, no error, no duplicate execution)', async () => {
    await agent.update({ status: 'compacting' })

    const msg = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'system',
      content: 'ping',
      metadata: { foo: 'bar' },
    })

    await deliverInboxMessagesToAgent(agent.id)

    const reloaded = await InboxMessage.mustFind(msg.id)
    expect(reloaded.deliveredAt).not.toBeNull()

    const queued = await Execution.list({ agentId: agent.id, status: 'queued' })
    expect(queued).toHaveLength(1)

    const humans = (await agent.listMessages()).messages.filter((m) => m.role === 'human')
    expect(humans).toHaveLength(1)
    expect(humans[0].metadata).toMatchObject({
      source: 'inbox',
      inboxMessageIds: [msg.id],
    })
  })
})
