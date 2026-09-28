/**
 * Route-level proof that the local-deployment log endpoints deliver real lines
 * on the HOST runtime, through the REAL supervisor + the REAL host sandbox
 * manager the API process uses (the factory singleton) — not a stubbed
 * supervisor. The supervisor-level test (services/deploy/local-deployment-host-logs.test.ts)
 * already covers the manager; this covers everything between the HTTP route and it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { like } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { db, squads } from '../db'
import { Squad } from '../entities/Squad'
import { configureDeploymentsRouteDependencies, deploymentsRouter } from './deployments'
import { identityMiddleware } from '../middleware/identity'
import { createLocalDeployment } from '../services/deploy/local-deployment-service'
import { ensureSquadSandbox } from '../services/sandbox/ensure'
import { clearHostWorkspaceOverrides } from '../services/sandbox/host/workspace-overrides'
import { getSandboxManager } from '../services/sandbox'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import { createTestAdmin, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

const PREFIX = 'deploy-host-logs'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api', deploymentsRouter)

/** Read an SSE body until `predicate` is satisfied or the deadline passes. */
/** Read the SSE body until `predicate` holds, the stream ends, or the deadline passes. */
async function readSSE(
  response: Response,
  predicate: (text: string) => boolean,
  ms = 5000
): Promise<{ text: string; matched: boolean; ended: boolean }> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let ended = false
  const deadline = Date.now() + ms
  try {
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => 'timeout' as const),
      ])
      if (read === 'timeout') break
      if (read.done) {
        ended = true
        break
      }
      text += decoder.decode(read.value, { stream: true })
      if (predicate(text)) return { text, matched: true, ended }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { text, matched: predicate(text), ended }
}

describe('local deployment logs over HTTP on the host runtime', () => {
  let testPrefix: string
  let adminUser: TestUser
  let home: string
  let prevHome: string | undefined
  let prevRuntime: string | undefined

  beforeAll(async () => {
    adminUser = await createTestAdmin({ prefix: PREFIX })
  })

  afterAll(async () => {
    await cleanupTestRbac(PREFIX)
  })

  beforeEach(() => {
    testPrefix = `deploy-host-logs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    home = mkdtempSync(join(tmpdir(), 'tau-route-host-logs-'))
    prevHome = process.env.HOME_DIR
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.HOME_DIR = home
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
    // Production wiring: no supervisor override at all, so the route builds the
    // real LocalDeploymentProcessSupervisor over the factory's host manager.
    configureDeploymentsRouteDependencies()
  })

  afterEach(async () => {
    configureDeploymentsRouteDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    clearHostWorkspaceOverrides()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(home, { recursive: true, force: true })
  })

  async function seedDeployment(mode: 'managed' | 'attached'): Promise<{ id: string; squadId: string }> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad`, purpose: 'Host deployment log route test' })
      .returning()
    const squad = new Squad(row)
    const localDeployment = await createLocalDeployment(squad, {
      name: 'web',
      mode,
      command: mode === 'managed' ? 'bun run dev' : undefined,
    } as any)
    await ensureSquadSandbox(squad.id, { restartManagedLocalDeployments: false })
    return { id: localDeployment.id, squadId: squad.id }
  }

  /** Seed an ATTACHED deployment with a registered log path under its workspace. */
  async function seedAttachedDeploymentWithLogs(
    logPath = 'my-app/app.log',
    content = 'line-one\nline-two\n'
  ): Promise<{ id: string; squadId: string }> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad`, purpose: 'Host deployment log route test' })
      .returning()
    const squad = new Squad(row)
    const localDeployment = await createLocalDeployment(squad, {
      name: 'web',
      mode: 'attached',
      logPath,
    } as any)
    await ensureSquadSandbox(squad.id, { restartManagedLocalDeployments: false })
    const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
    const absolute = join(workspaceMount, logPath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
    return { id: localDeployment.id, squadId: squad.id }
  }

  async function findSquad(): Promise<Squad> {
    const [row] = await db
      .select()
      .from(squads)
      .where(like(squads.name, `${testPrefix}-squad`))
      .limit(1)
    return new Squad(row)
  }

  async function seedDeploymentWithLogs(): Promise<{ id: string }> {
    const { id, squadId } = await seedDeployment('managed')
    const dir = join(resolveWorkspaceLayout({ squadId }).workspaceMount, '.tau', 'local-deployments', id)
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'current.log'), 'line-one\nline-two\n')
    return { id }
  }

  it('GET /logs returns the log lines', async () => {
    const { id } = await seedDeploymentWithLogs()
    const response = await app.request(`/api/local-deployments/${id}/logs`, {
      headers: authHeaders(adminUser.token),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ lines: ['line-one', 'line-two'] })
  })

  it('GET /logs/stream emits a lines event with the log lines', async () => {
    const { id } = await seedDeploymentWithLogs()
    const response = await app.request(`/api/local-deployments/${id}/logs/stream`, {
      headers: authHeaders(adminUser.token),
    })
    expect(response.status).toBe(200)
    const { text } = await readSSE(response, (t) => t.includes('line-two'), 5000)
    expect(text).toContain('event: lines')
    expect(text).toContain('line-one')
    expect(text).toContain('line-two')
    await getSandboxManager().cleanup?.()
  }, 15000)

  // Attached apps are processes Ficus did NOT start, so nothing ever writes the
  // managed launcher's current.log. Tailing it followed a permanently empty
  // file: the viewer sat on "Waiting for logs…" forever with an SSE connection
  // and a `tail -F` child leaking per viewer.
  it('GET /logs says why an attached app has no logs instead of returning nothing', async () => {
    const { id } = await seedDeployment('attached')
    const response = await app.request(`/api/local-deployments/${id}/logs`, {
      headers: authHeaders(adminUser.token),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { lines: string[] }
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0]).toContain('attached')
    expect(body.lines[0]).toContain('Ficus did not start it')
  })

  it('GET /logs/stream tells an attached app viewer why there are no logs, then ends', async () => {
    const { id } = await seedDeployment('attached')
    const response = await app.request(`/api/local-deployments/${id}/logs/stream`, {
      headers: authHeaders(adminUser.token),
    })
    expect(response.status).toBe(200)
    const { text, ended } = await readSSE(response, () => false, 3000)
    expect(text).toContain('event: lines')
    expect(text).toContain('Ficus did not start it')
    expect(ended).toBe(true)
  }, 15000)

  it('GET /logs/stream emits a lines event over a real socket (Bun.serve)', async () => {
    const { id } = await seedDeploymentWithLogs()
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => app.fetch(req) })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/local-deployments/${id}/logs/stream?tail=200`, {
        headers: authHeaders(adminUser.token),
      })
      expect(response.status).toBe(200)
      const { text } = await readSSE(response, (t) => t.includes('line-two'), 5000)
      expect(text).toContain('event: lines')
      expect(text).toContain('line-one')
      expect(text).toContain('line-two')
    } finally {
      await server.stop(true)
      await getSandboxManager().cleanup?.()
    }
  }, 15000)

  // ── Attached log paths, real supervisor over the host sandbox ────────────

  it('GET /logs tails an attached deployment registered with a log path', async () => {
    const { id } = await seedAttachedDeploymentWithLogs()

    const response = await app.request(`/api/local-deployments/${id}/logs`, {
      headers: authHeaders(adminUser.token),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ lines: ['line-one', 'line-two'] })
  })

  it('GET /logs/stream emits a lines event for an attached log path', async () => {
    const { id } = await seedAttachedDeploymentWithLogs()

    const response = await app.request(`/api/local-deployments/${id}/logs/stream`, {
      headers: authHeaders(adminUser.token),
    })

    expect(response.status).toBe(200)
    const { text } = await readSSE(response, (t) => t.includes('line-two'), 5000)
    expect(text).toContain('event: lines')
    expect(text).toContain('line-one')
    expect(text).toContain('line-two')
    await getSandboxManager().cleanup?.()
  }, 15000)

  it('GET /logs maps a workspace-internal symlink escape to 400', async () => {
    const { id } = await seedAttachedDeploymentWithLogs('my-app/evil.log', '')
    const squad = await findSquad()
    const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
    // The registered path normalizes INSIDE the workspace, but realpath pins it out.
    rmSync(join(workspaceMount, 'my-app', 'evil.log'))
    symlinkSync('/etc/hosts', join(workspaceMount, 'my-app', 'evil.log'))

    const logs = await app.request(`/api/local-deployments/${id}/logs`, {
      headers: authHeaders(adminUser.token),
    })
    expect(logs.status).toBe(400)

    const stream = await app.request(`/api/local-deployments/${id}/logs/stream`, {
      headers: authHeaders(adminUser.token),
    })
    expect(stream.status).toBe(400)
  })

  it('GET /logs and /logs/stream return a one-line notice for a missing attached log file', async () => {
    const { id } = await seedAttachedDeploymentWithLogs('my-app/never-written.log', 'ignored')
    const { workspaceMount } = resolveWorkspaceLayout({ squadId: (await findSquad()).id })
    rmSync(join(workspaceMount, 'my-app', 'never-written.log'))

    const logs = await app.request(`/api/local-deployments/${id}/logs`, {
      headers: authHeaders(adminUser.token),
    })
    expect(logs.status).toBe(200)
    const body = (await logs.json()) as { lines: string[] }
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0]).toContain('[ficus]')
    expect(body.lines[0]).toContain('my-app/never-written.log')

    const stream = await app.request(`/api/local-deployments/${id}/logs/stream`, {
      headers: authHeaders(adminUser.token),
    })
    expect(stream.status).toBe(200)
    const { text, ended } = await readSSE(stream, () => false, 3000)
    expect(text).toContain('event: lines')
    expect(text).toContain('my-app/never-written.log')
    expect(ended).toBe(true)
  }, 15000)
})
