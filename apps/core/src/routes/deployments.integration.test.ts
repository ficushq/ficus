import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { like } from 'drizzle-orm'
import { db, localDeployments, squads } from '../db'
import { Squad } from '../entities/Squad'
import { configureLocalDeploymentProxyDependencies } from '../services/deploy/local-deployment-proxy'
import { getLocalDeployment, updateLocalDeploymentRecord } from '../services/deploy/local-deployment-service'
import { configureDeploymentsRouteDependencies, deploymentsRouter } from './deployments'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'
import { AmbiguousPrefixError } from '../db/prefix-match'

const PREFIX = 'deploy-integration-rbac'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api', deploymentsRouter)

describe('deployments localDeployment integration', () => {
  let testPrefix: string
  let localDeploymentProcess: Bun.Subprocess | null = null
  let localDeploymentPort: number
  let adminUser: TestUser
  const resolveLocalDeploymentTarget = mock(async () => ({ host: '127.0.0.1', port: 0 }))

  beforeAll(async () => {
    adminUser = await createTestAdmin({ prefix: PREFIX })
  })

  afterAll(async () => {
    await cleanupTestRbac(PREFIX)
  })

  beforeEach(() => {
    testPrefix = `deploy-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    localDeploymentPort = allocateLocalPort()

    resolveLocalDeploymentTarget.mockClear()
    resolveLocalDeploymentTarget.mockImplementation(async () => ({ host: '127.0.0.1', port: localDeploymentPort }))
    configureLocalDeploymentProxyDependencies({ resolveLocalDeploymentTarget })

    configureDeploymentsRouteDependencies({
      ensureSquadSandbox: async () => '/workspace',
      refreshLocalDeploymentHealth: async (localDeploymentId) =>
        updateLocalDeploymentRecord(localDeploymentId, { status: 'running', keepSandboxAlive: true }),
      restartManagedLocalDeployment: async (localDeploymentId) => (await getLocalDeployment(localDeploymentId))!,
      supervisor: {
        startManagedLocalDeployment: async ({ localDeploymentId }) => {
          localDeploymentProcess = Bun.spawn(
            [
              'bun',
              '--eval',
              `Bun.serve({ hostname: '127.0.0.1', port: ${localDeploymentPort}, fetch() { return new Response('hello localDeployment') } })`,
            ],
            { stdout: 'pipe', stderr: 'pipe' }
          )
          await waitForLocalDeploymentServer(localDeploymentPort)
          return { processId: `integration-${localDeploymentId.slice(0, 8)}` }
        },
        stopLocalDeployment: async () => {
          localDeploymentProcess?.kill()
          await localDeploymentProcess?.exited.catch(() => {})
          localDeploymentProcess = null
        },
        tailLogs: async () => [],
        streamLogs: () => ({ cancel: () => {} }),
        resolveAttachedLogPath: async (_sandboxId: string, logPath: string) => ({ resolved: logPath, exists: true }),
        tailAttachedLogs: async () => ({ kind: 'unavailable' as const }),
        streamAttachedLogs: () => ({ cancel: () => {} }),
      },
    })
  })

  afterEach(async () => {
    localDeploymentProcess?.kill()
    await localDeploymentProcess?.exited.catch(() => {})
    localDeploymentProcess = null
    configureDeploymentsRouteDependencies()
    configureLocalDeploymentProxyDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  async function createTestSquad(): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad`, purpose: 'Deployment integration test squad' })
      .returning()
    return new Squad(row)
  }

  it('returns 409 with fresh-link guidance when the real local-deployment prefix resolver is ambiguous', async () => {
    const squad = await createTestSquad()
    const compact = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    const prefix = `${compact.slice(0, 8)}-${compact.slice(8)}`
    await db.insert(localDeployments).values([
      {
        id: `${prefix}-4aaa-8aaa-aaaaaaaaaaaa`,
        squadId: squad.id,
        sandboxId: squad.sandboxId,
        portScope: squad.sandboxId,
        name: 'ambiguous-a',
        port: 5101,
        targetHost: '127.0.0.1',
        browserAccessToken: 'token-a',
        mode: 'attached',
      },
      {
        id: `${prefix}-4bbb-8bbb-bbbbbbbbbbbb`,
        squadId: squad.id,
        sandboxId: squad.sandboxId,
        portScope: squad.sandboxId,
        name: 'ambiguous-b',
        port: 5102,
        targetHost: '127.0.0.1',
        browserAccessToken: 'token-b',
        mode: 'attached',
      },
    ])

    const response = await app.request(`/api/app/${prefix}/?_tau_token=irrelevant`)

    expect(response.status).toBe(409)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(await response.json()).toEqual({ error: 'This app link is no longer unique — get a fresh URL.' })
    expect(resolveLocalDeploymentTarget).not.toHaveBeenCalled()
  })

  it('provides a defensive ambiguous proxy mapping', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'defensive', port: localDeploymentPort, mode: 'attached' }),
    })
    const localDeployment = await createRes.json()
    configureDeploymentsRouteDependencies({
      proxyLocalDeploymentRequest: mock(async () => {
        throw new AmbiguousPrefixError('local deployment', localDeployment.id.slice(0, 13))
      }),
    })

    const response = await app.request(localDeployment.urlPathOrHost)

    expect(response.status).toBe(409)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(await response.json()).toEqual({ error: 'This app link is no longer unique — get a fresh URL.' })
    expect(resolveLocalDeploymentTarget).not.toHaveBeenCalled()
  })

  it('resolves a compact hostname prefix to the full deployment before exact browser-token validation', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'compact', port: localDeploymentPort, command: 'bun run dev' }),
    })
    expect(createRes.status).toBe(201)
    const localDeployment = await createRes.json()
    const token = new URL(localDeployment.urlPathOrHost, 'http://tau.test').searchParams.get('_tau_token')!
    const hyphenatedPrefix = localDeployment.id.slice(0, 13)

    const wrongToken = await app.request(`/api/app/${hyphenatedPrefix}/?_tau_token=wrong`)
    expect(wrongToken.status).toBe(401)

    const response = await app.request(`/api/app/${hyphenatedPrefix}/?_tau_token=${encodeURIComponent(token)}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello localDeployment')
    expect(response.headers.get('set-cookie')).toContain(`ficus_app_${localDeployment.id}=`)
  })

  it('keeps the full UUID path cookie behavior and omits a Domain attribute', async () => {
    const squad = await createTestSquad()
    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({ name: 'full-id', port: localDeploymentPort, command: 'bun run dev' }),
    })
    const localDeployment = await createRes.json()
    const tokenResponse = await app.request(localDeployment.urlPathOrHost)
    const setCookie = tokenResponse.headers.get('set-cookie')!
    const cookie = setCookie.split(';', 1)[0]

    expect(tokenResponse.status).toBe(200)
    expect(setCookie).not.toMatch(/(?:^|;)\s*Domain=/i)

    const cookieResponse = await app.request(`/api/app/${localDeployment.id}/`, { headers: { cookie } })
    expect(cookieResponse.status).toBe(200)
    expect(await cookieResponse.text()).toBe('hello localDeployment')
  })

  it('starts a managed localDeployment, proxies traffic, and stops the localDeployment', async () => {
    const squad = await createTestSquad()

    const createRes = await app.request(`/api/squads/${squad.id}/local-deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(adminUser.token) },
      body: JSON.stringify({
        name: 'web',
        port: localDeploymentPort,
        command: `bun --eval "Bun.serve({ hostname: '0.0.0.0', port: ${localDeploymentPort}, fetch() { return new Response('hello localDeployment') } })"`,
      }),
    })

    expect(createRes.status).toBe(201)
    const localDeployment = await createRes.json()
    expect(localDeployment.status).toBe('running')

    // The proxy uses the _tau_token URL — identityMiddleware bypasses auth for valid tokens.
    // No Bearer token needed here; the _tau_token query param is the auth mechanism for
    // in-browser asset loading (see publicRoute comment in deploymentsRouter).
    const proxyRes = await app.request(localDeployment.urlPathOrHost)
    expect(proxyRes.status).toBe(200)
    expect(await proxyRes.text()).toBe('hello localDeployment')

    const stopRes = await app.request(`/api/local-deployments/${localDeployment.id}/stop`, {
      method: 'POST',
      headers: authHeaders(adminUser.token),
    })
    expect(stopRes.status).toBe(200)
    const stopped = await stopRes.json()
    expect(stopped.status).toBe('stopped')

    // Use the _tau_token URL so identityMiddleware allows the unauthenticated browser request through.
    // After stopping, the proxy target is gone — the handler returns 404.
    const stoppedProxyRes = await app.request(stopped.urlPathOrHost)
    expect(stoppedProxyRes.status).toBe(404)
  })
})

function allocateLocalPort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error('Failed to allocate local port')
  return port
}

async function waitForLocalDeploymentServer(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`LocalDeployment server did not start on port ${port}`)
}
