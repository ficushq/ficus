import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AssistantRoutingHint, DecisionRequest, MessageMetadata } from '@ficus/shared'
import { agents, assistantConversations, db, messages } from '../../db'
import { identityMiddleware } from '../../middleware/identity'
import { agentsRouter } from '../../routes/agents'
import { assistantRouter } from '../../routes/assistant'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../../test-utils'
import { messageTextForModel } from '../chat/message-context'
import type { DecisionOutcome } from '../decisions/service'
import type { AssistantRoutingDeps, RoutingSquad } from './assistant-routing'
import { previewAssistantRouting, sentAssistantRouting } from './assistant-routing-preview'

const prefix = `assistant-routing-preview-${randomUUID()}`
const conversationIds: string[] = []
const agentIds: string[] = []
const app = new Hono()
  .use('*', identityMiddleware)
  .route('/api/assistant', assistantRouter)
  .route('/api/agents', agentsRouter)
const chlea: RoutingSquad = { id: randomUUID(), name: 'Chlea', purpose: 'The Chlea app' }
const billing: RoutingSquad = { id: randomUUID(), name: 'Billing', purpose: 'Invoices' }
const listSquads = async () => [chlea, billing]

afterEach(async () => {
  if (conversationIds.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds.splice(0)))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  await cleanupTestRbac(prefix)
})

async function fixture() {
  const owner = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  await assignRole({ userId: owner.id, roleId: role.id, scope: 'system' })
  const id = randomUUID()
  conversationIds.push(id)
  const request = (path: string, body: unknown, token = owner.token) =>
    app.request(path, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await request('/api/assistant', { id })).status).toBe(200)
  const { agentId } = (await (await request(`/api/assistant/${id}/agent`, {})).json()) as { agentId: string }
  agentIds.push(agentId)
  return { id, agentId, owner, request }
}

function recordingDecide(answer: (request: DecisionRequest) => DecisionOutcome) {
  const calls: Array<{ request: DecisionRequest; source: unknown }> = []
  const decide: NonNullable<AssistantRoutingDeps['decide']> = async (_purpose, request, options) => {
    calls.push({ request, source: options.source })
    return answer(request)
  }
  return { decide, calls }
}

const both = (kind: string, kindP: number, scope: string, scopeP: number): DecisionOutcome => ({
  ok: true,
  result: {
    answers: {
      kind: { type: 'choice', choice: kind, probabilities: { [kind]: kindP } },
      scope: { type: 'choice', choice: scope, probabilities: { [scope]: scopeP } },
    },
    providerId: 'p1',
    model: 'jev',
    latencyMs: 4,
  },
})
const chleaKey = `squad_${chlea.id.replaceAll('-', '').slice(0, 8)}`

test('a draft gets the same routing decision a sent message would, with the conversation so far as context', async () => {
  const f = await fixture()
  const identity = { type: 'user' as const, userId: f.owner.id }
  const { decide, calls } = recordingDecide(() => both('new_request', 0.9, chleaKey, 0.88))
  const deps = { decide, enabled: () => true, listSquads }
  // Too short to route: nothing is asked.
  expect(await previewAssistantRouting(identity, f.id, 'fix it', deps)).toEqual({ hint: null })
  expect(calls).toHaveLength(0)

  const { hint } = await previewAssistantRouting(identity, f.id, 'The checkout button is broken', deps)
  expect(hint).toEqual({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.88 })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.source).toEqual({ kind: 'assistant-preview', agentId: f.agentId })
  expect(calls[0]!.request.state).toMatchObject({ message: 'The checkout button is broken' })

  // Unsure, or a follow-up that keeps earlier routing: nothing to show.
  const unsure = recordingDecide(() => both('new_request', 0.9, chleaKey, 0.4))
  expect(
    await previewAssistantRouting(identity, f.id, 'The checkout button is broken', { ...deps, decide: unsure.decide })
  ).toEqual({ hint: null })
  const followUp = recordingDecide(() => both('follow_up', 0.9, chleaKey, 0.9))
  const inherited = { messageId: randomUUID(), hint: { scope: 'general' as const, confidence: 0.8 } }
  expect(
    await previewAssistantRouting(identity, f.id, 'and the cart too please', {
      ...deps,
      decide: followUp.decide,
      findInherited: async () => inherited,
    })
  ).toEqual({ hint: null })

  // Only the owner can preview their conversation.
  const stranger = await createTestUser({ prefix })
  await expect(
    previewAssistantRouting({ type: 'user', userId: stranger.id }, f.id, 'The checkout button is broken', deps)
  ).rejects.toThrow()
})

test('routing sent with a message is checked against visible squads; a pick becomes the correction', async () => {
  const identity = { type: 'user' as const, userId: randomUUID() }
  const send = (raw: unknown) => sentAssistantRouting(identity, raw, { listSquads })
  const hint = { scope: 'squad', squadId: chlea.id, confidence: 0.8 }
  expect(await send({ hint })).toEqual({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.8 })
  expect(await send({ hint: { scope: 'instance', confidence: 0.7 } })).toEqual({ scope: 'instance', confidence: 0.7 })
  // Unsure, unknown or invisible squads, and junk are dropped: the turn routes it as usual.
  expect(await send({ hint: { ...hint, confidence: 0.5 } })).toBeUndefined()
  expect(await send({ hint: { ...hint, squadId: randomUUID() } })).toBeUndefined()
  expect(await send({ hint: { scope: 'squad', squadId: 'nope', confidence: 2 } })).toBeUndefined()
  expect(await send({})).toBeUndefined()

  const picked = (await send({ hint, pick: { scope: 'squad', squadId: billing.id } })) as AssistantRoutingHint
  expect(picked).toMatchObject({
    scope: 'squad',
    squadId: chlea.id,
    confidence: 0.8,
    correction: { scope: 'squad', squadId: billing.id, squadName: 'Billing' },
  })
  // Picked before the preview answered.
  expect(await send({ pick: { scope: 'none' } })).toMatchObject({
    scope: 'general',
    confidence: 0,
    correction: { scope: 'none' },
  })
  // A pick of a squad the user cannot see is dropped, leaving the preview's pick.
  expect(await send({ hint, pick: { scope: 'squad', squadId: randomUUID() } })).toEqual({
    scope: 'squad',
    squadId: chlea.id,
    squadName: 'Chlea',
    confidence: 0.8,
  })
})

test("a message sent with the user's pick carries it, so the turn reads it without asking again", async () => {
  const f = await fixture()
  const clientId = randomUUID()
  const response = await f.request(`/api/agents/${f.agentId}/message`, {
    content: 'The export button crashes',
    clientId,
    assistantRouting: { pick: { scope: 'none' } },
  })
  expect(response.status).toBe(200)
  const [saved] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.agentId, f.agentId), eq(messages.content, 'The export button crashes')))
  const metadata = saved!.metadata as MessageMetadata
  expect(metadata.source).toBe('user_chat')
  expect(metadata.assistantRouting).toMatchObject({ correction: { scope: 'none' } })
  expect(messageTextForModel({ content: saved!.content, metadata })).toContain(
    'Routing (set by the user): this is not for a squad.'
  )
})
