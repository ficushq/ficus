import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, inbox } from '../db/schema'
import { AgentType } from './AgentType'
import { Agent } from './Agent'
import { InboxMessage } from './InboxMessage'

describe('InboxMessage remote sender', () => {
  let testAgentTypeId: string
  let recipient: Agent

  beforeEach(async () => {
    const prefix = `remote-sender-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${prefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Remote Recipient Type',
      systemPrompt: 'You are a test agent.',
    })

    recipient = await Agent.create({
      agentTypeId: testAgentTypeId,
      metadata: { name: 'RemoteRecipient' },
    })
  })

  afterEach(async () => {
    const agentList = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const a of agentList) {
      await db.delete(inbox).where(eq(inbox.recipientId, a.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('stores a remote sender with a non-uuid handle senderId without a uuid-cast error', async () => {
    const fromAddress = 'amtp://peer-instance-abc/alice'

    const message = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: recipient.id,
      senderType: 'remote',
      senderId: fromAddress,
      content: 'hello from a federated peer',
      deliveryMode: 'follow-up',
      metadata: {
        remote: {
          peerInstanceId: 'peer-instance-abc',
          fromAddress,
          fromHandle: 'alice',
          envelopeId: '00000000-0000-4000-8000-000000000001',
          agentSigVerified: false,
        },
        sender: { name: 'alice' },
      },
    })

    // Row persisted with the remote enum value and the raw handle string (no uuid coercion).
    expect(message.senderType).toBe('remote')
    expect(message.senderId).toBe(fromAddress)

    const [persisted] = await db.select().from(inbox).where(eq(inbox.id, message.id))
    expect(persisted.senderType).toBe('remote')
    expect(persisted.senderId).toBe(fromAddress)

    // A subsequent inbox query over this recipient exercises the senderId::uuid CASE join.
    // For senderType='remote' the CASE yields NULL, so neither query throws an
    // "invalid input syntax for type uuid" error.
    const unread = await InboxMessage.listUnread('agent', recipient.id)
    expect(unread.some((m) => m.id === message.id)).toBe(true)

    const found = await InboxMessage.find(message.id)
    expect(found).not.toBeNull()
    expect(found?.senderType).toBe('remote')
    expect(found?.senderId).toBe(fromAddress)
  })
})
