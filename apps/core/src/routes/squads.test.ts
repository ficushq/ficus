import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test'
import { like, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { squadsRouter } from './squads'
import { Squad } from '../entities/Squad'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { db, squads, squadPresets, agents } from '../db'
import { sandboxToolchainActivations, sandboxToolchainProvisions } from '../db/schema'
import {
  createLocalDeployment,
  getLocalDeployment,
  updateLocalDeploymentRecord,
} from '../services/deploy/local-deployment-service'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { insertMachine, deleteMachine } from '../services/machines/queries'
import { eventEmitter } from '../lib/infra/event-emitter'
import { ensureSquadWorkspace } from '../services/squad/workspace'
import {
  clearHostWorkspaceOverrides,
  getHostWorkspaceOverride,
  setHostWorkspaceOverride,
} from '../services/sandbox/host/workspace-overrides'
import * as sandboxFactory from '../services/sandbox/factory'
import * as sandboxPrewarm from '../services/sandbox/prewarm'
import { getHomeDir } from '../lib/utils/home'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)

// Shared admin for all tests — random slug so hasAdminUsers() won't see it
const prefix = `sq-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

describe('squads routes', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  it('validates typed event predicates on PATCH and preserves metadata when rejected', async () => {
    const squad = await Squad.create({ name: `${testPrefix} event predicates`, purpose: 'Test' })
    const rule = {
      id: 'typed',
      source: { integration: 'github', output: 'issue.assigned', version: 1 },
      filters: { audience: 'any' },
      predicates: [{ field: 'issue.number', op: 'gte', value: 15 }],
      action: { type: 'ignore' },
    }
    const patch = (rules: unknown[]) =>
      app.request(`/api/squads/${squad.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { integrationRules: { github: rules } } }),
      })
    expect((await patch([rule])).status).toBe(200)
    for (const predicate of [
      { field: 'body', op: 'eq', value: 'secret' },
      { field: 'issue.number', op: 'regex', value: 15 },
      { field: 'issue.number', op: 'gte', value: '15' },
      { field: 'pullRequest.number', op: 'eq', value: 15 },
    ])
      expect((await patch([{ ...rule, predicates: [predicate] }])).status).toBe(400)
    const [stored] = await db.select().from(squads).where(eq(squads.id, squad.id))
    expect(stored!.metadata).toMatchObject({ integrationRules: { github: [rule] } })
    expect(
      (
        await app.request(`/api/squads/${squad.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: { integrationRules: { github: [rule] } } }),
        })
      ).status
    ).toBe(401)
  })

  describe('JSON body migrations', () => {
    it('distinguishes absent optional source config from malformed JSON', async () => {
      const squad = await Squad.create({ name: `${testPrefix} JSON optional`, purpose: 'JSON test' })
      const path = `/api/squads/${squad.id}/source-configs/github`
      const absent = await app.request(path, { method: 'PUT', headers: authHeaders(admin.token) })
      expect(absent.status).toBe(200)

      const malformed = await app.request(path, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: '{',
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'Invalid JSON body' })
    })

    it('normalizes malformed required bulk-termination and avatar bodies', async () => {
      const squad = await Squad.create({ name: `${testPrefix} JSON required`, purpose: 'JSON test' })
      for (const path of [`/api/squads/${squad.id}/agents/terminate-bulk`, `/api/squads/${squad.id}/avatar`]) {
        const response = await app.request(path, {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: '{',
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
      }
    })
  })

  describe('squad attention subscription', () => {
    it('defaults to show/show, upserts explicit levels, and resets on delete', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Attention`, purpose: 'Testing' })
      const get = () => app.request(`/api/squads/${squad.id}/subscription`, { headers: authHeaders(admin.token) })

      expect(await (await get()).json()).toEqual({
        subscribed: false,
        count: 0,
        attention: { decisions: 'show', progress: 'show' },
      })

      const watched = await app.request(`/api/squads/${squad.id}/subscribe`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(watched.status).toBe(200)
      expect(await watched.json()).toEqual({
        subscribed: true,
        count: 1,
        attention: { decisions: 'notify', progress: 'notify' },
      })

      const tuned = await app.request(`/api/squads/${squad.id}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ attention: { decisions: 'notify', progress: 'mute' } }),
      })
      expect(await tuned.json()).toEqual({
        subscribed: true,
        count: 1,
        attention: { decisions: 'notify', progress: 'mute' },
      })
      expect(await (await get()).json()).toMatchObject({ attention: { decisions: 'notify', progress: 'mute' } })

      const removed = await app.request(`/api/squads/${squad.id}/subscribe`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(await removed.json()).toEqual({
        subscribed: false,
        count: 0,
        attention: { decisions: 'show', progress: 'show' },
      })
    })

    it('rejects a malformed attention body without changing the row', async () => {
      const squad = await Squad.create({ name: `${testPrefix} BadAttention`, purpose: 'Testing' })
      for (const attention of [{ decisions: 'loud', progress: 'mute' }, { decisions: 'mute' }, 'mute']) {
        const response = await app.request(`/api/squads/${squad.id}/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ attention }),
        })
        expect(response.status).toBe(400)
      }
      const current = await app.request(`/api/squads/${squad.id}/subscription`, { headers: authHeaders(admin.token) })
      expect(await current.json()).toMatchObject({ subscribed: false })
    })
  })

  describe('squad creation options and host workspace', () => {
    let previousRuntime: string | undefined

    beforeEach(() => {
      previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
    })

    afterEach(() => {
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
      clearHostWorkspaceOverrides()
    })

    it('reports host runtime and the real default workspace pattern', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const response = await app.request('/api/squads/create-options', { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        runtime: 'host',
        defaultHostWorkspaceRoot: join(getHomeDir(), 'workspaces', 'squads'),
      })
    })

    it('normalizes a host workspace before persisting it', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const root = mkdtempSync(join(tmpdir(), 'tau-create-squad-normalize-'))
      const rawWorkspace = `${root}//nested/./workspace/`
      try {
        const response = await app.request('/api/squads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({
            name: `${testPrefix} normalized cwd`,
            purpose: 'test',
            hostWorkspacePath: rawWorkspace,
          }),
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { id: string; hostWorkspacePath: string }
        expect(body.hostWorkspacePath).toBe(resolve(rawWorkspace))

        writeFileSync(join(body.hostWorkspacePath, 'README.md'), 'normalized workspace')
        const fileResponse = await app.request(`/api/squads/${body.id}/workspace/file?path=README.md`, {
          headers: authHeaders(admin.token),
        })
        expect(fileResponse.status).toBe(200)
        expect((await fileResponse.json()).content).toBe('normalized workspace')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects the displayed default-path placeholder', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const workspace = join(getHomeDir(), 'workspaces', 'squads', '<new squad id>')
      const response = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: `${testPrefix} placeholder cwd`, purpose: 'test', hostWorkspacePath: workspace }),
      })
      expect(response.status).toBe(400)
      expect(existsSync(workspace)).toBe(false)
    })

    it('removes newly-created directories and the override cache entry when squad creation fails', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const root = mkdtempSync(join(tmpdir(), 'tau-create-squad-rollback-'))
      const workspace = join(root, 'nested', 'workspace')
      const name = `${testPrefix} failed cwd`
      const createAgent = spyOn(Agent, 'create').mockRejectedValueOnce(new Error('manager creation failed'))
      try {
        const response = await app.request('/api/squads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ name, purpose: 'test', hostWorkspacePath: workspace }),
        })
        expect(response.status).toBe(500)
        expect(existsSync(workspace)).toBe(false)
        const [row] = await db.select({ id: squads.id }).from(squads).where(eq(squads.name, name))
        expect(row).toBeDefined()
        expect(getHostWorkspaceOverride(row!.id)).toBeUndefined()
      } finally {
        createAgent.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('creates and persists a usable host workspace override', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const root = mkdtempSync(join(tmpdir(), 'tau-create-squad-workspace-'))
      const workspace = join(root, 'nested', 'workspace')
      try {
        const response = await app.request('/api/squads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ name: `${testPrefix} host cwd`, purpose: 'test', hostWorkspacePath: workspace }),
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { id: string; hostWorkspacePath: string }
        expect(body.hostWorkspacePath).toBe(workspace)
        expect(getHostWorkspaceOverride(body.id)).toBe(workspace)
        expect(statSync(workspace).isDirectory()).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects host workspace overrides outside host runtime', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      const response = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: `${testPrefix} docker cwd`, purpose: 'test', hostWorkspacePath: '/tmp/x' }),
      })
      expect(response.status).toBe(400)
    })

    it('rejects a host workspace path that is an existing file', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const root = mkdtempSync(join(tmpdir(), 'tau-create-squad-file-'))
      const workspace = join(root, 'file')
      writeFileSync(workspace, 'not a directory')
      try {
        const response = await app.request('/api/squads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ name: `${testPrefix} invalid cwd`, purpose: 'test', hostWorkspacePath: workspace }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Host workspace path is not a directory' })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  // ── RBAC: denial tests ───────────────────────────────────────────────────────

  describe('RBAC: 403 for unprivileged identity', () => {
    let noPermsUser: TestUser
    let testSquad: Squad

    beforeEach(async () => {
      noPermsUser = await createTestUser({ prefix: `${testPrefix}-noperms` })
      testSquad = await Squad.create({ name: `${testPrefix} RBAC Squad`, purpose: 'RBAC test' })
    })

    afterEach(async () => {
      await db.delete(squads).where(eq(squads.id, testSquad.id))
      // cleanup the no-perms user's session — cleanupTestRbac will handle role rows
      await cleanupTestRbac(`${testPrefix}-noperms`)
    })

    it('denies POST /api/squads (squads:create) to user with no permissions', async () => {
      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(noPermsUser.token) },
        body: JSON.stringify({ name: `${testPrefix} Denied Squad`, purpose: 'Should be denied' }),
      })
      expect(res.status).toBe(403)
    })

    it('denies GET /api/squads/:id (squads:read) to user with no permissions', async () => {
      const res = await app.request(`/api/squads/${testSquad.id}`, {
        headers: authHeaders(noPermsUser.token),
      })
      expect(res.status).toBe(403)
    })

    it('denies PATCH /api/squads/:id (squads:update) to user with no permissions', async () => {
      const res = await app.request(`/api/squads/${testSquad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(noPermsUser.token) },
        body: JSON.stringify({ name: `${testPrefix} Patched` }),
      })
      expect(res.status).toBe(403)
    })

    it('denies DELETE /api/squads/:id (squads:delete) to user with no permissions', async () => {
      const res = await app.request(`/api/squads/${testSquad.id}`, {
        method: 'DELETE',
        headers: authHeaders(noPermsUser.token),
      })
      expect(res.status).toBe(403)
    })

    it('denies POST /api/squads/cleanup-agents (system:cleanup) to user with no permissions', async () => {
      const res = await app.request('/api/squads/cleanup-agents', {
        method: 'POST',
        headers: authHeaders(noPermsUser.token),
      })
      expect(res.status).toBe(403)
    })

    it('denies GET /api/squads/:id/agents (agents:read) to user with no permissions', async () => {
      const res = await app.request(`/api/squads/${testSquad.id}/agents`, {
        headers: authHeaders(noPermsUser.token),
      })
      expect(res.status).toBe(403)
    })

    it('denies GET /api/squads/:id/sandbox/status to user with no permissions', async () => {
      const res = await app.request(`/api/squads/${testSquad.id}/sandbox/status`, {
        headers: authHeaders(noPermsUser.token),
      })
      expect(res.status).toBe(403)
    })

    it('denies GET /api/squads (filtered list) with no token → 401', async () => {
      const res = await app.request('/api/squads')
      expect(res.status).toBe(401)
    })
  })

  // ── RBAC: positive tests ─────────────────────────────────────────────────────

  describe('RBAC: 200 for privileged identity', () => {
    let testSquad: Squad

    beforeEach(async () => {
      testSquad = await Squad.create({ name: `${testPrefix} RBAC Positive Squad`, purpose: 'RBAC positive test' })
    })

    afterEach(async () => {
      await db.delete(squads).where(eq(squads.id, testSquad.id))
    })

    it('allows GET /api/squads for admin (filtered list)', async () => {
      const res = await app.request('/api/squads', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const list = await res.json()
      expect(Array.isArray(list)).toBe(true)
    })

    it('allows GET /api/squads/:id for admin', async () => {
      const res = await app.request(`/api/squads/${testSquad.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(testSquad.id)
    })

    it('allows POST /api/squads for admin', async () => {
      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: `${testPrefix} Admin Created`, purpose: 'Admin test' }),
      })
      expect(res.status).toBe(201)
    })

    it('allows PATCH /api/squads/reorder without specific permission (just authenticated)', async () => {
      const s1 = await Squad.create({ name: `${testPrefix} Reorder A`, purpose: 'A' })
      const s2 = await Squad.create({ name: `${testPrefix} Reorder B`, purpose: 'B' })
      const res = await app.request('/api/squads/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ ids: [s2.id, s1.id] }),
      })
      expect(res.status).toBe(200)
      await db.delete(squads).where(eq(squads.id, s1.id))
      await db.delete(squads).where(eq(squads.id, s2.id))
    })
  })

  // ── Existing functional tests (now require auth) ──────────────────────────────

  describe('POST /api/squads', () => {
    it('creates a squad', async () => {
      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          name: `${testPrefix} Mobile Team`,
          purpose: 'Mobile app development',
        }),
      })

      expect(res.status).toBe(201)
      const squad = await res.json()
      expect(squad.name).toBe(`${testPrefix} Mobile Team`)
      expect(squad.status).toBe('active')
    })

    it('creates squad with optional fields', async () => {
      // Insert squad preset for FK reference
      await db.insert(squadPresets).values({ id: 'engineering-squad', name: 'Engineering Squad' }).onConflictDoNothing()

      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          name: `${testPrefix} Backend Team`,
          purpose: 'Backend services',
          squadPresetId: 'engineering-squad',
          defaultAgents: ['architect'],
          context: 'Additional context for squad agents.',
        }),
      })

      expect(res.status).toBe(201)
      const squad = await res.json()
      expect(squad.squadPresetId).toBe('engineering-squad')
      expect(squad.defaultAgents).toEqual(['architect'])
      expect(squad.context).toBe('Additional context for squad agents.')
    })

    it('returns 400 for missing name', async () => {
      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ purpose: 'No name' }),
      })

      expect(res.status).toBe(400)
    })

    it('creates a squad with an optional omitted purpose', async () => {
      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: `${testPrefix} No Purpose` }),
      })

      expect(res.status).toBe(201)
      const squad = await res.json()
      expect(squad.purpose).toBe('')
      expect((await Squad.mustFind(squad.id)).purpose).toBe('')
    })
  })

  describe('GET /api/squads', () => {
    it('lists all squads', async () => {
      await Squad.create({ name: `${testPrefix} Squad 1`, purpose: 'Purpose 1' })
      await Squad.create({ name: `${testPrefix} Squad 2`, purpose: 'Purpose 2' })

      const res = await app.request('/api/squads', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const list = await res.json()
      const ours = list.filter((s: any) => s.name.startsWith(testPrefix))
      expect(ours.length).toBe(2)
    })

    it('filters by status', async () => {
      const s1 = await Squad.create({ name: `${testPrefix} Active`, purpose: 'Active' })
      const s2 = await Squad.create({ name: `${testPrefix} Paused`, purpose: 'Paused' })

      // Update s2 to paused via API
      await app.request(`/api/squads/${s2.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ status: 'paused' }),
      })

      const res = await app.request('/api/squads?status=active', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const list = await res.json()
      const ours = list.filter((s: any) => s.name.startsWith(testPrefix))
      expect(ours.length).toBe(1)
      expect(ours[0].name).toBe(`${testPrefix} Active`)
    })
  })

  describe('GET /api/squads/:id', () => {
    it('returns squad by id', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Test`,
        purpose: 'Testing',
      })

      const res = await app.request(`/api/squads/${created.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const squad = await res.json()
      expect(squad.name).toBe(`${testPrefix} Test`)
    })

    /**
     * A squad-scoped role is the only grant this user has, so the guard must ask about THIS squad.
     * Asking about the raw route param instead made the short-prefix form a 403 (the prefix
     * matches no `squad_id`, so the squad-scoped grant was invisible) while the full id worked.
     */
    it('honours a squad-scoped grant through both the full id and a short prefix', async () => {
      const created = await Squad.create({ name: `${testPrefix} Scoped`, purpose: 'Testing' })
      const member = await createTestUser({ prefix: testPrefix })
      const role = await createTestRole({ prefix: testPrefix, permissions: ['squads:read'] })
      await assignRole({ userId: member.id, roleId: role.id, scope: 'squad', squadId: created.id })

      for (const id of [created.id, created.id.slice(0, 8)]) {
        const res = await app.request(`/api/squads/${id}`, { headers: authHeaders(member.token) })
        expect(res.status).toBe(200)
        expect((await res.json()).id).toBe(created.id)
      }

      // The grant is scoped: another squad stays forbidden through either form.
      const other = await Squad.create({ name: `${testPrefix} Unscoped`, purpose: 'Testing' })
      for (const id of [other.id, other.id.slice(0, 8)]) {
        const res = await app.request(`/api/squads/${id}`, { headers: authHeaders(member.token) })
        expect(res.status).toBe(403)
      }
    })

    it('supports short id prefix', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Prefix`,
        purpose: 'Testing',
      })

      const prefix = created.id.slice(0, 8)
      const res = await app.request(`/api/squads/${prefix}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const squad = await res.json()
      expect(squad.id).toBe(created.id)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Squad not found')
    })
  })

  describe('PATCH /api/squads/:id', () => {
    it('updates squad', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Original`,
        purpose: 'Original purpose',
      })

      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: `${testPrefix} Updated` }),
      })

      expect(res.status).toBe(200)
      const updated = await res.json()
      expect(updated.name).toBe(`${testPrefix} Updated`)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: 'New Name' }),
      })

      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid data', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Invalid`,
        purpose: 'Testing',
      })

      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ status: 'invalid-status' }),
      })

      expect(res.status).toBe(400)
    })

    it('accepts githubIdentity secret-key metadata without exposing token values', async () => {
      const created = await Squad.create({
        name: `${testPrefix} GitHub Identity`,
        purpose: 'Testing',
      })

      const metadata = {
        custom: { preserved: true },
        githubIdentity: {
          githubTokenSecretKey: 'SQUAD_GITHUB_TOKEN',
          gitUserName: 'Squad Bot',
          gitUserEmail: 'squad-bot@example.com',
        },
      }

      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ metadata }),
      })

      expect(res.status).toBe(200)
      const updated = await res.json()
      expect(updated.metadata).toEqual(metadata)
    })

    it('rejects plaintext github token metadata and invalid identity values', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Bad GitHub Identity`,
        purpose: 'Testing',
      })

      const plaintextTokenRes = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ metadata: { githubIdentity: { githubToken: 'ghp_plaintext' } } }),
      })
      expect(plaintextTokenRes.status).toBe(400)

      const invalidEmailRes = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ metadata: { githubIdentity: { gitUserEmail: 'not-an-email' } } }),
      })
      expect(invalidEmailRes.status).toBe(400)
    })
  })

  describe('DELETE /api/squads/:id', () => {
    it('deletes squad', async () => {
      const created = await Squad.create({
        name: `${testPrefix} To Delete`,
        purpose: 'Will be deleted',
      })

      const deleteRes = await app.request(`/api/squads/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(deleteRes.status).toBe(204)

      const getRes = await app.request(`/api/squads/${created.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(getRes.status).toBe(404)

      // Soft-delete: the row still exists with archivedAt set
      const [row] = await db.select().from(squads).where(eq(squads.id, created.id))
      expect(row).toBeDefined()
      expect(row.archivedAt).not.toBeNull()
    })

    it('returns 410 when PATCHing an archived squad', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Archived Patch`,
        purpose: 'Will be archived',
      })

      const deleteRes = await app.request(`/api/squads/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(deleteRes.status).toBe(204)

      const patchRes = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ purpose: 'new purpose' }),
      })
      expect(patchRes.status).toBe(410)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/squads/reorder', () => {
    it('reorders squads', async () => {
      const s1 = await Squad.create({ name: `${testPrefix} Squad A`, purpose: 'A' })
      const s2 = await Squad.create({ name: `${testPrefix} Squad B`, purpose: 'B' })
      const s3 = await Squad.create({ name: `${testPrefix} Squad C`, purpose: 'C' })

      // Reorder: C, A, B
      const res = await app.request('/api/squads/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ ids: [s3.id, s1.id, s2.id] }),
      })

      expect(res.status).toBe(200)
      const updated = await res.json()
      expect(updated).toHaveLength(3)

      // Verify order values
      const orderedById = new Map(updated.map((s: any) => [s.id, s.order]))
      expect(orderedById.get(s3.id)).toBe(0)
      expect(orderedById.get(s1.id)).toBe(1)
      expect(orderedById.get(s2.id)).toBe(2)
    })

    it('returns squads in new order when listing', async () => {
      const s1 = await Squad.create({ name: `${testPrefix} First`, purpose: 'A' })
      const s2 = await Squad.create({ name: `${testPrefix} Second`, purpose: 'B' })

      // Set s2 to come first
      await app.request('/api/squads/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ ids: [s2.id, s1.id] }),
      })

      const res = await app.request('/api/squads', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const list = await res.json()
      const ours = list.filter((s: any) => s.name.startsWith(testPrefix))

      // s2 should come before s1
      const s1Idx = ours.findIndex((s: any) => s.id === s1.id)
      const s2Idx = ours.findIndex((s: any) => s.id === s2.id)
      expect(s2Idx).toBeLessThan(s1Idx)
    })

    it('returns 400 for empty ids array', async () => {
      const res = await app.request('/api/squads/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ ids: [] }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid uuid', async () => {
      const res = await app.request('/api/squads/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ ids: ['not-a-uuid'] }),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/squads/:id/workspace/tree', () => {
    it('returns workspace tree', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Workspace Test`,
        purpose: 'Testing workspace',
      })

      ensureSquadWorkspace(created.id)
      const res = await app.request(`/api/squads/${created.id}/workspace/tree`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const tree = await res.json()
      expect(tree.type).toBe('directory')
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/workspace/tree', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/squads/:id/memory/tree', () => {
    it('returns seeded memory tree', async () => {
      const created = await Squad.create({ name: `${testPrefix} Memory Tree Test`, purpose: 'Testing memory' })

      const res = await app.request(`/api/squads/${created.id}/memory/tree?path=/memory&depth=1`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const tree = await res.json()
      expect(tree).toMatchObject({ name: 'memory', type: 'directory' })
      expect(tree.children.some((child: any) => child.name === 'context.md')).toBe(true)
      expect(tree.children.some((child: any) => child.name === 'map.md')).toBe(true)
    })

    it('rejects out-of-vault paths and missing squads', async () => {
      const created = await Squad.create({ name: `${testPrefix} Memory Invalid Tree Test`, purpose: 'Testing memory' })

      const invalidRes = await app.request(
        `/api/squads/${created.id}/memory/tree?path=${encodeURIComponent('/workspace')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(invalidRes.status).toBe(400)

      const missingRes = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/memory/tree', {
        headers: authHeaders(admin.token),
      })
      expect(missingRes.status).toBe(404)
    })
  })

  describe('GET /api/squads/:id/memory/download', () => {
    it('downloads seeded memory file content with the correct filename', async () => {
      const created = await Squad.create({ name: `${testPrefix} Memory Download Test`, purpose: 'Testing memory' })

      const res = await app.request(
        `/api/squads/${created.id}/memory/download?path=${encodeURIComponent('/memory/context.md')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="context.md"')
      expect(await res.text()).toContain('# Squad Context')
    })

    it('rejects invalid download paths and missing squads', async () => {
      const created = await Squad.create({
        name: `${testPrefix} Memory Invalid Download Test`,
        purpose: 'Testing memory',
      })

      const invalidRes = await app.request(
        `/api/squads/${created.id}/memory/download?path=${encodeURIComponent('/memory/../secret.md')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(invalidRes.status).toBe(400)

      const missingRes = await app.request(
        `/api/squads/00000000-0000-0000-0000-000000000000/memory/download?path=${encodeURIComponent('/memory/context.md')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(missingRes.status).toBe(404)
    })
  })

  describe('GET /api/squads/:id/memory/file', () => {
    it('returns seeded memory file content', async () => {
      const created = await Squad.create({ name: `${testPrefix} Memory File Test`, purpose: 'Testing memory' })

      const res = await app.request(
        `/api/squads/${created.id}/memory/file?path=${encodeURIComponent('/memory/context.md')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(res.status).toBe(200)
      const file = await res.json()
      expect(file.path).toBe('/memory/context.md')
      expect(file.binary).toBe(false)
      expect(file.content).toContain('# Squad Context')
    })

    it('rejects invalid memory file paths and missing squads', async () => {
      const created = await Squad.create({ name: `${testPrefix} Memory Invalid File Test`, purpose: 'Testing memory' })

      const invalidRes = await app.request(
        `/api/squads/${created.id}/memory/file?path=${encodeURIComponent('/memory/../secret.md')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(invalidRes.status).toBe(400)

      const missingRes = await app.request(
        `/api/squads/00000000-0000-0000-0000-000000000000/memory/file?path=${encodeURIComponent('/memory/context.md')}`,
        { headers: authHeaders(admin.token) }
      )
      expect(missingRes.status).toBe(404)
    })
  })

  describe('POST /api/squads/:id/spawn', () => {
    it('persists model overrides', async () => {
      const agentTypeId = `${testPrefix}-agent-type`
      await AgentType.create({
        id: agentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Override Test Agent',
        systemPrompt: 'You are a test agent.',
      })
      const squad = await Squad.create({ name: `${testPrefix} Spawn Team`, purpose: 'Test spawning' })

      const res = await app.request(`/api/squads/${squad.id}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          agentTypeId,
          model: 'anthropic:claude-sonnet-4-5:high',
        }),
      })

      expect(res.status).toBe(201)
      const agent = await res.json()
      expect(agent.modelOverride).toBe('anthropic:claude-sonnet-4-5:high')
      expect(agent.configuredModel).toBe('anthropic:claude-sonnet-4-5:high')
    })
  })

  describe('DELETE /api/squads/:id/agents/:agentId', () => {
    afterEach(async () => {
      const testSquads = await db
        .select()
        .from(squads)
        .where(like(squads.name, `${testPrefix}%`))
      for (const squad of testSquads) {
        await db.delete(agents).where(eq(agents.squadId, squad.id))
      }
      await cleanupTestRbac(`${testPrefix}-agent-delete`)
    })

    it('denies unauthenticated agent termination', async () => {
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      const squad = await Squad.create({ name: `${testPrefix} Delete Unauth`, purpose: 'delete auth test' })
      const agent = await squad.spawnAgent('engineer')

      const res = await app.request(`/api/squads/${squad.id}/agents/${agent.id}`, { method: 'DELETE' })

      expect(res.status).toBe(401)
    })

    it.each([
      ['dormant', 'AGENT_ALREADY_DORMANT'],
      ['terminated', 'AGENT_TERMINATED'],
    ] as const)('returns typed 409 for an already %s agent', async (status, code) => {
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      const squad = await Squad.create({ name: `${testPrefix} Repeat ${status}`, purpose: 'repeat terminate test' })
      const agent = await squad.spawnAgent('engineer')
      await db
        .update(agents)
        .set({ status, ...(status === 'dormant' ? { dormantAt: new Date() } : { terminatedAt: new Date() }) })
        .where(eq(agents.id, agent.id))

      const res = await app.request(`/api/squads/${squad.id}/agents/${agent.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code })
    })

    it('denies terminating an agent through another squad route', async () => {
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      const allowedSquad = await Squad.create({ name: `${testPrefix} Delete Allowed`, purpose: 'delete auth test' })
      const otherSquad = await Squad.create({ name: `${testPrefix} Delete Other`, purpose: 'delete auth test' })
      const otherAgent = await otherSquad.spawnAgent('engineer')
      const user = await createTestUser({ prefix: `${testPrefix}-agent-delete` })
      const role = await createTestRole({ prefix: `${testPrefix}-agent-delete`, permissions: ['agents:terminate'] })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: allowedSquad.id })

      const res = await app.request(`/api/squads/${allowedSquad.id}/agents/${otherAgent.id}`, {
        method: 'DELETE',
        headers: authHeaders(user.token),
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Agent does not belong to this squad' })
      expect((await Agent.find(otherAgent.id))?.terminatedAt).toBeNull()
    })
  })

  describe('POST /api/squads/:id/agents/terminate-bulk', () => {
    afterEach(async () => {
      const testSquads = await db
        .select()
        .from(squads)
        .where(like(squads.name, `${testPrefix}%`))
      for (const squad of testSquads) {
        await db.delete(agents).where(eq(agents.squadId, squad.id))
      }
      await cleanupTestRbac(`${testPrefix}-bulk-terminate`)
    })

    it('denies unauthenticated bulk termination', async () => {
      await AgentType.upsert({
        id: 'consultant',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Consultant',
        systemPrompt: 'You are a consultant.',
      })
      const squad = await Squad.create({ name: `${testPrefix} Bulk Unauth`, purpose: 'bulk terminate auth test' })

      const res = await app.request(`/api/squads/${squad.id}/agents/terminate-bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentTypeId: 'consultant' }),
      })

      expect(res.status).toBe(401)
    })

    it('terminates only eligible agents of the given type and leaves other types untouched', async () => {
      await AgentType.upsert({
        id: 'consultant',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Consultant',
        systemPrompt: 'You are a consultant.',
      })
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      const squad = await Squad.create({ name: `${testPrefix} Bulk OK`, purpose: 'bulk terminate test' })
      const consultantOne = await squad.spawnAgent('consultant')
      const consultantTwo = await squad.spawnAgent('consultant')
      const engineer = await squad.spawnAgent('engineer')
      const alreadyTerminated = await squad.spawnAgent('consultant')
      await alreadyTerminated.update({ terminatedAt: new Date() })

      const user = await createTestUser({ prefix: `${testPrefix}-bulk-terminate` })
      const role = await createTestRole({ prefix: `${testPrefix}-bulk-terminate`, permissions: ['agents:terminate'] })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })

      const res = await app.request(`/api/squads/${squad.id}/agents/terminate-bulk`, {
        method: 'POST',
        headers: { ...authHeaders(user.token), 'content-type': 'application/json' },
        body: JSON.stringify({ agentTypeId: 'consultant' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        terminated: string[]
        deferred: string[]
        skipped: { id: string; reason: string }[]
      }
      expect(body.terminated.sort()).toEqual([consultantOne.id, consultantTwo.id].sort())
      expect(body.deferred).toEqual([])
      expect(body.skipped).toEqual([])
      expect(body.terminated).not.toContain(engineer.id)
      expect(body.terminated).not.toContain(alreadyTerminated.id)
      expect((await Agent.find(consultantOne.id))?.status).toBe('dormant')
      expect((await Agent.find(consultantTwo.id))?.status).toBe('dormant')
      expect((await Agent.find(consultantOne.id))?.terminatedAt).toBeNull()
      expect((await Agent.find(consultantTwo.id))?.terminatedAt).toBeNull()
      expect((await Agent.find(engineer.id))?.status).toBe('idle')
    })

    it('returns 400 when agentTypeId is missing', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Bulk Bad`, purpose: 'bulk terminate bad request test' })
      const user = await createTestUser({ prefix: `${testPrefix}-bulk-terminate` })
      const role = await createTestRole({ prefix: `${testPrefix}-bulk-terminate`, permissions: ['agents:terminate'] })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })

      const res = await app.request(`/api/squads/${squad.id}/agents/terminate-bulk`, {
        method: 'POST',
        headers: { ...authHeaders(user.token), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/squads/:id/agents', () => {
    afterEach(async () => {
      // Clean up agents created during tests
      const testSquads = await db
        .select()
        .from(squads)
        .where(like(squads.name, `${testPrefix}%`))
      for (const squad of testSquads) {
        await db.delete(agents).where(eq(agents.squadId, squad.id))
      }
    })

    it('returns agents for a squad', async () => {
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      const squad = await Squad.create({
        name: `${testPrefix} Agent Test`,
        purpose: 'Testing agents endpoint',
        defaultAgents: ['engineer'],
      })

      const engineer = await squad.spawnAgent('engineer', {
        model: 'anthropic:claude-sonnet-4-5:high',
      })
      const dormant = await squad.spawnAgent('engineer')
      await dormant.update({ status: 'dormant', dormantAt: new Date() })
      const terminated = await squad.spawnAgent('engineer', { model: 'anthropic:claude-sonnet-4-5:low' })
      await terminated.update({ status: 'terminated', terminatedAt: new Date() })

      const res = await app.request(`/api/squads/${squad.id}/agents?includeRecentlyTerminated=true`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      const agentList = (body as any).agents

      expect(agentList.length).toBeGreaterThanOrEqual(1)
      const engineerResult = agentList.find((a: any) => a.id === engineer.id)
      expect(engineerResult).toBeDefined()
      expect(engineerResult.agentTypeId).toBe('engineer')
      expect(engineerResult.modelOverride).toBe('anthropic:claude-sonnet-4-5:high')
      expect(engineerResult.configuredModel).toBe('anthropic:claude-sonnet-4-5:high')
      expect(agentList.find((a: any) => a.id === dormant.id)).toMatchObject({ status: 'dormant' })
      expect(agentList.find((a: any) => a.id === terminated.id)).toBeUndefined()

      const terminatedResult = (body as any).recentlyTerminated.find((a: any) => a.id === terminated.id)
      expect(terminatedResult).toBeDefined()
      expect(terminatedResult.modelOverride).toBe('anthropic:claude-sonnet-4-5:low')
      expect(terminatedResult.configuredModel).toBe('anthropic:claude-sonnet-4-5:low')
    })

    it('paginates recently terminated agents without limiting active agents', async () => {
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
      const squad = await Squad.create({
        name: `${testPrefix} Agent Pagination Test`,
        purpose: 'Testing terminated agent pagination',
        defaultAgents: ['engineer'],
      })

      const active = await squad.spawnAgent('engineer')
      const terminatedAt = new Date()
      const terminatedAgents = await db
        .insert(agents)
        .values(
          Array.from({ length: 25 }, (_, index) => ({
            agentTypeId: 'engineer',
            squadId: squad.id,
            status: 'terminated' as const,
            terminatedAt: new Date(terminatedAt.getTime() - index * 1000),
          }))
        )
        .returning({ id: agents.id, terminatedAt: agents.terminatedAt })
      const terminatedIds = terminatedAgents
        .sort((left, right) => right.terminatedAt!.getTime() - left.terminatedAt!.getTime())
        .map((agent) => agent.id)

      const firstPage = await app.request(
        `/api/squads/${squad.id}/agents?includeRecentlyTerminated=true&terminatedLimit=20&terminatedOffset=0`,
        { headers: authHeaders(admin.token) }
      )
      expect(firstPage.status).toBe(200)
      const firstBody = await firstPage.json()
      expect((firstBody as any).agents.map((agent: any) => agent.id)).toContain(active.id)
      expect((firstBody as any).recentlyTerminated.map((agent: any) => agent.id)).toEqual(terminatedIds.slice(0, 20))
      expect((firstBody as any).recentlyTerminatedTotalCount).toBe(25)
      expect((firstBody as any).recentlyTerminatedHasMore).toBe(true)

      const secondPage = await app.request(
        `/api/squads/${squad.id}/agents?includeRecentlyTerminated=true&terminatedLimit=20&terminatedOffset=20`,
        { headers: authHeaders(admin.token) }
      )
      expect(secondPage.status).toBe(200)
      const secondBody = await secondPage.json()
      expect((secondBody as any).recentlyTerminated.map((agent: any) => agent.id)).toEqual(terminatedIds.slice(20))
      expect((secondBody as any).recentlyTerminatedTotalCount).toBe(25)
      expect((secondBody as any).recentlyTerminatedHasMore).toBe(false)
    }, 15_000)

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/agents', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/squads/:id/workspace/file', () => {
    it('returns file from memory path', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Memory File Test`,
        purpose: 'Testing memory file reading',
      })

      // The squad should have a default context.md file in memory
      const res = await app.request(
        `/api/squads/${squad.id}/workspace/file?path=${encodeURIComponent('/memory/context.md')}`,
        { headers: authHeaders(admin.token) }
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe('/memory/context.md')
      expect(body.content).toContain('Squad Context')
      expect(body.binary).toBe(false)
      expect(body.size).toBeGreaterThan(0)
    })

    it('returns 404 for non-existent memory file', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Missing Memory`,
        purpose: 'Testing missing memory file',
      })

      const res = await app.request(
        `/api/squads/${squad.id}/workspace/file?path=${encodeURIComponent('/memory/does-not-exist.md')}`,
        { headers: authHeaders(admin.token) }
      )

      expect(res.status).toBe(404)
    })

    it('returns 400 for missing path parameter', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} No Path`,
        purpose: 'Testing missing path',
      })

      const res = await app.request(`/api/squads/${squad.id}/workspace/file`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('workspace file routes reject escapes out of a host workspace override', () => {
    let prevRuntime: string | undefined
    let overrideDir: string
    let siblingDir: string

    beforeEach(() => {
      prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      // An override like /srv/repo has a SIBLING /srv/repo-secrets whose path
      // is a string prefix match — the case a startsWith() boundary lets through.
      const base = mkdtempSync(join(tmpdir(), 'squad-route-override-'))
      overrideDir = join(base, 'repo')
      siblingDir = `${overrideDir}-secrets`
      mkdirSync(overrideDir, { recursive: true })
      mkdirSync(siblingDir, { recursive: true })
      writeFileSync(join(overrideDir, 'ok.txt'), 'inside')
      writeFileSync(join(siblingDir, 'secret.txt'), 'TOP SECRET')
    })

    afterEach(() => {
      clearHostWorkspaceOverrides()
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
      rmSync(join(overrideDir, '..'), { recursive: true, force: true })
    })

    const escapePath = () => `../${basename(overrideDir)}-secrets/secret.txt`

    it('rejects a sibling-directory escape on workspace/file but serves a normal path', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Override Escape`, purpose: 'boundary' })
      setHostWorkspaceOverride(squad.id, overrideDir)

      const escaped = await app.request(
        `/api/squads/${squad.id}/workspace/file?path=${encodeURIComponent(escapePath())}`,
        { headers: authHeaders(admin.token) }
      )
      expect([400, 403]).toContain(escaped.status)
      expect(JSON.stringify(await escaped.json())).not.toContain('TOP SECRET')

      const ok = await app.request(`/api/squads/${squad.id}/workspace/file?path=${encodeURIComponent('ok.txt')}`, {
        headers: authHeaders(admin.token),
      })
      expect(ok.status).toBe(200)
      expect((await ok.json()).content).toBe('inside')
    })

    it('rejects a sibling-directory escape on workspace/download but serves a normal path', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Override Escape DL`, purpose: 'boundary' })
      setHostWorkspaceOverride(squad.id, overrideDir)

      const escaped = await app.request(
        `/api/squads/${squad.id}/workspace/download?path=${encodeURIComponent(escapePath())}`,
        { headers: authHeaders(admin.token) }
      )
      expect([400, 403]).toContain(escaped.status)
      expect(await escaped.text()).not.toContain('TOP SECRET')

      const ok = await app.request(`/api/squads/${squad.id}/workspace/download?path=${encodeURIComponent('ok.txt')}`, {
        headers: authHeaders(admin.token),
      })
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('inside')
    })
  })

  describe('POST /api/squads/:id/sandbox/stop', () => {
    it('marks active sandbox localDeployments stopped when stopping sandbox', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Sandbox Stop`,
        purpose: 'Testing sandbox stop localDeployment cleanup',
      })
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

      const res = await app.request(`/api/squads/${squad.id}/sandbox/stop`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(200)
      const stopped = await getLocalDeployment(localDeployment.id)
      expect(stopped?.status).toBe('stopped')
      expect(stopped?.keepSandboxAlive).toBe(false)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/sandbox/stop', {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })
  })

  // On the host runtime there is no sandbox at all: HostSandboxManager keeps an
  // in-memory record only, so start/stop would lie and a managed toolchain has
  // nowhere to be provisioned. Reject before touching the manager.
  describe('host runtime sandbox route guards', () => {
    let squad: Squad
    let prevRuntime: string | undefined

    beforeEach(async () => {
      squad = await Squad.create({ name: `${testPrefix} host guard`, purpose: 'test' })
      prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
    })

    afterEach(() => {
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    })

    const post = (path: string) =>
      app.request(`/api/squads/${squad.id}${path}`, { method: 'POST', headers: authHeaders(admin.token) })

    it('rejects POST /sandbox/start with 400 and an explanation', async () => {
      const res = await post('/sandbox/start')
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'Not applicable on the host runtime: agents run directly on this machine and there is no sandbox to start or stop.'
      )
    })

    it('rejects POST /sandbox/stop with 400 and an explanation', async () => {
      const res = await post('/sandbox/stop')
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'Not applicable on the host runtime: agents run directly on this machine and there is no sandbox to start or stop.'
      )
    })

    it('rejects POST /toolchain/apply with 400 and an explanation', async () => {
      const res = await post('/toolchain/apply')
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'Not applicable on the host runtime: managed toolchains are not available when agents run directly on this machine.'
      )
    })

    // An unknown id is an unknown id on every runtime: answering 400 "not
    // applicable on host" for a squad that does not exist hides the real
    // mistake, so the guard runs BELOW the entity lookup.
    it.each(['/sandbox/start', '/sandbox/stop', '/toolchain/apply'])(
      'still 404s an unknown squad on POST %s',
      async (path) => {
        const res = await app.request(`/api/squads/00000000-0000-4000-8000-00000000dead${path}`, {
          method: 'POST',
          headers: authHeaders(admin.token),
        })
        expect(res.status).toBe(404)
      }
    )

    // There is no devbox on host, so a declared toolchain must not decorate the
    // payload with a status (or flip devboxReady) for a thing that cannot exist.
    it('GET /sandbox/status carries no toolchain decoration even when one is declared', async () => {
      const declared = await Squad.create({
        name: `${testPrefix} host toolchain status`,
        purpose: 'test',
        metadata: { sandbox: { toolchain: { packages: ['jq@latest'] } } },
      })
      const res = await app.request(`/api/squads/${declared.id}/sandbox/status`, { headers: authHeaders(admin.token) })
      const body = await res.json()
      expect(body.runtime).toBe('host')
      expect(body).not.toHaveProperty('toolchain')

      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      const docker = await (
        await app.request(`/api/squads/${declared.id}/sandbox/status`, { headers: authHeaders(admin.token) })
      ).json()
      expect(docker).toHaveProperty('toolchain')
    })

    // The declaration is still stored on host (so it applies if the deployment
    // ever moves to a sandboxed runtime) — but prewarming a sandbox that does
    // not exist is pure churn.
    it('PUT and DELETE /toolchain skip the sandbox prewarm', async () => {
      const prewarm = spyOn(sandboxPrewarm, 'prewarmSandboxBackground').mockImplementation(() => {})
      try {
        const put = await app.request(`/api/squads/${squad.id}/toolchain`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ packages: ['jq'] }),
        })
        expect(put.status).toBe(200)
        expect((await Squad.mustFind(squad.id)).toolchainConfig).toEqual({ packages: ['jq'] })

        const del = await app.request(`/api/squads/${squad.id}/toolchain`, {
          method: 'DELETE',
          headers: authHeaders(admin.token),
        })
        expect(del.status).toBe(200)
        expect(prewarm).not.toHaveBeenCalled()
      } finally {
        prewarm.mockRestore()
      }
    })

    it('leaves the docker runtime behaviour unchanged', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      expect((await post('/sandbox/stop')).status).toBe(200)
      expect((await post('/toolchain/apply')).status).toBe(202)
    })
  })

  describe('squad toolchain routes', () => {
    it('replaces and returns a validated durable declaration', async () => {
      const squad = await Squad.create({ name: `${testPrefix} toolchain`, purpose: 'test' })
      const put = await app.request(`/api/squads/${squad.id}/toolchain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ packages: ['python3@latest'], setupScript: 'echo ready' }),
      })
      expect(put.status).toBe(200)
      expect((await Squad.mustFind(squad.id)).toolchainConfig).toEqual({
        packages: ['python3@latest'],
        setupScript: 'echo ready',
      })
      expect(
        await db.select().from(sandboxToolchainProvisions).where(eq(sandboxToolchainProvisions.squadId, squad.id))
      ).toEqual([])
      expect(
        await db.select().from(sandboxToolchainActivations).where(eq(sandboxToolchainActivations.squadId, squad.id))
      ).toEqual([])

      const get = await app.request(`/api/squads/${squad.id}/toolchain`, { headers: authHeaders(admin.token) })
      expect(await get.json()).toEqual({ packages: ['python3@latest'], setupScript: 'echo ready' })
    })

    it('triggers exactly one reconcile for each authoritative declaration mutation', async () => {
      const squad = await Squad.create({ name: `${testPrefix} trigger toolchain`, purpose: 'test' })
      const prewarm = spyOn(sandboxPrewarm, 'prewarmSandboxBackground').mockImplementation(() => {})
      try {
        await app.request(`/api/squads/${squad.id}/toolchain`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ packages: ['jq'] }),
        })
        expect(prewarm).toHaveBeenCalledTimes(1)
        expect((await Squad.mustFind(squad.id)).toolchainConfig).toEqual({ packages: ['jq'] })
        prewarm.mockClear()
        await app.request(`/api/squads/${squad.id}/toolchain`, {
          method: 'DELETE',
          headers: authHeaders(admin.token),
        })
        expect(prewarm).toHaveBeenCalledTimes(1)
        expect((await Squad.mustFind(squad.id)).toolchainConfig).toBeUndefined()
      } finally {
        prewarm.mockRestore()
      }
    })

    it('removes an old setup script when replacement omits it without returning null', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} replace toolchain`,
        purpose: 'test',
        metadata: { sandbox: { toolchain: { packages: ['a'], setupScript: 'echo old' } } },
      })
      const put = await app.request(`/api/squads/${squad.id}/toolchain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ packages: ['b'] }),
      })
      expect(await put.json()).toEqual({ packages: ['b'] })
      const get = await app.request(`/api/squads/${squad.id}/toolchain`, { headers: authHeaders(admin.token) })
      expect(await get.json()).toEqual({ packages: ['b'] })
    })

    it('clears and schedules an explicit apply', async () => {
      const squad = await Squad.create({ name: `${testPrefix} clear toolchain`, purpose: 'test' })
      const apply = await app.request(`/api/squads/${squad.id}/toolchain/apply`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(apply.status).toBe(202)
      const clear = await app.request(`/api/squads/${squad.id}/toolchain`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(clear.status).toBe(200)
    })

    it('rejects mutation for archived squads', async () => {
      const squad = await Squad.create({ name: `${testPrefix} archived toolchain`, purpose: 'test' })
      await squad.archive()
      const response = await app.request(`/api/squads/${squad.id}/toolchain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ packages: ['python3@latest'] }),
      })
      expect(response.status).toBe(410)
    })

    it('rejects unsafe package specs', async () => {
      const squad = await Squad.create({ name: `${testPrefix} invalid toolchain`, purpose: 'test' })
      const response = await app.request(`/api/squads/${squad.id}/toolchain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ packages: ['python 3'] }),
      })
      expect(response.status).toBe(400)
    })
  })

  describe('squad sandbox process management', () => {
    function fakeBoxClient(calls: unknown[][]) {
      return {
        listProcesses: async () => ({
          pressure: { cpus: 4, load: [22.7, 31.9, 30.5], memTotalMb: 7941, memAvailableMb: 3614 },
          processes: [
            {
              pid: 2838629,
              ppid: 1,
              cpuPercent: 187,
              memRssMb: 2116,
              ageSeconds: 9300,
              state: 'R',
              command: 'bun tsc -p apps/core',
              protected: false,
            },
          ],
          containers: { available: true, containers: [] },
        }),
        signalProcess: async (pid: number, signal: string) => {
          calls.push(['signal', pid, signal])
          return { pid, signal, command: 'bun tsc -p apps/core' }
        },
        stopContainer: async (id: string) => {
          calls.push(['stop', id])
          return { id }
        },
      }
    }

    it("lists the squad box's processes and stops one, for someone who can update the squad", async () => {
      const squad = await Squad.create({ name: `${testPrefix} Processes`, purpose: 'Testing box processes' })
      const calls: unknown[][] = []
      const client = fakeBoxClient(calls)
      const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
        getOrAttachClient: async (sandboxId: string) => (sandboxId === squad.sandboxId ? client : null),
      } as never)
      try {
        const listed = await app.request(`/api/squads/${squad.id}/sandbox/processes`, {
          headers: authHeaders(admin.token),
        })
        expect(listed.status).toBe(200)
        expect((await listed.json()).processes[0].command).toBe('bun tsc -p apps/core')

        const signalled = await app.request(`/api/squads/${squad.id}/sandbox/processes/2838629/signal`, {
          method: 'POST',
          headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
          body: JSON.stringify({ signal: 'kill' }),
        })
        expect(signalled.status).toBe(200)
        const stopped = await app.request(`/api/squads/${squad.id}/sandbox/containers/tau-core-tsc/stop`, {
          method: 'POST',
          headers: authHeaders(admin.token),
        })
        expect(stopped.status).toBe(200)
        expect(calls).toEqual([
          ['signal', 2838629, 'KILL'],
          ['stop', 'tau-core-tsc'],
        ])

        const malformed = await app.request(`/api/squads/${squad.id}/sandbox/processes/2838629/signal`, {
          method: 'POST',
          headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
          body: '{"signal":',
        })
        expect(malformed.status).toBe(400)
        expect(calls).toHaveLength(2)

        const invalid = await app.request(`/api/squads/${squad.id}/sandbox/processes/1/signal`, {
          method: 'POST',
          headers: authHeaders(admin.token),
        })
        expect(invalid.status).toBe(400)
      } finally {
        managerSpy.mockRestore()
      }
    })

    it('requires squads:update, since command lines can carry secrets, and reports a stopped box', async () => {
      const squad = await Squad.create({ name: `${testPrefix} Processes RBAC`, purpose: 'Testing box processes' })
      const member = await createTestUser({ prefix: testPrefix })
      const role = await createTestRole({ prefix: testPrefix, permissions: ['squads:read'] })
      await assignRole({ userId: member.id, roleId: role.id, scope: 'squad', squadId: squad.id })
      const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
        getOrAttachClient: async () => null,
      } as never)
      try {
        for (const [method, path] of [
          ['GET', 'processes'],
          ['POST', 'processes/4242/signal'],
          ['POST', 'containers/abc/stop'],
        ]) {
          const res = await app.request(`/api/squads/${squad.id}/sandbox/${path}`, {
            method,
            headers: authHeaders(member.token),
          })
          expect(res.status).toBe(403)
        }
        const stopped = await app.request(`/api/squads/${squad.id}/sandbox/processes`, {
          headers: authHeaders(admin.token),
        })
        expect(stopped.status).toBe(409)
      } finally {
        managerSpy.mockRestore()
      }
    })
  })

  describe('GET /api/squads/:id/sandbox/status', () => {
    it('returns not_found when no sandbox is running (docker mode)', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} Sandbox Status`,
        purpose: 'Testing sandbox status',
      })
      const runtimeSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(false)

      try {
        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, {
          headers: authHeaders(admin.token),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('not_found')
      } finally {
        runtimeSpy.mockRestore()
      }
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/sandbox/status', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })

    it("reports an open overload episode's load on a VM box whose status did not probe it", async () => {
      const squad = await Squad.create({ name: `${testPrefix} Overloaded`, purpose: 'Testing overload status' })
      const { observeSandboxOverload } = await import('../services/fleet-alerts/store')
      await observeSandboxOverload({
        status: 'sampled',
        sandboxId: squad.sandboxId,
        pressure: { cpus: 4, load: [31.9, 28.7, 25.5], memTotalMb: 7941, memAvailableMb: 463 },
        now: new Date(),
      })
      const remoteSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(true)
      const k8sSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)
      const vmSpy = spyOn(sandboxFactory, 'isVmRuntime').mockReturnValue(true)
      const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
        // An idle-flagged box: status answers from chain health without probing it.
        getSandboxStatus: async () => ({
          status: 'running',
          readiness: 'ready',
          devboxReady: true,
          chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
        }),
      } as never)
      try {
        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        expect(res.status).toBe(200)
        expect((await res.json()).pressure).toEqual({
          cpus: 4,
          load: [31.9, 28.7, 25.5],
          memTotalMb: 7941,
          memAvailableMb: 463,
        })
      } finally {
        remoteSpy.mockRestore()
        k8sSpy.mockRestore()
        vmSpy.mockRestore()
        managerSpy.mockRestore()
      }
    })

    it('adds provisioning diagnostics only for K8s status', async () => {
      const squad = await Squad.create({ name: `${testPrefix} K8s Status`, purpose: 'Testing K8s diagnostics' })
      const remoteSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(true)
      const k8sSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(true)
      const vmSpy = spyOn(sandboxFactory, 'isVmRuntime').mockReturnValue(false)
      const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
        getSandboxStatus: async () => ({ status: 'pending' }),
        getProvisionDiagnostics: async () => ({
          state: 'open',
          reasonCode: 'unschedulable_capacity',
          retryAfterMs: 5000,
          inFlight: 4,
          localWaiters: 2,
        }),
      } as any)
      try {
        const body = await (
          await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        ).json()
        expect(body.runtime).toBe('k8s')
        expect(body.provisioning).toMatchObject({ state: 'open', inFlight: 4, localWaiters: 2 })
      } finally {
        remoteSpy.mockRestore()
        k8sSpy.mockRestore()
        vmSpy.mockRestore()
        managerSpy.mockRestore()
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('reaches getSandboxStatus for a remote runtime (vm/k8s) instead of the docker fast-path', async () => {
      const squad = await Squad.create({
        name: `${testPrefix} VM Sandbox Status`,
        purpose: 'Testing vm sandbox status',
      })
      // The vm runtime is a remote runtime, so the route must query the live
      // getSandboxStatus surface (which the VmSandboxManager mirrors from k8s)
      // rather than the docker "running if tracked" shortcut.
      const runtimeSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(true)
      const getStatus = mock(async (_sandboxId: string) => ({ status: 'starting', reason: 'box is provisioning' }))
      const getManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
        getSandboxStatus: getStatus,
      } as any)

      try {
        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, {
          headers: authHeaders(admin.token),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('starting')
        expect(body.reason).toBe('box is provisioning')
        expect(getStatus).toHaveBeenCalledWith(squad.sandboxId)
      } finally {
        runtimeSpy.mockRestore()
        getManagerSpy.mockRestore()
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })
  })

  describe('typeContext', () => {
    beforeEach(async () => {
      await AgentType.upsert({
        id: 'architect',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Architect',
        systemPrompt: 'You are an architect.',
      })
      await AgentType.upsert({
        id: 'engineer',
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Engineer',
        systemPrompt: 'You are an engineer.',
      })
    })

    it('creates a squad with typeContext and returns it', async () => {
      const res = await app.request('/api/squads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          name: `${testPrefix} API-TC`,
          purpose: 'p',
          typeContext: { architect: 'design' },
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.typeContext).toEqual({ architect: 'design' })
    })

    it('updates typeContext', async () => {
      const created = await Squad.create({ name: `${testPrefix} API-TC2`, purpose: 'p' })
      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ typeContext: { engineer: 'ship' } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.typeContext).toEqual({ engineer: 'ship' })
    })

    it('merges typeContext on update instead of replacing', async () => {
      const created = await Squad.create({
        name: `${testPrefix} API-TC-MERGE`,
        purpose: 'p',
        typeContext: { architect: 'design' },
      })
      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ typeContext: { engineer: 'ship' } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.typeContext).toEqual({ architect: 'design', engineer: 'ship' })
    })

    it('deletes a key when set to null on update', async () => {
      const created = await Squad.create({
        name: `${testPrefix} API-TC-DEL`,
        purpose: 'p',
        typeContext: { architect: 'design', engineer: 'ship' },
      })
      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ typeContext: { architect: null } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.typeContext).toEqual({ engineer: 'ship' })
    })

    it('clears typeContext with null', async () => {
      const created = await Squad.create({
        name: `${testPrefix} API-TC3`,
        purpose: 'p',
        typeContext: { architect: 'x' },
      })
      const res = await app.request(`/api/squads/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ typeContext: null }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).typeContext).toBeNull()
    })
  })

  describe('workspace proxy handlers use namespaced mount', () => {
    let squad: Squad
    let listCalls: { path: string; maxDepth?: number }[]
    let bashCalls: { command: string; cwd: string }[]
    let runtimeSpy: ReturnType<typeof spyOn>
    let getSandboxManagerSpy: ReturnType<typeof spyOn>

    function makeFakeStream() {
      const handlers: Record<string, ((...args: any[]) => void)[]> = {}
      const stream = {
        on(event: string, fn: (...args: any[]) => void) {
          if (!handlers[event]) handlers[event] = []
          handlers[event].push(fn)
          return stream
        },
      }
      // Fire 'end' after all .on() registrations complete
      Promise.resolve().then(() => (handlers['end'] ?? []).forEach((fn) => fn()))
      return stream
    }

    beforeEach(async () => {
      squad = await Squad.create({ name: `${testPrefix} NS Mount`, purpose: 'ns mount test' })
      listCalls = []
      bashCalls = []

      const mockClient = {
        list: async (args: { path: string; maxDepth?: number }) => {
          listCalls.push(args)
          return { files: [] }
        },
        bash: (args: { command: string; cwd: string }) => {
          bashCalls.push(args)
          return makeFakeStream()
        },
      }

      const mockManager = {
        getClient: (_sandboxId: string) => mockClient,
      }

      runtimeSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(true)
      getSandboxManagerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue(mockManager as any)
    })

    afterEach(async () => {
      runtimeSpy.mockRestore()
      getSandboxManagerSpy.mockRestore()
      await db.delete(squads).where(eq(squads.id, squad.id))
    })

    it('workspace/tree issues client.list with /workspace/<squadId> when no relative path', async () => {
      const res = await app.request(`/api/squads/${squad.id}/workspace/tree`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      expect(listCalls.length).toBeGreaterThan(0)
      expect(listCalls[0].path).toBe(`/workspace/${squad.id}`)
    })

    it('workspace/tree issues client.list with /workspace/<squadId>/<path> for relative path', async () => {
      const res = await app.request(`/api/squads/${squad.id}/workspace/tree?path=src`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      expect(listCalls.length).toBeGreaterThan(0)
      expect(listCalls[0].path).toBe(`/workspace/${squad.id}/src`)
    })

    it('workspace/search runs find /workspace/<squadId> with cwd /workspace/<squadId>', async () => {
      const res = await app.request(`/api/squads/${squad.id}/workspace/search?q=hello`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      expect(bashCalls.length).toBeGreaterThan(0)
      expect(bashCalls[0].command).toContain(`find /workspace/${squad.id}`)
      expect(bashCalls[0].cwd).toBe(`/workspace/${squad.id}`)
    })
  })

  // ── Machine pin setter (POST /:id/machine + PATCH machineId) ───────────────
  describe('machine pin', () => {
    const machinePrefix = `squad-pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const createdMachineIds: string[] = []
    let squad: Squad

    async function makeMachine(status = 'ready'): Promise<string> {
      const m = await insertMachine({
        name: `${machinePrefix}-${Math.random().toString(36).slice(2, 8)}`,
        provider: 'ssh',
        sshHost: '10.0.0.9',
        sshUser: 'tau',
        sshKeyId: `secret-${Math.random().toString(36).slice(2, 8)}`,
        sshPublicKey: 'ssh-ed25519 AAAA test',
        status,
      })
      createdMachineIds.push(m.id)
      return m.id
    }

    async function reloadMachineId(id: string): Promise<string | null> {
      const [row] = await db.select({ machineId: squads.machineId }).from(squads).where(eq(squads.id, id))
      return row?.machineId ?? null
    }

    beforeEach(async () => {
      squad = await Squad.create({ name: `${testPrefix}-pin`, purpose: 'test' })
    })

    afterEach(async () => {
      for (const id of createdMachineIds.splice(0)) await deleteMachine(id)
    })

    it('POST /:id/machine pins the squad to a ready machine and emits squad.updated', async () => {
      const machineId = await makeMachine('ready')
      const spy = spyOn(eventEmitter, 'emit')
      try {
        const res = await app.request(`/api/squads/${squad.id}/machine`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ machineId }),
        })
        expect(res.status).toBe(200)
        expect(await reloadMachineId(squad.id)).toBe(machineId)
        expect(spy.mock.calls.some((c) => c[0] === 'squad.updated')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })

    it('POST /:id/machine with null unpins the squad', async () => {
      const machineId = await makeMachine('ready')
      await squad.update({ machineId })
      expect(await reloadMachineId(squad.id)).toBe(machineId)

      const res = await app.request(`/api/squads/${squad.id}/machine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ machineId: null }),
      })
      expect(res.status).toBe(200)
      expect(await reloadMachineId(squad.id)).toBeNull()
    })

    it('POST /:id/machine rejects an absent machineId key with 400 (no silent unpin)', async () => {
      const machineId = await makeMachine('ready')
      await squad.update({ machineId })
      expect(await reloadMachineId(squad.id)).toBe(machineId)

      const res = await app.request(`/api/squads/${squad.id}/machine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ notMachineId: machineId }),
      })
      expect(res.status).toBe(400)
      // The pin is untouched — no silent unpin + migration.
      expect(await reloadMachineId(squad.id)).toBe(machineId)
    })

    it('POST /:id/machine rejects a malformed JSON body with 400 (no silent unpin)', async () => {
      const machineId = await makeMachine('ready')
      await squad.update({ machineId })
      expect(await reloadMachineId(squad.id)).toBe(machineId)

      const res = await app.request(`/api/squads/${squad.id}/machine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: '{not json',
      })
      expect(res.status).toBe(400)
      expect(await reloadMachineId(squad.id)).toBe(machineId)
    })

    it('POST /:id/machine rejects a not-ready machine with 400', async () => {
      const machineId = await makeMachine('bootstrapping')
      const res = await app.request(`/api/squads/${squad.id}/machine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ machineId }),
      })
      expect(res.status).toBe(400)
      expect(await reloadMachineId(squad.id)).toBeNull()
    })

    it('POST /:id/machine requires machines:write (unprivileged → 403)', async () => {
      const machineId = await makeMachine('ready')
      const unprivileged = await createTestUser({ prefix: `${testPrefix}-pin-noperms` })
      const res = await app.request(`/api/squads/${squad.id}/machine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(unprivileged.token) },
        body: JSON.stringify({ machineId }),
      })
      expect(res.status).toBe(403)
      expect(await reloadMachineId(squad.id)).toBeNull()
    })

    it('PATCH /:id rejects a nonexistent machineId with 400 (readiness validated, not just uuid shape)', async () => {
      // A well-formed (uuid) but nonexistent machine id must be rejected up front,
      // not silently persisted to only fail later at ensure.
      const res = await app.request(`/api/squads/${squad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ machineId: '00000000-0000-0000-0000-000000000000' }),
      })
      expect(res.status).toBe(400)
      expect(await reloadMachineId(squad.id)).toBeNull()
    })

    it('PATCH /:id rejects a not-ready machineId with 400', async () => {
      const machineId = await makeMachine('bootstrapping')
      const res = await app.request(`/api/squads/${squad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ machineId }),
      })
      expect(res.status).toBe(400)
      expect(await reloadMachineId(squad.id)).toBeNull()
    })

    it('PATCH /:id allows pinning to a ready machine', async () => {
      const machineId = await makeMachine('ready')
      const res = await app.request(`/api/squads/${squad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ machineId }),
      })
      expect(res.status).toBe(200)
      expect(await reloadMachineId(squad.id)).toBe(machineId)
    })

    it('PATCH /:id allows unpinning with null', async () => {
      const machineId = await makeMachine('ready')
      await squad.update({ machineId })
      expect(await reloadMachineId(squad.id)).toBe(machineId)

      const res = await app.request(`/api/squads/${squad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ machineId: null }),
      })
      expect(res.status).toBe(200)
      expect(await reloadMachineId(squad.id)).toBeNull()
    })
  })

  describe('hostWorkspacePath', () => {
    let squad: Squad
    let previousRuntime: string | undefined
    beforeEach(async () => {
      previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      squad = await Squad.create({ name: `${testPrefix}-hwp`, purpose: 'test' })
    })

    afterEach(() => {
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
    })

    async function patch(body: unknown) {
      return app.request(`/api/squads/${squad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify(body),
      })
    }

    it('accepts an absolute path, persists it, returns it, and primes the override cache', async () => {
      clearHostWorkspaceOverrides()
      const root = mkdtempSync(join(tmpdir(), 'tau-patch-squad-workspace-'))
      const rawWorkspace = `${root}//nested/./workspace/`
      const workspace = resolve(rawWorkspace)
      try {
        const res = await patch({ hostWorkspacePath: rawWorkspace })
        expect(res.status).toBe(200)
        expect((await res.json()).hostWorkspacePath).toBe(workspace)
        expect((await Squad.mustFind(squad.id)).hostWorkspacePath).toBe(workspace)
        expect(getHostWorkspaceOverride(squad.id)).toBe(workspace)
        expect(statSync(workspace).isDirectory()).toBe(true)
        const cleared = await patch({ hostWorkspacePath: null })
        expect(cleared.status).toBe(200)
        expect((await cleared.json()).hostWorkspacePath).toBeNull()
        expect(getHostWorkspaceOverride(squad.id)).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects an uncreatable path and leaves the saved override unchanged', async () => {
      const root = mkdtempSync(join(tmpdir(), 'tau-patch-squad-file-'))
      const file = join(root, 'file')
      writeFileSync(file, 'not a directory')
      try {
        const res = await patch({ hostWorkspacePath: join(file, 'workspace') })
        expect(res.status).toBe(400)
        expect((await Squad.mustFind(squad.id)).hostWorkspacePath).toBeNull()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects setting a host workspace outside host runtime', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      expect((await patch({ hostWorkspacePath: '/tmp/squad-workspace' })).status).toBe(400)
      expect((await Squad.mustFind(squad.id)).hostWorkspacePath).toBeNull()
    })

    it('rejects relative paths and .. segments', async () => {
      expect((await patch({ hostWorkspacePath: 'repo' })).status).toBe(400)
      expect((await patch({ hostWorkspacePath: '/srv/../etc' })).status).toBe(400)
    })

    it('rejects the bare root "/"', async () => {
      expect((await patch({ hostWorkspacePath: '/' })).status).toBe(400)
    })

    it('GET /sandbox/status reports runtime "host" under FICUS_SANDBOX_RUNTIME=host', async () => {
      const prev = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      try {
        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        expect(res.status).toBe(200)
        expect((await res.json()).runtime).toBe('host')
      } finally {
        if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
        else process.env.FICUS_SANDBOX_RUNTIME = prev
      }
    })

    // The ACTIVE directory agents/terminal/file routes use right now — the
    // override when one is primed, otherwise the storage path.
    it('GET /sandbox/status reports the resolved host workspace path', async () => {
      const prev = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      const status = async () =>
        (await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })).json()
      try {
        clearHostWorkspaceOverrides()
        expect((await status()).workspacePath).toEndWith(`/workspaces/squads/${squad.id}`)

        setHostWorkspaceOverride(squad.id, '/srv/override-repo')
        expect((await status()).workspacePath).toBe('/srv/override-repo')
      } finally {
        clearHostWorkspaceOverrides()
        if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
        else process.env.FICUS_SANDBOX_RUNTIME = prev
      }
    })

    // The override cache is primed by the PATCH itself, so it predicts where
    // agents WILL work. The status endpoint must report where they ARE working:
    // the path the last host ensure recorded on the row.
    it('GET /sandbox/status prefers the applied path over a newer cached override', async () => {
      const prev = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      try {
        await Squad.update(squad.id, { metadata: { hostRuntime: { activeWorkspacePath: '/srv/applied-repo' } } })
        setHostWorkspaceOverride(squad.id, '/srv/just-saved-repo')

        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        const body = await res.json()
        expect(body.workspacePath).toBe('/srv/applied-repo')
        expect(body.workspacePathApplied).toBe(true)
      } finally {
        clearHostWorkspaceOverrides()
        await Squad.update(squad.id, { metadata: { hostRuntime: null } })
        if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
        else process.env.FICUS_SANDBOX_RUNTIME = prev
      }
    })

    it('GET /sandbox/status falls back to the resolved path, flagged as not applied', async () => {
      const prev = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      try {
        clearHostWorkspaceOverrides()
        setHostWorkspaceOverride(squad.id, '/srv/never-ensured')
        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        const body = await res.json()
        expect(body.workspacePath).toBe('/srv/never-ensured')
        expect(body.workspacePathApplied).toBe(false)
      } finally {
        clearHostWorkspaceOverrides()
        if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
        else process.env.FICUS_SANDBOX_RUNTIME = prev
      }
    })

    it('GET /sandbox/status omits workspacePath on a docker runtime', async () => {
      const prev = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      try {
        const res = await app.request(`/api/squads/${squad.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        expect(await res.json()).not.toHaveProperty('workspacePath')
      } finally {
        if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
        else process.env.FICUS_SANDBOX_RUNTIME = prev
      }
    })
  })
})
