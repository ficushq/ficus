import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, squads, inbox, outbox } from '../db'
import { Agent } from '../entities/Agent'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { inboxRouter } from './inbox'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestUser,
  type TestUser,
} from '../test-utils'

// Production-like app: sentinel wired exactly as in apps/core/src/index.ts
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/inbox', inboxRouter)

const prefix = `inbox-fedsend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PEER = 'peerinstfedsendaaaaaaaaaaaaaaaaa' // stand-in remote instance id
let admin: TestUser
let plainUser: TestUser
let squadId: string
let instanceId: string

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  plainUser = await createTestUser({ prefix })
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

const createdAgentIds: string[] = []

afterEach(async () => {
  await db.delete(outbox).where(eq(outbox.peerInstanceId, PEER))
  for (const id of createdAgentIds.splice(0)) {
    await db.delete(inbox).where(eq(inbox.recipientId, id))
    await db.delete(agents).where(eq(agents.id, id))
  }
})

// Creates an agent in the test squad, optionally with a federation handle, owned by `ownerUserId`
// (the owner determines the agent identity's resolved permissions).
async function makeAgent(opts: { handle?: string | null; ownerUserId?: string }) {
  // Owner on the agent ROW: since #1223 agent permissions resolve via the root
  // agent's ownerUserId, not the token's userId.
  const agent = await Agent.create({
    agentTypeId: 'system-manager',
    squadId,
    ownerUserId: opts.ownerUserId ?? null,
    context: {},
  })
  createdAgentIds.push(agent.id)
  if (opts.handle !== undefined) {
    await db.update(agents).set({ amtpHandle: opts.handle }).where(eq(agents.id, agent.id))
  }
  const token = await createTestAgentToken({ agentId: agent.id, squadId, userId: opts.ownerUserId })
  return { agent, token: token.token }
}

describe('POST /api/inbox — outbound federation send', () => {
  test('agent with amtp:send sending to an amtp:// address enqueues an outbox row to the peer', async () => {
    const { token } = await makeAgent({ handle: `${prefix}-sender`, ownerUserId: admin.id })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: `amtp://${PEER}/bob`,
        subject: 'hi there',
        content: 'hello from local',
      }),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.enqueued).toBe(true)
    expect(typeof body.outboxId).toBe('string')

    const [row] = await db.select().from(outbox).where(eq(outbox.id, body.outboxId))
    expect(row).toBeDefined()
    expect(row.peerInstanceId).toBe(PEER)
    expect(row.toAddress).toBe(`amtp://${PEER}/bob`)
    expect(row.status).toBe('pending')
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.v).toBe(1)
    expect(env.to).toBe(`amtp://${PEER}/bob`)
    expect(env.from).toBe(`amtp://${instanceId}/${prefix}-sender`)
    expect(env.content).toBe('hello from local')
    expect(env.subject).toBe('hi there')
    expect(row.idempotencyKey).toBe(env.id as string)
  })

  test('missing amtp:send returns 403', async () => {
    // Token owned by a plain user → agent identity resolves no amtp:send.
    const { token } = await makeAgent({ handle: `${prefix}-noperm`, ownerUserId: plainUser.id })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: `amtp://${PEER}/bob`,
        content: 'should be blocked',
      }),
    })

    expect(res.status).toBe(403)
    const rows = await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))
    expect(rows.length).toBe(0)
  })

  test('agent without a federation handle returns 400', async () => {
    const { token } = await makeAgent({ handle: null, ownerUserId: admin.id })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: `amtp://${PEER}/bob`,
        content: 'no handle',
      }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('sender not federation-registered')
  })

  test('inReplyTo to a remote-origin row defaults the destination to its fromAddress and carries the envelope id', async () => {
    const { agent, token } = await makeAgent({ handle: `${prefix}-replier`, ownerUserId: admin.id })

    // Seed an inbound remote-origin message (senderType='remote' → non-UUID senderId per the CASE-on-UUID invariant).
    const fromAddress = `amtp://${PEER}/alice`
    const [original] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'remote',
        senderId: fromAddress,
        content: 'ping from alice',
        deliveryMode: 'follow-up',
        metadata: {
          remote: {
            peerInstanceId: PEER,
            fromAddress,
            fromHandle: 'alice',
            envelopeId: 'env-original-123',
            agentSigVerified: false,
          },
          sender: { name: 'alice' },
        },
      })
      .returning()

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: `amtp://${PEER}/bob`, // overridden by the reply target
        content: 'pong to alice',
        inReplyTo: original.id,
      }),
    })

    expect(res.status).toBe(202)
    const { outboxId } = await res.json()
    const [row] = await db.select().from(outbox).where(eq(outbox.id, outboxId))
    // Destination defaults to the original sender's address, not the body recipientId.
    expect(row.toAddress).toBe(fromAddress)
    expect(row.peerInstanceId).toBe(PEER)
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.to).toBe(fromAddress)
    expect(env.inReplyTo).toBe('env-original-123')
  })

  test('local/non-remote inReplyTo keeps the explicit amtp:// recipient', async () => {
    const { agent, token } = await makeAgent({ handle: `${prefix}-locreply`, ownerUserId: admin.id })

    // Seed a LOCAL (non-remote, no metadata.remote) inbox message addressed to the sending agent
    const [localMsg] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'agent',
        senderId: agent.id,
        content: 'local message from self',
        deliveryMode: 'follow-up',
        metadata: {},
      })
      .returning()

    const explicitTo = `amtp://${PEER}/charlie`
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: explicitTo,
        content: 'reply to local message',
        inReplyTo: localMsg.id,
      }),
    })

    expect(res.status).toBe(202)
    const { outboxId } = await res.json()
    const [row] = await db.select().from(outbox).where(eq(outbox.id, outboxId))
    // Must go to the explicit address — NOT overridden from the local message
    expect(row.toAddress).toBe(explicitTo)
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.to).toBe(explicitTo)
    expect(env.inReplyTo).toBeUndefined()
  })

  test('malformed inReplyTo (≥36-char non-UUID string) does not 500', async () => {
    const { token } = await makeAgent({ handle: `${prefix}-badinreply`, ownerUserId: admin.id })

    const explicitTo = `amtp://${PEER}/dave`
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: explicitTo,
        content: 'test with malformed inReplyTo',
        inReplyTo: 'this-is-not-a-uuid-at-all-but-it-is-long-enough-yes',
      }),
    })

    // Must NOT 500 — degrade gracefully to a plain send
    expect(res.status).toBe(202)
    const { outboxId } = await res.json()
    const [row] = await db.select().from(outbox).where(eq(outbox.id, outboxId))
    expect(row.toAddress).toBe(explicitTo)
  })

  test('reply to a remote-origin message owned by a DIFFERENT agent does not override destination', async () => {
    // Agent A is the sender; the seeded remote-origin message is addressed to agent B (different agent)
    const { token } = await makeAgent({ handle: `${prefix}-senderA`, ownerUserId: admin.id })
    const { agent: agentB } = await makeAgent({ handle: `${prefix}-recipB`, ownerUserId: admin.id })

    const fromAddress = `amtp://${PEER}/eve`
    const [original] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agentB.id, // addressed to agent B, NOT to the sender
        senderType: 'remote',
        senderId: fromAddress,
        content: 'message addressed to agent B',
        deliveryMode: 'follow-up',
        metadata: {
          remote: {
            peerInstanceId: PEER,
            fromAddress,
            fromHandle: 'eve',
            envelopeId: 'env-other-agent-456',
            agentSigVerified: false,
          },
        },
      })
      .returning()

    const explicitTo = `amtp://${PEER}/frank`
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: explicitTo,
        content: 'should not steal fromAddress from agentB message',
        inReplyTo: original.id,
      }),
    })

    expect(res.status).toBe(202)
    const { outboxId } = await res.json()
    const [row] = await db.select().from(outbox).where(eq(outbox.id, outboxId))
    // Must NOT use fromAddress from agentB's remote message
    expect(row.toAddress).toBe(explicitTo)
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.to).toBe(explicitTo)
    expect(env.inReplyTo).toBeUndefined()
  })

  test('empty subject is coerced to undefined in the enqueued envelope (not an empty string)', async () => {
    const { token } = await makeAgent({ handle: `${prefix}-emptysub`, ownerUserId: admin.id })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: `amtp://${PEER}/bob`,
        subject: '',
        content: 'hello no subject',
      }),
    })

    expect(res.status).toBe(202)
    const { outboxId } = await res.json()
    const [row] = await db.select().from(outbox).where(eq(outbox.id, outboxId))
    expect(row).toBeDefined()
    const env = row.envelopeJson as unknown as Record<string, unknown>
    // Empty string subject must be omitted from the envelope (not stored as '')
    expect(env.subject).toBeUndefined()
  })

  test('malformed amtp:// recipient returns 400 invalid federation address', async () => {
    const { token } = await makeAgent({ handle: `${prefix}-malformtau`, ownerUserId: admin.id })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: 'amtp://inst', // malformed: no /handle component
        content: 'test malformed ficus address',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid federation address')
  })

  test('a normal local (non-amtp://) send is unchanged', async () => {
    const { agent, token } = await makeAgent({ handle: `${prefix}-local`, ownerUserId: admin.id })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: agent.id, // agent messaging itself — ordinary local path
        content: 'local note',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.senderType).toBe('agent')
    expect(body.recipientId).toBe(agent.id)
    const fed = await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))
    expect(fed.length).toBe(0)
  })
})
