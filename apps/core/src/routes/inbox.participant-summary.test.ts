import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, inbox, squads } from '../db'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import { InboxAttachment } from '../entities/InboxAttachment'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { eventEmitter } from '../lib/infra/event-emitter'
import { setupEventBridge } from '../services/ws/bridge'
import { WebSocketManager } from '../services/ws/manager'
import { hasAgentResourcePermission } from '../services/rbac/agent-resource-access'
import { buildNotificationEvent } from '../services/notifications/event-builders'
import { loadInboxSnapshot } from '../services/squad-activity/source-loaders'
import * as delivery from '../services/inbox/inboxDelivery'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, createTestUser } from '../test-utils'
import { inboxRouter } from './inbox'

// All data is synthetic. A real identity, recipient guard, entity serializer and
// HTTP JSON response are used; no private payload or real read receipt is needed.
const app = new Hono()
app.use('*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.onError((_error, c) => c.json({ error: 'Synthetic dependency failure' }, 500))
app.route('/api/inbox', inboxRouter)
const privateSentinel = 'SYNTHETIC_PARTICIPANT_PRIVATE_STATE'
const content = '  Authored context, memory, configuration, credentials and token.\nUnicode: λ 🦉\t\n'
const metadata = {
  sender: { userId: 'synthetic-authenticated-user', name: 'Synthetic Human' },
  inReplyTo: 'synthetic-message',
  remote: { fromHandle: 'synthetic-peer' },
  context: { authored: 'Keep message-owned context verbatim' },
}
let prefix: string
let owner: Awaited<ReturnType<typeof createTestUser>>
let reader: Awaited<ReturnType<typeof createTestAdmin>>
let privateAgent: Agent
let manager: Agent
let squadId: string
let agentToken: Awaited<ReturnType<typeof createTestAgentToken>>
const messageIds: string[] = []
const summary = (a: Agent) => ({
  id: a.id,
  name: typeof a.metadata?.name === 'string' ? a.metadata.name : null,
  agentTypeId: a.agentTypeId,
  squadId: a.squadId,
  ownerUserId: a.ownerUserId,
})

beforeEach(async () => {
  prefix = `inbox-summary-${randomUUID()}`
  owner = await createTestUser({ prefix })
  reader = await createTestAdmin({ prefix })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Synthetic test' }).returning()
  squadId = squad.id
  const rows = await db
    .insert(agents)
    .values([
      {
        agentTypeId: 'system-manager',
        ownerUserId: owner.id,
        metadata: { name: 'Private Assistant', purpose: privateSentinel },
        context: { sentinel: privateSentinel },
      },
      {
        agentTypeId: 'manager',
        squadId,
        metadata: { name: 'Squad Manager', privateFutureField: privateSentinel },
        context: { sentinel: privateSentinel },
      },
    ])
    .returning()
  privateAgent = new Agent(rows[0])
  manager = new Agent(rows[1])
  agentToken = await createTestAgentToken({ agentId: manager.id, squadId })
})

afterEach(async () => {
  mock.restore()
  eventEmitter.removeAllListeners()
  if (messageIds.length) await db.delete(inbox).where(inArray(inbox.id, messageIds.splice(0)))
  await db.delete(agents).where(inArray(agents.id, [privateAgent.id, manager.id]))
  await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

async function insertMessage(recipientType: 'user' | 'agent' | 'system' | 'voice_assistant', recipientId: string) {
  const [row] = await db
    .insert(inbox)
    .values({
      recipientType,
      recipientId,
      senderType: 'agent',
      senderId: privateAgent.id,
      subject: '  Exact subject λ  ',
      content,
      metadata,
    })
    .returning()
  messageIds.push(row.id)
  return row
}

function expectSafe(message: any, recipient: Agent | null = null) {
  expect(message.senderAgent).toEqual(summary(privateAgent))
  expect(message.recipientAgent).toEqual(recipient ? summary(recipient) : null)
  expect(message.content).toBe(content)
  expect(message.subject).toBe('  Exact subject λ  ')
  expect(message.metadata).toEqual(metadata)
  expect(JSON.stringify(message)).not.toContain(privateSentinel)
}

test('serializes only both participant summaries while retaining exact message and attachment data', async () => {
  const row = await insertMessage('agent', manager.id)
  const message = new InboxMessage(row, privateAgent, manager)
  // Unknown future fields must not leak even if Agent detail serialization grows.
  Object.assign(privateAgent, { futurePrivateField: privateSentinel, questionData: { sentinel: privateSentinel } })
  const attachment = new InboxAttachment({
    id: randomUUID(),
    messageId: row.id,
    filename: 'synthetic.txt',
    contentType: 'text/plain',
    byteSize: 3,
    sha256: 'synthetic-hash',
    storagePath: privateSentinel,
    createdAt: row.createdAt,
  })
  message.attachments.push(attachment)
  const wire = JSON.parse(JSON.stringify(message.toJson()))
  expectSafe(wire, manager)
  expect(wire.id).toBe(row.id)
  expect(wire.createdAt).toBe(row.createdAt.toISOString())
  expect(wire.deliveryMode).toBe(row.deliveryMode)
  expect(wire.readAt).toBeNull()
  expect(wire.deliveredAt).toBeNull()
  expect(wire.attachments).toEqual([
    {
      id: attachment.id,
      messageId: row.id,
      filename: 'synthetic.txt',
      contentType: 'text/plain',
      byteSize: 3,
      sha256: 'synthetic-hash',
      createdAt: row.createdAt.toISOString(),
    },
  ])
  for (const name of [undefined, null, 42, { nested: privateSentinel }, [privateSentinel]]) {
    Object.assign(privateAgent, { metadata: { name } })
    expect(message.toJson().senderAgent).toEqual({ ...summary(privateAgent), name: null })
    expect(JSON.stringify(delivery.prepareInboxDelivery([message], 'follow-up', 'follow-up'))).not.toContain(
      privateSentinel
    )
  }
  privateAgent.metadata = null
  expect(message.toJson().senderAgent?.name).toBeNull()
  expect(new InboxMessage(row).toJson().senderAgent).toBeNull()
  expect(new InboxMessage(row).toJson().recipientAgent).toBeNull()
})

test('another user can read their inbox but not private assistant details: single, list and page JSON', async () => {
  expect(await hasAgentResourcePermission({ type: 'user', userId: reader.id }, privateAgent, 'agents:read')).toBe(false)
  const denied = await app.request(`/api/inbox/agent/${privateAgent.id}`, { headers: authHeaders(reader.token) })
  expect(denied.status).toBe(403)
  for (const [type, id] of [
    ['user', reader.id],
    ['voice_assistant', `workspace:${reader.id}`],
    ['system', 'system'],
  ] as const) {
    const row = await insertMessage(type, id)
    for (const path of [
      `/api/inbox/message/${row.id}`,
      `/api/inbox/${type}/${id}`,
      `/api/inbox/${type}/${id}?limit=10`,
    ]) {
      const response = await app.request(path, { headers: authHeaders(reader.token) })
      expect(response.status).toBe(200)
      const wire = await response.json()
      const item = Array.isArray(wire)
        ? wire.find((m: any) => m.id === row.id)
        : wire.items
          ? wire.items.find((m: any) => m.id === row.id)
          : wire
      expectSafe(item)
      if (wire.items) {
        expect(wire).toEqual({
          items: expect.any(Array),
          hasMore: expect.any(Boolean),
          nextCursor: null,
          totalCount: expect.any(Number),
        })
      }
    }
  }
})

test('squad self-inbox and reverse/user send receipts expose summaries without widening ownership', async () => {
  expect(
    await hasAgentResourcePermission({ type: 'agent', agentId: manager.id, squadId }, privateAgent, 'agents:read')
  ).toBe(false)
  const received = await InboxMessage.send({
    recipientType: 'agent',
    recipientId: manager.id,
    senderType: 'agent',
    senderId: privateAgent.id,
    content,
    deferDelivery: true,
  })
  messageIds.push(received.id)
  const response = await app.request(`/api/inbox/agent/${manager.id}?limit=10`, {
    headers: authHeaders(agentToken.token),
  })
  expect(response.status).toBe(200)
  const page = await response.json()
  expect(page.items[0].senderAgent).toEqual(summary(privateAgent))
  expect(page.items[0].recipientAgent).toEqual(summary(manager))
  expect(JSON.stringify(page)).not.toContain(privateSentinel)

  // Suppress execution startup only: the real send validation, persistence,
  // attribution, serializer and response still execute for both send receipts.
  spyOn(delivery, 'deliverInboxMessagesToAgent').mockResolvedValue(undefined)
  for (const token of [agentToken.token, reader.token]) {
    const result = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: privateAgent.id,
        content,
        metadata: { sender: { userId: 'spoof', name: 'spoof' } },
      }),
    })
    expect(result.status).toBe(201)
    const sent = await result.json()
    messageIds.push(sent.id)
    expect(sent.recipientAgent).toEqual(summary(privateAgent))
    expect(sent.content).toBe(content)
    expect(JSON.stringify(sent)).not.toContain(privateSentinel)
    if (token === reader.token) {
      expect(sent.senderAgent).toBeNull()
      expect(sent.senderId).toBe(reader.id)
      expect(sent.metadata.sender).toMatchObject({ userId: reader.id, name: reader.displayName })
    } else expect(sent.senderAgent).toEqual(summary(manager))
  }
})

test('activity attribution never substitutes private purpose for an absent participant name', async () => {
  await db
    .update(agents)
    .set({ metadata: { purpose: privateSentinel } })
    .where(eq(agents.id, manager.id))
  const [row] = await db
    .insert(inbox)
    .values({ recipientType: 'agent', recipientId: manager.id, senderType: 'agent', senderId: manager.id, content })
    .returning()
  messageIds.push(row.id)
  const snapshot = await loadInboxSnapshot(db, row.id)
  expect(snapshot?.senderName).toBeNull()
  expect(JSON.stringify(snapshot)).not.toContain(privateSentinel)
  await db
    .update(agents)
    .set({ metadata: { name: { sentinel: privateSentinel } } })
    .where(eq(agents.id, manager.id))
  expect((await loadInboxSnapshot(db, row.id))?.senderName).toBeNull()
})

test('real received/read/all-read producers stay compact through distributed events, bridge and WebSocket JSON', async () => {
  const managerWs = new WebSocketManager()
  const frames: any[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (json: string) => {
      frames.push(JSON.parse(json))
      return 0
    },
  } as any
  const clientId = managerWs.addClient(ws, { type: 'user', userId: reader.id })
  await managerWs.subscribe(clientId, 'inbox')
  await managerWs.subscribe(clientId, `inbox:${reader.id}`)
  frames.length = 0
  const pending: Promise<void>[] = []
  const broadcast = managerWs.broadcast.bind(managerWs)
  spyOn(managerWs, 'broadcast').mockImplementation((...args) => {
    const result = broadcast(...args)
    pending.push(result)
    return result
  })
  const distributed: any[] = []
  eventEmitter.initialize('synthetic-summary-test', async (_channel, json) => {
    distributed.push(JSON.parse(json))
  })
  setupEventBridge(managerWs)
  try {
    const sent = await InboxMessage.send({
      recipientType: 'user',
      recipientId: reader.id,
      senderType: 'agent',
      senderId: privateAgent.id,
      content,
    })
    messageIds.push(sent.id)
    const notification = await buildNotificationEvent('inbox.messageReceived', { messageId: sent.id })
    expect(notification?.body).toBe(content)
    expect(JSON.stringify(notification)).not.toContain(privateSentinel)
    const prepared = delivery.prepareInboxDelivery([sent], 'follow-up', 'follow-up')
    expect(prepared.prompt).toContain(content)
    expect(prepared.metadata.inboxMessageIds).toEqual([sent.id])
    expect(JSON.stringify(prepared)).not.toContain(privateSentinel)
    await sent.markAsRead()
    await sent.markAsRead() // Idempotent on the same entity.
    await InboxMessage.markAllAsRead('user', reader.id)
    await Promise.all(pending)
    const allowedKeys = {
      'inbox.messageReceived': ['messageId', 'recipientId', 'recipientType', 'senderAgentId'],
      'inbox.messageRead': ['messageId', 'recipientId', 'recipientType'],
      'inbox.allRead': ['recipientId', 'recipientType'],
    }
    const events = distributed.filter((e) => e.event in allowedKeys)
    expect(events.map((e) => e.event)).toEqual(['inbox.messageReceived', 'inbox.messageRead', 'inbox.allRead'])
    for (const event of events) {
      expect(Object.keys(event.data).sort()).toEqual(allowedKeys[event.event as keyof typeof allowedKeys])
      for (const topic of ['inbox', `inbox:${reader.id}`])
        expect(frames).toContainEqual({ type: 'event', topic, event: event.event, data: event.data })
    }
    expect(JSON.stringify({ frames, distributed })).not.toContain(privateSentinel)
  } finally {
    managerWs.removeClient(clientId)
    // Restore local-only emitter behavior without installing another transport.
    eventEmitter.initialize('', async () => {})
  }
})

test('mark-read preserves denial, idempotence and the distinct pre-authorization sentinel failure', async () => {
  const row = await insertMessage('user', reader.id)
  const path = `/api/inbox/${row.id}/read`
  const read = (token = reader.token) => app.request(path, { method: 'POST', headers: authHeaders(token) })
  const denied = await read(owner.token)
  expect(denied.status).toBe(403)
  expect((await InboxMessage.find(row.id))?.readAt).toBeNull()

  const find = spyOn(InboxMessage, 'find').mockRejectedValueOnce(
    new Error('Synthetic pre-authorization lookup failure')
  )
  const failed = await read()
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: 'Authorization check missing' })
  find.mockRestore()
  expect((await InboxMessage.find(row.id))?.readAt).toBeNull()

  const mark = spyOn(InboxMessage.prototype, 'markAsRead').mockRejectedValueOnce(
    new Error('Synthetic post-authorization write failure')
  )
  const postAuthFailure = await read()
  expect(postAuthFailure.status).toBe(500)
  expect(await postAuthFailure.json()).toEqual({ error: 'Synthetic dependency failure' })
  mark.mockRestore()
  const serialize = spyOn(InboxMessage.prototype, 'toJson').mockImplementation(() => {
    throw new Error('Mark-read must not serialize participants')
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await read()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
  }
  expect(serialize).not.toHaveBeenCalled()
  expect((await InboxMessage.find(row.id))?.readAt).not.toBeNull()
})
