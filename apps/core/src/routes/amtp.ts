import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { Context } from 'hono'
import {
  createPeerSchema,
  updatePeerSchema,
  registerAgentSchema,
  createAmtpAllowRuleSchema,
  formatAmtpAddress,
  amtpSignedAgentCardSchema,
} from '@ficus/shared'
import { verifyAgentCard, signedCardByteSize, SIGNED_CARD_MAX_BYTES } from 'amtp-protocol'
import { requirePermission } from '../middleware/require-permission'
import { requirePeerSignature } from '../middleware/require-peer-signature'
import { requirePeerSignatureGet } from '../middleware/require-peer-signature-get'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { Peer } from '../entities/Peer'
import { Agent } from '../entities/Agent'
import { isValidFederationIdentityPublicKey } from '../entities/agent-queries'
import { AmtpAllowRule } from '../entities/AmtpAllowRule'
import { instanceIdFromPublicKeyPem } from '../services/amtp/crypto'
import { amtpEngine } from '../services/amtp/engine'
import { hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'
import { inspectAgentSigningIdentity } from '../services/amtp/agent-signing-identity'

// Re-exported from the leaf seam module (services/amtp/seams.ts) so the frozen
// route-level tests' imports of `__setPullImpl`/`__setKeyFetchImpl` from
// `'./amtp'` keep working unchanged (docs/superpowers/specs/
// 2026-07-08-amtp-engine-design.md §7.1/§7.4).
export { __setPullImpl, __setKeyFetchImpl } from '../services/amtp/seams'

/**
 * Load the target agent + identity for an /agents/:id/... route. Returns a Response
 * on 401/404 so the handler can early-return; otherwise the loaded pair. The literal
 * id segment "me" resolves to the calling agent: the in-sandbox CLI authenticates with
 * FICUS_TOKEN only (no FICUS_AGENT_ID), so the server resolves identity → identity.agentId.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a peer reference the way callers actually hold it: row id (UUID),
 * localAlias, or instanceId. The UUID guard avoids a Postgres 22P02 on
 * non-UUID refs hitting the uuid-typed primary key.
 */
async function resolvePeerRef(ref: string): Promise<Peer | null> {
  if (UUID_RE.test(ref)) {
    const byId = await Peer.findById(ref)
    if (byId) return byId
  }
  return (await Peer.findByInstanceId(ref)) ?? Peer.findByLocalAlias(ref)
}

async function loadAgentForFed(c: Context) {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  const idParam = c.req.param('id')
  const targetId = idParam === 'me' && identity.type === 'agent' ? identity.agentId : idParam
  const agent = await Agent.find(targetId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  return { agent, identity }
}

/**
 * §4.2: a recorded peer's `instanceId` MUST equal the self-certifying §4.1 derivation of
 * its `publicKeyPem`. Returns an error message on mismatch or a malformed key (derivation
 * throws), or null when the pair self-certifies.
 */
function selfCertifyingKeyMismatch(instanceId: string, publicKeyPem: string): string | null {
  try {
    if (instanceIdFromPublicKeyPem(publicKeyPem) !== instanceId) return 'instanceId does not match publicKeyPem'
    return null
  } catch {
    return 'instanceId does not match publicKeyPem'
  }
}

export const amtpRouter = new Hono()
  // Public bootstrap: exchanged out-of-band when peering. Returns only non-secret identity.
  .get('/identity', async (c) => {
    c.set('publicRoute', true)
    return c.json(await amtpEngine.getIdentity())
  })
  // Operator view of THIS instance's identity (same payload, but RBAC-gated for the admin UI).
  .get('/instance-identity', requirePermission('amtp:read'), async (c) => {
    return c.json(await amtpEngine.getIdentity())
  })
  .get('/peers', requirePermission('amtp:read'), async (c) => {
    const list = await Peer.list()
    return c.json(list.map((p) => p.toJson()))
  })
  .post('/peers', requirePermission('amtp:write'), zValidator('json', createPeerSchema), async (c) => {
    const body = c.req.valid('json')
    const mismatch = selfCertifyingKeyMismatch(body.instanceId, body.publicKeyPem)
    if (mismatch) return c.json({ error: mismatch }, 400)
    try {
      const peer = await Peer.create(body)
      return c.json(peer.toJson(), 201)
    } catch (err) {
      // Unique violation on localAlias/instanceId → 409
      if ((err as { code?: string })?.code === '23505') return c.json({ error: 'Peer already exists' }, 409)
      const msg = err instanceof Error ? err.message : 'Failed to create peer'
      return c.json({ error: msg }, 400)
    }
  })
  .patch('/peers/:id', requirePermission('amtp:write'), zValidator('json', updatePeerSchema), async (c) => {
    const patch = c.req.valid('json')
    if (patch.publicKeyPem) {
      const existing = await Peer.findById(c.req.param('id'))
      if (!existing) return c.json({ error: 'Peer not found' }, 404)
      const mismatch = selfCertifyingKeyMismatch(existing.instanceId, patch.publicKeyPem)
      if (mismatch) return c.json({ error: mismatch }, 400)
    }
    const peer = await Peer.update(c.req.param('id'), patch)
    if (!peer) return c.json({ error: 'Peer not found' }, 404)
    return c.json(peer.toJson())
  })
  .delete('/peers/:id', requirePermission('amtp:write'), async (c) => {
    const peer = await Peer.findById(c.req.param('id'))
    if (!peer) return c.json({ error: 'Peer not found' }, 404)
    await Peer.delete(peer.id)
    return c.json({ success: true })
  })
  // Local consumer proxy for peer handle discovery (parent design §6.2). Gated
  // amtp:read OR amtp:send — discovery is most useful to senders
  // (custom roles may grant send without read). The server performs the instance-signed
  // GET; agents never hold the instance key.
  .get('/peers/:ref/handles', async (c) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const agent = identity.type === 'agent' ? await Agent.find(identity.agentId) : null
    const squadId = agent?.squadId ?? undefined
    const allowed =
      (await hasPermission(identity, 'amtp:read', squadId)) || (await hasPermission(identity, 'amtp:send', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)

    const peer = await resolvePeerRef(c.req.param('ref'))
    if (!peer) return c.json({ error: 'Peer not found' }, 404)
    if (peer.status !== 'active') return c.json({ error: 'Peer not active' }, 409)

    const result = await amtpEngine.fetchPeerHandles({ peerBaseUrl: peer.baseUrl })
    if (!result.ok) {
      return c.json({ error: 'Failed to fetch handles from peer' }, 502)
    }
    return c.json({ handles: result.handles })
  })
  // Local consumer proxy for a peer agent's published card (spec §4.6 Verifying): resolves
  // :ref exactly like /peers/:ref/handles, then performs the TOFU-pinned + signature-verified
  // client-side card fetch. `ok:false` (peer unknown, network failure, binding mismatch, bad
  // signature, oversize) all fold into a single 404 — the caller learns "no verified card",
  // never the specific failure reason.
  .get('/peers/:ref/agents/:handle/card', async (c) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const agent = identity.type === 'agent' ? await Agent.find(identity.agentId) : null
    const squadId = agent?.squadId ?? undefined
    const allowed =
      (await hasPermission(identity, 'amtp:read', squadId)) || (await hasPermission(identity, 'amtp:send', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)

    const peer = await resolvePeerRef(c.req.param('ref'))
    if (!peer) return c.json({ error: 'Peer not found' }, 404)
    if (peer.status !== 'active') return c.json({ error: 'Peer not active' }, 409)

    const result = await amtpEngine.fetchPeerAgentCard({
      peerInstanceId: peer.instanceId,
      handle: c.req.param('handle'),
    })
    if (!result.ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ verified: true, card: result.card, signedCard: result.signedCard })
  })
  // Public: a peer fetches an agent's published identity key by handle (D2/D5 first contact).
  .get('/agents/:handle/key', async (c) => {
    c.set('publicRoute', true)
    const result = await amtpEngine.serveAgentKey(c.req.param('handle'))
    if (!result.found) return c.json({ error: 'Not found' }, 404)
    const { handle, instanceId, identityPublicKey } = result
    return c.json({ handle, instanceId, identityPublicKey })
  })
  // Public: a peer (or any consumer) fetches an agent's published signed card by handle
  // (spec §4.6 Serving). Mirrors /key exactly: 404 on miss, body is the signed card verbatim
  // (never re-signed or normalized).
  .get('/agents/:handle/card', async (c) => {
    c.set('publicRoute', true)
    const result = await amtpEngine.serveAgentCard(c.req.param('handle'))
    if (!result.found) return c.json({ error: 'Not found' }, 404)
    return c.json(result.signedCard)
  })

  // Peer-facing handle discovery (parent design §6.2): which handles this instance
  // publishes. Auth = instance signature over the canonical GET string (established
  // peers only) — the public /identity payload intentionally does NOT include handles.
  .get('/handles', requirePeerSignatureGet, async (c) => {
    return c.json(await amtpEngine.listHandles())
  })

  // Status (UI + agent self): self OR amtp:read/write.
  .get('/agents/:id/status', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      isSelf ||
      (await hasPermission(identity, 'amtp:read', squadId)) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)
    const allowRules = (await AmtpAllowRule.listForAgent(agent.id)).map((r) => r.toJson())
    const signingIdentity = await inspectAgentSigningIdentity(agent)
    const registered = agent.amtpHandle != null
    const durableIdentityReady = registered && isValidFederationIdentityPublicKey(agent.identityPublicKey)
    const federationReady = durableIdentityReady && signingIdentity.status === 'ready'
    const { instanceId } = await InstanceIdentity.getPublic()
    return c.json({
      handle: agent.amtpHandle,
      address: agent.amtpHandle ? formatAmtpAddress(instanceId, agent.amtpHandle) : null,
      registered,
      federationReady,
      inboundOpen: durableIdentityReady && agent.inboundOpen,
      allowsInbound: durableIdentityReady && (agent.inboundOpen || allowRules.length > 0),
      signingIdentity,
      allowRules,
      card: agent.cardJson ?? null,
      agentName: agent.metadata?.name ?? null,
      agentDescription: (agent.metadata?.description as string | undefined) ?? null,
    })
  })

  // Register: self (amtp:register) OR operator (amtp:write). Idempotent; 23505→409.
  .post('/agents/:id/register', zValidator('json', registerAgentSchema), async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      (isSelf && (await hasPermission(identity, 'amtp:register', squadId))) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)

    const signingIdentity = await inspectAgentSigningIdentity(agent)
    if (signingIdentity.status !== 'ready') {
      return c.json(
        {
          error: signingIdentity.message!,
          code:
            signingIdentity.status === 'unsupported'
              ? 'AMTP_SIGNING_IDENTITY_UNSUPPORTED'
              : 'AMTP_SIGNING_IDENTITY_UNAVAILABLE',
          signingIdentity,
        },
        409
      )
    }
    const { handle } = c.req.valid('json')
    try {
      if (agent.amtpHandle !== handle) await agent.update({ amtpHandle: handle, cardJson: null })
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') return c.json({ error: 'handle already taken' }, 409)
      throw err
    }
    const { instanceId } = await InstanceIdentity.getPublic()
    return c.json({
      handle,
      address: formatAmtpAddress(instanceId, handle),
      identityPublicKey: signingIdentity.identityPublicKey,
    })
  })

  // Revoke/unpublish: self OR operator. Clears the handle + closes the mailbox.
  // Auth asymmetry vs. register/open/close (which require amtp:register for self-callers)
  // is intentional: revoke is always safe for the agent to do unilaterally (it only reduces its
  // attack surface). An operator that wants to prevent self-revoke can revoke amtp:write
  // from the agent's role; there is no separate "amtp:register required for self-revoke"
  // rule in the spec.
  .delete('/agents/:id/register', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    // Spec: self OR amtp:write. No amtp:register scope required for self-revoke.
    const allowed = isSelf || (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)
    await agent.update({ amtpHandle: null, inboundOpen: false, cardJson: null })
    return c.json({ success: true })
  })

  // Publish/update a signed agent card: self (amtp:register) OR operator (amtp:write).
  // Validation order (all early-return): registered? (409) -> handle binding (400) ->
  // instanceId binding vs this instance's own identity (400) -> identity key present? (409)
  // -> size (413) -> signature verify (400). Persists the signed card verbatim (never re-signed).
  .put('/agents/:id/card', zValidator('json', amtpSignedAgentCardSchema), async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      (isSelf && (await hasPermission(identity, 'amtp:register', squadId))) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)

    const signed = c.req.valid('json')
    if (!agent.amtpHandle) return c.json({ error: 'Agent is not registered' }, 409)
    if (signed.handle !== agent.amtpHandle) {
      return c.json({ error: 'card handle does not match the registered handle' }, 400)
    }
    const { instanceId } = await InstanceIdentity.getPublic()
    if (signed.instanceId !== instanceId) {
      return c.json({ error: 'card instanceId does not match this instance' }, 400)
    }
    const signingIdentity = await inspectAgentSigningIdentity(agent)
    if (signingIdentity.status !== 'ready') {
      return c.json(
        {
          error: signingIdentity.message!,
          code:
            signingIdentity.status === 'unsupported'
              ? 'AMTP_SIGNING_IDENTITY_UNSUPPORTED'
              : 'AMTP_SIGNING_IDENTITY_UNAVAILABLE',
          signingIdentity,
        },
        409
      )
    }
    if (signedCardByteSize(signed) > SIGNED_CARD_MAX_BYTES) return c.json({ error: 'card too large' }, 413)
    if (!verifyAgentCard(signingIdentity.identityPublicKey!, signed)) {
      return c.json({ error: 'card signature verification failed' }, 400)
    }

    await agent.update({ cardJson: signed })
    return c.json({ ok: true, card: signed.card })
  })

  // Unpublish the signed card only (leaves the handle registered): same authz as PUT.
  .delete('/agents/:id/card', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      (isSelf && (await hasPermission(identity, 'amtp:register', squadId))) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)
    await agent.update({ cardJson: null })
    return c.json({ success: true })
  })

  // Open the mailbox: self (amtp:register) OR operator (amtp:write).
  .post('/agents/:id/open', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      (isSelf && (await hasPermission(identity, 'amtp:register', squadId))) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)
    if (!agent.amtpHandle) return c.json({ error: 'Agent is not registered', code: 'AMTP_AGENT_NOT_REGISTERED' }, 409)
    const signingIdentity = await inspectAgentSigningIdentity(agent)
    if (signingIdentity.status !== 'ready') {
      return c.json(
        {
          error: signingIdentity.message!,
          code:
            signingIdentity.status === 'unsupported'
              ? 'AMTP_SIGNING_IDENTITY_UNSUPPORTED'
              : 'AMTP_SIGNING_IDENTITY_UNAVAILABLE',
          signingIdentity,
        },
        409
      )
    }
    await agent.update({ inboundOpen: true })
    return c.json({ inboundOpen: true })
  })

  // Close the mailbox: self (amtp:register) OR operator (amtp:write).
  .post('/agents/:id/close', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      (isSelf && (await hasPermission(identity, 'amtp:register', squadId))) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)
    await agent.update({ inboundOpen: false })
    return c.json({ inboundOpen: false })
  })

  // List allow-rules (UI/self): self OR amtp:read/write.
  .get('/agents/:id/allow-rules', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    const squadId = agent.squadId ?? undefined
    const isSelf = identity.type === 'agent' && identity.agentId === agent.id
    const allowed =
      isSelf ||
      (await hasPermission(identity, 'amtp:read', squadId)) ||
      (await hasPermission(identity, 'amtp:write', squadId))
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)
    const allowRules = (await AmtpAllowRule.listForAgent(agent.id)).map((r) => r.toJson())
    return c.json(allowRules)
  })

  // Create an allow-rule (operator only): amtp:write.
  .post('/agents/:id/allow-rules', zValidator('json', createAmtpAllowRuleSchema), async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    if (!(await hasPermission(identity, 'amtp:write', agent.squadId ?? undefined))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    c.set('authzChecked', true)
    const { peerInstanceId, principalKind, principalValue } = c.req.valid('json')
    // Validate before hitting the DB so client errors return 400 and unexpected
    // DB failures can propagate to the generic 500 handler with no info leak.
    if (principalKind === 'handle' && !principalValue) {
      return c.json({ error: "'handle' allow-rule requires a non-empty principalValue" }, 400)
    }
    const rule = await AmtpAllowRule.create({
      targetAgentId: agent.id,
      peerInstanceId,
      principalKind,
      principalValue,
    })
    return c.json(rule.toJson(), 201)
  })

  // Delete an allow-rule (operator only): amtp:write.
  .delete('/agents/:id/allow-rules/:ruleId', async (c) => {
    const loaded = await loadAgentForFed(c)
    if (loaded instanceof Response) return loaded
    const { agent, identity } = loaded
    if (!(await hasPermission(identity, 'amtp:write', agent.squadId ?? undefined))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    c.set('authzChecked', true)
    const removed = await AmtpAllowRule.deleteForAgent(agent.id, c.req.param('ruleId'))
    if (!removed) return c.json({ error: 'Not found' }, 404)
    return c.json({ success: true })
  })

  // Inbound federation messages. Auth is the instance signature (requirePeerSignature),
  // NOT user RBAC. No zValidator('json') — the signed bytes are the raw body, read once
  // by the middleware; the engine re-parses it with the envelope schema (§8 pipeline,
  // docs/history/superpowers/specs/2026-07-08-amtp-engine-design.md §5.4/§7.4).
  .post('/inbox', requirePeerSignature, async (c) => {
    const rawBody = c.get('amtpRawBody') ?? ''
    const peerInstanceId = c.get('peerInstanceId') ?? ''
    const result = await amtpEngine.receiveEnvelope({ peerInstanceId, rawBody })
    return c.json(result.body, result.httpStatus)
  })
  // Peer-authenticated attachment serve. A peer may pull only attachments tau actually sent to it
  // (default-deny via outbox check). Both the auth-failed and the not-authorized cases return 404
  // to avoid leaking existence. TLS-at-transport assumption (§10) makes the 5-min replay window
  // acceptable for this idempotent, read-only route.
  .get('/attachments/:id', requirePeerSignatureGet, async (c) => {
    const peerInstanceId = c.get('peerInstanceId')!
    const id = c.req.param('id')

    const result = await amtpEngine.serveAttachment({ peerInstanceId, attachmentId: id })
    if (!result.found) return c.json({ error: 'Not found' }, 404)

    // `new Uint8Array(bytes)` is MANDATORY (not conditional): `new Response(Buffer)` is the exact
    // BodyInit pattern that produces the known inbox.ts:148 tsc error; wrapping avoids a NEW error.
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'content-type': result.contentType,
        'content-length': String(result.byteSize),
      },
    })
  })
