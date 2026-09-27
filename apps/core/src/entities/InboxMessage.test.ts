import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq, inArray, or } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, inbox, executions, squads, squadRelationships } from '../db/schema'
import { AgentType } from './AgentType'
import { Agent, setSendMessageLockedHookForTests } from './Agent'
import { InboxMessage, setBeforeRecipientLifecycleLockHookForTest } from './InboxMessage'
import { makeDormant, terminate } from '../services/agent/lifecycle'
import { SYSTEM_RECIPIENT_ID, workspaceVoiceRecipientId } from '@ficus/shared'
import { Execution } from './Execution'
import { Squad } from './Squad'
import { User } from './User'
import { eventEmitter } from '../lib/infra/event-emitter'

describe('InboxMessage', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let agent: Agent
  let agentId: string

  beforeEach(async () => {
    testPrefix = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    agent = await Agent.create({
      agentTypeId: testAgentTypeId,
      metadata: { name: 'TestAgent' },
    })
    agentId = agent.id
  })

  afterEach(async () => {
    setSendMessageLockedHookForTests()

    const agentList = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const a of agentList) {
      await db.delete(executions).where(eq(executions.agentId, a.id))
      await db.delete(inbox).where(eq(inbox.recipientId, a.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))

    const createdSquads = await db.select().from(squads).where(eq(squads.purpose, testPrefix))
    const squadIds = createdSquads.map((s) => s.id)
    const managerAgentIds = createdSquads.map((s) => s.managerAgentId).filter((id): id is string => Boolean(id))

    if (managerAgentIds.length > 0) {
      await db.delete(executions).where(inArray(executions.agentId, managerAgentIds))
      await db
        .delete(inbox)
        .where(or(inArray(inbox.recipientId, managerAgentIds), inArray(inbox.senderId, managerAgentIds)))
    }
    if (squadIds.length > 0) {
      await db.delete(agents).where(inArray(agents.squadId, squadIds))
    }
    await db.delete(squadRelationships)
    await db.delete(squads).where(eq(squads.purpose, testPrefix))
  })

  describe('sendOnce()', () => {
    it('sendOnce atomically deduplicates an idempotency key', async () => {
      await db.insert(executions).values({ agentId, status: 'running' })
      await agent.update({ status: 'active' })

      const idempotencyKey = `${testPrefix}-send-once`
      const receivedMessageIds: string[] = []
      const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
        if (event.recipientType === 'agent' && event.recipientId === agentId) {
          receivedMessageIds.push(event.messageId)
        }
      })
      const deliverySpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
        success: true,
        status: 'running',
      }))

      try {
        const content = `dedupe-body-${crypto.randomUUID()}`
        const input = {
          recipientType: 'agent' as const,
          recipientId: agentId,
          senderType: 'system' as const,
          content,
          deliveryMode: 'steer' as const,
        }
        const results = await Promise.all([
          InboxMessage.sendOnce({ ...input }, idempotencyKey),
          InboxMessage.sendOnce({ ...input }, idempotencyKey),
        ])

        const rows = await db.select().from(inbox).where(eq(inbox.idempotencyKey, idempotencyKey))
        expect(rows).toHaveLength(1)
        expect(rows[0].content).toBe(content)
        expect(results[0].message.id).toBe(rows[0].id)
        expect(results[1].message.id).toBe(rows[0].id)
        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(receivedMessageIds).toEqual([rows[0].id])
        expect(deliverySpy).toHaveBeenCalledTimes(1)
      } finally {
        unsubscribe()
        deliverySpy.mockRestore()
      }
    })

    it('finds an exact durable winner by idempotency key', async () => {
      const key = `${testPrefix}-lookup`
      const result = await InboxMessage.sendOnce(
        {
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          content: 'Durable lookup winner',
        },
        key
      )

      expect((await InboxMessage.findByIdempotencyKey(key))?.id).toBe(result.message.id)
      expect(await InboxMessage.findByIdempotencyKey(`${key}-other`)).toBeNull()
    })

    it('does not authenticate manager fleet messages as human fleet routing hints', async () => {
      const events: Array<Record<string, unknown>> = []
      const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
        if (event.recipientType === 'agent' && event.recipientId === agentId) events.push(event)
      })
      try {
        const result = await InboxMessage.sendOnce(
          {
            recipientType: 'agent',
            recipientId: agentId,
            senderType: 'system',
            content: 'Manager-only fleet work injection',
            metadata: {
              source: 'fleet-incident-manager',
              squadId: '11111111-1111-4111-8111-111111111111',
              audience: 'manager',
            },
          },
          `${testPrefix}-manager-fleet`
        )
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          messageId: result.message.id,
          recipientType: 'agent',
          recipientId: agentId,
        })
        expect(events[0]).not.toHaveProperty('source')
        expect(events[0]).not.toHaveProperty('squadId')
      } finally {
        unsubscribe()
      }
    })

    it('emits only authenticated and validated fleet alert routing hints', async () => {
      const events: Array<Record<string, unknown>> = []
      const idempotencyKeys = [
        `${testPrefix}-fleet-valid`,
        `${testPrefix}-fleet-spoof`,
        `${testPrefix}-fleet-invalid`,
        `${testPrefix}-fleet-global`,
      ]
      const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
        if (event.recipientType === 'system' && event.recipientId === SYSTEM_RECIPIENT_ID) events.push(event)
      })

      try {
        const common = {
          recipientType: 'system' as const,
          recipientId: SYSTEM_RECIPIENT_ID,
          content: 'Fleet operator notification',
        }
        const valid = await InboxMessage.sendOnce(
          {
            ...common,
            senderType: 'system',
            metadata: {
              source: 'fleet-alert',
              squadId: '11111111-1111-4111-8111-111111111111',
              details: 'must not propagate',
            },
          },
          idempotencyKeys[0]
        )
        await InboxMessage.sendOnce(
          {
            ...common,
            senderType: 'user',
            senderId: crypto.randomUUID(),
            metadata: { source: 'fleet-alert', squadId: '11111111-1111-4111-8111-111111111111' },
          },
          idempotencyKeys[1]
        )
        await InboxMessage.sendOnce(
          {
            ...common,
            senderType: 'system',
            metadata: { source: 'fleet-alert', squadId: 'not-a-uuid' },
          },
          idempotencyKeys[2]
        )
        await InboxMessage.sendOnce(
          {
            ...common,
            senderType: 'system',
            metadata: { source: 'fleet-alert', provider: 'openai-codex' },
          },
          idempotencyKeys[3]
        )

        expect(events).toHaveLength(4)
        expect(events[0]).toMatchObject({
          messageId: valid.message.id,
          source: 'fleet-alert',
          squadId: '11111111-1111-4111-8111-111111111111',
        })
        expect(events[0]).not.toHaveProperty('details')
        expect(events[1]).not.toHaveProperty('source')
        expect(events[1]).not.toHaveProperty('squadId')
        expect(events[2]).not.toHaveProperty('source')
        expect(events[2]).not.toHaveProperty('squadId')
        expect(events[3]?.source).toBe('fleet-alert')
        expect(events[3]).not.toHaveProperty('squadId')
      } finally {
        unsubscribe()
        await db.delete(inbox).where(inArray(inbox.idempotencyKey, idempotencyKeys))
      }
    })
  })

  describe('send() - manager cross-squad communication', () => {
    it('allows manager-to-manager messaging across a direct squad relationship', async () => {
      const source = await Squad.create({ name: `${testPrefix} Related Source`, purpose: testPrefix })
      const target = await Squad.create({ name: `${testPrefix} Related Target`, purpose: testPrefix })
      await source.addRelationship(target.id, 'collaborates')

      await expect(
        InboxMessage.send({
          senderType: 'agent',
          senderId: source.managerAgentId!,
          recipientType: 'agent',
          recipientId: target.managerAgentId!,
          subject: 'coordination',
          content: 'relationship-scoped manager message',
        })
      ).resolves.toBeDefined()
    })

    it('allows manager-to-manager message to a globally collaborative squad without explicit relationship', async () => {
      const sourceSquad = await Squad.create({ name: `${testPrefix} Source`, purpose: testPrefix })
      const targetSquad = await Squad.create({ name: `${testPrefix} Target`, purpose: testPrefix })
      await targetSquad.update({ globalCollaborationEnabled: true })

      await expect(
        InboxMessage.send({
          senderType: 'agent',
          senderId: sourceSquad.managerAgentId!,
          recipientType: 'agent',
          recipientId: targetSquad.managerAgentId!,
          subject: 'hello',
          content: 'hello global squad',
        })
      ).resolves.toBeDefined()
    })

    it('rejects unrelated manager-to-manager message when global collaboration is disabled', async () => {
      const sourceSquad = await Squad.create({ name: `${testPrefix} Source`, purpose: testPrefix })
      const targetSquad = await Squad.create({ name: `${testPrefix} Target`, purpose: testPrefix })

      await expect(
        InboxMessage.send({
          senderType: 'agent',
          senderId: sourceSquad.managerAgentId!,
          recipientType: 'agent',
          recipientId: targetSquad.managerAgentId!,
          content: 'blocked',
        })
      ).rejects.toThrow('Target squad is not connected to sender squad')
    })

    it('allows the squad-less system-manager to message a squad manager', async () => {
      const squad = await Squad.create({ name: `${testPrefix} SM-route`, purpose: testPrefix })
      const systemManager = await Agent.create({ agentTypeId: 'system-manager' })
      try {
        await expect(
          InboxMessage.send({
            senderType: 'agent',
            senderId: systemManager.id,
            recipientType: 'agent',
            recipientId: squad.managerAgentId!,
            subject: 'route',
            content: 'please handle this work',
          })
        ).resolves.toBeDefined()
      } finally {
        await db.delete(inbox).where(eq(inbox.senderId, systemManager.id))
        await db.delete(agents).where(eq(agents.id, systemManager.id))
      }
    })
  })

  describe('send() - inbox wake on message receipt', () => {
    it('creates execution when idle agent receives message', async () => {
      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'Test wake message',
      })

      // Small delay for async execution queueing
      await new Promise((r) => setTimeout(r, 100))

      const execs = await Execution.list({ agentId })
      expect(execs.length).toBe(1)
      expect(execs[0].message).toContain('unread message')
      expect(execs[0].message).toContain('Test wake message')
      expect(execs[0].message).toContain('system')
      expect(execs[0].message).toContain('ficus inbox read')

      const messages = await InboxMessage.listUnread('agent', agentId)
      expect(messages).toHaveLength(1)
      expect(messages[0].readAt).toBeNull()
      expect(messages[0].deliveredAt).toBeTruthy()
      await expect(InboxMessage.listUndeliveredUnread('agent', agentId)).resolves.toEqual([])
    })

    it('leaves delivered messages unread but does not wake with them again', async () => {
      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'Deliver once',
      })

      await new Promise((r) => setTimeout(r, 100))

      const messages = await InboxMessage.listUnread('agent', agentId)
      expect(messages).toHaveLength(1)
      expect(messages[0].readAt).toBeNull()
      expect(messages[0].deliveredAt).toBeTruthy()

      const undelivered = await InboxMessage.listUndeliveredUnread('agent', agentId)
      expect(undelivered).toEqual([])
    })

    it('includes subject and sender name in formatted message', async () => {
      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        subject: 'Build failed',
        content: 'CI pipeline is broken',
        metadata: {
          sender: { name: 'Engineer Bot', agentTypeId: 'engineer' },
        },
      })

      await new Promise((r) => setTimeout(r, 100))

      const execs = await Execution.list({ agentId })
      expect(execs.length).toBe(1)
      expect(execs[0].message).toContain('Engineer Bot')
      expect(execs[0].message).toContain('engineer')
      expect(execs[0].message).toContain('**Build failed**')
      expect(execs[0].message).toContain('CI pipeline is broken')
    })

    it('delivers to active agents through Agent.sendMessage without idle wake logic', async () => {
      await db.insert(executions).values({ agentId, status: 'running' })
      await agent.update({ status: 'active' })
      const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
        success: true,
        status: 'running',
      }))

      const message = await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'Deliver while running',
        deliveryMode: 'steer',
      })

      const delivered = await InboxMessage.mustFind(message.id)
      expect(sendSpy).toHaveBeenCalledWith(expect.stringContaining('Deliver while running'), {
        deliveryMode: 'steer',
        metadata: expect.objectContaining({ source: 'inbox', inboxMessageIds: [message.id] }),
      })
      expect(message.deliveredAt).toBeInstanceOf(Date)
      expect(delivered.deliveredAt).toBeInstanceOf(Date)

      sendSpy.mockRestore()
    })

    it('returns the created snapshot when the row is deleted during delivery', async () => {
      await db.insert(executions).values({ agentId, status: 'running' })
      await agent.update({ status: 'active' })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const content = `${testPrefix}-deleted-during-delivery`

      setSendMessageLockedHookForTests(async () => {
        entered.resolve()
        await release.promise
      })

      try {
        const send = InboxMessage.send({
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          content,
        })
        await entered.promise

        const [created] = await db.select().from(inbox).where(eq(inbox.content, content))
        expect(created).toBeDefined()
        await db.delete(inbox).where(eq(inbox.id, created.id))
        release.resolve()

        await expect(send).resolves.toMatchObject({ id: created.id })
      } finally {
        release.resolve()
        setSendMessageLockedHookForTests()
      }
    })

    it('sendOnce atomically creates and delivers a keyed message once', async () => {
      await db.insert(executions).values({ agentId, status: 'running' })
      await agent.update({ status: 'active' })
      const deliverySpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => ({
        success: true,
        status: 'running',
      }))
      const received: string[] = []
      const unsubscribe = eventEmitter.on('inbox.messageReceived', ({ messageId }) => received.push(messageId))
      const content = `${testPrefix}-send-once`
      const input = {
        recipientType: 'agent' as const,
        recipientId: agentId,
        senderType: 'system' as const,
        content,
      }

      try {
        const [a, b] = await Promise.all([
          InboxMessage.sendOnce(input, `${testPrefix}:once`),
          InboxMessage.sendOnce(input, `${testPrefix}:once`),
        ])
        const rows = await db.select().from(inbox).where(eq(inbox.content, content))

        expect(rows).toHaveLength(1)
        expect(new Set([a.message.id, b.message.id]).size).toBe(1)
        expect([a, b].filter((result) => result.created)).toHaveLength(1)
        expect(received).toEqual([rows[0].id])
        expect(deliverySpy).toHaveBeenCalledTimes(1)
      } finally {
        unsubscribe()
        deliverySpy.mockRestore()
      }
    })

    it('rejects invalid sendOnce keys before persistence', async () => {
      const content = `${testPrefix}-invalid-send-once-key`
      const input = {
        recipientType: 'agent' as const,
        recipientId: agentId,
        senderType: 'system' as const,
        content,
      }

      await expect(InboxMessage.sendOnce(input, '')).rejects.toThrow('idempotencyKey is required')
      await expect(InboxMessage.sendOnce(input, 'x'.repeat(201))).rejects.toThrow(
        'idempotencyKey must be at most 200 characters'
      )
      expect(await db.select().from(inbox).where(eq(inbox.content, content))).toEqual([])
    })

    it('resets deliveredAt after best-effort delivery fails', async () => {
      await db.insert(executions).values({ agentId, status: 'running' })
      await agent.update({ status: 'active' })
      const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async () => {
        throw new Error('delivery failed in send test')
      })

      const message = await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'Fail delivery while running',
        deliveryMode: 'steer',
      })

      expect(message.deliveredAt).toBeNull()

      const failed = await InboxMessage.mustFind(message.id)
      expect(failed.deliveredAt).toBeNull()

      sendSpy.mockRestore()
    })

    it('does not trigger for user messages', async () => {
      const user = await User.create({
        email: `${testPrefix}-recipient@example.com`,
        displayName: 'Recipient User',
      })

      try {
        await InboxMessage.send({
          recipientType: 'user',
          recipientId: user.id,
          senderType: 'agent',
          senderId: agentId,
          content: 'Notification for user',
        })

        await new Promise((r) => setTimeout(r, 100))

        const execs = await Execution.list({ agentId })
        expect(execs.length).toBe(0)
      } finally {
        await db.delete(inbox).where(eq(inbox.recipientId, user.id))
        await user.delete()
      }
    })

    it('rejects nonexistent user recipients', async () => {
      await expect(
        InboxMessage.send({
          recipientType: 'user',
          recipientId: '00000000-0000-4000-8000-0000000000a1',
          senderType: 'agent',
          senderId: agentId,
          content: 'Notification for missing user',
        })
      ).rejects.toThrow('Recipient user not found')
    })

    it('defaults inbox delivery mode to steer for workspace voice messages to users', async () => {
      const user = await User.create({
        email: `${testPrefix}-voice-recipient@example.com`,
        displayName: 'Voice Recipient',
      })

      try {
        const message = await InboxMessage.send({
          recipientType: 'user',
          recipientId: user.id,
          senderType: 'voice_assistant',
          senderId: workspaceVoiceRecipientId(user.id),
          content: 'Hello from workspace voice',
        })

        expect(message.senderType).toBe('voice_assistant')
        expect(message.deliveryMode).toBe('steer')
      } finally {
        await db.delete(inbox).where(eq(inbox.recipientId, user.id))
        await user.delete()
      }
    })
  })

  describe('subagent parent-child permissions', () => {
    it('allows parent-child messages for null-squad subagents', async () => {
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: agent.id, squadId: null })

      const childToParent = await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'agent',
        senderId: child.id,
        content: 'subagent result',
      })
      expect(childToParent.id).toBeDefined()

      const parentToChild = await InboxMessage.send({
        recipientType: 'agent',
        recipientId: child.id,
        senderType: 'agent',
        senderId: agent.id,
        content: 'follow-up',
      })
      expect(parentToChild.id).toBeDefined()
    })

    it('wakes a dormant child through normal inbox delivery with one pending human message', async () => {
      const child = await Agent.create({
        agentTypeId: testAgentTypeId,
        parentAgentId: agent.id,
        metadata: { label: 'researcher', priorContext: 'keep me' },
      })
      await makeDormant(child, { metadata: { resultStatus: 'completed' } })

      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: child.id,
        senderType: 'agent',
        senderId: agent.id,
        content: 'new instructions',
      })

      const revived = await Agent.mustFind(child.id)
      const pending = await revived.listPendingHumanMessages()
      const executions = await Execution.list({ agentId: child.id })

      expect(revived.terminatedAt).toBeNull()
      expect((revived.metadata as Record<string, unknown>).priorContext).toBe('keep me')
      expect((revived.metadata as Record<string, unknown>).resultStatus).toBeNull()
      expect(pending).toHaveLength(1)
      expect(pending[0].content).toContain('new instructions')
      expect(executions).toHaveLength(1)
    })

    it('rejects without persistence when final termination wins after recipient pre-read', async () => {
      const target = await Agent.create({ agentTypeId: testAgentTypeId })
      await makeDormant(target)
      setBeforeRecipientLifecycleLockHookForTest(async () => {
        setBeforeRecipientLifecycleLockHookForTest(undefined)
        await terminate(target, { finalCleanup: async () => true })
      })
      try {
        await expect(
          InboxMessage.send({
            recipientType: 'agent',
            recipientId: target.id,
            senderType: 'remote',
            senderId: 'amtp://peer.example/agent',
            content: 'too late',
          })
        ).rejects.toMatchObject({ code: 'AGENT_TERMINATED' })
      } finally {
        setBeforeRecipientLifecycleLockHookForTest(undefined)
      }
      expect(await InboxMessage.listForRecipient('agent', target.id)).toHaveLength(0)
    })

    it('rejects messages to terminated non-subagent agents', async () => {
      const terminated = await Agent.create({ agentTypeId: testAgentTypeId })
      await terminated.update({ terminatedAt: new Date() })

      await expect(
        InboxMessage.send({
          recipientType: 'agent',
          recipientId: terminated.id,
          senderType: 'agent',
          senderId: agent.id,
          content: 'should be blocked',
        })
      ).rejects.toThrow('is terminated and cannot be woken')
    })

    it('allows a non-waking system message to target a subagent', async () => {
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: agent.id })

      const result = await InboxMessage.sendOnce(
        {
          recipientType: 'agent',
          recipientId: child.id,
          senderType: 'system',
          wakeEligible: false,
          deliveryMode: 'steer',
          content: 'slot grant',
        },
        `slot-system-child:${child.id}`
      )

      expect(result.created).toBe(true)
      expect(result.message.metadata.wakeEligible).toBe(false)
    })

    it('rejects subagent messages to any non-parent even within the same squad', async () => {
      const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: testPrefix })
      const parent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const sibling = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id, parentAgentId: parent.id })

      await expect(
        InboxMessage.send({
          recipientType: 'agent',
          recipientId: sibling.id,
          senderType: 'agent',
          senderId: child.id,
          content: 'should be blocked',
        })
      ).rejects.toThrow('Subagents can only message their parent agent')
    })
  })
})
