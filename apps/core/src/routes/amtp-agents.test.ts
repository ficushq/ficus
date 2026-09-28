import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Hono } from 'hono'
import { generateInstanceKeyPair, signAgentCard } from 'amtp-protocol'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import { db, agents, squads } from '../db'
import { Agent } from '../entities/Agent'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { hasPermission } from '../services/rbac'
import { agentIdentityHostPath, ensureAgentIdentity } from '../services/amtp/agent-identity'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestUser,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-agents-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let plainUser: TestUser
let squadId: string
let instanceId: string
const createdAgentIds: string[] = []

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

afterEach(async () => {
  for (const id of createdAgentIds.splice(0)) {
    rmSync(dirname(dirname(agentIdentityHostPath(`agent_${id}`))), { recursive: true, force: true })
    await db.delete(agents).where(eq(agents.id, id))
  }
})

async function makeAgent(opts: { ownerUserId?: string; provisionIdentity?: boolean; agentTypeId?: string } = {}) {
  // ownerUserId goes on the AGENT ROW: since #1223, agent permission resolution
  // reads the root agent's ownerUserId (resolveAgentAuthority), not the token's
  // userId — a user-backed token on an ownerless agent row grants nothing.
  const agent = await Agent.create({
    agentTypeId: opts.agentTypeId ?? 'manager',
    squadId,
    ownerUserId: opts.ownerUserId ?? null,
    context: {},
  })
  createdAgentIds.push(agent.id)
  let keys: ReturnType<typeof generateInstanceKeyPair> | undefined
  if (opts.provisionIdentity !== false) {
    keys = generateInstanceKeyPair()
    const keyPath = agentIdentityHostPath(`agent_${agent.id}`)
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, keys.privateKeyPem, { mode: 0o600 })
    await ensureAgentIdentity(agent, `agent_${agent.id}`)
  }
  const token = await createTestAgentToken({ agentId: agent.id, squadId, userId: opts.ownerUserId })
  return { agent, token: token.token, keys }
}

describe('agent-federation routes', () => {
  test('self register returns the full amtp:// address + identityPublicKey', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-self`
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, agentKey: 'CLIENT-KEY-IGNORED' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      handle,
      address: `amtp://${instanceId}/${handle}`,
      identityPublicKey: agent.identityPublicKey,
    })
    // Client key is ignored (the recorded key is unchanged).
    expect((await Agent.mustFind(agent.id)).identityPublicKey).toBe(agent.identityPublicKey)
  })

  test('"me" resolves to the calling agent for register + status (FICUS_TOKEN identity)', async () => {
    // The in-sandbox CLI has only FICUS_TOKEN (no agent id in the URL); the server resolves
    // the literal "me" segment to identity.agentId.
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-me`
    const reg = await app.request('/api/amtp/agents/me/register', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    expect(reg.status).toBe(200)
    expect((await reg.json()).address).toBe(`amtp://${instanceId}/${handle}`)
    // It resolved to THIS agent, not some agent literally named "me".
    expect((await Agent.mustFind(agent.id)).amtpHandle).toBe(handle)

    const status = await app.request('/api/amtp/agents/me/status', { headers: authHeaders(token) })
    expect(status.status).toBe(200)
    expect((await status.json()).handle).toBe(handle)
  })

  test('register is idempotent for the same agent + handle', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-idem`
    const body = { handle }
    const headers = { ...authHeaders(token), 'Content-Type': 'application/json' }
    expect(
      (
        await app.request(`/api/amtp/agents/${agent.id}/register`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      ).status
    ).toBe(200)
    const second = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    expect(second.status).toBe(200)
    expect((await second.json()).handle).toBe(handle)
  })

  test('keyless register returns typed 409 without mutating the handle', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id, provisionIdentity: false })
    const legacyCard: AmtpSignedAgentCard = {
      v: 1,
      instanceId: 'i',
      handle: 'old',
      card: { name: 'Old' },
      cardSig: 'sig',
    }
    await agent.update({ cardJson: legacyCard })
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `${prefix}-keyless` }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'AMTP_SIGNING_IDENTITY_UNAVAILABLE',
      signingIdentity: { reason: 'missing_public_key' },
    })
    const unchanged = await Agent.mustFind(agent.id)
    expect(unchanged.amtpHandle).toBeNull()
    expect(unchanged.cardJson).toEqual(legacyCard)
  })

  test('shared system-manager registration is unsupported even with a recorded key', async () => {
    const { agent, token } = await makeAgent({
      ownerUserId: admin.id,
      provisionIdentity: false,
      agentTypeId: 'system-manager',
    })
    await agent.update({ identityPublicKey: generateInstanceKeyPair().publicKeyPem })
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `${prefix}-shared` }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'AMTP_SIGNING_IDENTITY_UNSUPPORTED',
      signingIdentity: { reason: 'shared_system_manager_custody' },
    })
  })

  test('historical keyless registration remains visible but cannot open', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id, provisionIdentity: false })
    const handle = `${prefix}-historical`
    await agent.update({ amtpHandle: handle, inboundOpen: true })
    const opened = await app.request(`/api/amtp/agents/${agent.id}/open`, {
      method: 'POST',
      headers: authHeaders(token),
    })
    expect(opened.status).toBe(409)
    const status = await app.request(`/api/amtp/agents/${agent.id}/status`, { headers: authHeaders(token) })
    expect(await status.json()).toMatchObject({
      handle,
      registered: true,
      federationReady: false,
      inboundOpen: false,
      allowsInbound: false,
    })
  })

  test('same-handle register is rejected after custody becomes unavailable', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-lost`
    await agent.update({ amtpHandle: handle, inboundOpen: true })
    rmSync(agentIdentityHostPath(`agent_${agent.id}`), { force: true })
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('AMTP_SIGNING_IDENTITY_UNAVAILABLE')
    expect((await Agent.mustFind(agent.id)).amtpHandle).toBe(handle)
    const status = await app.request(`/api/amtp/agents/${agent.id}/status`, { headers: authHeaders(token) })
    expect(await status.json()).toMatchObject({ federationReady: false, inboundOpen: true, allowsInbound: true })
  })

  test('open returns a typed conflict when unregistered', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const res = await app.request(`/api/amtp/agents/${agent.id}/open`, { method: 'POST', headers: authHeaders(token) })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'AMTP_AGENT_NOT_REGISTERED' })
  })

  test('close and revoke remain available for historical keyless rows', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id, provisionIdentity: false })
    await agent.update({ amtpHandle: `${prefix}-reduce`, inboundOpen: true })
    expect(
      (await app.request(`/api/amtp/agents/${agent.id}/close`, { method: 'POST', headers: authHeaders(token) })).status
    ).toBe(200)
    expect(
      (await app.request(`/api/amtp/agents/${agent.id}/register`, { method: 'DELETE', headers: authHeaders(token) }))
        .status
    ).toBe(200)
    expect(await Agent.mustFind(agent.id)).toMatchObject({ amtpHandle: null, inboundOpen: false })
  })

  test('duplicate handle across agents returns 409', async () => {
    const handle = `${prefix}-dup`
    const a = await makeAgent({ ownerUserId: admin.id })
    await app.request(`/api/amtp/agents/${a.agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(a.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    const b = await makeAgent({ ownerUserId: admin.id })
    const res = await app.request(`/api/amtp/agents/${b.agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(b.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    expect(res.status).toBe(409)
  })

  test('a plain-user (no amtp:write) operator is forbidden from registering another agent', async () => {
    const { agent } = await makeAgent({ ownerUserId: admin.id })
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(plainUser.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `${prefix}-x` }),
    })
    expect(res.status).toBe(403)
  })

  test('open/close toggles inboundOpen', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `${prefix}-oc` }),
    })
    const opened = await app.request(`/api/amtp/agents/${agent.id}/open`, {
      method: 'POST',
      headers: authHeaders(token),
    })
    expect((await opened.json()).inboundOpen).toBe(true)
    expect((await Agent.mustFind(agent.id)).inboundOpen).toBe(true)
    const closed = await app.request(`/api/amtp/agents/${agent.id}/close`, {
      method: 'POST',
      headers: authHeaders(token),
    })
    expect((await closed.json()).inboundOpen).toBe(false)
  })

  test('status reports handle, registered, inboundOpen, allowsInbound, allowRules', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-status`
    await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    await app.request(`/api/amtp/agents/${agent.id}/open`, { method: 'POST', headers: authHeaders(token) })
    const res = await app.request(`/api/amtp/agents/${agent.id}/status`, { headers: authHeaders(admin.token) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ handle, registered: true, inboundOpen: true, allowsInbound: true })
    expect(Array.isArray(body.allowRules)).toBe(true)
  })

  test('DELETE register unpublishes (handle null, inboundOpen false)', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `${prefix}-del` }),
    })
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'DELETE',
      headers: authHeaders(token),
    })
    expect(res.status).toBe(200)
    const reloaded = await Agent.mustFind(agent.id)
    expect(reloaded.amtpHandle).toBeNull()
    expect(reloaded.inboundOpen).toBe(false)
  })

  test('self-DELETE succeeds without amtp:register scope (no userId on token)', async () => {
    // Regression for: DELETE previously required isSelf AND amtp:register.
    // Spec says "self OR amtp:write" — a self-caller needs no extra scope.
    //
    // Register using the admin token (has amtp:write). Then try to unregister
    // with a token for an agent that has NO owning user — permissions resolve
    // from the agent-type role only. A WORKER-type agent specifically: the
    // default-worker role never carries amtp:register (config/roles/defaults.yaml),
    // so the precondition below holds whether or not an earlier test file left
    // the YAML role sync'd (default-MANAGER does include amtp:register).
    // Under the old guard this would 403; under the fixed guard
    // (isSelf OR amtp:write) it must 200.
    const { agent } = await makeAgent({ agentTypeId: 'engineer' })
    await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `${prefix}-self-del` }),
    })
    // A pure agent token — no backing user, so identity.userId is undefined.
    const { token: selfTokenNoUser } = await createTestAgentToken({ agentId: agent.id, squadId })
    // Precondition: confirm this token does NOT grant amtp:register (it's a no-userId agent
    // token; permissions come from the agent-type role which does not include amtp:register).
    // If this assertion ever fails, the regression test becomes vacuous (it passes under both the
    // old and new guards), so we keep it pinned here.
    const agentIdentity = { type: 'agent' as const, agentId: agent.id, squadId }
    expect(await hasPermission(agentIdentity, 'amtp:register', squadId)).toBe(false)
    const res = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'DELETE',
      headers: authHeaders(selfTokenNoUser),
    })
    expect(res.status).toBe(200)
    const reloaded = await Agent.mustFind(agent.id)
    expect(reloaded.amtpHandle).toBeNull()
    expect(reloaded.inboundOpen).toBe(false)
  })

  test('public key endpoint returns handle + instanceId + identityPublicKey', async () => {
    const { agent, token } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-keyep`
    await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    const res = await app.request(`/api/amtp/agents/${handle}/key`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handle, instanceId, identityPublicKey: agent.identityPublicKey })
  })

  test('public key endpoint 404s for an unknown handle', async () => {
    expect((await app.request(`/api/amtp/agents/${prefix}-nobody/key`)).status).toBe(404)
  })
})

describe('agent card routes', () => {
  async function registerWithKey(handleSuffix: string) {
    const { agent, token, keys } = await makeAgent({ ownerUserId: admin.id })
    const handle = `${prefix}-${handleSuffix}`
    const reg = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    expect(reg.status).toBe(200)
    return { agent, token, handle, keys: keys! }
  }

  function buildSignedCard(
    keys: { privateKeyPem: string },
    overrides: Partial<{ instanceId: string; handle: string; card: Record<string, unknown> }> = {},
    handle: string
  ): AmtpSignedAgentCard {
    const sansSig = {
      v: 1 as const,
      instanceId: overrides.instanceId ?? instanceId,
      handle: overrides.handle ?? handle,
      card: overrides.card ?? { name: 'A' },
    }
    const cardSig = signAgentCard(keys.privateKeyPem, sansSig)
    return { ...sansSig, cardSig }
  }

  test('PUT card happy path: publish, public GET returns it verbatim, status reflects it', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-happy')
    const signed = buildSignedCard(keys, {}, handle)

    const put = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ok: true, card: signed.card })

    const getCard = await app.request(`/api/amtp/agents/${handle}/card`)
    expect(getCard.status).toBe(200)
    expect(await getCard.json()).toEqual(signed)

    const status = await app.request(`/api/amtp/agents/${agent.id}/status`, { headers: authHeaders(token) })
    expect(status.status).toBe(200)
    expect((await status.json()).card).toEqual(signed)
  })

  test('PUT card rejects a handle that does not match the registered handle (400)', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-wrong-handle')
    const signed = buildSignedCard(keys, { handle: `${handle}-other` }, handle)
    const res = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(res.status).toBe(400)
  })

  test('PUT card rejects an instanceId that does not match this instance (400)', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-wrong-instance')
    const signed = buildSignedCard(keys, { instanceId: 'some-other-instance-id' }, handle)
    const res = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(res.status).toBe(400)
  })

  test('PUT card rejects a bad signature — signed with a different key (400)', async () => {
    const { agent, token, handle } = await registerWithKey('card-bad-sig')
    const otherKeys = generateInstanceKeyPair()
    const signed = buildSignedCard(otherKeys, {}, handle)
    const res = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(res.status).toBe(400)
  })

  test('PUT card on an unregistered agent returns 409', async () => {
    const { agent, token, keys } = await makeAgent({ ownerUserId: admin.id })
    const signed = buildSignedCard(keys!, {}, `${prefix}-never-registered`)
    const res = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(res.status).toBe(409)
  })

  test('PUT card rejects an oversized card (413)', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-oversized')
    const signed = buildSignedCard(keys, { card: { name: 'A', extensions: { blob: 'x'.repeat(20000) } } }, handle)
    const res = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(res.status).toBe(413)
  })

  test('DELETE /agents/:id/register clears the card (subsequent GET card 404s)', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-del-register')
    const signed = buildSignedCard(keys, {}, handle)
    await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect((await app.request(`/api/amtp/agents/${handle}/card`)).status).toBe(200)

    const del = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'DELETE',
      headers: authHeaders(token),
    })
    expect(del.status).toBe(200)
    expect((await Agent.mustFind(agent.id)).cardJson).toBeNull()

    expect((await app.request(`/api/amtp/agents/${handle}/card`)).status).toBe(404)
  })

  test('POST register with a DIFFERENT handle clears the stored card (subsequent GET card 404s)', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-rehandle-a')
    const signed = buildSignedCard(keys, {}, handle)
    await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect((await app.request(`/api/amtp/agents/${handle}/card`)).status).toBe(200)

    const newHandle = `${prefix}-card-rehandle-b`
    const reg = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: newHandle }),
    })
    expect(reg.status).toBe(200)

    expect((await Agent.mustFind(agent.id)).cardJson).toBeNull()
    expect((await app.request(`/api/amtp/agents/${newHandle}/card`)).status).toBe(404)
  })

  test('idempotent POST register with the SAME handle does NOT clear an existing card', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-rehandle-same')
    const signed = buildSignedCard(keys, {}, handle)
    await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect((await app.request(`/api/amtp/agents/${handle}/card`)).status).toBe(200)

    const reg = await app.request(`/api/amtp/agents/${agent.id}/register`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
    expect(reg.status).toBe(200)

    expect((await Agent.mustFind(agent.id)).cardJson).not.toBeNull()
    expect((await app.request(`/api/amtp/agents/${handle}/card`)).status).toBe(200)
  })

  test('public GET /agents/:handle/card requires no auth', async () => {
    const { agent, token, handle, keys } = await registerWithKey('card-public')
    const signed = buildSignedCard(keys, {}, handle)
    const put = await app.request(`/api/amtp/agents/${agent.id}/card`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    expect(put.status).toBe(200)

    // No Authorization header at all.
    const res = await app.request(`/api/amtp/agents/${handle}/card`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(signed)

    // Unknown handle also requires no auth — mirrors the public /key 404 test.
    expect((await app.request(`/api/amtp/agents/${prefix}-card-nobody/card`)).status).toBe(404)
  })
})
