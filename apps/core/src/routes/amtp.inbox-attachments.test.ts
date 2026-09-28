import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, peers, agents, agentTypes, inbox, executions, amtpReceived, inboxAttachments } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter, __setPullImpl } from './amtp'
import { pullAttachment } from '../services/amtp/attachment-pull'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { Peer } from '../entities/Peer'
import { Execution } from '../entities/Execution'
import { AmtpAllowRule } from '../entities/AmtpAllowRule'
import { getSettingsStore } from '../services/settings'
import { sha256Hex } from '../services/inbox/attachment-storage'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'
import { formatAmtpAddress } from '../services/amtp/address'
import { ensureAgentIdentity } from '../services/amtp/agent-identity'
import type { AmtpEnvelope, AmtpAttachmentRef } from '@ficus/shared'

// Production-like app: sentinel wired exactly as real app does.
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-inbox-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const peerKeys = generateInstanceKeyPair()
const peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
const handle = `${prefix}-bob`
const agentTypeId = `${prefix}-att-type`

// Set in beforeEach from InstanceIdentity.getPublic() so envelope.to uses the real instanceId
// (required after the to.instanceId integrity check in the receive handler).
let localInstanceId: string
let agent: Agent
let home: string
const origHome = process.env.HOME_DIR

beforeEach(async () => {
  ;({ instanceId: localInstanceId } = await InstanceIdentity.getPublic())

  // Set up temp dir for attachment file storage.
  home = await mkdtemp(join(tmpdir(), 'fed-att-'))
  process.env.HOME_DIR = home

  const store = getSettingsStore()
  await store.initialize()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760') // 10 MB
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240') // 10 GB

  await db.delete(peers)
  await db.delete(amtpReceived)

  await AgentType.create({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Fed Inbox Att Type',
    systemPrompt: 'You are a test agent.',
  })
  agent = await Agent.create({ agentTypeId, metadata: { name: 'Bob' } })
  await ensureAgentIdentity(agent, `agent_${agent.id}`)
  await db.update(agents).set({ amtpHandle: handle }).where(eq(agents.id, agent.id))
  await Peer.create({
    localAlias: `${prefix}-peer`,
    instanceId: peerInstanceId,
    baseUrl: 'https://peer.example/api',
    publicKeyPem: peerKeys.publicKeyPem,
  })

  // Reset pullImpl to real impl before each test (overridden per-test below).
  __setPullImpl(pullAttachment)
})

afterEach(async () => {
  // Restore pullImpl to real impl to avoid cross-test leakage.
  __setPullImpl(pullAttachment)

  if (origHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = origHome

  await rm(home, { recursive: true, force: true })

  await db.delete(executions).where(eq(executions.agentId, agent.id))
  // Explicitly delete inboxAttachments before deleting inbox rows to avoid
  // relying on cascade behaviour for test isolation (cascade is tested in the
  // InboxAttachment unit tests; here we want deterministic cleanup).
  const agentInboxRows = await db.select({ id: inbox.id }).from(inbox).where(eq(inbox.recipientId, agent.id))
  for (const row of agentInboxRows) {
    await db.delete(inboxAttachments).where(eq(inboxAttachments.messageId, row.id))
  }
  await db.delete(inbox).where(eq(inbox.recipientId, agent.id))
  await db.delete(amtpReceived)
  await db.delete(agents).where(eq(agents.agentTypeId, agentTypeId))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  await db.delete(peers)
})

afterAll(async () => {
  await db.delete(peers)
})

function makeRef(overrides: Partial<AmtpAttachmentRef> = {}): AmtpAttachmentRef {
  const bytes = new TextEncoder().encode('hello attachment')
  return {
    id: crypto.randomUUID(),
    filename: 'hello.txt',
    contentType: 'text/plain',
    byteSize: bytes.byteLength,
    sha256: sha256Hex(bytes),
    ...overrides,
  }
}

function makeEnvelope(overrides: Partial<AmtpEnvelope> = {}): AmtpEnvelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: formatAmtpAddress(peerInstanceId, 'alice'),
    to: formatAmtpAddress(localInstanceId, handle),
    content: 'hello from alice',
    ...overrides,
  }
}

function signedRequest(env: AmtpEnvelope, opts: { instanceId?: string; sig?: string } = {}) {
  const body = JSON.stringify(env)
  const sig = opts.sig ?? signEnvelope(peerKeys.privateKeyPem, new TextEncoder().encode(body))
  return app.request('/api/amtp/inbox', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amtp-instance': opts.instanceId ?? peerInstanceId,
      'x-amtp-signature': sig,
    },
    body,
  })
}

async function allowAlice() {
  await AmtpAllowRule.create({
    targetAgentId: agent.id,
    peerInstanceId,
    principalKind: 'handle',
    principalValue: 'alice',
  })
}

describe('POST /api/amtp/inbox — attachment path', () => {
  test('single attachment happy path: inbox row + 1 linked InboxAttachment with matching bytes and sha256', async () => {
    await allowAlice()

    const bytes = new TextEncoder().encode('hello attachment')
    const ref = makeRef({ byteSize: bytes.byteLength, sha256: sha256Hex(bytes) })
    const env = makeEnvelope({ attachments: [ref] })

    // Inject mock pull that returns the correct bytes.
    __setPullImpl(async (_deps, _args) => bytes)

    const res = await signedRequest(env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: true })

    // Exactly one inbox row for the recipient with senderType='remote'.
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.senderType).toBe('remote')
    expect(row.senderId).toBe(env.from)

    // Exactly one linked InboxAttachment row.
    const atts = await db.select().from(inboxAttachments).where(eq(inboxAttachments.messageId, row.id))
    expect(atts).toHaveLength(1)
    const att = atts[0]
    expect(att.filename).toBe(ref.filename)
    expect(att.contentType).toBe(ref.contentType)
    expect(att.byteSize).toBe(bytes.byteLength)
    expect(att.sha256).toBe(sha256Hex(bytes))

    // Agent woke up: an execution is queued.
    await new Promise((r) => setTimeout(r, 100))
    const execs = await Execution.list({ agentId: agent.id })
    expect(execs.length).toBeGreaterThanOrEqual(1)
  })

  test('sha256 mismatch from pull → 422 (terminal); NO inbox row; NO InboxAttachment; dedup released', async () => {
    await allowAlice()

    const ref = makeRef()
    const env = makeEnvelope({ attachments: [ref] })

    __setPullImpl(async () => {
      throw new Error('ATTACHMENT_HASH_MISMATCH')
    })

    const res = await signedRequest(env)
    expect(res.status).toBe(422)

    // No inbox row persisted.
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(0)

    // No InboxAttachment persisted (no inbox rows for this agent means no attachments either).
    // Check via join: get any inbox rows for this agent, then verify no attachments on them.
    const inboxRows = await db.select({ id: inbox.id }).from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(inboxRows).toHaveLength(0)
    // Since there are no inbox rows, there can be no attachments — confirmed by checking the
    // agent's inbox being empty above.

    // Dedup slot released — retry would be treated as first sighting.
    const received = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(received).toHaveLength(0)
  })

  test('size mismatch from pull → 422 (terminal); nothing persisted; dedup released', async () => {
    await allowAlice()

    const ref = makeRef()
    const env = makeEnvelope({ attachments: [ref] })

    __setPullImpl(async () => {
      throw new Error('ATTACHMENT_SIZE_MISMATCH')
    })

    const res = await signedRequest(env)
    expect(res.status).toBe(422)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(0)

    const received = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(received).toHaveLength(0)
  })

  test('over-aggregate-cap → 507 (retryable 5xx); nothing persisted; dedup released', async () => {
    await allowAlice()

    // Set total storage cap to 0 so any incoming byte fails the pre-check.
    const store = getSettingsStore()
    await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '0')

    const ref = makeRef() // byteSize > 0
    const env = makeEnvelope({ attachments: [ref] })

    // pullImpl should NOT be called (pre-check fires first); default real impl would fail anyway
    // since the peer URL is fake. No need to override __setPullImpl.

    const res = await signedRequest(env)
    expect(res.status).toBe(507)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(0)

    const received = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(received).toHaveLength(0)
  })

  test('pull network failure → 502 (retryable); nothing persisted; dedup released', async () => {
    await allowAlice()

    const ref = makeRef()
    const env = makeEnvelope({ attachments: [ref] })

    __setPullImpl(async () => {
      throw new Error('ATTACHMENT_PULL_FAILED')
    })

    const res = await signedRequest(env)
    expect(res.status).toBe(502)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(0)

    const received = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(received).toHaveLength(0)
  })

  test('per-blob too-large → 413 (terminal); nothing persisted; dedup released', async () => {
    await allowAlice()

    const ref = makeRef()
    const env = makeEnvelope({ attachments: [ref] })

    __setPullImpl(async () => {
      throw new Error('ATTACHMENT_TOO_LARGE')
    })

    const res = await signedRequest(env)
    expect(res.status).toBe(413)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(0)

    const received = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(received).toHaveLength(0)
  })
})

describe('POST /api/amtp/inbox — text-only regression (Slice 3 unchanged)', () => {
  test('text-only envelope (no attachments) → 200; inbox row created; agent wakes', async () => {
    await allowAlice()
    const env = makeEnvelope({ subject: 'hi', content: 'text only' })

    const res = await signedRequest(env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: true })

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].senderType).toBe('remote')

    // No InboxAttachment rows for this message.
    const atts = await db.select().from(inboxAttachments).where(eq(inboxAttachments.messageId, rows[0].id))
    expect(atts).toHaveLength(0)

    // Agent wakes.
    await new Promise((r) => setTimeout(r, 100))
    const execs = await Execution.list({ agentId: agent.id })
    expect(execs.length).toBeGreaterThanOrEqual(1)
  })
})
