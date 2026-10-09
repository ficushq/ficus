import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AssistantRoutingHint, MessageMetadata } from '@ficus/shared'
import { agents, assistantConversations, db, messages } from '../../db'
import { identityMiddleware } from '../../middleware/identity'
import { assistantRouter } from '../../routes/assistant'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../../test-utils'
import { messageTextForModel } from '../chat/message-context'
import { correctAssistantRouting } from './assistant-routing-correction'

const prefix = `assistant-routing-${randomUUID()}`
const conversationIds: string[] = []
const agentIds: string[] = []
const app = new Hono().use('*', identityMiddleware).route('/api/assistant', assistantRouter)
const chlea = { id: randomUUID(), name: 'Chlea', purpose: 'The Chlea app' }

afterEach(async () => {
  if (conversationIds.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds.splice(0)))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  await cleanupTestRbac(prefix)
})

async function fixture(hint: AssistantRoutingHint | null = { scope: 'general', confidence: 0.72 }) {
  const owner = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  await assignRole({ userId: owner.id, roleId: role.id, scope: 'system' })
  const id = randomUUID()
  conversationIds.push(id)
  const request = (path: string, body: unknown) =>
    app.request(`/api/assistant${path}`, {
      method: 'POST',
      headers: { ...authHeaders(owner.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await request('', { id })).status).toBe(200)
  const { agentId } = (await (await request(`/${id}/agent`, {})).json()) as { agentId: string }
  agentIds.push(agentId)
  const [message] = await db
    .insert(messages)
    .values({
      agentId,
      role: 'human',
      content: 'The export button crashes',
      pending: false,
      metadata: { source: 'user_chat', ...(hint ? { assistantRouting: hint } : {}) },
    })
    .returning()
  return { id, agentId, owner, request, messageId: message!.id }
}

const corrections = (agentId: string) =>
  db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.content, '[System] You said this is for Chlea.')
      )
    )

test('picking a squad saves it on the message and tells the Assistant which squad', async () => {
  const f = await fixture()
  const identity = { type: 'user' as const, userId: f.owner.id }
  const deps = { listSquads: async () => [chlea] }
  const body = { messageId: f.messageId, clientId: randomUUID(), scope: 'squad', squadId: chlea.id }
  const { hint } = await correctAssistantRouting(identity, f.id, body, deps)
  expect(hint).toMatchObject({
    scope: 'general',
    confidence: 0.72,
    correction: { scope: 'squad', squadId: chlea.id, squadName: 'Chlea' },
  })
  const [saved] = await db.select().from(messages).where(eq(messages.id, f.messageId))
  expect((saved!.metadata as MessageMetadata).assistantRouting).toEqual(hint)
  expect((saved!.metadata as MessageMetadata).source).toBe('user_chat')

  const [note] = await corrections(f.agentId)
  const metadata = note!.metadata as MessageMetadata
  expect(metadata.source).toBe('assistant_routing_correction')
  expect(metadata.assistantRoutingCorrection).toEqual({
    messageId: f.messageId,
    excerpt: 'The export button crashes',
    scope: 'squad',
    squadId: chlea.id,
    squadName: 'Chlea',
  })
  expect(messageTextForModel({ content: note!.content, metadata })).toContain(
    `their latest message ("The export button crashes") is for squad "Chlea" (squadId ${chlea.id})`
  )

  // The same pick again changes nothing and sends nothing.
  await correctAssistantRouting(identity, f.id, { ...body, clientId: randomUUID() }, deps)
  expect(await corrections(f.agentId)).toHaveLength(1)
})

test('squads the user cannot see, other messages and other users are refused', async () => {
  const f = await fixture()
  const identity = { type: 'user' as const, userId: f.owner.id }
  const squad = { messageId: f.messageId, clientId: randomUUID(), scope: 'squad', squadId: randomUUID() }
  await expect(correctAssistantRouting(identity, f.id, squad, { listSquads: async () => [chlea] })).rejects.toThrow(
    'Squad not found'
  )
  await expect(
    correctAssistantRouting(identity, f.id, { messageId: randomUUID(), clientId: randomUUID(), scope: 'none' })
  ).rejects.toThrow('Message not found')
  const stranger = await createTestUser({ prefix })
  await expect(
    correctAssistantRouting({ type: 'user', userId: stranger.id }, f.id, {
      messageId: f.messageId,
      clientId: randomUUID(),
      scope: 'none',
    })
  ).rejects.toThrow()
})

test('only the latest message the user sent can be corrected; Assistant replies and notes after it do not count', async () => {
  const f = await fixture()
  const identity = { type: 'user' as const, userId: f.owner.id }
  const body = () => ({ messageId: f.messageId, clientId: randomUUID(), scope: 'none' as const })
  await db.insert(messages).values([
    { agentId: f.agentId, role: 'assistant', content: 'On it.', pending: false },
    {
      agentId: f.agentId,
      role: 'human',
      content: '[System] A note',
      pending: false,
      metadata: { source: 'assistant_routing_correction' },
    },
  ])
  await correctAssistantRouting(identity, f.id, body())

  await db.insert(messages).values({
    agentId: f.agentId,
    role: 'human',
    content: 'Also the import button',
    pending: false,
    metadata: { source: 'user_chat' },
  })
  const response = await f.request(`/${f.id}/routing`, {
    ...body(),
    scope: 'squad',
    squadId: chlea.id,
  })
  expect(response.status).toBe(409)
  expect(((await response.json()) as { error: string }).error).toBe(
    'Only your latest message can change squad. Ask the Assistant to move older work.'
  )
})

test('a message without a hint has nothing to correct', async () => {
  const f = await fixture(null)
  const response = await f.request(`/${f.id}/routing`, {
    messageId: f.messageId,
    clientId: randomUUID(),
    scope: 'none',
  })
  expect(response.status).toBe(409)
})

test('the route records No squad', async () => {
  const f = await fixture({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.9 })
  const response = await f.request(`/${f.id}/routing`, {
    messageId: f.messageId,
    clientId: randomUUID(),
    scope: 'none',
  })
  expect(response.status).toBe(200)
  const { hint } = (await response.json()) as { hint: AssistantRoutingHint }
  expect(hint.correction?.scope).toBe('none')
  const sent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.agentId, f.agentId), eq(messages.content, '[System] You said this is not for a squad.')))
  expect(sent).toHaveLength(1)
})
