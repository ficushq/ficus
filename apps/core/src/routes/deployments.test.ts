import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { eq, like } from 'drizzle-orm'
import { existsSync } from 'fs'
import { db, appDeployments, squads } from '../db'
import { Squad } from '../entities/Squad'
import { getLocalDeployment, updateLocalDeploymentRecord } from '../services/deploy/local-deployment-service'
import { configureDeploymentsRouteDependencies, deploymentsRouter } from './deployments'
import { SandboxProvisionError } from '../services/sandbox/k8s/provision-errors'
import { identityMiddleware } from '../middleware/identity'
import { getSquadWorkspacePath } from '../services/squad/workspace'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
  type TestUser,
} from '../test-utils'
import { createDeviceToken, revokeDeviceToken } from '../services/auth/device-tokens'

const PREFIX = 'deploy-route-rbac'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api', deploymentsRouter)

describe('deployments routes', () => {
  let testPrefix: string
  const supervisorStarts: any[] = []
  const supervisorStops: any[] = []
  const ensureSquadSandbox = mock(async () => '/workspace')
  let adminUser: TestUser

  function getRouteSupervisor() {
    return {
      startManagedLocalDeployment: async (args: any) => {
        supervisorStarts.push(args)
        return { processId: `tau-local-deployment-${args.localDeploymentId.slice(0, 8)}` }
      },
      stopLocalDeployment: async (sandboxId: string, processId: string) => {
        supervisorStops.push({ sandboxId, processId })
      },
      tailLogs: async () => ['line 1', 'line 2'],
      streamLogs: () => ({ cancel: () => {} }),
      resolveAttachedLogPath: async (_sandboxId: string, logPath: string) => ({ resolved: logPath, exists: true }),
      tailAttachedLogs: async () => ({ kind: 'lines', lines: ['line 1', 'line 2'] }),
      streamAttachedLogs: () => ({ cancel: () => {} }),
    }
  }

  beforeAll(async () => {
    adminUser = await createTestAdmin({ prefix: PREFIX })
  })

  afterAll(async () => {
    await cleanupTestRbac(PREFIX)
  })

  beforeEach(() => {
    testPrefix = `deploy-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    supervisorStarts.length = 0
    supervisorStops.length = 0
    ensureSquadSandbox.mockClear()
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      refreshLocalDeploymentHealth: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      restartManagedLocalDeployment: async (localDeploymentId) => {
        const localDeployment = (await getLocalDeployment(localDeploymentId))!
        const { processId } = await (getRouteSupervisor() as any).startManagedLocalDeployment({
          localDeploymentId: localDeployment.id,
          sandboxId: localDeployment.sandboxId,
          command: localDeployment.command ?? '',
          cwd: localDeployment.cwd,
          port: localDeployment.port,
        })
        return updateLocalDeploymentRecord(localDeployment.id, {
          status: 'restarting',
          keepSandboxAlive: true,
          processId,
          restartCount: localDeployment.restartCount + 1,
        })
      },
      supervisor: getRouteSupervisor() as any,
    })
  })

  afterEach(async () => {
    configureDeploymentsRouteDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  async function createTestSquad(name = 'squad'): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-${name}`, purpose: 'Deployment route test squad' })
      .returning()
    return new Squad(row)
  }

  // ── Auth denial tests ────────────────────────────────────────────────────────

  it('GET /api/deploy/providers → 401 when unauthenticated', async () => {
    const res = await app.request('/api/deploy/providers')
    expect(res.status).toBe(401)
  })

  it('GET /api/deploy/providers → 403 when unprivileged', async () => {
    const unprivileged = await createTestUser({ prefix: `${PREFIX}-unpriv` })
    const res = await app.request('/api/deploy/providers', { headers: authHeaders(unprivileged.token) })
    expect(res.status).toBe(403)
    await cleanupTestRbac(`${PREFIX}-unpriv`)
  })

  it('GET /api/squads/:id/deployments → 401 when unauthenticated', async () => {
    const squad = await createTestSquad()
    const res = await app.request(`/api/squads/${squad.id}/deployments`)
    expect(res.status).toBe(401)
  })

  it('GET /api/squads/:id/deployments → 403 when unprivileged', async () => {
    const squad = await createTestSquad()
    const unprivileged = await createTestUser({ prefix: `${PREFIX}-unpriv2` })
    const res = await app.request(`/api/squads/${squad.id}/deployments`, {
      headers: authHeaders(unprivileged.token),
    })
    expect(res.status).toBe(403)
    await cleanupTestRbac(`${PREFIX}-unpriv2`)
  })

  it('GET /api/squads/:id/deployments → 403 for cross-squad access', async () => {
    const mySquad = await createTestSquad('mine')
    const otherSquad = await createTestSquad('other')
    // Create a user with deployments:read scoped only to mySquad
    const user = await createTestUser({ prefix: `${PREFIX}-cross` })
    const role = await createTestRole({ prefix: `${PREFIX}-cross`, permissions: ['deployments:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: mySquad.id })
    const res = await app.request(`/api/squads/${otherSquad.id}/deployments`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
    await cleanupTestRbac(`${PREFIX}-cross`)
  })

  it('GET /api/deployments/:id → 401 when unauthenticated', async () => {
    const squad = await createTestSquad()
    const [deployment] = await db
      .insert(appDeployments)
      .values({ squadId: squad.id, provider: 'vercel', status: 'planned', metadata: {} })
      .returning()
    const res = await app.request(`/api/deployments/${deployment.id}`)
    expect(res.status).toBe(401)
  })

  it('GET /api/deployments/:id → 403 for cross-squad access', async () => {
    const mySquad = await createTestSquad('mine2')
    const otherSquad = await createTestSquad('other2')
    const [deployment] = await db
      .insert(appDeployments)
      .values({ squadId: otherSquad.id, provider: 'vercel', status: 'planned', metadata: {} })
      .returning()
    const user = await createTestUser({ prefix: `${PREFIX}-cross2` })
    const role = await createTestRole({ prefix: `${PREFIX}-cross2`, permissions: ['deployments:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: mySquad.id })
    const res = await app.request(`/api/deployments/${deployment.id}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
    await cleanupTestRbac(`${PREFIX}-cross2`)
  })

  it('DELETE /api/deployments/:id → 401 when unauthenticated', async () => {
    const squad = await createTestSquad()
    const [deployment] = await db
      .insert(appDeployments)
      .values({ squadId: squad.id, provider: 'vercel', status: 'planned', metadata: {} })
      .returning()
    const res = await app.request(`/api/deployments/${deployment.id}`, { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('DELETE /api/deployments/:id → 403 when lacking deployments:delete', async () => {
    const squad = await createTestSquad()
    const [deployment] = await db
      .insert(appDeployments)
      .values({ squadId: squad.id, provider: 'vercel', status: 'planned', metadata: {} })
      .returning()
    const user = await createTestUser({ prefix: `${PREFIX}-nodelete` })
    // Give them deployments:read but not delete
    const role = await createTestRole({ prefix: `${PREFIX}-nodelete`, permissions: ['deployments:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    const res = await app.request(`/api/deployments/${deployment.id}`, {
      method: 'DELETE',
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
    await cleanupTestRbac(`${PREFIX}-nodelete`)
  })

  it('GET /api/local-deployments/:id → 401 when unauthenticated', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const created = await createRes.json()
    const res = await app.request(`/api/local-deployments/${created.id}`)
    expect(res.status).toBe(401)
  })

  it('GET /api/local-deployments/:id → 403 for cross-squad access', async () => {
    const mySquad = await createTestSquad('mine3')
    const otherSquad = await createTestSquad('other3')
    const createRes = await app.request(`/api/squads/${otherSquad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const created = await createRes.json()
    const user = await createTestUser({ prefix: `${PREFIX}-cross3` })
    const role = await createTestRole({ prefix: `${PREFIX}-cross3`, permissions: ['deployments:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: mySquad.id })
    const res = await app.request(`/api/local-deployments/${created.id}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
    await cleanupTestRbac(`${PREFIX}-cross3`)
  })

  // ── Existing functional tests (now with auth) ────────────────────────────────

  it('GET /api/deploy/providers lists deployment providers', async () => {
    const res = await app.request('/api/deploy/providers', { headers: authHeaders(adminUser.token) })

    expect(res.status).toBe(200)
    const providers = await res.json()
    expect(providers.map((provider: any) => provider.id)).toContain('vercel')
    expect(providers.map((provider: any) => provider.id)).toContain('netlify')
  })

  it('GET /api/deployments/:id returns a deployment', async () => {
    const squad = await createTestSquad()
    const [deployment] = await db
      .insert(appDeployments)
      .values({ squadId: squad.id, provider: 'vercel', status: 'planned', metadata: { appType: 'next' } })
      .returning()

    const res = await app.request(`/api/deployments/${deployment.id}`, { headers: authHeaders(adminUser.token) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(deployment.id)
    expect(body.metadata).toEqual({ appType: 'next' })
  })

  it('POST /api/squads/:id/deployments creates a deployment record', async () => {
    const squad = await createTestSquad()

    const res = await app.request(`/api/squads/${squad.id}/deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({
        name: 'docs site',
        provider: 'github-pages',
        url: 'https://example.github.io/app',
        providerProjectUrl: 'https://github.com/example/app/actions',
        environment: 'production',
        status: 'ready',
        costRisk: 'none',
        logsCommand: 'gh run list --limit 10',
        rollbackCommand: 'git revert HEAD && git push',
        metadata: { appPath: '/workspace/app', branch: 'main' },
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe('docs site')
    expect(body.provider).toBe('github-pages')
    expect(body.url).toBe('https://example.github.io/app')
    expect(body.providerProjectUrl).toBe('https://github.com/example/app/actions')
    expect(body.environment).toBe('production')
    expect(body.status).toBe('ready')
    expect(body.logsCommand).toBe('gh run list --limit 10')
    expect(body.metadata).toEqual({ appPath: '/workspace/app', branch: 'main' })
  })

  it('POST /api/squads/:id/deployments rejects secret-like metadata keys', async () => {
    const squad = await createTestSquad()

    const res = await app.request(`/api/squads/${squad.id}/deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', provider: 'vercel', metadata: { apiToken: 'do-not-store' } }),
    })

    expect(res.status).toBe(400)
  })

  it('PATCH /api/deployments/:id updates a deployment record', async () => {
    const squad = await createTestSquad()
    const [deployment] = await db.insert(appDeployments).values({ squadId: squad.id, provider: 'vercel' }).returning()

    const res = await app.request(`/api/deployments/${deployment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({
        name: 'failed web',
        status: 'failed',
        url: 'https://example.com',
        providerProjectUrl: 'https://vercel.com/example/web',
        metadata: { reason: 'build failed' },
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('failed web')
    expect(body.status).toBe('failed')
    expect(body.url).toBe('https://example.com')
    expect(body.providerProjectUrl).toBe('https://vercel.com/example/web')
    expect(body.metadata).toEqual({ reason: 'build failed' })
  })

  it('DELETE /api/deployments/:id archives a deployment record', async () => {
    const squad = await createTestSquad()
    const [deployment] = await db
      .insert(appDeployments)
      .values({ squadId: squad.id, name: 'web', provider: 'railway', status: 'ready' })
      .returning()

    const res = await app.request(`/api/deployments/${deployment.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.archivedAt).toBeTruthy()
    expect(body.status).toBe('destroyed')

    const listRes = await app.request(`/api/squads/${squad.id}/deployments`, {
      headers: authHeaders(adminUser.token),
    })
    expect(await listRes.json()).toEqual([])
    const archivedListRes = await app.request(`/api/squads/${squad.id}/deployments?includeArchived=true`, {
      headers: authHeaders(adminUser.token),
    })
    expect(await archivedListRes.json()).toHaveLength(1)
  })

  it('PATCH /api/deployments/:id returns 404 for unknown deployment', async () => {
    const res = await app.request('/api/deployments/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ status: 'failed' }),
    })

    expect(res.status).toBe(404)
  })

  it('GET /api/squads/:id/deployments lists squad deployments', async () => {
    const squad = await createTestSquad()
    const other = await createTestSquad('other')
    await db.insert(appDeployments).values({ squadId: squad.id, provider: 'vercel' })
    await db.insert(appDeployments).values({ squadId: other.id, provider: 'netlify' })

    const res = await app.request(`/api/squads/${squad.id}/deployments`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const deployments = await res.json()
    expect(deployments).toHaveLength(1)
    expect(deployments[0].provider).toBe('vercel')
  })

  it('GET /api/squads/:id/local-deployments lists localDeployments', async () => {
    const squad = await createTestSquad()
    await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const localDeployments = await res.json()
    expect(localDeployments).toHaveLength(1)
    expect(localDeployments[0].name).toBe('web')
  })

  it('POST /api/squads/:id/local-deployments creates managed localDeployments and starts supervisor', async () => {
    const squad = await createTestSquad()

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'Web App', port: 5173, command: 'bun run dev' }),
    })

    expect(res.status).toBe(201)
    const localDeployment = await res.json()
    expect(localDeployment.name).toBe('web-app')
    expect(localDeployment.urlPathOrHost).toMatch(new RegExp(`^/api/app/${localDeployment.id}/\\?_ficus_token=.+`))
    expect(localDeployment.processId).toBe(`tau-local-deployment-${localDeployment.id.slice(0, 8)}`)
    expect(supervisorStarts).toHaveLength(1)
    expect(supervisorStarts[0]).toMatchObject({
      localDeploymentId: localDeployment.id,
      sandboxId: squad.sandboxId,
      port: 5173,
    })
  })

  it('POST /api/squads/:id/local-deployments returns the hosted URL', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    const previousAppUrl = process.env.APP_URL
    process.env.FICUS_APPS_DOMAIN = 'ficus.app'
    process.env.APP_URL = 'https://team--blue.ficus.sh'

    try {
      const squad = await createTestSquad()
      const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
        body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached' }),
      })

      expect(res.status).toBe(201)
      const localDeployment = await res.json()
      const compactId = localDeployment.id.replaceAll('-', '').slice(0, 12)
      expect(localDeployment.urlPathOrHost).toMatch(
        new RegExp(`^https://team--blue--${compactId}\\.ficus\\.app/\\?_ficus_token=.+$`)
      )
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
      if (previousAppUrl === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousAppUrl
    }
  })

  it('POST /api/squads/:id/local-deployments creates attached localDeployments', async () => {
    const squad = await createTestSquad()

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached' }),
    })

    expect(res.status).toBe(201)
    const localDeployment = await res.json()
    expect(localDeployment.mode).toBe('attached')
    expect(supervisorStarts).toHaveLength(0)
  })

  it('maps provisioning failures to typed 503 with Retry-After', async () => {
    const squad = await createTestSquad()
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox: async () => {
        throw new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'Scheduling unavailable.', 28_100)
      },
    })
    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached' }),
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('29')
    expect(await res.json()).toMatchObject({ code: 'SANDBOX_PROVISION_UNAVAILABLE', retryAfterMs: 28_100 })
  })

  it('returns 404 for unknown squad', async () => {
    const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/local-deployments', {
      headers: authHeaders(adminUser.token),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid port without ensuring sandbox', async () => {
    const squad = await createTestSquad()
    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 80, command: 'bun run dev' }),
    })
    expect(res.status).toBe(400)
    expect(ensureSquadSandbox).not.toHaveBeenCalled()
  })

  it('returns 400 for public visibility without ensuring sandbox', async () => {
    const squad = await createTestSquad()
    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev', visibility: 'public' }),
    })
    expect(res.status).toBe(400)
    expect(ensureSquadSandbox).not.toHaveBeenCalled()
  })

  it('marks localDeployment crashed when managed supervisor start fails after row creation', async () => {
    const squad = await createTestSquad()
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      refreshLocalDeploymentHealth: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      supervisor: {
        ...getRouteSupervisor(),
        startManagedLocalDeployment: async () => {
          throw new Error('tmux unavailable')
        },
      } as any,
    })

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })

    expect(res.status).toBe(400)
    const localDeployments = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      headers: authHeaders(adminUser.token),
    })
    const body = await localDeployments.json()
    expect(body).toHaveLength(1)
    expect(body[0].status).toBe('crashed')
    expect(body[0].keepSandboxAlive).toBe(false)
  })

  it('GET /api/local-deployments/:localDeploymentId returns a localDeployment', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const created = await createRes.json()

    const res = await app.request(`/api/local-deployments/${created.id}`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const localDeployment = await res.json()
    expect(localDeployment.id).toBe(created.id)
  })

  it('GET /api/local-deployments/:localDeploymentId/logs returns logs', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/logs?tail=50`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ localDeploymentId: localDeployment.id, lines: ['line 1', 'line 2'] })
  })

  it('POST /api/local-deployments/:localDeploymentId/restart restarts a localDeployment', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()
    supervisorStarts.length = 0

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/restart`, {
      method: 'POST',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const restarted = await res.json()
    expect(restarted.status).toBe('restarting')
    expect(supervisorStarts).toHaveLength(1)
  })

  it('DELETE /api/local-deployments/:localDeploymentId stops managed localDeployments and archives the row', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()

    const res = await app.request(`/api/local-deployments/${localDeployment.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const archived = await res.json()
    expect(archived.status).toBe('stopped')
    expect(archived.keepSandboxAlive).toBe(false)
    expect(archived.archivedAt).toBeTruthy()
    expect(supervisorStops).toEqual([{ sandboxId: squad.sandboxId, processId: localDeployment.processId }])
    expect(
      (
        await app.request(`/api/local-deployments/${localDeployment.id}`, {
          headers: authHeaders(adminUser.token),
        })
      ).status
    ).toBe(200)
  })

  it('closes a device-authenticated deployment log stream on revoke and rejects reconnect', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'stream-web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()
    const device = await createDeviceToken({ userId: adminUser.id, name: 'CLI', platform: 'cli' })
    let started!: () => void
    const streamStarted = new Promise<void>((resolve) => (started = resolve))
    let cancelled!: () => void
    const streamCancelled = new Promise<void>((resolve) => (cancelled = resolve))
    const cancel = mock(() => cancelled())
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      refreshLocalDeploymentHealth: async (id) => (await getLocalDeployment(id))!,
      restartManagedLocalDeployment: async (id) => (await getLocalDeployment(id))!,
      supervisor: {
        ...getRouteSupervisor(),
        streamLogs: () => {
          started()
          return { cancel }
        },
      } as any,
    })

    const response = await app.request(`/api/local-deployments/${localDeployment.id}/logs/stream`, {
      headers: authHeaders(device.token),
    })
    await streamStarted
    await revokeDeviceToken(adminUser.id, device.id)
    await response.text()
    await streamCancelled

    expect(cancel).toHaveBeenCalledTimes(1)
    const reconnect = await app.request(`/api/local-deployments/${localDeployment.id}/logs/stream`, {
      headers: authHeaders(device.token),
    })
    expect(reconnect.status).toBe(401)
  })

  it('DELETE /api/local-deployments/:localDeploymentId ensures sandbox and retries cleanup when sandbox is unknown', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()
    const cleanupAttempts: string[] = []
    const ensureCalls: string[] = []
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox: async (squadOrId) => {
        ensureCalls.push(typeof squadOrId === 'string' ? squadOrId : squadOrId.id)
        return '/workspace'
      },
      refreshLocalDeploymentHealth: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      restartManagedLocalDeployment: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      supervisor: {
        startManagedLocalDeployment: async () => ({ processId: 'unused' }),
        stopLocalDeployment: async () => {
          cleanupAttempts.push('stop')
          if (cleanupAttempts.length === 1) throw new Error(`Sandbox not found: ${squad.sandboxId}`)
        },
        tailLogs: async () => [],
        streamLogs: () => ({ cancel: () => {} }),
        resolveAttachedLogPath: async (_sandboxId: string, logPath: string) => ({ resolved: logPath, exists: true }),
        tailAttachedLogs: async () => ({ kind: 'unavailable' as const }),
        streamAttachedLogs: () => ({ cancel: () => {} }),
      },
    })

    const res = await app.request(`/api/local-deployments/${localDeployment.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    expect(cleanupAttempts).toHaveLength(2)
    expect(ensureCalls).toEqual([squad.id])
  })

  it('DELETE /api/local-deployments/:localDeploymentId archives even when sandbox cleanup still fails after ensure', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      refreshLocalDeploymentHealth: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      restartManagedLocalDeployment: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      supervisor: {
        startManagedLocalDeployment: async () => ({ processId: 'unused' }),
        stopLocalDeployment: async () => {
          throw new Error(`Sandbox not found: ${squad.sandboxId}`)
        },
        tailLogs: async () => [],
        streamLogs: () => ({ cancel: () => {} }),
        resolveAttachedLogPath: async (_sandboxId: string, logPath: string) => ({ resolved: logPath, exists: true }),
        tailAttachedLogs: async () => ({ kind: 'unavailable' as const }),
        streamAttachedLogs: () => ({ cancel: () => {} }),
      },
    })

    const res = await app.request(`/api/local-deployments/${localDeployment.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const archived = await res.json()
    expect(archived.archivedAt).toBeTruthy()
    expect(archived.status).toBe('stopped')
  })

  it('stale deployment cleanup does not resurrect an archived squad workspace', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()
    await db.update(squads).set({ status: 'archived', archivedAt: new Date() }).where(eq(squads.id, squad.id))
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox: (await import('../services/sandbox/ensure')).ensureSquadSandbox,
      refreshLocalDeploymentHealth: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      restartManagedLocalDeployment: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      supervisor: {
        startManagedLocalDeployment: async () => ({ processId: 'unused' }),
        stopLocalDeployment: async () => {
          throw new Error(`Sandbox not found: ${squad.sandboxId}`)
        },
        tailLogs: async () => [],
        streamLogs: () => ({ cancel: () => {} }),
        resolveAttachedLogPath: async (_sandboxId: string, logPath: string) => ({ resolved: logPath, exists: true }),
        tailAttachedLogs: async () => ({ kind: 'unavailable' as const }),
        streamAttachedLogs: () => ({ cancel: () => {} }),
      },
    })

    const res = await app.request(`/api/local-deployments/${localDeployment.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    expect(existsSync(getSquadWorkspacePath(squad.id))).toBe(false)
  })

  it('POST /api/local-deployments/:localDeploymentId/stop stops managed localDeployments', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/stop`, {
      method: 'POST',
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const stopped = await res.json()
    expect(stopped.status).toBe('stopped')
    expect(stopped.keepSandboxAlive).toBe(false)
    expect(supervisorStops).toEqual([{ sandboxId: squad.sandboxId, processId: localDeployment.processId }])
  })
  for (const operation of ['stop', 'archive'] as const) {
    it(`persists ${operation} intent before transport cleanup can race automatic recovery`, async () => {
      const squad = await createTestSquad()
      const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
        body: JSON.stringify({ name: 'web', port: 5173, command: 'bun run dev' }),
      })
      const deployment = await createRes.json()
      let statusDuringCleanup: string | undefined
      configureDeploymentsRouteDependencies({
        ensureSquadSandbox: async () => '/workspace',
        supervisor: {
          ...getRouteSupervisor(),
          stopLocalDeployment: async () => {
            statusDuringCleanup = (await getLocalDeployment(deployment.id))?.status
          },
        } as any,
      })
      const response = await app.request(
        `/api/local-deployments/${deployment.id}${operation === 'stop' ? '/stop' : ''}`,
        {
          method: operation === 'stop' ? 'POST' : 'DELETE',
          headers: authHeaders(adminUser.token),
        }
      )
      expect(response.status).toBe(200)
      expect(statusDuringCleanup).toBe('stopped')
    })
  }

  // ── Attached logPath tests ──────────────────────────────────────────────────

  it('POST create with an attached logPath returns it normalized', async () => {
    const squad = await createTestSquad()

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached', logPath: 'my-app/app.log' }),
    })

    expect(res.status).toBe(201)
    const localDeployment = await res.json()
    expect(localDeployment.logPath).toBe(`/workspace/${squad.id}/my-app/app.log`)
  })

  it('POST create rejects logPath on managed mode with 400', async () => {
    const squad = await createTestSquad()
    ensureSquadSandbox.mockClear()

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', command: 'bun run dev', logPath: 'app.log' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('attached') })
    expect(ensureSquadSandbox).not.toHaveBeenCalled()
  })

  it('POST create rejects an escaping logPath with 400', async () => {
    const squad = await createTestSquad()
    ensureSquadSandbox.mockClear()

    const res = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached', logPath: '../../etc/passwd' }),
    })

    expect(res.status).toBe(400)
    expect(ensureSquadSandbox).not.toHaveBeenCalled()
  })

  it('GET /logs tails the registered attached log path', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached', logPath: 'my-app/app.log' }),
    })
    const localDeployment = await createRes.json()
    const tailCalls: Array<{ sandboxId: string; logPath: string; tail: number }> = []
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      supervisor: {
        ...getRouteSupervisor(),
        tailAttachedLogs: async (sandboxId: string, logPath: string, tail: number) => {
          tailCalls.push({ sandboxId, logPath, tail })
          return { kind: 'lines', lines: ['line 1', 'line 2'] }
        },
      } as any,
    })

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/logs?tail=50`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ localDeploymentId: localDeployment.id, lines: ['line 1', 'line 2'] })
    expect(tailCalls).toEqual([
      { sandboxId: localDeployment.sandboxId, logPath: `/workspace/${squad.id}/my-app/app.log`, tail: 50 },
    ])
  })

  it('GET /logs keeps the notice for attached without logPath', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached' }),
    })
    const localDeployment = await createRes.json()
    ensureSquadSandbox.mockClear()

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/logs`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0]).toContain('attached')
    expect(ensureSquadSandbox).not.toHaveBeenCalled()
  })

  it('GET /logs maps an outside-workspace path to 400', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached', logPath: 'my-app/app.log' }),
    })
    const localDeployment = await createRes.json()
    const { LocalDeploymentLogPathOutsideWorkspaceError: TypedError } =
      await import('../services/deploy/local-deployment-log-path')
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      supervisor: {
        ...getRouteSupervisor(),
        tailAttachedLogs: async () => {
          throw new TypedError('Attached log path must stay inside the squad workspace')
        },
      } as any,
    })

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/logs`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Attached log path must stay inside the squad workspace' })
  })

  it('GET /logs returns a one-line notice when the attached log file is unavailable', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached', logPath: 'my-app/app.log' }),
    })
    const localDeployment = await createRes.json()
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      supervisor: {
        ...getRouteSupervisor(),
        tailAttachedLogs: async () => ({ kind: 'unavailable' }),
      } as any,
    })

    const res = await app.request(`/api/local-deployments/${localDeployment.id}/logs`, {
      headers: authHeaders(adminUser.token),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0]).toContain('my-app/app.log')
    expect(body.lines[0]).toContain('[ficus]')
  })

  it('GET /logs/stream emits SSE lines for an attached log path', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached', logPath: 'my-app/app.log' }),
    })
    const localDeployment = await createRes.json()
    configureDeploymentsRouteDependencies({
      ensureSquadSandbox,
      supervisor: {
        ...getRouteSupervisor(),
        streamAttachedLogs: (
          sandboxId: string,
          resolvedLogPath: string,
          tail: number,
          onLine: (line: string) => void
        ) => {
          expect(sandboxId).toBe(localDeployment.sandboxId)
          expect(resolvedLogPath).toBe(`/workspace/${squad.id}/my-app/app.log`)
          expect(tail).toBe(50)
          onLine('streamed-line')
          return { cancel: () => {} }
        },
      } as any,
    })

    const response = await app.request(`/api/local-deployments/${localDeployment.id}/logs/stream?tail=50`, {
      headers: authHeaders(adminUser.token),
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const read = await Promise.race([reader.read(), Bun.sleep(2000).then(() => 'timeout' as const)])
      if (read === 'timeout') break
      if (read.done) break
      text += decoder.decode(read.value, { stream: true })
      if (text.includes('streamed-line')) break
    }
    await reader.cancel().catch(() => {})
    expect(text).toContain('event: lines')
    expect(text).toContain('streamed-line')
  }, 10000)

  it('GET /logs/stream keeps the notice-and-close behavior without a logPath', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'web', port: 5173, mode: 'attached' }),
    })
    const localDeployment = await createRes.json()
    ensureSquadSandbox.mockClear()

    const response = await app.request(`/api/local-deployments/${localDeployment.id}/logs/stream`, {
      headers: authHeaders(adminUser.token),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('event: lines')
    expect(text).toContain('Ficus did not start it')
    expect(ensureSquadSandbox).not.toHaveBeenCalled()
  })
})
