import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, outbox, inboxAttachments, inbox } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { Peer } from '../entities/Peer'
import { InboxAttachment } from '../entities/InboxAttachment'
import { Outbox } from '../entities/Outbox'
import { getSettingsStore } from '../services/settings'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'
import { canonicalPeerGetString } from 'amtp-protocol'
import type { AmtpEnvelope } from '@ficus/shared'

// Production-like app: sentinel wired exactly as in index.ts.
// identityMiddleware must be mounted so the cookieless peer GET bypasses
// identity (via the identity.ts prefix bypass) and the sentinel confirms
// authzChecked was set by requirePeerSignatureGet.
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// Peer B keypair
const peerBKeys = generateInstanceKeyPair()
const peerBInstanceId = instanceIdFromPublicKeyPem(peerBKeys.publicKeyPem)

// A second peer whose outbox rows we will NOT create (for the no-auth test)
const peerCKeys = generateInstanceKeyPair()
const peerCInstanceId = instanceIdFromPublicKeyPem(peerCKeys.publicKeyPem)

let peerB: Peer
let peerC: Peer
let home: string
const origHome = process.env.HOME_DIR

// --- lifecycle ---

beforeAll(async () => {
  peerB = await Peer.create({
    localAlias: `${prefix}-peer-b`,
    instanceId: peerBInstanceId,
    baseUrl: 'https://peer-b.example/api',
    publicKeyPem: peerBKeys.publicKeyPem,
  })
  peerC = await Peer.create({
    localAlias: `${prefix}-peer-c`,
    instanceId: peerCInstanceId,
    baseUrl: 'https://peer-c.example/api',
    publicKeyPem: peerCKeys.publicKeyPem,
  })
})

afterAll(async () => {
  await Peer.delete(peerB.id)
  await Peer.delete(peerC.id)
})

beforeEach(async () => {
  // Isolate attachment storage per test.
  home = await mkdtemp(join(tmpdir(), 'fed-att-route-'))
  process.env.HOME_DIR = home
  const store = getSettingsStore()
  await store.initialize()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')
})

afterEach(async () => {
  if (origHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = origHome
  await rm(home, { recursive: true, force: true })
  await db.delete(outbox).where(eq(outbox.peerInstanceId, peerBInstanceId))
  await db.delete(outbox).where(eq(outbox.peerInstanceId, peerCInstanceId))
  await db.delete(inboxAttachments)
  await db.delete(inbox)
})

// --- helpers ---

/** Create a system inbox message + one attachment, return both. */
async function seedAttachment(content = 'test attachment bytes') {
  // Insert the inbox row directly to avoid InboxMessage.send's recipient validation.
  const [msgRow] = await db
    .insert(inbox)
    .values({
      recipientType: 'system',
      recipientId: crypto.randomUUID(),
      senderType: 'system',
      content: 'msg with attachment',
    })
    .returning()
  const bytes = new TextEncoder().encode(content)
  const att = await InboxAttachment.create({
    messageId: msgRow.id,
    filename: 'test.txt',
    contentType: 'text/plain',
    bytes,
  })
  return { msgId: msgRow.id, att, bytes }
}

/** Enqueue a minimal outbox row advertising `attachmentId` to `peerInstanceId`. */
async function authorizeAttachmentForPeer(peerInstanceId: string, attachmentId: string) {
  const envelope: AmtpEnvelope = {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: `amtp://local-instance/sender`,
    to: `amtp://${peerInstanceId}/receiver`,
    content: 'message with attachment',
    attachments: [
      {
        id: attachmentId,
        filename: 'test.txt',
        contentType: 'text/plain',
        byteSize: 4,
        sha256: 'abc',
      },
    ],
  }
  await Outbox.enqueue({
    peerInstanceId,
    toAddress: `amtp://${peerInstanceId}/receiver`,
    envelope,
    idempotencyKey: crypto.randomUUID(),
  })
}

/** Build headers for a signed GET as `peer`. */
function signedGetHeaders(path: string, keys: { privateKeyPem: string }, instanceId: string) {
  const ts = Date.now()
  const canonical = canonicalPeerGetString('GET', path, ts)
  const sig = signEnvelope(keys.privateKeyPem, new TextEncoder().encode(canonical))
  return {
    'x-amtp-instance': instanceId,
    'x-amtp-signature': sig,
    'x-amtp-timestamp': String(ts),
  }
}

// --- tests ---

describe('GET /api/amtp/attachments/:id', () => {
  test('authorized pull → 200, bytes match, correct headers', async () => {
    const { att, bytes } = await seedAttachment('hello attachment')
    await authorizeAttachmentForPeer(peerBInstanceId, att.id)

    const path = `/api/amtp/attachments/${att.id}`
    const res = await app.request(path, {
      method: 'GET',
      headers: signedGetHeaders(path, peerBKeys, peerBInstanceId),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(att.contentType)
    expect(res.headers.get('content-length')).toBe(String(att.byteSize))

    const body = await res.arrayBuffer()
    expect(new Uint8Array(body)).toEqual(new Uint8Array(bytes))
  })

  test('same attachment but no outbox row to peer B → 404', async () => {
    const { att } = await seedAttachment()
    // No outbox row → hasOutboundAttachmentForPeer returns false

    const path = `/api/amtp/attachments/${att.id}`
    const res = await app.request(path, {
      method: 'GET',
      headers: signedGetHeaders(path, peerBKeys, peerBInstanceId),
    })

    expect(res.status).toBe(404)
  })

  test('random/unknown attachment id (no outbox row) → 404', async () => {
    const fakeId = crypto.randomUUID()
    const path = `/api/amtp/attachments/${fakeId}`
    const res = await app.request(path, {
      method: 'GET',
      headers: signedGetHeaders(path, peerBKeys, peerBInstanceId),
    })

    expect(res.status).toBe(404)
  })

  test('missing signature headers → 401 (requirePeerSignatureGet rejects)', async () => {
    const { att } = await seedAttachment()
    await authorizeAttachmentForPeer(peerBInstanceId, att.id)

    const path = `/api/amtp/attachments/${att.id}`
    const res = await app.request(path, {
      method: 'GET',
      // No auth headers
    })

    expect(res.status).toBe(401)
  })

  test('200 is not rewritten to 500 — authzChecked is set by requirePeerSignatureGet', async () => {
    const { att } = await seedAttachment()
    await authorizeAttachmentForPeer(peerBInstanceId, att.id)

    const path = `/api/amtp/attachments/${att.id}`
    const res = await app.request(path, {
      method: 'GET',
      headers: signedGetHeaders(path, peerBKeys, peerBInstanceId),
    })

    // If authzChecked was NOT set, the authzSentinel would rewrite 200 to 500.
    expect(res.status).toBe(200)
    // Confirm it's definitely not a sentinel error
    if (res.status === 500) {
      const body = await res.json().catch(() => null)
      expect(body?.error).not.toBe('Authorization check missing')
    }
  })
})
