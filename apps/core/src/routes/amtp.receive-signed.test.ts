import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { generateKeyPairSync } from 'crypto'
import { rmSync } from 'fs'
import { dirname } from 'path'
import { eq } from 'drizzle-orm'
import { db, peers, agents, agentTypes, inbox, executions, amtpReceived, amtpKnownKeys } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter, __setKeyFetchImpl } from './amtp'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { Peer } from '../entities/Peer'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { AmtpKnownKey } from '../entities/AmtpKnownKey'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'
import { formatAmtpAddress, canonicalAgentSigBytes } from '@ficus/shared'
import { ensureAgentIdentity, agentIdentityHostPath } from '../services/amtp/agent-identity'
import type { AmtpEnvelope } from '@ficus/shared'

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `recv-signed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const peerKeys = generateInstanceKeyPair()
const peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
const agentKeys = generateInstanceKeyPair() // the remote AGENT's identity key (alice)
const agentTypeId = `${prefix}-type`
const handle = `${prefix}-bob`
let localInstanceId: string
let agent: Agent

beforeEach(async () => {
  await db.delete(peers)
  await db.delete(amtpReceived)
  await db.delete(amtpKnownKeys)
  ;({ instanceId: localInstanceId } = await InstanceIdentity.getPublic())
  await AgentType.create({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Recv Type',
    systemPrompt: 'test',
  })
  agent = await Agent.create({ agentTypeId, metadata: { name: 'Bob' } })
  await ensureAgentIdentity(agent, `agent_${agent.id}`)
  rmSync(agentIdentityHostPath(`agent_${agent.id}`), { force: true })
  await db.update(agents).set({ amtpHandle: handle, inboundOpen: true }).where(eq(agents.id, agent.id))
  await Peer.create({
    localAlias: `${prefix}-peer`,
    instanceId: peerInstanceId,
    baseUrl: 'https://peer.example/api',
    publicKeyPem: peerKeys.publicKeyPem,
  })
  __setKeyFetchImpl(async () => ({
    handle: 'alice',
    instanceId: peerInstanceId,
    identityPublicKey: agentKeys.publicKeyPem,
  }))
})

afterEach(async () => {
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

function makeSignedEnvelope(): AmtpEnvelope {
  const id = crypto.randomUUID()
  const from = formatAmtpAddress(peerInstanceId, 'alice')
  const to = formatAmtpAddress(localInstanceId, handle)
  const content = 'signed remote hello'
  const subject = 'hi'
  const agentSig = signEnvelope(
    agentKeys.privateKeyPem,
    canonicalAgentSigBytes({ v: 1, id, from, to, subject, content, attachments: [] })
  )
  return { v: 1, id, ts: Date.now(), from, to, subject, content, agentKey: agentKeys.publicKeyPem, agentSig }
}

function post(env: AmtpEnvelope) {
  const body = JSON.stringify(env)
  const sig = signEnvelope(peerKeys.privateKeyPem, new TextEncoder().encode(body))
  return app.request('/api/amtp/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amtp-instance': peerInstanceId, 'x-amtp-signature': sig },
    body,
  })
}

describe('POST /api/amtp/inbox — signed receive', () => {
  test.each([
    ['null', null],
    ['malformed', 'not-a-public-key'],
    [
      'non-Ed25519',
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string,
    ],
  ])('rejects inbound delivery before receive policy for a %s recipient identity', async (_case, identityPublicKey) => {
    await agent.update({ identityPublicKey })
    const env = makeSignedEnvelope()
    const res = await post(env)
    expect(res.status).toBe(404)
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))).toHaveLength(0)
    expect(await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))).toHaveLength(0)
  })

  test('first contact pins the sender key and marks agentSigVerified true', async () => {
    const env = makeSignedEnvelope()
    const res = await post(env)
    expect(res.status).toBe(200)
    expect(await AmtpKnownKey.getPin(peerInstanceId, 'alice')).toBe(agentKeys.publicKeyPem)
    const [row] = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect((row.metadata as any).remote.agentSigVerified).toBe(true)
  })

  test('a key differing from the pin is rejected 403 (no new row)', async () => {
    const env = makeSignedEnvelope()
    await AmtpKnownKey.recordPinIfNew(peerInstanceId, 'alice', generateInstanceKeyPair().publicKeyPem)
    const res = await post(env)
    expect(res.status).toBe(403)
    expect((await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))).length).toBe(0)
    // Dedup slot must NOT be consumed by a rejected (pin-mismatch) envelope.
    expect((await db.select().from(amtpReceived).where(eq(amtpReceived.envelopeId, env.id))).length).toBe(0)
  })

  test('a tampered body with a matching pin delivers advisory agentSigVerified=false', async () => {
    const env = makeSignedEnvelope()
    env.content = 'TAMPERED AFTER SIGNING'
    const res = await post(env)
    expect(res.status).toBe(200)
    const [row] = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect((row.metadata as any).remote.agentSigVerified).toBe(false)
  })

  test('a signature lifted onto a new envelope id does not verify (agentSig bound to id)', async () => {
    // Attacker captures a signed envelope and gives it a fresh id (to dodge the replay ledger)
    // but cannot re-sign agentSig (no private key). The peer relays it, so the INSTANCE sig is
    // valid and the key pins on first contact — but agentSig is bound to the OLD id, so authorship
    // must come back false rather than riding along as verified.
    const env = makeSignedEnvelope()
    const lifted = { ...env, id: crypto.randomUUID() }
    const res = await post(lifted) // post() re-signs only the instance sig over the new body
    expect(res.status).toBe(200)
    const [row] = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect((row.metadata as any).remote.envelopeId).toBe(lifted.id)
    expect((row.metadata as any).remote.agentSigVerified).toBe(false)
  })

  test('wrong recipient instance id is rejected 404', async () => {
    const env = makeSignedEnvelope()
    env.to = formatAmtpAddress('some-other-instance-id', handle)
    // re-sign the agentSig over the new `to` so the failure is the instance check, not the sig
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
    const res = await post(env)
    expect(res.status).toBe(404)
  })

  test('replay of the same id is deduped 200', async () => {
    const env = makeSignedEnvelope()
    expect((await post(env)).status).toBe(200)
    const second = await post(env)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ accepted: true, duplicate: true })
  })
})
