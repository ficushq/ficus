import { afterAll, describe, expect, test } from 'bun:test'
import { app } from '../index'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser } from '../test-utils/rbac'
import { Squad } from '../entities/Squad'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { db } from '../db'
import { agents, agentTypes, squads } from '../db/schema'
import { eq } from 'drizzle-orm'
import { hasPermission, resolvePermissions } from '../services/rbac'
import { probeWithConcurrency, uniqueRouteEndpoints } from '../test-utils/route-probes'

const PREFIX = 'route-coverage'
const TEST_MODEL = 'anthropic:claude-sonnet-4-5'
let fixtureSquadId: string | undefined
let fixtureAgentTypeId: string | undefined
let fixtureAgentId: string | undefined

const PUBLIC_ALLOWLIST = new Set([
  'GET /health',
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/register/email',
  'POST /api/auth/register/options',
  'POST /api/auth/register/verify',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  // Invite / passkey-recovery deep link. Both halves are gated by the single-use,
  // short-lived token in the body plus the WebAuthn ceremony on top of it — the
  // caller by definition has no session yet, which is the whole point. The token
  // authorises registering a passkey and nothing else; it is not a bearer credential.
  'POST /api/auth/register/token/options',
  'POST /api/auth/register/token/verify',
  // Recovery request is intentionally unauthenticated and answers identically for
  // known and unknown addresses, so it can't be used to enumerate accounts.
  'POST /api/auth/recover/passkey',
  // Device bootstrap and polling are gated by independent 256-bit, short-lived capabilities.
  'POST /api/auth/device/start',
  'POST /api/auth/device/token',
  // Mobile pairing claim is intentionally unauthenticated — gated by the single-use, short-lived code itself.
  'POST /api/auth/pair/claim',
  // App-store reviewer access on a designated demo instance: 404 unless FICUS_DEMO_REVIEWER_ACCESS
  // is set, then gated by the private reviewer secret (timing-safe, rate limited per address)
  // and yielding only an ordinary single-use pairing code for the demo account.
  'POST /api/auth/demo/pair',
  // Logout self-authenticates (revokes only the session whose token is presented)
  // and must clear the cookie even when the token is already invalid.
  'POST /api/auth/logout',
  'POST /api/webhooks/:provider',
  'POST /api/webhooks/channels/:provider',
  'POST /api/webhooks/trigger/:scheduleId',
  'GET /api/images/:id',
  'POST /api/memory/:squadId/sync/webhook',
  'ALL /api/app/:localDeploymentId/*',
  'GET /api/amtp/identity',
  // Peer-signature authenticated (requirePeerSignature sets authzChecked); cookieless + token-less.
  'POST /api/amtp/inbox',
  'GET /api/amtp/attachments/:id', // peer-signature authenticated (requirePeerSignatureGet sets authzChecked)
  // Published agent identity public key — intentionally public so federation peers can fetch-and-pin
  // it on first contact (public keys are non-secret; registration makes the handle addressable).
  'GET /api/amtp/agents/:handle/key',
  // Published signed agent card (spec §4.6 Serving) — public for the same reason as /key above;
  // the card itself is signed, so serving it unauthenticated leaks nothing new.
  'GET /api/amtp/agents/:handle/card',
  'GET /api/amtp/handles', // peer-signature authenticated (requirePeerSignatureGet sets authzChecked)
])

function normalizeMethod(method: string): string {
  return method.toUpperCase() === 'ALL' ? 'ALL' : method.toUpperCase()
}

function routeKey(route: { method: string; path: string }): string {
  return `${normalizeMethod(route.method)} ${route.path}`
}

function probePath(path: string): string {
  return path
    .replace(/:([^/]+)/g, (_match, name: string) => {
      if (name.toLowerCase().includes('id')) return '00000000-0000-4000-8000-000000000000'
      return `test-${name}`
    })
    .replace(/\*/g, 'probe')
}

describe('default-deny route coverage', () => {
  afterAll(async () => {
    if (fixtureSquadId) {
      await db.delete(agents).where(eq(agents.squadId, fixtureSquadId))
      await db.delete(squads).where(eq(squads.id, fixtureSquadId))
    }
    if (fixtureAgentTypeId) {
      await db.delete(agentTypes).where(eq(agentTypes.id, fixtureAgentTypeId))
    }
    await cleanupTestRbac(PREFIX)

    if (fixtureAgentId) {
      expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, fixtureAgentId))).toEqual([])
    }
  })

  test('every /api route is guarded or explicitly allowlisted', async () => {
    // Hono lists one entry per middleware/handler, not per HTTP endpoint. A
    // request already traverses the whole chain, so probing each entry caused
    // thousands of duplicate concurrent auth queries and pool starvation.
    const allRoutes = uniqueRouteEndpoints(app.routes)
    const routes = allRoutes.filter((route) => route.path.startsWith('/api/'))

    const missingFromAllowlist = [...PUBLIC_ALLOWLIST].filter(
      (allowed) => !allRoutes.some((route) => routeKey(route) === allowed)
    )
    expect(missingFromAllowlist).toEqual([])

    const unexpectedPublic = routes
      .map(routeKey)
      .filter((key) => PUBLIC_ALLOWLIST.has(key) && key.startsWith('GET /api/webhooks'))
    expect(unexpectedPublic).toEqual([])

    const identityOnlyLeaks: string[] = []
    const sentinelFailures: string[] = []
    const noPermissionUser = await createTestUser({ prefix: PREFIX })
    const admin = await createTestAdmin({ prefix: PREFIX })
    const adminIdentity = { type: 'user' as const, userId: admin.id }
    expect(await resolvePermissions(adminIdentity)).toContain('*')
    expect(await hasPermission(adminIdentity, 'agents:read')).toBe(true)

    const squad = await Squad.create({ name: `${PREFIX}-workstream-squad`, purpose: 'route coverage' })
    fixtureSquadId = squad.id
    fixtureAgentTypeId = `${PREFIX}-${crypto.randomUUID()}`
    await AgentType.create({
      id: fixtureAgentTypeId,
      name: 'Route coverage agent',
      model: TEST_MODEL,
      systemPrompt: 'route coverage',
    })
    const fixtureAgent = await Agent.create({ agentTypeId: fixtureAgentTypeId, squadId: squad.id })
    fixtureAgentId = fixtureAgent.id

    const preflight = await app.request('/api/worker/status', { headers: authHeaders(noPermissionUser.token) })
    expect(preflight.status).toBe(403)

    await probeWithConcurrency(routes, 4, async (route) => {
      const key = routeKey(route)
      if (PUBLIC_ALLOWLIST.has(key)) return
      if (key === 'DELETE /api/sessions') return

      const path = probePath(route.path)
      const method = route.method === 'ALL' ? 'GET' : route.method
      const unauthenticated = await app.request(path, { method })
      if (![401, 403].includes(unauthenticated.status)) {
        identityOnlyLeaks.push(`${key} -> ${unauthenticated.status}`)
      }

      const noPermission = await app.request(path, {
        method,
        headers: authHeaders(noPermissionUser.token),
      })
      if (noPermission.status === 500) {
        const body = await noPermission
          .clone()
          .json()
          .catch(() => null)
        if (body?.error === 'Authorization check missing') {
          sentinelFailures.push(`${key} -> ${noPermission.status}`)
        }
      }
    })

    const postflight = await app.request('/api/worker/status', { headers: authHeaders(noPermissionUser.token) })
    expect(postflight.status).toBe(403)

    const unprivilegedAgents = await app.request('/api/agents', {
      headers: authHeaders(noPermissionUser.token),
    })
    expect(unprivilegedAgents.status).toBe(200)
    expect(((await unprivilegedAgents.json()) as Array<{ id: string }>).some((row) => row.id === fixtureAgent.id)).toBe(
      false
    )

    const adminAgents = await app.request('/api/agents', { headers: authHeaders(admin.token) })
    expect(adminAgents.status).toBe(200)
    const adminAgentRows = (await adminAgents.json()) as Array<{ id: string }>
    expect(adminAgentRows.filter((row) => row.id === fixtureAgent.id)).toHaveLength(1)

    const workerStatus = await app.request('/api/worker/status', { headers: authHeaders(admin.token) })
    expect(workerStatus.status).not.toBe(500)

    const createdWorkstream = await app.request('/api/workstreams', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${PREFIX} workstream`, squadId: squad.id }),
    })
    expect(createdWorkstream.status).not.toBe(500)

    expect(identityOnlyLeaks).toEqual([])
    expect(sentinelFailures).toEqual([])
  }, 15_000)
})
