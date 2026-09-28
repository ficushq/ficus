import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { db, outbox, peers, instanceIdentity, agents, inbox } from '../../db'
import { Outbox, OUTBOX_MAX_ATTEMPTS } from '../../entities/Outbox'
import { Peer } from '../../entities/Peer'
import { drainOutboxOnce } from './outbox-delivery'
import { verifyEnvelope, generateInstanceKeyPair, instanceIdFromPublicKeyPem } from './crypto'
import type { AmtpEnvelope } from '@ficus/shared'

const PEER_INSTANCE = 'peer-instance-fingerprint-00000000000000000000'
const PEER_INSTANCE_2 = 'peer-instance-fingerprint-11111111111111111111'

beforeEach(async () => {
  await db.delete(outbox)
  await db.delete(peers)
  await db.delete(instanceIdentity)
})

async function seedPeer(status = 'active'): Promise<Peer> {
  const peer = await Peer.create({
    localAlias: 'acme',
    instanceId: PEER_INSTANCE,
    baseUrl: 'https://acme.example/api',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
  })
  if (status !== peer.status) await Peer.update(peer.id, { status })
  return peer
}

function buildEnvelope(peerInstanceId = PEER_INSTANCE): AmtpEnvelope {
  return {
    v: 1,
    id: randomUUID(),
    ts: Date.now(),
    from: 'amtp://local-instance/sender',
    to: `amtp://${peerInstanceId}/receiver`,
    subject: 'hi',
    content: 'hello federation',
  }
}

async function seedPendingRow(env: AmtpEnvelope, peerInstanceId = PEER_INSTANCE): Promise<Outbox> {
  return Outbox.enqueue({
    peerInstanceId,
    toAddress: env.to,
    envelope: env,
    idempotencyKey: env.id,
  })
}

describe('drainOutboxOnce', () => {
  test('delivers a pending row: POSTs the signed envelope and marks delivered', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    // Use a known key pair so we can cryptographically verify the outgoing signature.
    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    const signerInstanceId = instanceIdFromPublicKeyPem(publicKeyPem)
    const signer = async () => ({ instanceId: signerInstanceId, privateKeyPem })

    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl, signer })

    expect(result).toEqual({ delivered: 1, failedTerminal: 0, retried: 0 })

    // Correct machine route + transport headers.
    expect(capturedUrl).toBe('https://acme.example/api/amtp/inbox')
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit!.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    // x-amtp-instance must be the exact id derived from the seeded instance's public key.
    expect(headers['x-amtp-instance']).toBe(signerInstanceId)

    // Cryptographically verify the signature over the exact bytes that were posted.
    const postedBody = capturedInit!.body as string
    expect(verifyEnvelope(publicKeyPem, new TextEncoder().encode(postedBody), headers['x-amtp-signature'])).toBe(true)

    // Body envelope: id is unchanged (dedup still works), ts is re-stamped at delivery time.
    const parsedBody = JSON.parse(postedBody)
    expect(parsedBody.id).toBe(env.id)
    expect(parsedBody.to).toBe(env.to)
    expect(parsedBody.from).toBe(env.from)
    expect(parsedBody.content).toBe(env.content)
    // ts is re-stamped at delivery time — must be recent (within 5s of this check)
    expect(parsedBody.ts).toBeGreaterThanOrEqual(Date.now() - 5000)

    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('delivered')
  })

  test('403 marks the row terminally failed (no retry)', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('failed')
    expect(reloaded.lastError).toContain('403')
  })

  test('500 response increments attempts and reschedules (markRetry)', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)
    expect(row.attempts).toBe(0)

    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
    expect(reloaded.claimToken).toBeNull()
    expect(reloaded.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
  })

  test('network error (fetch throws) increments attempts and reschedules (markRetry)', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
    expect(reloaded.lastError).toContain('ECONNREFUSED')
  })

  test('batch isolation: one failing row does not abort delivery of other rows', async () => {
    // Seed two active peers with distinct instance IDs and base URLs.
    await seedPeer('active') // PEER_INSTANCE -> acme.example
    await Peer.create({
      localAlias: 'acme2',
      instanceId: PEER_INSTANCE_2,
      baseUrl: 'https://acme2.example/api',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
    })

    // Row 1 -> PEER_INSTANCE (first peer, will throw). Row 2 -> PEER_INSTANCE_2 (succeeds).
    const env1 = buildEnvelope(PEER_INSTANCE)
    const env2 = buildEnvelope(PEER_INSTANCE_2)
    const row1 = await seedPendingRow(env1, PEER_INSTANCE)
    const row2 = await seedPendingRow(env2, PEER_INSTANCE_2)

    const fetchImpl = (async (url: string) => {
      // acme2.example is the good peer; anything else (acme.example) throws.
      if (!url.includes('acme2')) throw new Error('ECONNREFUSED peer1')
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    // One delivered (row2), one retried (row1) — the bad row never aborts the batch.
    expect(result.delivered).toBe(1)
    expect(result.retried).toBe(1)
    expect(result.failedTerminal).toBe(0)

    const [reloaded1] = await db.select().from(outbox).where(eq(outbox.id, row1.id))
    expect(reloaded1.status).toBe('pending')
    expect(reloaded1.attempts).toBe(1)
    expect(reloaded1.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())

    const [reloaded2] = await db.select().from(outbox).where(eq(outbox.id, row2.id))
    expect(reloaded2.status).toBe('delivered')
  })

  test('disabled peer: row is retried and lastError mentions peer status', async () => {
    // Peer exists in the DB but its status is 'disabled'.
    await seedPeer('disabled')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    // fetch must never be called — the delivery should short-circuit before the HTTP call.
    const fetchImpl = (async () => {
      throw new Error('fetch should not be called for a disabled peer')
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
    expect(reloaded.lastError).toContain('not active')
  })

  test('re-stamps ts on each delivery attempt (fresh ts, original id unchanged)', async () => {
    await seedPeer('active')
    // Seed a row with an OLD ts — 10 minutes ago (would be rejected by a receiver's freshness check).
    const OLD_TS = Date.now() - 10 * 60 * 1000
    const env = { ...buildEnvelope(), ts: OLD_TS }
    const row = await seedPendingRow(env)

    let capturedBody: string | undefined
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const beforeDrain = Date.now()
    await drainOutboxOnce({ fetchImpl })

    const parsed = JSON.parse(capturedBody!)
    // id must be unchanged (receiver dedup still works)
    expect(parsed.id).toBe(row.envelopeJson.id)
    // ts must be fresh — NOT the old enqueue ts
    expect(parsed.ts).not.toBe(OLD_TS)
    expect(parsed.ts).toBeGreaterThanOrEqual(beforeDrain - 1000)
    expect(parsed.ts).toBeLessThanOrEqual(Date.now() + 1000)
  })

  test('400 response marks the row terminally failed (permanent client error, not retried)', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('failed')
    expect(reloaded.lastError).toContain('400')
  })

  test('404 response marks the row terminally failed (permanent client error, not retried)', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('failed')
    expect(reloaded.lastError).toContain('404')
  })

  test('429 response is retried (transient rate-limit, not permanent)', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
  })

  test('row at OUTBOX_MAX_ATTEMPTS - 1 is dead-lettered (not retried) on a 500 response', async () => {
    await seedPeer('active')
    const env = buildEnvelope()
    const row = await seedPendingRow(env)

    // Manually set attempts to the threshold so the next failure dead-letters it.
    await db
      .update(outbox)
      .set({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })
      .where(eq(outbox.id, row.id))

    const fetchImpl = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch

    const result = await drainOutboxOnce({ fetchImpl })

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    const [reloaded] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(reloaded.status).toBe('failed')
    expect(reloaded.lastError).toContain('max delivery attempts exceeded')
  })

  test('URL join: trailing slash in baseUrl does not produce double slash', async () => {
    // Peer whose baseUrl ends with '/'; the assembled URL must still be well-formed.
    await Peer.create({
      localAlias: 'acme-slash',
      instanceId: PEER_INSTANCE,
      baseUrl: 'https://acme.example/api/',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
    })
    const env = buildEnvelope()
    await seedPendingRow(env)

    let capturedUrl: string | undefined
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    await drainOutboxOnce({ fetchImpl })
    expect(capturedUrl).toBe('https://acme.example/api/amtp/inbox')
  })
})

describe('dead-letter bounce', () => {
  const senderIds: string[] = []

  afterEach(async () => {
    for (const id of senderIds.splice(0)) {
      await db.delete(inbox).where(eq(inbox.recipientId, id))
      await db.delete(agents).where(eq(agents.id, id))
    }
  })

  async function seedSenderAgent(handle: string): Promise<string> {
    const id = randomUUID()
    senderIds.push(id)
    await db.insert(agents).values({
      id,
      agentTypeId: 'manager',
      squadId: null,
      status: 'idle',
      amtpHandle: handle,
    })
    return id
  }

  function envelopeFrom(handle: string): AmtpEnvelope {
    return { ...buildEnvelope(), from: `amtp://local-instance/${handle}` }
  }

  const signer = async () => {
    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    return { instanceId: instanceIdFromPublicKeyPem(publicKeyPem), privateKeyPem }
  }

  test('immediate 4xx dead-letter → bounce inbox message to the sending agent', async () => {
    await seedPeer('active')
    const handle = `bounce-${randomUUID().slice(0, 8)}`
    const agentId = await seedSenderAgent(handle)
    const env = envelopeFrom(handle)
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch
    const result = await drainOutboxOnce({ signer, fetchImpl })
    expect(result.failedTerminal).toBe(1)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    expect(rows.length).toBe(1)
    expect(rows[0].senderType).toBe('system')
    expect(rows[0].subject).toBe(`Federation delivery failed: ${env.to}`)
    expect(rows[0].content).toContain('HTTP 403')
    const bounce = (rows[0].metadata as { federationBounce?: Record<string, unknown> }).federationBounce
    expect(bounce).toEqual({
      outboxId: row.id,
      envelopeId: env.id,
      toAddress: env.to,
      reason: 'delivery failed: HTTP 403',
    })
  })

  test('max-attempts dead-letter → bounce; retryable failure below max → NO bounce', async () => {
    await seedPeer('active')
    const handle = `bounce-${randomUUID().slice(0, 8)}`
    const agentId = await seedSenderAgent(handle)
    const env = envelopeFrom(handle)
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('flaky', { status: 500 })) as unknown as typeof fetch

    // First failure: retryable, below max — no bounce yet.
    await drainOutboxOnce({ signer, fetchImpl })
    expect((await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).length).toBe(0)

    // Push the row to the brink and make it immediately claimable again.
    await db
      .update(outbox)
      .set({ attempts: OUTBOX_MAX_ATTEMPTS - 1, status: 'pending', nextAttemptAt: new Date(0), claimToken: null })
      .where(eq(outbox.id, row.id))

    await drainOutboxOnce({ signer, fetchImpl })
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    expect(rows.length).toBe(1)
    expect(rows[0].content).toContain('max delivery attempts exceeded')
  })

  test('sender agent gone → dead-letter succeeds, no bounce, no throw', async () => {
    await seedPeer('active')
    const env = envelopeFrom(`ghost-${randomUUID().slice(0, 8)}`) // no agent registered with this handle
    const row = await seedPendingRow(env)

    const fetchImpl = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch
    const result = await drainOutboxOnce({ signer, fetchImpl })
    expect(result.failedTerminal).toBe(1)

    const [updated] = await db.select().from(outbox).where(eq(outbox.id, row.id))
    expect(updated.status).toBe('failed')
    // Scope to this row's would-be bounce (other suites legitimately leave inbox rows).
    const bounces = await db
      .select()
      .from(inbox)
      .where(eq(inbox.subject, `Federation delivery failed: ${env.to}`))
    expect(bounces.length).toBe(0)
  })
})
