import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { eq, inArray, or } from 'drizzle-orm'
import { assistantInboxRecipientId } from '@ficus/shared'
import { agentTypes, agents, assistantConversations, db, executions, images, inbox, squads } from '../db'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Image, getImagePath } from '../entities/Image'
import { InboxMessage, setBeforeRecipientLifecycleLockHookForTest } from '../entities/InboxMessage'
import { Squad } from '../entities/Squad'
import { ensureAssistantConversationAgent } from '../services/assistant-conversation-agent'
import { sendAssistantTaskRequest } from '../services/assistant-task-requests'
import { prepareInboxDelivery } from '../services/inbox/inboxDelivery'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { createAssistantTools } from './assistant'

const prefix = `assistant-images-${randomUUID()}`
const agentIds: string[] = []
const conversationIds: string[] = []
const imageIds: string[] = []
let squad: Squad
let member: TestUser
let other: TestUser
let squadAgent: Agent
let textAgent: Agent

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function conversationFor(user: TestUser) {
  const [conversation] = await db.insert(assistantConversations).values({ ownerUserId: user.id }).returning()
  conversationIds.push(conversation!.id)
  const { agentId } = await ensureAssistantConversationAgent({ type: 'user', userId: user.id }, conversation!.id)
  agentIds.push(agentId)
  const tools = createAssistantTools(agentId, randomUUID(), conversation!.id)
  const call = async (name: string, args: object) => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`Missing tool ${name}`)
    const result = await tool.execute(randomUUID(), args as never, undefined, undefined, {} as never)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    return { value: result.details as any, text }
  }
  /** An image the user sent in this conversation: bound to its agent, as a claimed upload is. */
  const receive = async () => {
    const image = await Image.create({
      content: { type: 'image', data: PNG, mimeType: 'image/png' },
      agentId,
      uploadedByUserId: user.id,
    })
    imageIds.push(image.id)
    return image
  }
  return { conversationId: conversation!.id, agentId, call, receive }
}

/** The copies a delivered inbox message carries, and the image blocks its recipient would load. */
async function deliveredImages(messageId: string, recipient: Agent) {
  const message = await InboxMessage.mustFind(messageId)
  const { imageIds: delivered } = prepareInboxDelivery([message], 'steer', 'steer')
  imageIds.push(...delivered)
  const rows = await db.select().from(images).where(inArray(images.id, delivered))
  const blocks = await Image.loadManyForAgent(delivered, recipient)
  return { delivered, rows, blocks }
}

beforeAll(async () => {
  await AgentType.create({
    id: `${prefix}-type`,
    name: 'Image recipient',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'test',
  })
  await AgentType.create({ id: `${prefix}-text`, name: 'Text only', model: 'zai:glm-5.2', systemPrompt: 'test' })
  squad = await Squad.create({ name: prefix, purpose: 'image forwarding' })
  member = await createTestUser({ prefix: `${prefix}-member` })
  other = await createTestUser({ prefix: `${prefix}-other` })
  const chat = await createTestRole({ prefix: `${prefix}-chat`, permissions: ['chat:send'] })
  const squadRole = await createTestRole({
    prefix: `${prefix}-squad`,
    permissions: ['chat:send', 'agents:read', 'agents:write', 'squads:read'],
  })
  for (const user of [member, other]) await assignRole({ userId: user.id, roleId: chat.id, scope: 'system' })
  await assignRole({ userId: member.id, roleId: squadRole.id, scope: 'squad', squadId: squad.id })
  squadAgent = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id, ownerUserId: member.id })
  textAgent = await Agent.create({ agentTypeId: `${prefix}-text`, squadId: squad.id, ownerUserId: member.id })
  agentIds.push(squadAgent.id, textAgent.id)
})

afterAll(async () => {
  const forwarded = await db.select().from(images).where(inArray(images.forwardedFromImageId, imageIds))
  await Image.deleteMany([...new Set([...imageIds, ...forwarded.map((row) => row.id)])])
  if (conversationIds.length) {
    await db
      .delete(inbox)
      .where(
        or(
          inArray(inbox.senderId, conversationIds.map(assistantInboxRecipientId)),
          inArray(inbox.recipientId, conversationIds.map(assistantInboxRecipientId)),
          inArray(inbox.recipientId, agentIds)
        )
      )
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds))
  }
  const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squad.id))
  await db.delete(agents).where(inArray(agents.id, [...agentIds, ...owned.map((row) => row.id)]))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(agentTypes).where(inArray(agentTypes.id, [`${prefix}-type`, `${prefix}-text`]))
  await cleanupTestRbac(prefix)
})

test('the Assistant lists the images it received, with the message each came with', async () => {
  const { call, receive, agentId } = await conversationFor(member)
  expect((await call('list_conversation_images', {})).value).toEqual({ images: [] })
  const image = await receive()
  const message = await (
    await Agent.mustFind(agentId)
  ).recordMessage({ role: 'human', content: 'Look at this bug', metadata: { imageIds: [image.id] } })
  const { value } = await call('list_conversation_images', {})
  expect(value.images).toHaveLength(1)
  expect(value.images[0]).toMatchObject({
    id: image.id,
    mimeType: 'image/png',
    messageId: message?.id,
    messagePreview: 'Look at this bug',
  })
})

test('delegating to a squad consultant copies the image to it and delivers real image blocks', async () => {
  const { call, receive } = await conversationFor(member)
  const image = await receive()
  const { value, text } = await call('delegate_task', {
    request: 'File this bug',
    squadId: squad.id,
    imageIds: [image.id],
  })
  expect(text).not.toContain('error')
  expect(value).toMatchObject({ kind: 'squad', squadId: squad.id })
  const consultant = await Agent.mustFind(value.agentId)
  agentIds.push(consultant.id)
  expect(consultant.agentTypeId).toBe('consultant')

  const { delivered, rows, blocks } = await deliveredImages(value.id, consultant)
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).not.toBe(image.id)
  // The copy is the consultant's own, uploaded by the same user and traced to the original.
  expect(rows[0]).toMatchObject({
    agentId: consultant.id,
    squadId: squad.id,
    uploadedByUserId: member.id,
    forwardedFromImageId: image.id,
    mimeType: 'image/png',
    size: image.size,
  })
  expect(rows[0]!.filename).not.toBe(image.filename)
  expect(existsSync(new Image(rows[0]!).getFilePath())).toBe(true)
  expect(blocks).toEqual([{ type: 'image', data: PNG, mimeType: 'image/png' }])
  // The original stays with the Assistant, which the consultant cannot read directly.
  expect((await Image.mustFind(image.id)).agentId).not.toBe(consultant.id)
  await expect(Image.loadManyForAgent([image.id], consultant)).rejects.toThrow()

  // The delivery queued the consultant's turn with the copy attached.
  const [execution] = await db.select().from(executions).where(eq(executions.agentId, consultant.id))
  expect(execution?.imageIds).toEqual(delivered)
})

test('delegating to the general worker forwards the image the same way', async () => {
  const { call, receive } = await conversationFor(member)
  const image = await receive()
  const { value } = await call('delegate_task', { request: 'Look into this error', imageIds: [image.id] })
  expect(value).toMatchObject({ kind: 'background' })
  const worker = await Agent.mustFind(value.agentId)
  agentIds.push(worker.id)
  const { rows, blocks } = await deliveredImages(value.id, worker)
  expect(rows[0]).toMatchObject({ agentId: worker.id, squadId: null, forwardedFromImageId: image.id })
  expect(blocks).toEqual([{ type: 'image', data: PNG, mimeType: 'image/png' }])
})

test('message_agent forwards images to an agent the user can chat with', async () => {
  const { call, receive } = await conversationFor(member)
  const image = await receive()
  const { value } = await call('message_agent', {
    agentId: squadAgent.id,
    request: 'Is this the same bug?',
    imageIds: [image.id],
  })
  expect(value.agentId).toBe(squadAgent.id)
  const { rows, blocks } = await deliveredImages(value.messageId, squadAgent)
  expect(rows[0]).toMatchObject({ agentId: squadAgent.id, squadId: squad.id, forwardedFromImageId: image.id })
  expect(blocks).toHaveLength(1)
})

test("an agent whose model can't read images is refused", async () => {
  const { call, receive } = await conversationFor(member)
  const image = await receive()
  const result = await call('message_agent', { agentId: textAgent.id, request: 'Look', imageIds: [image.id] })
  expect(result.value).toEqual({ error: true })
  expect(result.text).toBe("That agent's model cannot read images.")
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, textAgent.id))).toEqual([])
})

test('a delivery that does not commit leaves neither copy rows nor copy blobs', async () => {
  const { call, receive } = await conversationFor(member)
  const image = await receive()
  const gone = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id, ownerUserId: member.id })
  agentIds.push(gone.id)
  await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, gone.id))
  const blobs = () => readdirSync(dirname(getImagePath('probe'))).sort()
  const before = blobs()
  const result = await call('message_agent', { agentId: gone.id, request: 'Look', imageIds: [image.id] })
  expect(result.value).toEqual({ error: true })
  expect(result.text).toContain('terminated')
  expect(await db.select().from(images).where(eq(images.forwardedFromImageId, image.id))).toEqual([])
  expect(blobs()).toEqual(before)
})

test('copy rows commit with the inbox message: a copy that fails in the transaction rolls the message back', async () => {
  const { call, receive } = await conversationFor(member)
  const image = await receive()
  // The original leaves this conversation after the copies are prepared, before the delivery commits.
  setBeforeRecipientLifecycleLockHookForTest(async () => {
    await db.update(images).set({ agentId: squadAgent.id }).where(eq(images.id, image.id))
  })
  try {
    const result = await call('message_agent', { agentId: squadAgent.id, request: 'Racing', imageIds: [image.id] })
    expect(result.text).toBe('An image is no longer available to forward.')
  } finally {
    setBeforeRecipientLifecycleLockHookForTest(undefined)
  }
  const sent = await db.select().from(inbox).where(eq(inbox.recipientId, squadAgent.id))
  expect(sent.some((row) => row.content === 'Racing')).toBe(false)
  expect(await db.select().from(images).where(eq(images.forwardedFromImageId, image.id))).toEqual([])
})

test("forwarding another conversation's image, or one that doesn't exist, is refused and sends nothing", async () => {
  const mine = await conversationFor(member)
  const theirs = await conversationFor(other)
  const foreign = await theirs.receive()
  // Even the same user's other conversation does not count: only this conversation's images.
  const sibling = await (await conversationFor(member)).receive()
  for (const id of [foreign.id, sibling.id, randomUUID()]) {
    for (const [name, args] of [
      ['delegate_task', { request: 'File this', imageIds: [id] }],
      ['message_agent', { agentId: squadAgent.id, request: 'Look', imageIds: [id] }],
    ] as const) {
      const result = await mine.call(name, args)
      expect(result.value).toEqual({ error: true })
      expect(result.text).toBe(`Image ${id} is not one this conversation received.`)
    }
  }
  const sent = await db
    .select()
    .from(inbox)
    .where(eq(inbox.senderId, assistantInboxRecipientId(mine.conversationId)))
  expect(sent).toEqual([])
  expect(
    await db
      .select()
      .from(images)
      .where(inArray(images.forwardedFromImageId, [foreign.id, sibling.id]))
  ).toEqual([])
})

test('an image cannot be sent twice in one request, and a replayed request reuses its copies', async () => {
  const { call, receive, conversationId } = await conversationFor(member)
  const image = await receive()
  expect((await call('delegate_task', { request: 'Twice', imageIds: [image.id, image.id] })).value).toEqual({
    error: true,
  })
  // A lost response retried with the same client ID delivers once, with one set of copies.
  const identity = { type: 'user' as const, userId: member.id }
  const body = { clientId: randomUUID(), request: 'Once', imageIds: [image.id] }
  const first = await sendAssistantTaskRequest(identity, conversationId, body)
  agentIds.push(first.agentId)
  const second = await sendAssistantTaskRequest(identity, conversationId, body)
  expect(second.id).toBe(first.id)
  const copies = await db.select().from(images).where(eq(images.forwardedFromImageId, image.id))
  expect(copies).toHaveLength(1)
  expect((await InboxMessage.mustFind(first.id)).metadata.imageIds).toEqual([copies[0]!.id])
})
