import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, squads, inbox, outbox } from '../db'
import { Agent } from '../entities/Agent'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { inboxRouter } from './inbox'
import { generateInstanceKeyPair, signEnvelope } from '../services/amtp/crypto'
import { canonicalAgentSigBytes, formatAmtpAddress } from '@ficus/shared'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, type TestUser } from '../test-utils'

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/inbox', inboxRouter)

const prefix = `inbox-signed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PEER = 'peerinstsignedaaaaaaaaaaaaaaaaaaa'
let admin: TestUser
let squadId: string
let instanceId: string
const createdAgentIds: string[] = []
const keys = generateInstanceKeyPair()

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-squad`, purpose: 'test' })
    .returning()
  squadId = squad.id
  ;({ instanceId } = await InstanceIdentity.getPublic())
})

afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

afterEach(async () => {
  await db.delete(outbox).where(eq(outbox.peerInstanceId, PEER))
  for (const id of createdAgentIds.splice(0)) {
    await db.delete(inbox).where(eq(inbox.recipientId, id))
    await db.delete(agents).where(eq(agents.id, id))
  }
})

async function makeSender(handle: string) {
  // Owner on the agent ROW: since #1223 agent permissions resolve via the root
  // agent's ownerUserId, not the token's userId.
  const agent = await Agent.create({ agentTypeId: 'system-manager', squadId, ownerUserId: admin.id, context: {} })
  createdAgentIds.push(agent.id)
  await db
    .update(agents)
    .set({ amtpHandle: handle, identityPublicKey: keys.publicKeyPem })
    .where(eq(agents.id, agent.id))
  const token = await createTestAgentToken({ agentId: agent.id, squadId, userId: admin.id })
  return { agent, token: token.token }
}

function sign(opts: { id: string; handle: string; to: string; subject?: string; content: string }): string {
  const bytes = canonicalAgentSigBytes({
    v: 1,
    id: opts.id,
    from: formatAmtpAddress(instanceId, opts.handle),
    to: opts.to,
    subject: opts.subject,
    content: opts.content,
    attachments: [],
  })
  return signEnvelope(keys.privateKeyPem, bytes)
}

describe('POST /api/inbox — signed federation send (D7)', () => {
  test('a valid agentSig over the canonical subset enqueues with agentKey + agentSig + client id', async () => {
    const handle = `${prefix}-signer`
    const { token } = await makeSender(handle)
    const id = crypto.randomUUID()
    const to = `amtp://${PEER}/bob`
    const agentSig = sign({ id, handle, to, subject: 'hi', content: 'signed hello' })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: to,
        subject: 'hi',
        content: 'signed hello',
        id,
        agentKey: keys.publicKeyPem,
        agentSig,
      }),
    })
    expect(res.status).toBe(202)
    const [row] = await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))
    expect(row.idempotencyKey).toBe(id)
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.id).toBe(id)
    expect(env.agentKey).toBe(keys.publicKeyPem)
    expect(env.agentSig).toBe(agentSig)
  })

  test('agentKey not matching the agent identity is rejected 400 (no enqueue)', async () => {
    const handle = `${prefix}-mismatch`
    const { token } = await makeSender(handle)
    const id = crypto.randomUUID()
    const to = `amtp://${PEER}/bob`
    const agentSig = sign({ id, handle, to, content: 'x' })
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: to,
        content: 'x',
        id,
        agentKey: generateInstanceKeyPair().publicKeyPem,
        agentSig,
      }),
    })
    expect(res.status).toBe(400)
    expect((await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))).length).toBe(0)
  })

  test('a tampered content (signature no longer valid) is rejected 400', async () => {
    const handle = `${prefix}-tamper`
    const { token } = await makeSender(handle)
    const id = crypto.randomUUID()
    const to = `amtp://${PEER}/bob`
    const agentSig = sign({ id, handle, to, content: 'original' })
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: to,
        content: 'TAMPERED',
        id,
        agentKey: keys.publicKeyPem,
        agentSig,
      }),
    })
    expect(res.status).toBe(400)
  })

  test('signed path uses the CLI-resolved `to` verbatim and the explicit inReplyToEnvelopeId (no threading rewrite)', async () => {
    const handle = `${prefix}-thread`
    const { agent, token } = await makeSender(handle)
    // Seed a remote-origin row that the UNSIGNED path WOULD use to override `to`.
    await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'remote',
        senderId: `amtp://${PEER}/alice`,
        content: 'inbound',
        deliveryMode: 'follow-up',
        metadata: {
          remote: {
            peerInstanceId: PEER,
            fromAddress: `amtp://${PEER}/alice`,
            fromHandle: 'alice',
            envelopeId: 'env-orig',
            agentSigVerified: false,
          },
        },
      })
      .returning()

    const id = crypto.randomUUID()
    const to = `amtp://${PEER}/charlie` // explicit, must NOT be rewritten to alice
    const agentSig = sign({ id, handle, to, content: 'reply' })
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: to,
        content: 'reply',
        id,
        agentKey: keys.publicKeyPem,
        agentSig,
        inReplyToEnvelopeId: 'env-orig',
      }),
    })
    expect(res.status).toBe(202)
    const [row] = await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))
    expect(row.toAddress).toBe(to)
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.to).toBe(to)
    expect(env.inReplyTo).toBe('env-orig')
  })

  test('an unsigned amtp:// send still works (backward compatible)', async () => {
    const handle = `${prefix}-unsigned`
    const { token } = await makeSender(handle)
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientType: 'agent', recipientId: `amtp://${PEER}/bob`, content: 'plain' }),
    })
    expect(res.status).toBe(202)
  })
})
