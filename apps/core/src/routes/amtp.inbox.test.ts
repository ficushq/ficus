import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, peers, agents, agentTypes, inbox, executions, amtpReceived, amtpKnownKeys } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter, __setKeyFetchImpl } from './amtp'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { Peer } from '../entities/Peer'
import { Execution } from '../entities/Execution'
import { AmtpAllowRule } from '../entities/AmtpAllowRule'
import { AmtpKnownKey } from '../entities/AmtpKnownKey'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'
import { formatAmtpAddress } from '../services/amtp/address'
import { canonicalAgentSigBytes } from '@ficus/shared'
import { ensureAgentIdentity, agentIdentityHostPath } from '../services/amtp/agent-identity'
import { rmSync } from 'fs'
import { dirname } from 'path'
import type { AmtpEnvelope } from '@ficus/shared'

// Sentinel discipline: mount identityMiddleware + authzSentinel exactly as the real app does,
// so the cookieless/token-less peer request must clear the sentinel via requirePeerSignature's
// authzChecked=true (NOT publicRoute), and signature/validation rejects survive as 4xx.
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const peerKeys = generateInstanceKeyPair()
const peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
const handle = `${prefix}-bob`
const agentTypeId = `${prefix}-type`

// Set in beforeEach from InstanceIdentity.getPublic() so envelope.to uses the real instanceId
// (required after the to.instanceId integrity check in the receive handler — Issue 3).
let localInstanceId: string
let agent: Agent

beforeEach(async () => {
  ;({ instanceId: localInstanceId } = await InstanceIdentity.getPublic())
  await db.delete(peers)
  await db.delete(amtpReceived)
  await AgentType.create({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Fed Inbox Type',
    systemPrompt: 'You are a test agent.',
  })
  agent = await Agent.create({ agentTypeId, metadata: { name: 'Bob' } })
  await ensureAgentIdentity(agent, `agent_${agent.id}`)
  // amtpHandle is set directly (column added in Task 6); avoids coupling to Agent.create input.
  await db.update(agents).set({ amtpHandle: handle }).where(eq(agents.id, agent.id))
  await Peer.create({
    localAlias: `${prefix}-peer`,
    instanceId: peerInstanceId,
    baseUrl: 'https://peer.example/api',
    publicKeyPem: peerKeys.publicKeyPem,
  })
})

afterEach(async () => {
  // Reset the key-fetch seam after each test so it does not leak into subsequent tests.
  __setKeyFetchImpl((await import('../services/amtp/peer-key-fetch')).fetchPeerAgentKey)
  await db.delete(executions).where(eq(executions.agentId, agent.id))
  await db.delete(inbox).where(eq(inbox.recipientId, agent.id))
  await db.delete(amtpReceived)
  await db.delete(amtpKnownKeys)
  rmSync(dirname(dirname(agentIdentityHostPath(`agent_${agent.id}`))), { recursive: true, force: true })
  await db.delete(agents).where(eq(agents.agentTypeId, agentTypeId))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  await db.delete(peers)
})

afterAll(async () => {
  await db.delete(peers)
})

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

// Signed-request helper: signs the EXACT serialized body bytes the receiver verifies.
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

describe('POST /api/amtp/inbox', () => {
  test('signed envelope from an allowed sender creates a remote inbox row and wakes the agent', async () => {
    await allowAlice()
    const env = makeEnvelope({ subject: 'hi', content: 'remote work please' })

    const res = await signedRequest(env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: true })

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.senderType).toBe('remote')
    expect(row.senderId).toBe(env.from)
    expect(row.deliveryMode).toBe('follow-up')
    const meta = row.metadata as Record<string, any>
    expect(meta.remote).toMatchObject({
      peerInstanceId,
      fromAddress: env.from,
      fromHandle: 'alice',
      envelopeId: env.id,
      agentSigVerified: false,
    })
    expect(meta.sender).toEqual({ name: 'alice' })

    // Wake the bound agent: an execution is queued for the recipient.
    await new Promise((r) => setTimeout(r, 100))
    const execs = await Execution.list({ agentId: agent.id })
    expect(execs.length).toBe(1)
    expect(execs[0].message).toContain('remote work please')
  })

  test('replayed envelope (same id) is idempotent — second POST is a 200 duplicate with no new row', async () => {
    await allowAlice()
    const env = makeEnvelope()

    const first = await signedRequest(env)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ accepted: true })

    const second = await signedRequest(env)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ accepted: true, duplicate: true })

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
  })

  test('disallowed sender is rejected 403 (default-deny) and writes no inbox row', async () => {
    // No allow rule created.
    const res = await signedRequest(makeEnvelope())
    expect(res.status).toBe(403)
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(0)
  })

  test('stale timestamp is rejected 400', async () => {
    await allowAlice()
    const res = await signedRequest(makeEnvelope({ ts: Date.now() - 400_000 }))
    expect(res.status).toBe(400)
  })

  test('unknown recipient handle is rejected 404', async () => {
    await allowAlice()
    const env = makeEnvelope({ to: formatAmtpAddress(localInstanceId, `${prefix}-nobody`) })
    const res = await signedRequest(env)
    expect(res.status).toBe(404)
  })

  test('bad signature is rejected 401 by requirePeerSignature (sentinel preserves the 4xx)', async () => {
    await allowAlice()
    const env = makeEnvelope()
    const res = await signedRequest(env, {
      sig: signEnvelope(generateInstanceKeyPair().privateKeyPem, new TextEncoder().encode(JSON.stringify(env))),
    })
    expect(res.status).toBe(401)
  })

  test('from-instance mismatch (envelope.from claims a different instanceId than verified peer) is rejected 400', async () => {
    await allowAlice()
    // Envelope claims it's from a *different* instance than the signing key used
    const otherInstanceId = 'other-instance-0000000000000000000000000000'
    const env = makeEnvelope({ from: formatAmtpAddress(otherInstanceId, 'alice') })
    // Sign with the registered peer's key (peerInstanceId), but from claims otherInstanceId
    const res = await signedRequest(env)
    expect(res.status).toBe(400)
    // From-mismatch must not consume a dedup slot
    const receivedRows = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(receivedRows).toHaveLength(0)
  })

  test('rejected-before-dedup (no allow rule) does not poison the dedup slot — same envelope delivers after allow rule added', async () => {
    // No allow rule created.
    const env = makeEnvelope()

    // First POST: rejected 403 — no amtp_received row consumed
    const res1 = await signedRequest(env)
    expect(res1.status).toBe(403)
    const receivedRows1 = await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))
    expect(receivedRows1).toHaveLength(0)

    // Add the allow rule after the fact
    await allowAlice()

    // Second POST: same envelope id — must deliver (not treated as duplicate)
    const res2 = await signedRequest(env)
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2).toEqual({ accepted: true })
    expect(body2).not.toHaveProperty('duplicate')

    // Inbox row was created on the second attempt
    const inboxRows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(inboxRows).toHaveLength(1)
  })

  test('inboundOpen=true allows receive without an explicit allow rule (Issue 1)', async () => {
    // No allow rule — but inboundOpen gate should accept any sender from any known peer.
    await db.update(agents).set({ inboundOpen: true }).where(eq(agents.id, agent.id))
    const res = await signedRequest(makeEnvelope())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: true })
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
  })

  test('inboundOpen=false with no allow rule still rejects (inboundOpen must actually gate)', async () => {
    // Verify inboundOpen=false (the default) does not bypass the deny gate.
    await db.update(agents).set({ inboundOpen: false }).where(eq(agents.id, agent.id))
    const res = await signedRequest(makeEnvelope())
    expect(res.status).toBe(403)
  })

  test('to.instanceId mismatch is rejected 404 (Issue 3 — integrity check)', async () => {
    await allowAlice()
    const foreignInstanceId = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    const env = makeEnvelope({ to: formatAmtpAddress(foreignInstanceId, handle) })
    const res = await signedRequest(env)
    expect(res.status).toBe(404)
  })

  test('agentSig with matching key sets agentSigVerified=true in metadata (Issue 2)', async () => {
    await allowAlice()
    const agentKeys = generateInstanceKeyPair()
    // Mock the peer key-fetch so first-contact pinning returns the agent's public key.
    __setKeyFetchImpl(async () => ({
      handle: 'alice',
      instanceId: peerInstanceId,
      identityPublicKey: agentKeys.publicKeyPem,
    }))
    const envBase = makeEnvelope({ agentKey: agentKeys.publicKeyPem })
    // Sign the canonical subset with the agent's private key.
    const sigBytes = canonicalAgentSigBytes({
      v: envBase.v,
      id: envBase.id,
      from: envBase.from,
      to: envBase.to,
      subject: envBase.subject,
      content: envBase.content,
      attachments: envBase.attachments ?? [],
    })
    const agentSig = signEnvelope(agentKeys.privateKeyPem, sigBytes)
    const env = { ...envBase, agentSig }

    const res = await signedRequest(env)
    expect(res.status).toBe(200)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
    const meta = rows[0].metadata as Record<string, any>
    expect(meta.remote.agentSigVerified).toBe(true)
  })

  test('key endpoint unreachable on first contact fails CLOSED (retryable 502, no delivery, slot free)', async () => {
    await allowAlice()
    const agentKeys = generateInstanceKeyPair()
    // Simulate peer key endpoint down: throw on first-contact fetch.
    __setKeyFetchImpl(async () => {
      throw new Error('connection refused')
    })
    // A VALID agentSig is present — the rejection is solely because we cannot fetch the sender's
    // published key to verify authorship, so we must not deliver it unverified.
    const env = makeEnvelope({ agentKey: agentKeys.publicKeyPem })
    env.agentSig = signEnvelope(
      agentKeys.privateKeyPem,
      canonicalAgentSigBytes({
        v: 1,
        id: env.id,
        from: env.from,
        to: env.to,
        subject: env.subject,
        content: env.content,
        attachments: [],
      })
    )

    const res = await signedRequest(env)
    // Fail closed with a retryable 502 — failing open would let anyone who can disrupt/time the
    // peer key endpoint force an unverified first message in.
    expect(res.status).toBe(502)

    // Nothing delivered, no pin recorded, and the dedup slot is NOT consumed, so the sender's
    // outbox retry (>=500 is retryable) succeeds cleanly once the key endpoint recovers.
    expect((await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))).length).toBe(0)
    expect(await AmtpKnownKey.getPin(peerInstanceId, 'alice')).toBeNull()
    expect((await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))).length).toBe(0)
  })

  test('agentSig with wrong key sets agentSigVerified=false (tampered key scenario)', async () => {
    await allowAlice()
    const agentKeys = generateInstanceKeyPair()
    const wrongKeys = generateInstanceKeyPair()
    // Mock the peer key-fetch to return the CLAIMED key (agentKeys); the sig is signed with wrongKeys.
    __setKeyFetchImpl(async () => ({
      handle: 'alice',
      instanceId: peerInstanceId,
      identityPublicKey: agentKeys.publicKeyPem,
    }))
    const envBase = makeEnvelope({ agentKey: agentKeys.publicKeyPem })
    // Sign with the WRONG key — the pinned key won't verify this.
    const sigBytes = canonicalAgentSigBytes({
      v: envBase.v,
      id: envBase.id,
      from: envBase.from,
      to: envBase.to,
      subject: envBase.subject,
      content: envBase.content,
      attachments: envBase.attachments ?? [],
    })
    const agentSig = signEnvelope(wrongKeys.privateKeyPem, sigBytes)
    const env = { ...envBase, agentSig }

    const res = await signedRequest(env)
    // Message still delivers (agentSig is advisory, not a gate)
    expect(res.status).toBe(200)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(rows).toHaveLength(1)
    const meta = rows[0].metadata as Record<string, any>
    expect(meta.remote.agentSigVerified).toBe(false)
  })
})
