import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TypeGuard } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { eq, inArray } from 'drizzle-orm'
import { db, agents, agentExtraScopes, localDeployments, roleAssignments, squads } from '../db'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac } from '../test-utils/rbac'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { getLocalDeployment, isValidLocalDeploymentBrowserToken } from '../services/deploy/local-deployment-service'
import { SandboxHttpError } from '../services/sandbox/k8s/http-client'
import { createBrowserTools } from './browser'

describe('browser_open local deployment handoff', () => {
  let prefix: string
  let squadId: string
  let agentId: string
  let deploymentId: string
  let assignmentId: string
  let token: string
  let squadIds: string[]
  let agentIds: string[]
  let calls: Array<{ runId: string; url: string }>
  let open: ReturnType<typeof createBrowserTools>[number]
  let previousEnv: { APP_URL: string | undefined; FICUS_APPS_DOMAIN: string | undefined }

  async function createSquad() {
    const [row] = await db
      .insert(squads)
      .values({ name: `${prefix}-squad`, purpose: 'Synthetic browser test' })
      .returning()
    squadIds.push(row.id)
    return row.id
  }

  function toolsFor(callerId: string, fail = false) {
    return createBrowserTools(
      callerId,
      'browser-fixture',
      () =>
        ({
          getBrowserBackend: () => ({
            async browserOpen(runId: string, url: string) {
              calls.push({ runId, url })
              if (fail) throw new SandboxHttpError(`page.goto: failed navigating to ${url}`, 500)
              // A title can echo location.href. Neither it nor a navigation error
              // may reflect the internally resolved credential into the transcript.
              return { title: url, screenshotBase64: 'SYNTHETIC_IMAGE' }
            },
          }),
        }) as any
    ).find((tool) => tool.name === 'browser_open')!
  }

  function execute(params: Record<string, unknown>, tool = open) {
    return tool.execute('synthetic-call', params, undefined, undefined, {} as any)
  }

  async function expectDenied(params: Record<string, unknown>, tool = open) {
    const result = await execute(params, tool)
    expect(result.details).toHaveProperty('error')
    expect(JSON.stringify(result)).not.toContain(token)
    expect(calls).toHaveLength(0)
  }

  beforeEach(async () => {
    prefix = `browser-deploy-${crypto.randomUUID()}`
    squadIds = []
    agentIds = []
    calls = []
    previousEnv = { APP_URL: process.env.APP_URL, FICUS_APPS_DOMAIN: process.env.FICUS_APPS_DOMAIN }
    process.env.APP_URL = 'https://tenant.example.test'
    delete process.env.FICUS_APPS_DOMAIN
    squadId = await createSquad()
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['deployments:read'] })
    assignmentId = await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
    const [agent] = await db
      .insert(agents)
      .values({ agentTypeId: 'engineer', squadId, ownerUserId: user.id })
      .returning()
    agentId = agent.id
    agentIds.push(agentId)
    token = `synthetic-${crypto.randomUUID()}`
    const [deployment] = await db
      .insert(localDeployments)
      .values({
        squadId,
        sandboxId: `squad_${squadId}`,
        portScope: `sandbox:${squadId}`,
        name: 'synthetic-preview',
        port: 5173,
        targetHost: '127.0.0.1',
        browserAccessToken: token,
        status: 'running',
      })
      .returning()
    deploymentId = deployment.id
    open = toolsFor(agentId)
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
    if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
    await cleanupTestRbac(prefix)
    invalidatePermissionCache()
  })

  test('schema accepts deployment IDs without requiring a literal capability URL', () => {
    // ToolDefinition erases the concrete schema type using typebox v1. Verify
    // the actual @sinclair/typebox schema before using its matching validator.
    const schema = open.parameters
    if (!TypeGuard.IsSchema(schema)) throw new Error('Expected a TypeBox browser parameter schema')
    expect(Value.Check(schema, { localDeploymentId: deploymentId })).toBe(true)
    expect(Value.Check(schema, { url: 'https://example.test' })).toBe(true)
  })

  test('opens the exact current issued URL internally for an authorized caller without disclosing it', async () => {
    const deployment = await getLocalDeployment(deploymentId)
    const result = await execute({ localDeploymentId: deploymentId })
    expect(calls).toEqual([{ runId: agentId, url: new URL(deployment!.urlPathOrHost, process.env.APP_URL).href }])
    expect(
      await isValidLocalDeploymentBrowserToken(deploymentId, new URL(calls[0].url).searchParams.get('_tau_token'))
    ).toBe(true)
    expect(result.details).not.toHaveProperty('error')
    expect(result.content).toContainEqual({ type: 'image', data: 'SYNTHETIC_IMAGE', mimeType: 'image/png' })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('_tau_token')
  })

  test('uses the issued hosted app origin rather than concatenating APP_URL', async () => {
    process.env.FICUS_APPS_DOMAIN = 'apps.example.test'
    const result = await execute({ localDeploymentId: deploymentId })
    expect(result.details).not.toHaveProperty('error')
    const url = new URL(calls[0].url)
    expect(url.origin).toBe(`https://tenant--${deploymentId.replaceAll('-', '').slice(0, 12)}.apps.example.test`)
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('_tau_token')).toBe(token)
  })

  test('does not pass caller-supplied identity or origin overrides to privileged resolution', async () => {
    await db.delete(roleAssignments).where(eq(roleAssignments.id, assignmentId))
    invalidatePermissionCache()
    await expectDenied({
      localDeploymentId: deploymentId,
      agentId: crypto.randomUUID(),
      squadId,
      baseUrl: 'https://attacker.test',
    })
  })

  test('rejects a deployment in a squad the caller cannot read', async () => {
    const otherSquadId = await createSquad()
    await db.update(localDeployments).set({ squadId: otherSquadId }).where(eq(localDeployments.id, deploymentId))
    await expectDenied({ localDeploymentId: deploymentId })
  })

  test('uses a squad worker grant only in its own squad', async () => {
    await db.update(agents).set({ ownerUserId: null }).where(eq(agents.id, agentId))
    await db.insert(agentExtraScopes).values({ agentId, permission: 'deployments:read' })
    const result = await execute({ localDeploymentId: deploymentId })
    expect(result.details).not.toHaveProperty('error')
    expect(calls).toHaveLength(1)
    calls.length = 0
    const otherSquadId = await createSquad()
    await db.update(localDeployments).set({ squadId: otherSquadId }).where(eq(localDeployments.id, deploymentId))
    await expectDenied({ localDeploymentId: deploymentId })
  })

  test('rechecks permission on each call instead of retaining an earlier grant', async () => {
    await execute({ localDeploymentId: deploymentId })
    expect(calls).toHaveLength(1)
    calls.length = 0
    await db.delete(roleAssignments).where(eq(roleAssignments.id, assignmentId))
    invalidatePermissionCache()
    await expectDenied({ localDeploymentId: deploymentId })
  })

  test('rejects a missing calling agent', async () => {
    await expectDenied({ localDeploymentId: deploymentId }, toolsFor(crypto.randomUUID()))
  })

  test('rejects a caller that is no longer live', async () => {
    await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, agentId))
    await expectDenied({ localDeploymentId: deploymentId })
  })

  test('honors a live child agent authority and rejects a terminated parent', async () => {
    const [child] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId, parentAgentId: agentId })
      .returning()
    agentIds.push(child.id)
    const childTool = toolsFor(child.id)
    const result = await execute({ localDeploymentId: deploymentId }, childTool)
    expect(result.details).not.toHaveProperty('error')
    expect(calls[0].runId).toBe(child.id)
    calls.length = 0
    await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, agentId))
    await expectDenied({ localDeploymentId: deploymentId }, childTool)
  })

  test.each(['', 'not-a-uuid', '%', 'https://attacker.test/app', '../../auth'])(
    'rejects invalid deployment selector %s',
    async (id) => {
      await expectDenied({ localDeploymentId: id })
    }
  )

  test('rejects UUID prefixes rather than performing a privileged prefix lookup', async () => {
    await expectDenied({ localDeploymentId: deploymentId.slice(0, 8) })
  })

  test('rejects a nonexistent deployment', async () => {
    await expectDenied({ localDeploymentId: crypto.randomUUID() })
  })

  test.each([
    { archivedAt: new Date() },
    { status: 'stopped' as const },
    { expiresAt: new Date(0) },
    { browserAccessToken: null },
  ])('rejects an unavailable deployment (%j)', async (change) => {
    await db.update(localDeployments).set(change).where(eq(localDeployments.id, deploymentId))
    await expectDenied({ localDeploymentId: deploymentId })
  })

  test('rechecks deployment state after a successful navigation', async () => {
    await execute({ localDeploymentId: deploymentId })
    expect(calls).toHaveLength(1)
    calls.length = 0
    await db.update(localDeployments).set({ archivedAt: new Date() }).where(eq(localDeployments.id, deploymentId))
    await expectDenied({ localDeploymentId: deploymentId })
  })

  test.each([undefined, 'not a URL', 'file:///tmp/app', 'https://user:password@example.test'])(
    'fails closed for unusable APP_URL (%s)',
    async (origin) => {
      if (origin === undefined) delete process.env.APP_URL
      else process.env.APP_URL = origin
      await expectDenied({ localDeploymentId: deploymentId })
    }
  )

  test('requires exactly one navigation selector', async () => {
    await expectDenied({})
    await expectDenied({ localDeploymentId: deploymentId, url: 'https://attacker.test' })
  })

  test('does not disclose internally resolved URLs in backend failure messages or details', async () => {
    const result = await execute({ localDeploymentId: deploymentId }, toolsFor(agentId, true))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(token)
    expect(result.details).toHaveProperty('error')
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('_tau_token')
  })
})
