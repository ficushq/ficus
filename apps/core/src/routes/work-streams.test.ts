import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { createBlankWorkflow, createWorkflowRun, type CreateWorkStreamInput } from '@ficus/shared'
import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, setSystemTime, spyOn } from 'bun:test'
import { like, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { workStreamsRouter } from './work-streams'
import { squadsRouter } from './squads'
import { agentsRouter } from './agents'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import {
  workStreams,
  workStreamFlowRuns,
  worktreeCleanupJobs,
  workStreamWorktrees,
  workStreamOrderSnapshots,
  workStreamOrderSnapshotItems,
  squads,
  agents,
  agentTypes,
  executions,
  roles,
} from '../db/schema'
import { openWait } from '../services/work-streams/waits'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { Execution } from '../entities/Execution'
import { WorkStream } from '../entities/WorkStream'
import { sortCanonicalWorkStreams, type CanonicalWorkStreamOrderInput } from '@ficus/shared'
import { Squad } from '../entities/Squad'
import { isSubscribedToWorkStream } from '../services/work-streams/subscriptions'
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
app.use('*', identityMiddleware)
app.route('/api/workstreams', workStreamsRouter)
app.route('/api/squads', squadsRouter)
app.route('/api/agents', agentsRouter)

const wsPrefix = `ws-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: wsPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(wsPrefix)
})

describe('work-streams routes', () => {
  let testPrefix: string
  let testSquadId: string
  let testAgentTypeId: string
  let testAgentId: string

  /** Helper: call app.fetch with admin auth token and optional body */
  async function apiFetch(
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<Response> {
    const baseHeaders = authHeaders(admin.token)
    const extraHeaders = init?.headers ?? {}
    return app.fetch(
      new Request(`http://localhost${url}`, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: { ...baseHeaders, ...extraHeaders },
      })
    )
  }

  it('uses numeric references for detail, mutation and subscriptions without changing UUID identity', async () => {
    const [row] = await db.insert(workStreams).values({ squadId: testSquadId, title: 'Number lookup' }).returning()
    for (const ref of [row!.id, row!.id.slice(0, 8), String(row!.number), `%23${row!.number}`]) {
      const response = await apiFetch(`/api/workstreams/${ref}`)
      expect(response.status).toBe(200)
      expect((await response.json()).id).toBe(row!.id)
    }
    const update = await apiFetch(`/api/workstreams/${row!.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated' }),
    })
    expect(update.status).toBe(200)
    expect((await WorkStream.mustFind(row!.id)).title).toBe('Updated')
    const subscription = await apiFetch(`/api/workstreams/${row!.number}/subscribe`, { method: 'POST' })
    expect(subscription.status).toBe(200)
    expect(await isSubscribedToWorkStream(row!.id, admin.id)).toBe(true)
  })

  it('rejects a malformed codeHost binding at write time and explains the allowed shape', async () => {
    const [row] = await db.insert(workStreams).values({ squadId: testSquadId, title: 'Binding' }).returning()
    const binding = { integration: 'github', repository: 'example/repo', changeRequest: { number: 7 } }
    const valid = await patchJson(`/api/workstreams/${row!.id}`, { metadata: { codeHost: binding } })
    expect(valid.status).toBe(200)
    // The dot-path CLI shape merges into the existing binding; extra evidence keys are refused here.
    const annotated = await patchJson(`/api/workstreams/${row!.id}`, {
      metadata: {
        codeHost: { changeRequest: { number: 7, url: 'https://github.com/example/repo/pull/7', state: 'MERGED' } },
      },
    })
    expect(annotated.status).toBe(400)
    expect((await annotated.json()).error).toContain(
      'codeHost metadata is invalid: codeHost.changeRequest: unknown keys `state` (allowed: number, url)'
    )
    expect((await WorkStream.mustFind(row!.id)).metadata?.codeHost).toEqual(binding)
    // Unrelated metadata edits do not re-validate a binding they do not touch.
    const unrelated = await patchJson(`/api/workstreams/${row!.id}`, { metadata: { delivery: { note: 'ok' } } })
    expect(unrelated.status).toBe(200)
    // Removing the binding through the same path is still allowed.
    expect((await patchJson(`/api/workstreams/${row!.id}`, { metadata: { codeHost: null } })).status).toBe(200)
    expect((await WorkStream.mustFind(row!.id)).metadata?.codeHost).toBeUndefined()
  })

  it('reports inherited squad attention, overrides it per stream, and resets to inheritance', async () => {
    const [row] = await db.insert(workStreams).values({ squadId: testSquadId, title: 'Attention stream' }).returning()
    const subscription = async () => (await apiFetch(`/api/workstreams/${row!.id}/subscription`)).json()

    expect(await subscription()).toEqual({
      subscribed: false,
      count: 0,
      attention: { decisions: 'show', progress: 'show' },
      inherited: true,
    })

    await apiFetch(`/api/squads/${testSquadId}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attention: { decisions: 'notify', progress: 'notify' } }),
    })
    expect(await subscription()).toEqual({
      subscribed: false,
      count: 0,
      attention: { decisions: 'notify', progress: 'notify' },
      inherited: true,
    })

    const overridden = await apiFetch(`/api/workstreams/${row!.id}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attention: { decisions: 'mute', progress: 'mute' } }),
    })
    expect(await overridden.json()).toEqual({
      subscribed: true,
      count: 1,
      attention: { decisions: 'mute', progress: 'mute' },
      inherited: false,
    })

    const reset = await apiFetch(`/api/workstreams/${row!.id}/subscribe`, { method: 'DELETE' })
    expect(await reset.json()).toEqual({
      subscribed: false,
      count: 0,
      attention: { decisions: 'notify', progress: 'notify' },
      inherited: true,
    })
    await apiFetch(`/api/squads/${testSquadId}/subscribe`, { method: 'DELETE' })
  })

  it('respectAttention drops progress-muted streams from the cross-squad list and refuses pagination', async () => {
    const [visible] = await db.insert(workStreams).values({ squadId: testSquadId, title: 'Attended' }).returning()
    const [hidden] = await db.insert(workStreams).values({ squadId: testSquadId, title: 'Progress muted' }).returning()
    await apiFetch(`/api/workstreams/${hidden!.id}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attention: { decisions: 'notify', progress: 'mute' } }),
    })

    const unfiltered = (await (await apiFetch('/api/workstreams')).json()) as Array<{ id: string }>
    expect(unfiltered.map(({ id }) => id)).toContain(hidden!.id)

    const filtered = (await (await apiFetch('/api/workstreams?respectAttention=true')).json()) as Array<{ id: string }>
    expect(filtered.map(({ id }) => id)).toContain(visible!.id)
    expect(filtered.map(({ id }) => id)).not.toContain(hidden!.id)

    const paginated = await apiFetch('/api/workstreams?respectAttention=true&limit=50')
    expect(paginated.status).toBe(400)
    expect((await paginated.json()).error).toBe('respectAttention is not supported with pagination')
  })

  /** Helper: POST JSON to a URL */
  function postJson(url: string, body: unknown): Promise<Response> {
    return apiFetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** JSON response-shaped fixture for tests of stored legacy reads and transitions, not HTTP creation. */
  async function legacyFixtureResponse(input: CreateWorkStreamInput): Promise<Response> {
    const row = await storedLegacyWorkStream(input)
    return Response.json(row.toJson(), { status: 201 })
  }

  /** Helper: PATCH JSON to a URL */
  function patchJson(url: string, body: unknown): Promise<Response> {
    return apiFetch(url, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Helper: DELETE a URL */
  function del(url: string): Promise<Response> {
    return apiFetch(url, { method: 'DELETE' })
  }

  /** Helper: POST (no body) */
  function post(url: string): Promise<Response> {
    return apiFetch(url, { method: 'POST' })
  }

  it('returns actionable conflicts for cleanup-owned mutation, reopen, and deletion', async () => {
    const stream = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Cleanup conflict' })
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id))
    await db
      .insert(worktreeCleanupJobs)
      .values({ workStreamId: stream.id, status: 'removing', operationId: crypto.randomUUID() })
    for (const response of [
      await patchJson(`/api/workstreams/${stream.id}`, { autoCleanupWorktree: false }),
      await post(`/api/workstreams/${stream.id}/reopen`),
      await del(`/api/workstreams/${stream.id}`),
    ]) {
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('worktree_cleanup_conflict')
    }
    expect((await WorkStream.mustFind(stream.id)).status).toBe('done')
  })

  it('inspects original ownership separately from current metadata and enforces squad read access', async () => {
    const stream = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Divergent ownership' })
    const ownership = {
      workspace: '/workspace',
      repository: '/workspace/repo',
      commonDirectory: '/workspace/repo/.git',
      gitDirectory: '/workspace/repo/.git/worktrees/original',
      worktree: '/workspace/original',
      branch: 'original',
      directoryIdentity: '1:2',
    }
    await db.insert(workStreamWorktrees).values({ workStreamId: stream.id, squadId: testSquadId, ownership })
    await db
      .update(workStreams)
      .set({
        autoCleanupWorktree: true,
        metadata: { git: { repository: ownership.repository, worktree: '/workspace/manual', branch: 'manual' } },
      })
      .where(eq(workStreams.id, stream.id))
    const response = await apiFetch(`/api/workstreams/${stream.id}/worktree-cleanup`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      owned: ownership,
      current: { worktree: '/workspace/manual' },
      bindingsMatch: false,
      recovery: 'retain',
      cleanup: null,
    })
    const stranger = await createTestUser({ prefix: testPrefix })
    const forbidden = await app.fetch(
      new Request(`http://localhost/api/workstreams/${stream.id}/worktree-cleanup`, {
        headers: authHeaders(stranger.token),
      })
    )
    expect(forbidden.status).toBe(403)
    await db
      .insert(worktreeCleanupJobs)
      .values({ workStreamId: stream.id, status: 'removing', operationId: crypto.randomUUID() })
    expect(await (await apiFetch(`/api/workstreams/${stream.id}/worktree-cleanup`)).json()).toMatchObject({
      recovery: 'in-flight',
    })
    await db
      .update(worktreeCleanupJobs)
      .set({ status: 'succeeded' })
      .where(eq(worktreeCleanupJobs.workStreamId, stream.id))
    expect(await (await apiFetch(`/api/workstreams/${stream.id}/worktree-cleanup`)).json()).toMatchObject({
      recovery: 'reclaimed',
    })
    await db.delete(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, stream.id))
    // No new ownership was adopted, and GET cannot create a cleanup job.
    expect(
      await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, stream.id))
    ).toHaveLength(0)
    for (const body of [{ worktree: '/workspace/third' }, { metadata: { git: { branch: 'third' } } }]) {
      const blocked = await patchJson(`/api/workstreams/${stream.id}`, body)
      expect(blocked.status).toBe(409)
      expect((await blocked.json()).code).toBe('worktree_cleanup_conflict')
    }
  })

  it('cleanup API preserves false, rejects non-booleans, and exposes only public status', async () => {
    const stream = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Cleanup retention' })
    const disabled = await patchJson(`/api/workstreams/${stream.id}`, { autoCleanupWorktree: false })
    expect(disabled.status).toBe(200)
    expect((await disabled.json()).autoCleanupWorktree).toBe(false)
    expect((await patchJson(`/api/workstreams/${stream.id}`, { autoCleanupWorktree: 'false' })).status).toBe(400)
    await db
      .insert(worktreeCleanupJobs)
      .values({ workStreamId: stream.id, status: 'deferred', reason: 'Retain evidence' })
    const detail = await apiFetch(`/api/workstreams/${stream.id}`)
    expect((await detail.json()).worktreeCleanup).toMatchObject({ status: 'deferred', reason: 'Retain evidence' })
  })

  beforeEach(async () => {
    testPrefix = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`

    await AgentType.upsert({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'Test prompt',
    })

    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    testAgentId = agent.id

    // Create squad directly via ORM to avoid API auth complexity in setup
    const squad = await Squad.create({ name: `${testPrefix} Route Squad`, purpose: 'Testing routes' })
    testSquadId = squad.id
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = testAgentTypeId
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
  })

  afterEach(async () => {
    await db.delete(workStreamOrderSnapshotItems)
    await db.delete(workStreamOrderSnapshots)
    // Clean up executions for all agents of this type (test fixture + spawned)
    const allTypeAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    if (allTypeAgents.length > 0) {
      await db.delete(executions).where(
        inArray(
          executions.agentId,
          allTypeAgents.map((a) => a.id)
        )
      )
    }
    await db.delete(workStreams).where(eq(workStreams.squadId, testSquadId))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  describe('PATCH /:id worker-binding (assigned workers may transition their own streams)', () => {
    async function seedWorkerRole() {
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      await db.insert(roles).values({
        slug: 'default-worker',
        name: 'Squad Worker',
        permissions: ['workstreams:read', 'workstreams:respond'],
      })
    }

    afterEach(async () => {
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    })

    async function patchAs(token: string, id: string, body: unknown): Promise<Response> {
      return await app.fetch(
        new Request(`http://localhost/api/workstreams/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        })
      )
    }

    async function boundWorker() {
      await seedWorkerRole()
      const worker = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
      const token = (await worker.getOrCreateToken())!
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} worker-bound`,
        agentIds: [worker.id],
        assigneeAgentId: worker.id,
      })
      return { worker, token, ws }
    }

    it('lets a bound worker set in_progress', async () => {
      const { token, ws } = await boundWorker()
      expect((await patchAs(token, ws.id, { status: 'in_progress' })).status).toBe(200)
    })

    it('forbids a bound worker from canceling', async () => {
      const { token, ws } = await boundWorker()
      expect((await patchAs(token, ws.id, { status: 'canceled' })).status).toBe(403)
    })

    it('forbids a bound worker from changing the agent list', async () => {
      const { token, ws } = await boundWorker()
      expect((await patchAs(token, ws.id, { agentIds: [testAgentId] })).status).toBe(403)
    })

    it('forbids a worker not bound to the work stream', async () => {
      await seedWorkerRole()
      const worker = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
      const token = (await worker.getOrCreateToken())!
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} unbound`,
        agentIds: [testAgentId],
      })
      expect((await patchAs(token, ws.id, { status: 'in_progress' })).status).toBe(403)
    })
  })

  describe('POST /api/workstreams', () => {
    it('accepts ownerAgentId and resolves a prefix', async () => {
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} Owned`,
        ownerAgentId: testAgentId.slice(0, 8),
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.ownerAgentId).toBe(testAgentId)
    })

    it('creates a work stream', async () => {
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} Implement auth`,
      })

      expect(res.status).toBe(201)
      const ws = await res.json()
      expect(ws.title).toBe(`${testPrefix} Implement auth`)
      expect(ws.status).toBe('active')
    })

    it('accepts typed completion and git fields as metadata', async () => {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = testAgentTypeId
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} typed-fields-test`,
        workflow: { kind: 'inline', definition: { ...definition, completion: { mode: 'review-approval' } } },
        branch: 'feat-x',
        worktree: '/workspace/worktrees/feat-x',
        baseBranch: 'develop',
      })

      expect(res.status).toBe(201)
      const ws = await res.json()
      expect(ws.completionMode).toBe('review-approval')
      expect(ws.branch).toBe('feat-x')
      expect(ws.worktree).toBe('/workspace/worktrees/feat-x')
      expect(ws.baseBranch).toBe('develop')
      expect(ws.metadata.completion.mode).toBe('review-approval')
      expect(ws.metadata.git.branch).toBe('feat-x')
      expect(ws.metadata.git.worktree).toBe('/workspace/worktrees/feat-x')
      expect(ws.metadata.git.baseBranch).toBe('develop')
    })

    it('accepts pr-auto-merge completion mode', async () => {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = testAgentTypeId
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} auto-merge-mode-test`,
        workflow: { kind: 'inline', definition: { ...definition, completion: { mode: 'pr-auto-merge' } } },
      })

      expect(res.status).toBe(201)
      const ws = await res.json()
      expect(ws.completionMode).toBe('pr-auto-merge')
      expect(ws.metadata.completion.mode).toBe('pr-auto-merge')
    })

    it('rejects invalid completion mode', async () => {
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} invalid completion mode`,
        completionMode: 'something-else',
      })

      expect(res.status).toBe(400)
    })

    it('validates squadId exists', async () => {
      const res = await postJson('/api/workstreams', {
        squadId: '00000000-0000-0000-0000-000000000000',
        title: `${testPrefix} Orphan`,
      })

      expect(res.status).toBe(404)
    })
  })

  describe('requestingUserId attribution (agent creators)', () => {
    // Give squad agents permission to create + read work streams via the squad-default agent role.
    async function seedCreatorRole() {
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
      await db.insert(roles).values({
        slug: 'default-worker',
        name: 'Squad Worker',
        permissions: ['workstreams:create', 'workstreams:read'],
      })
    }
    afterEach(async () => {
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    })

    async function agentToken(): Promise<string> {
      await seedCreatorRole()
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
      return (await agent.getOrCreateToken())!
    }

    async function createAsAgent(token: string, body: unknown): Promise<Response> {
      return app.fetch(
        new Request('http://localhost/api/workstreams', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        })
      )
    }

    it('drops a requestingUserId for a user who cannot read the squad (no inbox-injection leak)', async () => {
      const token = await agentToken()
      const victim = await createTestUser({ prefix: testPrefix })
      const res = await createAsAgent(token, {
        squadId: testSquadId,
        title: `${testPrefix} attr-victim`,
        requestingUserId: victim.id,
      })
      expect(res.status).toBe(201)
      const ws = (await res.json()) as { id: string; requestingUserId: string | null }
      expect(ws.requestingUserId).toBeNull()
      expect(await isSubscribedToWorkStream(ws.id, victim.id)).toBe(false)
    })

    it('honors a requestingUserId for a user with workstreams:read on the squad', async () => {
      const token = await agentToken()
      const reader = await createTestUser({ prefix: testPrefix })
      const role = await createTestRole({ prefix: testPrefix, permissions: ['workstreams:read'] })
      await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: testSquadId })
      const res = await createAsAgent(token, {
        squadId: testSquadId,
        title: `${testPrefix} attr-reader`,
        requestingUserId: reader.id,
      })
      expect(res.status).toBe(201)
      const ws = (await res.json()) as { id: string; requestingUserId: string | null }
      expect(ws.requestingUserId).toBe(reader.id)
      expect(await isSubscribedToWorkStream(ws.id, reader.id)).toBe(true)
    })
  })

  describe('POST /api/workstreams always creates a flow', () => {
    it('rejects every legacy assignment shape before creating a stream or worker', async () => {
      const before = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
      for (const legacy of [
        { agents: [testAgentTypeId] },
        { agents: [] },
        { agentIds: [testAgentId] },
        { agentIds: [] },
        { assigneeAgentId: testAgentId },
        { assigneeAgentIndex: 0 },
        { agentModelOverrides: {} },
        { completionMode: 'pr-merge' },
      ]) {
        const res = await postJson('/api/workstreams', {
          squadId: testSquadId,
          title: `${testPrefix} rejected`,
          ...legacy,
        })
        expect(res.status).toBe(400)
        expect((await res.json()).error).toContain('Legacy')
      }
      expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, testAgentTypeId))).toEqual(
        before
      )
      expect(await WorkStream.list({ squadId: testSquadId })).toHaveLength(0)
    })

    it('activates only the first participant and keeps future participants lazy', async () => {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = testAgentTypeId
      definition.participants.reviewer = { agentTypeId: testAgentTypeId, session: 'reuse-within-stream' }
      const first = definition.steps[0]!
      if (first.kind !== 'agent') throw new Error('Expected agent fixture')
      definition.steps.push({ ...structuredClone(first), id: 'review', participant: 'reviewer' })
      first.outcomes = { completed: { next: 'review' } }
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} lazy`,
        workflow: { kind: 'inline', definition },
      })
      expect(res.status).toBe(201)
      const stream = await res.json()
      expect(stream.agentIds).toHaveLength(1)
      expect(stream.assigneeAgentId).toBe(stream.agentIds[0])
      const { getFlow } = await import('../services/workflows/execution')
      expect((await getFlow(stream.id))!.state.definition.steps).toHaveLength(2)
    })

    it('rolls back creation if a flow references an unavailable worker', async () => {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = `${testPrefix}-missing`
      const res = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} invalid`,
        workflow: { kind: 'inline', definition },
      })
      expect(res.status).toBe(400)
      expect(await WorkStream.list({ squadId: testSquadId })).toHaveLength(0)
    })
  })

  describe('GET /api/workstreams', () => {
    async function walkPagedIds(
      path: string,
      limit: number,
      afterFirst?: (ids: string[]) => Promise<void>
    ): Promise<string[]> {
      const seen: string[] = []
      let cursor: string | null = null
      let pageNumber = 0
      do {
        const separator = path.includes('?') ? '&' : '?'
        const response = await apiFetch(`${path}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
        expect(response.status).toBe(200)
        const page = await response.json()
        expect(page.items.length).toBeLessThanOrEqual(limit)
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
        pageNumber += 1
        if (pageNumber === 1 && afterFirst) await afterFirst(seen)
      } while (cursor)
      return seen
    }

    /**
     * Five active streams covering the human-actionability tiers: a review a
     * human must judge, running work, an authorized auto-merge delivery gate
     * waiting on code-host CI (annotated automatedReviewGate), a dependency
     * wait, and idle work.
     */
    async function seedActionabilityFixture() {
      const squad = await Squad.find(testSquadId)
      await db
        .update(squads)
        .set({ metadata: { ...(squad!.metadata as object), policies: { allowAutoMerge: true } } })
        .where(eq(squads.id, testSquadId))

      const human = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} human review` })
      expect((await postJson(`/api/workstreams/${human.id}/request-review`, { message: 'human verdict' })).status).toBe(
        200
      )

      const running = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} running`,
        agentIds: [testAgentId],
        assigneeAgentId: testAgentId,
      })
      await db.insert(executions).values({ agentId: testAgentId, status: 'running' })

      const auto = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} automated gate`,
        completionMode: 'pr-auto-merge',
        metadata: {
          codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 7 } },
        },
      })
      const definition = createBlankWorkflow()
      definition.completion = { mode: 'pr-auto-merge', followChanges: true }
      await db.insert(workStreamFlowRuns).values({
        workStreamId: auto.id,
        activated: true,
        state: { ...createWorkflowRun(definition), status: 'completion-ready' },
        source: { schemaVersion: 1, source: { kind: 'inline' }, definition },
        createRequestId: crypto.randomUUID(),
        createRequestHash: 'fixture',
        createdBy: 'test',
      })
      expect((await postJson(`/api/workstreams/${auto.id}/request-review`, { message: 'ci will merge' })).status).toBe(
        200
      )

      const dependency = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} dependency wait`,
      })
      await openWait(db, { workStreamId: dependency.id, type: 'dependency' })

      const idle = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} idle` })
      return { human, running, auto, dependency, idle }
    }

    it('lists work streams for a squad', async () => {
      await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Stream 1` })
      await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Stream 2` })

      const res = await apiFetch(`/api/workstreams?squadId=${testSquadId}`)
      expect(res.status).toBe(200)
      const list = await res.json()
      const ours = list.filter((ws: { title: string }) => ws.title.startsWith(testPrefix))
      expect(ours.length).toBe(2)
    })

    it('includes runtime on each row', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} runtime-test`,
        agentIds: [testAgentId],
      })
      const startedAt = new Date('2026-01-01T00:00:00Z')
      await db.insert(executions).values({
        agentId: testAgentId,
        status: 'completed',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 12_000),
      })

      const res = await apiFetch(`/api/workstreams?squadId=${testSquadId}`)
      expect(res.status).toBe(200)
      const rows = (await res.json()) as Array<{
        id: string
        runtime?: { totalMs: number; activeCount: number; computedAt: string }
      }>
      const row = rows.find((r) => r.id === ws.id)
      expect(row?.runtime?.totalMs).toBe(12_000)
      expect(row?.runtime?.activeCount).toBe(0)
      expect(typeof row?.runtime?.computedAt).toBe('string')
    })

    it('returns an array and filters by statuses without limit', async () => {
      const done = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} done statuses` })
      await done.update({ status: 'done' })
      const canceled = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} canceled statuses` })
      await canceled.update({ status: 'canceled' })
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} pending statuses` })

      const res = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done,canceled`)

      expect(res.status).toBe(200)
      const list = await res.json()
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBe(2)
      expect(list.every((ws: { status: string }) => ws.status === 'done' || ws.status === 'canceled')).toBe(true)
    })

    it('lets statuses take precedence over status', async () => {
      const done = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} precedence done` })
      await done.update({ status: 'done' })
      const pending = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} precedence pending` })

      const res = await apiFetch(`/api/workstreams?squadId=${testSquadId}&status=pending&statuses=done,canceled`)

      expect(res.status).toBe(200)
      const list = await res.json()
      expect(list.map((ws: { id: string }) => ws.id)).toContain(done.id)
      expect(list.map((ws: { id: string }) => ws.id)).not.toContain(pending.id)
      expect(list.every((ws: { status: string }) => ws.status === 'done' || ws.status === 'canceled')).toBe(true)
    })

    it('returns a paginated envelope when limit is present', async () => {
      for (const [i, status] of ['done', 'canceled', 'done', 'canceled'].entries()) {
        const ws = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} page ${i}` })
        await ws.update({ status: status as 'done' | 'canceled' })
      }
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} page pending` })

      const firstRes = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done,canceled&limit=2`)
      expect(firstRes.status).toBe(200)
      const first = await firstRes.json()
      expect(Array.isArray(first)).toBe(false)
      expect(first.items.length).toBe(2)
      expect(first.hasMore).toBe(true)
      expect(first.nextCursor).toEqual(expect.any(String))
      expect(first.nextCursor).not.toBe(first.items[1].id)
      expect(first.totalCount).toBe(4)

      const secondRes = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=done,canceled&limit=2&cursor=${first.nextCursor}`
      )
      const second = await secondRes.json()
      const firstIds = new Set(first.items.map((ws: { id: string }) => ws.id))
      expect(second.items.length).toBe(2)
      expect(second.items.some((ws: { id: string }) => firstIds.has(ws.id))).toBe(false)
    })

    it('paginates only the requested squads for an aggregate squadIds filter', async () => {
      const secondSquad = await Squad.create({ name: `${testPrefix} Second Squad`, purpose: 'Included' })
      const excludedSquad = await Squad.create({ name: `${testPrefix} Excluded Squad`, purpose: 'Excluded' })
      const first = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} First included` })
      const second = await storedLegacyWorkStream({ squadId: secondSquad.id, title: `${testPrefix} Second included` })
      const excluded = await storedLegacyWorkStream({ squadId: excludedSquad.id, title: `${testPrefix} Not included` })
      await Promise.all([
        first.update({ status: 'done' }),
        second.update({ status: 'done' }),
        excluded.update({ status: 'done' }),
      ])

      const response = await apiFetch(
        `/api/workstreams?squadIds=${testSquadId},${secondSquad.id}&statuses=done&limit=50`
      )
      expect(response.status).toBe(200)
      const page = await response.json()
      expect(page.items.map((row: { id: string }) => row.id).sort()).toEqual([first.id, second.id].sort())
      expect(page.totalCount).toBe(2)
      expect(page.hasMore).toBe(false)
    })

    it('paginates default and mixed filters across the non-terminal to terminal boundary', async () => {
      const active = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} mixed active` })
      const older = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} mixed older` })
      const newer = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} mixed newer` })
      await older.update({ status: 'done' })
      await newer.update({ status: 'done' })
      await db
        .update(workStreams)
        .set({ metadata: { completion: { completedAt: '2026-01-01T00:00:00.000Z' } } })
        .where(eq(workStreams.id, older.id))
      await db
        .update(workStreams)
        .set({ metadata: { completion: { completedAt: '2026-01-02T00:00:00.000Z' } } })
        .where(eq(workStreams.id, newer.id))

      for (const filter of ['', '&statuses=active,done']) {
        const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&limit=1${filter}`)).json()
        expect(first.items.map((row: { id: string }) => row.id)).toEqual([active.id])
        expect(first.hasMore).toBe(true)
        expect(first.totalCount).toBe(3)
        const second = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&limit=1${filter}&cursor=${first.nextCursor}`)
        ).json()
        expect(second.items.map((row: { id: string }) => row.id)).toEqual([newer.id])
        expect(second.hasMore).toBe(true)
        const third = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&limit=1${filter}&cursor=${second.nextCursor}`)
        ).json()
        expect(third.items.map((row: { id: string }) => row.id)).toEqual([older.id])
        expect(third.hasMore).toBe(false)
      }
    })

    it('linearizes review completion after its row lock so a blocked approval cannot re-enter terminal history', async () => {
      const review = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} locked review completion`,
        priority: 'high',
      })
      const other = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} locked review other`,
        priority: 'normal',
      })
      const history = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} locked review history`,
        priority: 'low',
      })
      await history.update({ status: 'done' })
      await review.handoffForReview()

      let releaseLock!: () => void
      const releaseLockPromise = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      let rowLocked!: () => void
      const rowLockedPromise = new Promise<void>((resolve) => {
        rowLocked = resolve
      })
      const holder = db.transaction(async (tx) => {
        await tx.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, review.id)).for('update')
        rowLocked()
        await releaseLockPromise
      })
      await rowLockedPromise

      const approval = review.approveReview()
      let approvalWaiting = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query ILIKE '%work_streams%'
            AND query ILIKE '%for update%'
        `)
        if ((row?.waiting ?? 0) > 0) {
          approvalWaiting = true
          break
        }
        await Bun.sleep(10)
      }
      let first: { items: Array<{ id: string }>; nextCursor: string | null }
      try {
        expect(approvalWaiting).toBe(true)
        first = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active,done&limit=1`)
        ).json()
        expect(first.items.map((row) => row.id)).toEqual([review.id])
      } finally {
        releaseLock()
        await holder
      }
      await approval

      const seen = [review.id]
      let cursor = first.nextCursor as string | null
      while (cursor) {
        const page = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active,done&limit=1&cursor=${cursor}`)
        ).json()
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
      }
      expect(seen).toEqual([review.id, other.id, history.id])
      expect(new Set(seen).size).toBe(3)
    })

    it('does not repeat an emitted non-terminal that completes before the terminal phase', async () => {
      const active = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} emitted transition` })
      const older = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} emitted older` })
      const newer = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} emitted newer` })
      await older.update({ status: 'done' })
      await newer.update({ status: 'done' })
      await db
        .update(workStreams)
        .set({ metadata: { completion: { completedAt: '2026-01-01T00:00:00.000Z' } } })
        .where(eq(workStreams.id, older.id))
      await db
        .update(workStreams)
        .set({ metadata: { completion: { completedAt: '2026-01-02T00:00:00.000Z' } } })
        .where(eq(workStreams.id, newer.id))

      const first = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1`)
      ).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([active.id])
      await active.update({ status: 'done' })
      const second = await (
        await apiFetch(
          `/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1&cursor=${first.nextCursor}`
        )
      ).json()
      const third = await (
        await apiFetch(
          `/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1&cursor=${second.nextCursor}`
        )
      ).json()
      expect([...second.items, ...third.items].map((row: { id: string }) => row.id)).toEqual([newer.id, older.id])
      expect(third.hasMore).toBe(false)
    })

    it('preserves a frozen remaining non-terminal that completes before emission', async () => {
      const firstActive = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} remaining first`,
        priority: 'high',
      })
      const remainingActive = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} remaining departed`,
        priority: 'normal',
      })
      const terminal = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} remaining terminal` })
      await terminal.update({ status: 'done' })

      const first = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1`)
      ).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([firstActive.id])
      await remainingActive.update({ status: 'done' })
      const second = await (
        await apiFetch(
          `/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1&cursor=${first.nextCursor}`
        )
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([remainingActive.id])
      expect(second.totalCount).toBe(3)
      expect(second.hasMore).toBe(true)
      const third = await (
        await apiFetch(
          `/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1&cursor=${second.nextCursor}`
        )
      ).json()
      expect(third.items.map((row: { id: string }) => row.id)).toEqual([terminal.id])
      expect(third.hasMore).toBe(false)
    })

    it('freezes review and idle order across opposite wait transitions', async () => {
      const review = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} snapshot review` })
      await review.handoffForReview({ message: 'freeze review first' })
      const idleA = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} snapshot idle a` })
      const idleB = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} snapshot idle b` })
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(workStreams.id, idleA.id))
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
        .where(eq(workStreams.id, idleB.id))

      const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1`)).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([review.id])
      await review.sendBackReview('become idle')
      await idleB.handoffForReview({ message: 'move before the old cursor live' })

      const second = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=2&cursor=${first.nextCursor}`)
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([idleA.id, idleB.id])
      expect(second.hasMore).toBe(false)
    })

    it('freezes running and idle order across opposite execution transitions', async () => {
      const runningAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
      const idleAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
      const running = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} snapshot running`,
        agentIds: [runningAgent.id],
        assigneeAgentId: runningAgent.id,
      })
      const idle = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} snapshot execution idle`,
        agentIds: [idleAgent.id],
        assigneeAgentId: idleAgent.id,
      })
      const [runningExecution] = await db
        .insert(executions)
        .values({ agentId: runningAgent.id, status: 'running', startedAt: new Date() })
        .returning({ id: executions.id })

      const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1`)).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([running.id])
      await db
        .update(executions)
        .set({ status: 'completed', endedAt: new Date() })
        .where(eq(executions.id, runningExecution!.id))
      await db.insert(executions).values({ agentId: idleAgent.id, status: 'running', startedAt: new Date() })

      const second = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${first.nextCursor}`)
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([idle.id])
      expect(second.hasMore).toBe(false)
    })

    it('freezes priority order across opposite priority transitions', async () => {
      const streams = await Promise.all(
        (['critical', 'high', 'normal', 'low'] as const).map((priority) =>
          storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} snapshot ${priority}`, priority })
        )
      )
      const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1`)).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([streams[0]!.id])
      await streams[0]!.update({ priority: 'low' })
      await streams[3]!.update({ priority: 'critical' })

      const second = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=3&cursor=${first.nextCursor}`)
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual(streams.slice(1).map((stream) => stream.id))
      expect(second.hasMore).toBe(false)
    })

    it('paginates opposed unpositioned queue priorities exactly once', async () => {
      await patchJson(`/api/squads/${testSquadId}`, { maxConcurrentWorkStreams: 1 })
      const blocker = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} priority blocker` })
      const streams = await Promise.all(
        (['critical', 'high', 'normal', 'low'] as const).map((priority) =>
          storedLegacyWorkStream({
            squadId: testSquadId,
            title: `${testPrefix} queued ${priority}`,
            priority,
            dependsOn: [blocker.id],
          })
        )
      )
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const page = await (
          await apiFetch(
            `/api/workstreams?squadId=${testSquadId}&statuses=queued&limit=1${cursor ? `&cursor=${cursor}` : ''}`
          )
        ).json()
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
      } while (cursor)
      expect(seen).toEqual(streams.map((stream) => stream.id))
    })

    it('freezes queued position and status order across movements in both directions', async () => {
      const blocker = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} queue movement blocker`,
      })
      const positionedA = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} positioned a`,
        priority: 'high',
      })
      const positionedB = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} positioned b`,
        priority: 'normal',
      })
      const unpositioned = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} initially unpositioned`,
        priority: 'low',
        dependsOn: [blocker.id],
      })
      await db
        .update(workStreams)
        .set({ status: 'queued' })
        .where(inArray(workStreams.id, [positionedA.id, positionedB.id, unpositioned.id]))

      const first = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=1`)
      ).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([blocker.id])
      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, blocker.id))
      await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, positionedA.id))
      await db
        .update(workStreams)
        .set({ dependsOn: [], priority: 'critical' })
        .where(eq(workStreams.id, unpositioned.id))

      const seen = [blocker.id]
      let cursor = first.nextCursor as string | null
      while (cursor) {
        const page = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=2&cursor=${cursor}`)
        ).json()
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
      }
      expect(seen).toEqual([blocker.id, positionedA.id, positionedB.id, unpositioned.id])
    })

    it('returns a recoverable 410 instead of empty+hasMore when the deleted-slice guard is exhausted', async () => {
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 12 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} guarded deleted slice ${index}`,
            status: 'active' as const,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          }))
        )
        .returning({ id: workStreams.id })
      const first = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=1`)
      ).json()
      await db.delete(workStreams).where(
        inArray(
          workStreams.id,
          inserted.slice(1, 11).map((row) => row.id)
        )
      )

      const guarded = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=1&cursor=${first.nextCursor}`
      )
      expect(guarded.status).toBe(410)

      const restarted = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=1`)
      ).json()
      expect(restarted.items.map((row: { id: string }) => row.id)).toEqual([inserted[0]!.id])
      expect(restarted.hasMore).toBe(true)
    })

    it('fills across consecutive deleted ordinal slices before returning a page', async () => {
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 20 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} deleted slice ${index}`,
            status: 'active' as const,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          }))
        )
        .returning({ id: workStreams.id })
      const first = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=5`)
      ).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual(inserted.slice(0, 5).map((row) => row.id))
      await db.delete(workStreams).where(
        inArray(
          workStreams.id,
          inserted.slice(5, 15).map((row) => row.id)
        )
      )

      const second = await (
        await apiFetch(
          `/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=5&cursor=${first.nextCursor}`
        )
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual(inserted.slice(15).map((row) => row.id))
      expect(second.hasMore).toBe(false)
      expect(second.nextCursor).toBeNull()
    })

    it('advances snapshot continuation by consumed ordinal when a row is deleted', async () => {
      const streams = await Promise.all(
        (['high', 'normal', 'low'] as const).map((priority) =>
          storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} deleted ordinal ${priority}`, priority })
        )
      )
      const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1`)).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([streams[0]!.id])
      await db.delete(workStreams).where(eq(workStreams.id, streams[1]!.id))

      const second = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${first.nextCursor}`)
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([streams[2]!.id])
      expect(second.hasMore).toBe(false)
      expect(second.nextCursor).toBeNull()
    })

    it('counts and paginates completions within an exclusive/inclusive visit window', async () => {
      const rows = []
      for (const day of [1, 2, 3, 4]) {
        const row = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} completed ${day}` })
        await db
          .update(workStreams)
          .set({ status: 'done', metadata: { completion: { completedAt: `2026-01-0${day}T00:00:00.000Z` } } })
          .where(eq(workStreams.id, row.id))
        rows.push(row)
      }
      const url = `/api/workstreams?squadId=${testSquadId}&statuses=done&limit=1&completedAfter=2026-01-01T00:00:00.000Z&completedBefore=2026-01-03T00:00:00.000Z`
      const count = await (await apiFetch(`${url}&countOnly=true`)).json()
      expect(count.totalCount).toBe(2)
      const page = await (await apiFetch(url)).json()
      expect(page.totalCount).toBe(2)
      expect(page.items.map((row: { id: string }) => row.id)).toEqual([rows[2]!.id])
      const next = await (await apiFetch(`${url}&cursor=${page.nextCursor}`)).json()
      expect(next.items.map((row: { id: string }) => row.id)).toEqual([rows[1]!.id])
      expect(next.hasMore).toBe(false)
      expect((await apiFetch(url.replace('statuses=done', 'statuses=active'))).status).toBe(400)
      expect((await apiFetch(url.replace('2026-01-01T00:00:00.000Z', 'invalid'))).status).toBe(400)
    })

    it('does not skip metadata or legacy completion rows that differ only by microseconds', async () => {
      const metadataRows = await Promise.all([
        storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} metadata micros a` }),
        storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} metadata micros b` }),
      ])
      const legacyRows = await Promise.all([
        storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} legacy micros a` }),
        storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} legacy micros b` }),
      ])
      const sameCreated = new Date('2025-01-01T00:00:00.000Z')
      await db
        .update(workStreams)
        .set({
          status: 'done',
          createdAt: sameCreated,
          metadata: { completion: { completedAt: '2026-01-02T00:00:00.000900Z' } },
        })
        .where(eq(workStreams.id, metadataRows[0]!.id))
      await db
        .update(workStreams)
        .set({
          status: 'done',
          createdAt: sameCreated,
          metadata: { completion: { completedAt: '2026-01-02T00:00:00.000100Z' } },
        })
        .where(eq(workStreams.id, metadataRows[1]!.id))
      await db.execute(
        sql`UPDATE work_streams SET status = 'done', created_at = ${sameCreated.toISOString()}::timestamp, metadata = '{}'::jsonb, updated_at = '2026-01-01T00:00:00.000900Z'::timestamptz AT TIME ZONE 'UTC' WHERE id = ${legacyRows[0]!.id}::uuid`
      )
      await db.execute(
        sql`UPDATE work_streams SET status = 'done', created_at = ${sameCreated.toISOString()}::timestamp, metadata = '{}'::jsonb, updated_at = '2026-01-01T00:00:00.000100Z'::timestamptz AT TIME ZONE 'UTC' WHERE id = ${legacyRows[1]!.id}::uuid`
      )

      const seen: string[] = []
      let cursor: string | null = null
      do {
        const page = await (
          await apiFetch(
            `/api/workstreams?squadId=${testSquadId}&statuses=done&limit=1${cursor ? `&cursor=${cursor}` : ''}`
          )
        ).json()
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
      } while (cursor)
      expect(seen).toEqual([...metadataRows.map((row) => row.id).sort(), ...legacyRows.map((row) => row.id).sort()])
    })

    it('keyset-pages regex-shaped invalid completion metadata without throwing', async () => {
      const invalid = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} shaped invalid` })
      const valid = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} shaped valid` })
      await db
        .update(workStreams)
        .set({ status: 'done', metadata: { completion: { completedAt: '2026-99-99T99:99:99Z' } } })
        .where(eq(workStreams.id, invalid.id))
      await db
        .update(workStreams)
        .set({ status: 'done', metadata: { completion: { completedAt: '2026-01-01T00:00:00.000Z' } } })
        .where(eq(workStreams.id, valid.id))

      const firstResponse = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done&limit=1`)
      expect(firstResponse.status).toBe(200)
      const first = await firstResponse.json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([valid.id])
      const secondResponse = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=done&limit=1&cursor=${first.nextCursor}`
      )
      expect(secondResponse.status).toBe(200)
      const second = await secondResponse.json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([invalid.id])
    })

    it('continues terminal history when the cursor row is reopened', async () => {
      const streams: WorkStream[] = []
      for (const day of [3, 2, 1]) {
        const stream = await storedLegacyWorkStream({
          squadId: testSquadId,
          title: `${testPrefix} cursor departure ${day}`,
        })
        await stream.update({ status: 'done' })
        await db
          .update(workStreams)
          .set({
            metadata: { completion: { completedAt: `2026-01-0${day}T00:00:00.000Z` } },
            updatedAt: new Date(`2026-01-0${day}T00:00:00.000Z`),
          })
          .where(eq(workStreams.id, stream.id))
        streams.push(stream)
      }

      const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done&limit=1`)).json()
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([streams[0]!.id])
      await streams[0]!.reload()
      await streams[0]!.reopen()

      const second = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done&limit=1&cursor=${first.nextCursor}`)
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([streams[1]!.id])
      expect(second.hasMore).toBe(true)
    })

    it('bounds terminal annotation work to the requested page', async () => {
      for (let index = 0; index < 6; index++) {
        const stream = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} bounded ${index}` })
        await stream.update({ status: 'done' })
      }
      const original = WorkStream.computeRuntimes
      const observedSizes: number[] = []
      const runtimeSpy = spyOn(WorkStream, 'computeRuntimes').mockImplementation(async (streams) => {
        observedSizes.push(streams.length)
        return original.call(WorkStream, streams)
      })
      try {
        const page = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done,canceled&limit=2`)
        ).json()
        expect(page.items).toHaveLength(2)
        expect(page.totalCount).toBe(6)
        expect(observedSizes).toEqual([2])
      } finally {
        runtimeSpy.mockRestore()
      }
    })

    it('paginates queued streams in canonical queue order instead of creation order', async () => {
      await patchJson(`/api/squads/${testSquadId}`, { maxConcurrentWorkStreams: 1 })
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} slot holder` })
      const high = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} older high`,
        priority: 'high',
      })
      const low = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} newer low`,
        priority: 'low',
      })
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(workStreams.id, high.id))
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
        .where(eq(workStreams.id, low.id))

      const firstResponse = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued&limit=1`)
      const first = await firstResponse.json()
      expect(firstResponse.status).toBe(200)
      expect(first.totalCount).toBe(2)
      expect(first.items.map((row: { id: string }) => row.id)).toEqual([high.id])
      expect(first.items[0].queuePosition).toBe(1)
      expect(first.hasMore).toBe(true)
      expect(first.nextCursor).toEqual(expect.any(String))
      const second = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued&limit=1&cursor=${first.nextCursor}`)
      ).json()
      expect(second.items.map((row: { id: string }) => row.id)).toEqual([low.id])
      expect(second.items[0].queuePosition).toBe(2)
      expect(second.hasMore).toBe(false)
    })

    it('includes an immediately created work stream using the database snapshot clock', async () => {
      const created = await (
        await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} immediate snapshot member`,
        })
      ).json()
      const page = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=25`)
      ).json()
      expect(page.items.map((row: { id: string }) => row.id)).toContain(created.id)
      const count = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=1&countOnly=true`)
      ).json()
      expect(count).toEqual({ totalCount: 1 })
    })

    it('uses the database clock rather than an app clock skewed into the future', async () => {
      const future = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} future database row` })
      await db
        .update(workStreams)
        .set({ createdAt: sql`clock_timestamp() + interval '30 minutes'` })
        .where(eq(workStreams.id, future.id))
      setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
      try {
        const page = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=25`)
        ).json()
        expect(page.items.map((row: { id: string }) => row.id)).not.toContain(future.id)
      } finally {
        setSystemTime()
      }
    })

    it('normalizes created and terminal snapshot boundaries to milliseconds', async () => {
      const active = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} created micros` })
      await db
        .update(workStreams)
        .set({ createdAt: sql`'2026-01-01T00:00:00.123999Z'::timestamptz` })
        .where(eq(workStreams.id, active.id))
      const candidates = await WorkStream.listNonTerminalOrderCandidates({
        squadId: testSquadId,
        statuses: ['active'],
        createdBefore: new Date('2026-01-01T00:00:00.123Z'),
      })
      expect(candidates.map((row) => row.id)).toContain(active.id)

      const terminal = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} terminal micros` })
      await db
        .update(workStreams)
        .set({
          status: 'done',
          metadata: { completion: { completedAt: '2026-01-01T00:00:00.123999Z' } },
        })
        .where(eq(workStreams.id, terminal.id))
      const terminalPage = await WorkStream.listTerminalPage({
        squadId: testSquadId,
        statuses: ['done'],
        limit: 10,
        completedBefore: new Date('2026-01-01T00:00:00.123Z'),
      })
      expect(terminalPage.items.map((row) => row.id)).toContain(terminal.id)
    })

    it('keeps a terminal row visible when the app clock is ahead of the database clock', async () => {
      const stream = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} future completion clock`,
      })
      const realNow = Date.now()
      setSystemTime(new Date(realNow + 60_000))
      try {
        const response = await patchJson(`/api/workstreams/${stream.id}`, { status: 'done' })
        expect(response.status).toBe(200)
      } finally {
        setSystemTime()
      }

      const persisted = await WorkStream.mustFind(stream.id)
      expect(persisted.completedAt?.getTime()).toBeLessThan(realNow + 30_000)
      const page = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active,done&limit=25`)
      ).json()
      expect(page.items.map((row: { id: string }) => row.id)).toContain(stream.id)
    })

    it('does not duplicate an emitted row when the app clock is behind the database clock', async () => {
      const first = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} past completion first`,
        priority: 'high',
      })
      const second = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} past completion second`,
        priority: 'normal',
      })
      const pageOne = await (
        await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active,done&limit=1`)
      ).json()
      expect(pageOne.items.map((row: { id: string }) => row.id)).toEqual([first.id])
      await Bun.sleep(5)
      setSystemTime(new Date('2000-01-01T00:00:00.020Z'))
      try {
        await patchJson(`/api/workstreams/${first.id}`, { status: 'done' })
      } finally {
        setSystemTime()
      }

      const persisted = await WorkStream.mustFind(first.id)
      expect(persisted.completedAt?.getUTCFullYear()).not.toBe(2000)
      const seen = [first.id]
      let cursor = pageOne.nextCursor as string | null
      while (cursor) {
        const page = await (
          await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active,done&limit=1&cursor=${cursor}`)
        ).json()
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
      }
      expect(seen).toEqual([first.id, second.id])
      expect(new Set(seen).size).toBe(2)
    })

    it('returns count-only totals without snapshots, full rows, or runtime annotation', async () => {
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} count a` })
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} count b` })
      const runtimeSpy = spyOn(WorkStream, 'computeRuntimes')
      try {
        const response = await apiFetch(
          `/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=1&countOnly=true`
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ totalCount: 2 })
        expect(runtimeSpy).not.toHaveBeenCalled()
        const snapshots = await db.select({ id: workStreamOrderSnapshots.id }).from(workStreamOrderSnapshots)
        expect(snapshots).toEqual([])
      } finally {
        runtimeSpy.mockRestore()
      }
    })

    it('scenario A: walks 47 uniform-priority queued rows at limit 10 with zero loss or duplicates', async () => {
      const rows = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 47 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} scenario A ${index}`,
            status: 'queued' as const,
            priority: 'normal' as const,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          }))
        )
        .returning({ id: workStreams.id })
      const expected = rows.map((row) => row.id)
      const seen = await walkPagedIds(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active`, 10)
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(47)
    })

    it('scenario B: walks 12 priority-opposed active rows at limit 3 exactly once', async () => {
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 12 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} scenario B ${index}`,
            status: 'active' as const,
            priority: index % 2 === 0 ? ('high' as const) : ('normal' as const),
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 11 - index)),
          }))
        )
        .returning({
          id: workStreams.id,
          status: workStreams.status,
          priority: workStreams.priority,
          createdAt: workStreams.createdAt,
        })
      const expected = sortCanonicalWorkStreams(inserted.map((row) => ({ ...row, derivedState: 'idle' as const }))).map(
        (row) => row.id
      )
      const seen = await walkPagedIds(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active`, 3)
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(12)
    })

    it('scenario C: walks 9 priority-opposed dependency-blocked queued rows at limit 2 exactly once', async () => {
      const blocker = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} scenario C blocker` })
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 9 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} scenario C ${index}`,
            status: 'queued' as const,
            priority: index % 3 === 0 ? ('high' as const) : ('normal' as const),
            dependsOn: [blocker.id],
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 8 - index)),
          }))
        )
        .returning({
          id: workStreams.id,
          status: workStreams.status,
          priority: workStreams.priority,
          createdAt: workStreams.createdAt,
        })
      const expected = sortCanonicalWorkStreams(inserted.map((row) => ({ ...row, waitingOnDependencies: true }))).map(
        (row) => row.id
      )
      const seen = await walkPagedIds(`/api/workstreams?squadId=${testSquadId}&statuses=queued`, 2)
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(9)
    })

    it('scenario D: walks every surviving member of 20 rows after mid-walk departure at limit 5', async () => {
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 20 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} scenario D ${index}`,
            status: 'active' as const,
            priority: 'normal' as const,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          }))
        )
        .returning({ id: workStreams.id })
      const departed = inserted.slice(10, 12).map((row) => row.id)
      let postSnapshotId = ''
      const seen = await walkPagedIds(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active`, 5, async () => {
        await db.delete(workStreams).where(inArray(workStreams.id, departed))
        const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} post snapshot` })
        postSnapshotId = created.id
      })
      const survivors = inserted.map((row) => row.id).filter((id) => !departed.includes(id))
      expect(seen).toEqual(survivors)
      expect(new Set(seen).size).toBe(18)
      expect(seen).not.toContain(postSnapshotId)
    })

    it('scenario E: preserves 12 priority-opposed active rows across a limit-4 live boundary', async () => {
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 12 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} scenario E ${index}`,
            status: 'active' as const,
            priority: index < 6 ? ('high' as const) : ('normal' as const),
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 11 - index)),
          }))
        )
        .returning({
          id: workStreams.id,
          status: workStreams.status,
          priority: workStreams.priority,
          createdAt: workStreams.createdAt,
        })
      const expected = sortCanonicalWorkStreams(inserted.map((row) => ({ ...row, derivedState: 'idle' as const }))).map(
        (row) => row.id
      )
      const seen = await walkPagedIds(`/api/workstreams?squadId=${testSquadId}&statuses=queued,active`, 4, async () => {
        await db
          .update(workStreams)
          .set({ priority: 'critical' })
          .where(inArray(workStreams.id, expected.slice(-3)))
        await db
          .update(workStreams)
          .set({ priority: 'low' })
          .where(inArray(workStreams.id, expected.slice(0, 3)))
      })
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(12)
    })

    it('scenario F: flattens 120 active (30 high + 90 normal) mobile-shape rows exactly once at limit 25', async () => {
      const inserted = await db
        .insert(workStreams)
        .values(
          Array.from({ length: 120 }, (_, index) => ({
            squadId: testSquadId,
            title: `${testPrefix} mobile shape ${String(index).padStart(3, '0')}`,
            status: 'active' as const,
            priority: index < 30 ? ('high' as const) : ('normal' as const),
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
            updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          }))
        )
        .returning({
          id: workStreams.id,
          status: workStreams.status,
          priority: workStreams.priority,
          createdAt: workStreams.createdAt,
          updatedAt: workStreams.updatedAt,
        })
      const expected = sortCanonicalWorkStreams(inserted.map((row) => ({ ...row, derivedState: 'idle' as const }))).map(
        (row) => row.id
      )

      const seen: string[] = []
      let cursor: string | null = null
      let pageNumber = 0
      do {
        const page = await (
          await apiFetch(
            `/api/workstreams?squadId=${testSquadId}&statuses=queued,active&limit=25${cursor ? `&cursor=${cursor}` : ''}`
          )
        ).json()
        expect(page.items.length).toBeLessThanOrEqual(25)
        seen.push(...page.items.map((row: { id: string }) => row.id))
        cursor = page.nextCursor
        pageNumber += 1
        if (pageNumber === 1) {
          await db.update(workStreams).set({ status: 'queued', priority: 'low' }).where(eq(workStreams.id, seen[0]!))
          await db
            .update(workStreams)
            .set({ priority: 'critical' })
            .where(inArray(workStreams.id, expected.slice(-10)))
        }
      } while (cursor)

      expect(pageNumber).toBe(5)
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(120)
    })

    it('orders active work by human actionability: human review, running work, automated gate, then the rest', async () => {
      const { human, running, auto, dependency, idle } = await seedActionabilityFixture()

      const list = (await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active`)).json()) as {
        id: string
        derivedState: string
        automatedReviewGate?: boolean
      }[]
      expect(list.map((row) => row.id)).toEqual([human.id, running.id, auto.id, dependency.id, idle.id])
      const byId = new Map(list.map((row) => [row.id, row]))
      expect(byId.get(auto.id)?.automatedReviewGate).toBe(true)
      expect(byId.get(human.id)?.automatedReviewGate).toBeUndefined()
      expect(list.map((row: { derivedState: string }) => row.derivedState)).toEqual([
        'in_review',
        'in_progress',
        'in_review',
        'waiting_on_dependency',
        'idle',
      ])
    })

    it('orders the paged snapshot path with the same annotation-aware urgency', async () => {
      const { human, running, auto, dependency, idle } = await seedActionabilityFixture()

      const seen = await walkPagedIds(`/api/workstreams?squadId=${testSquadId}&statuses=active`, 2)
      expect(seen).toEqual([human.id, running.id, auto.id, dependency.id, idle.id])
      const page = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=5`)).json()
      const autoRow = page.items.find((row: { id: string }) => row.id === auto.id)
      expect(autoRow.automatedReviewGate).toBe(true)
    })

    it('bounds large queued pages, cursors, and full-row annotation work', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z')
      await db.insert(workStreams).values(
        Array.from({ length: 3200 }, (_, index) => ({
          squadId: testSquadId,
          title: `${testPrefix} large queue ${String(index).padStart(4, '0')}`,
          status: 'queued' as const,
          priority: 'normal' as const,
          createdAt,
          updatedAt: createdAt,
        }))
      )
      const original = WorkStream.computeRuntimes
      const observedSizes: number[] = []
      const runtimeSpy = spyOn(WorkStream, 'computeRuntimes').mockImplementation(async (streams) => {
        observedSizes.push(streams.length)
        return original.call(WorkStream, streams)
      })
      try {
        const response = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued&limit=25`)
        const body = await response.text()
        const page = JSON.parse(body)
        expect(response.status).toBe(200)
        expect(page.items).toHaveLength(25)
        expect(page.totalCount).toBe(3200)
        expect(page.hasMore).toBe(true)
        expect(page.nextCursor.length).toBeLessThan(1024)
        expect(body.length).toBeLessThan(100_000)
        expect(observedSizes).toEqual([25])
      } finally {
        runtimeSpy.mockRestore()
      }
    })

    it('rejects malformed legacy mixed-cursor UUID arrays without a database error', async () => {
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} malformed cursor` })
      const malformed = Buffer.from(
        JSON.stringify({
          v: 2,
          remainingNonTerminalIds: ['not-a-uuid'],
          excludedTerminalIds: ['also-not-a-uuid'],
          totalCount: 1,
        })
      ).toString('base64url')
      const response = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=active,done&limit=1&cursor=${malformed}`
      )
      expect(response.status).toBe(400)
    })

    it('orders equal positioned queue rows across squads by canonical priority exactly once', async () => {
      const other = await Squad.create({ name: `${testPrefix} Other Queue`, purpose: 'cross-squad queue tie' })
      try {
        await patchJson(`/api/squads/${testSquadId}`, { maxConcurrentWorkStreams: 0 })
        await other.update({ maxConcurrentWorkStreams: 0 })
        const low = await storedLegacyWorkStream({
          squadId: testSquadId,
          title: `${testPrefix} positioned low`,
          priority: 'low',
        })
        const high = await storedLegacyWorkStream({
          squadId: other.id,
          title: `${testPrefix} positioned high`,
          priority: 'high',
        })
        await db
          .update(workStreams)
          .set({ status: 'queued' })
          .where(inArray(workStreams.id, [low.id, high.id]))
        const seen: string[] = []
        let cursor: string | null = null
        do {
          const page = await (
            await apiFetch(`/api/workstreams?statuses=queued&limit=1${cursor ? `&cursor=${cursor}` : ''}`)
          ).json()
          seen.push(...page.items.map((row: { id: string }) => row.id))
          cursor = page.nextCursor
        } while (cursor)
        // The unfiltered queued listing is shared-DB-wide, so assert on OUR
        // rows only: canonical priority order (high before low across squads at
        // equal queue position) and exactly-once pagination. Asserting the full
        // listing equaled exactly these two rows made any queued row leaked by
        // an earlier suite in the same run fail this test (observed 4x on CI
        // 2026-08-20/21, reproduced with an in-process leak probe).
        const mine = seen.filter((id) => id === high.id || id === low.id)
        expect(mine).toEqual([high.id, low.id])
      } finally {
        await db.delete(workStreams).where(eq(workStreams.squadId, other.id))
        await db.delete(squads).where(eq(squads.id, other.id))
      }
    })

    it('rejects expired and request-mismatched durable cursors', async () => {
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} durable cursor a` })
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} durable cursor b` })
      const first = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1`)).json()
      const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as {
        v: 4
        snapshotId: string
        nextOrdinal: number
        terminalCursor?: string
        signature: string
      }
      const [storedSnapshot] = await db
        .select({ cursorSecret: workStreamOrderSnapshots.cursorSecret })
        .from(workStreamOrderSnapshots)
        .where(eq(workStreamOrderSnapshots.id, decoded.snapshotId))
      const signedCursor = (value: Omit<typeof decoded, 'signature'>) => {
        const signature = createHmac('sha256', storedSnapshot!.cursorSecret)
          .update(JSON.stringify(value))
          .digest('base64url')
        return Buffer.from(JSON.stringify({ ...value, signature })).toString('base64url')
      }

      const tamperedOrdinal = Buffer.from(
        JSON.stringify({ ...decoded, nextOrdinal: decoded.nextOrdinal + 1 })
      ).toString('base64url')
      expect(
        (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${tamperedOrdinal}`))
          .status
      ).toBe(400)
      const outOfBounds = signedCursor({ v: 4, snapshotId: decoded.snapshotId, nextOrdinal: 3 })
      expect(
        (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${outOfBounds}`)).status
      ).toBe(400)
      const malformedNested = signedCursor({
        v: 4,
        snapshotId: decoded.snapshotId,
        nextOrdinal: 2,
        terminalCursor: 'not-a-terminal-cursor',
      })
      expect(
        (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${malformedNested}`))
          .status
      ).toBe(400)

      const mismatch = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=queued&limit=1&cursor=${first.nextCursor}`
      )
      expect(mismatch.status).toBe(400)

      await db
        .update(workStreamOrderSnapshots)
        .set({ ownerKey: 'user:foreign-owner' })
        .where(eq(workStreamOrderSnapshots.id, decoded.snapshotId))
      const foreignOwner = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${first.nextCursor}`
      )
      expect(foreignOwner.status).toBe(400)

      await db
        .update(workStreamOrderSnapshots)
        .set({ expiresAt: new Date(0) })
        .where(eq(workStreamOrderSnapshots.id, decoded.snapshotId))
      const expired = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${first.nextCursor}`
      )
      expect(expired.status).toBe(410)

      const fresh = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1`)).json()
      const missingDecoded = JSON.parse(Buffer.from(fresh.nextCursor, 'base64url').toString('utf8')) as {
        snapshotId: string
      }
      await db.delete(workStreamOrderSnapshots).where(eq(workStreamOrderSnapshots.id, missingDecoded.snapshotId))
      const missing = await apiFetch(
        `/api/workstreams?squadId=${testSquadId}&statuses=active&limit=1&cursor=${fresh.nextCursor}`
      )
      expect(missing.status).toBe(410)
    })

    it('orders dependency-parked unpositioned queue rows by priority, creation, then id', async () => {
      await patchJson(`/api/squads/${testSquadId}`, { maxConcurrentWorkStreams: 1 })
      const blocker = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} unresolved blocker` })
      const rows = await Promise.all([
        storedLegacyWorkStream({
          squadId: testSquadId,
          title: `${testPrefix} normal tie a`,
          priority: 'normal',
          dependsOn: [blocker.id],
        }),
        storedLegacyWorkStream({
          squadId: testSquadId,
          title: `${testPrefix} high new`,
          priority: 'high',
          dependsOn: [blocker.id],
        }),
        storedLegacyWorkStream({
          squadId: testSquadId,
          title: `${testPrefix} high old`,
          priority: 'high',
          dependsOn: [blocker.id],
        }),
        storedLegacyWorkStream({
          squadId: testSquadId,
          title: `${testPrefix} normal tie b`,
          priority: 'normal',
          dependsOn: [blocker.id],
        }),
      ])
      const same = new Date('2026-01-03T00:00:00.000Z')
      await db
        .update(workStreams)
        .set({ createdAt: same })
        .where(inArray(workStreams.id, [rows[0]!.id, rows[3]!.id]))
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
        .where(eq(workStreams.id, rows[1]!.id))
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(workStreams.id, rows[2]!.id))

      const response = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=queued`)
      const json = (await response.json()) as Array<{
        id: string
        queuePosition?: number
        waitingOnDependencies?: boolean
      }>
      const ties = [rows[0]!.id, rows[3]!.id].sort()
      expect(json.map((row) => row.id)).toEqual([rows[2]!.id, rows[1]!.id, ...ties])
      expect(json.every((row) => row.queuePosition === undefined && row.waitingOnDependencies === true)).toBe(true)
    })

    it('orders active rows by derived review urgency before creation time', async () => {
      const review = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} older review`,
        priority: 'low',
      })
      await review.handoffForReview({ message: 'Review this first' })
      const idle = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} newer idle`,
        priority: 'critical',
      })
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(workStreams.id, review.id))
      await db
        .update(workStreams)
        .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
        .where(eq(workStreams.id, idle.id))

      const response = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active`)
      expect(response.status).toBe(200)
      const rows = (await response.json()) as Array<{ id: string; derivedState?: string }>
      const ours = rows.filter((row) => row.id === review.id || row.id === idle.id)
      expect(ours.map((row) => row.id)).toEqual([review.id, idle.id])
      expect(ours.map((row) => row.derivedState)).toEqual(['in_review', 'idle'])
    })

    it('serializes terminalFailure for an execution_failed stream and omits it otherwise', async () => {
      const [agent] = await db.insert(agents).values({ agentTypeId: testAgentTypeId }).returning()
      const failed = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} platform refused`,
        assigneeAgentId: agent.id,
        agentIds: [agent.id],
      })
      const healthy = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} healthy idle` })
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'failed',
        error: 'Admission effect was refused by the durable fence',
        failureClass: 'platform_pre_tool_refusal',
        failureReason: 'admission_fence-closed',
        endedAt: new Date('2026-01-03T00:00:00.000Z'),
      })

      const listResponse = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=active`)
      expect(listResponse.status).toBe(200)
      const listRows = (await listResponse.json()) as Array<{
        id: string
        derivedState?: string
        terminalFailure?: {
          executionId: string
          failureClass: string | null
          failureReason: string | null
          endedAt: string
        }
      }>
      const failedRow = listRows.find((row) => row.id === failed.id)
      const healthyRow = listRows.find((row) => row.id === healthy.id)
      expect(failedRow?.derivedState).toBe('execution_failed')
      expect(failedRow?.terminalFailure).toMatchObject({
        failureClass: 'platform_pre_tool_refusal',
        failureReason: 'admission_fence-closed',
      })
      expect(typeof failedRow?.terminalFailure?.executionId).toBe('string')
      expect(typeof failedRow?.terminalFailure?.endedAt).toBe('string')
      // Older-row clients see nullable-only additions: streams without a
      // surfaced failure simply omit the field.
      expect(healthyRow?.derivedState).toBe('idle')
      expect(healthyRow?.terminalFailure).toBeUndefined()

      const detailResponse = await apiFetch(`/api/workstreams/${failed.id}`)
      expect(detailResponse.status).toBe(200)
      const detail = (await detailResponse.json()) as {
        derivedState?: string
        terminalFailure?: { failureClass: string | null }
      }
      expect(detail.derivedState).toBe('execution_failed')
      expect(detail.terminalFailure?.failureClass).toBe('platform_pre_tool_refusal')
    })

    it('orders terminal history by immutable completion time', async () => {
      const completedLast = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} completed last`,
      })
      const completedFirst = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} completed first`,
      })
      await completedFirst.update({ status: 'canceled' })
      await completedLast.update({ status: 'done' })
      await db
        .update(workStreams)
        .set({
          metadata: { completion: { completedAt: '2026-01-09T00:00:00.000Z' } },
          updatedAt: new Date('2026-01-09T00:00:00.000Z'),
        })
        .where(eq(workStreams.id, completedLast.id))
      await db
        .update(workStreams)
        .set({
          metadata: { completion: { completedAt: '2026-01-02T00:00:00.000Z' } },
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        })
        .where(eq(workStreams.id, completedFirst.id))
      await completedFirst.reload()
      await completedFirst.update({ title: `${testPrefix} completed first edited later` })
      const malformed = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} malformed completion`,
      })
      await db
        .update(workStreams)
        .set({
          status: 'done',
          metadata: { completion: { completedAt: 'not-a-date' } },
          updatedAt: new Date('2026-01-10T00:00:00.000Z'),
        })
        .where(eq(workStreams.id, malformed.id))
      await malformed.reload()
      await malformed.update({ title: `${testPrefix} malformed completion edited later` })

      const response = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=done,canceled`)
      expect(response.status).toBe(200)
      const rows = (await response.json()) as Array<{ id: string; completedAt?: string | null }>
      expect(rows.map((row) => row.id)).toEqual([completedLast.id, completedFirst.id, malformed.id])
      expect(rows.map((row) => row.completedAt)).toEqual(['2026-01-09T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null])
      expect(sortCanonicalWorkStreams(rows as unknown as CanonicalWorkStreamOrderInput[]).map((row) => row.id)).toEqual(
        [completedLast.id, completedFirst.id, malformed.id]
      )
    })

    it('rejects an explicit statuses filter with no valid values instead of returning an unbounded list', async () => {
      await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} invalid status filter` })
      const response = await apiFetch(`/api/workstreams?squadId=${testSquadId}&statuses=unknown,,legacy&limit=1`)
      expect(response.status).toBe(400)
    })

    it('filters by status', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Active` })
      const created = await createRes.json()

      await patchJson(`/api/workstreams/${created.id}`, { status: 'in_progress', assigneeAgentId: testAgentId })

      const res = await apiFetch(`/api/workstreams?squadId=${testSquadId}&status=in_progress`)
      const list = await res.json()
      expect(list.some((ws: { title: string }) => ws.title === `${testPrefix} Active`)).toBe(true)
    })
  })

  describe('dependedOnBy serialization', () => {
    it('returns truthful inverse edges in list and detail and updates after dependency mutation', async () => {
      const target = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} target` })
      const empty = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} empty` })
      const dependent = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} dependent`,
        dependsOn: [target.id],
      })
      const otherSquad = await Squad.create({ name: `${testPrefix} Other Squad`, purpose: 'Testing isolation' })
      await storedLegacyWorkStream({
        squadId: otherSquad.id,
        title: `${testPrefix} cross squad`,
        dependsOn: [target.id],
      })

      const list = (await (await apiFetch(`/api/workstreams?squadId=${testSquadId}`)).json()) as Array<{
        id: string
        dependedOnBy: string[]
      }>
      expect(list.find((stream) => stream.id === target.id)?.dependedOnBy).toEqual([dependent.id])
      expect(list.find((stream) => stream.id === empty.id)?.dependedOnBy).toEqual([])

      const detail = (await (await apiFetch(`/api/workstreams/${target.id}`)).json()) as { dependedOnBy: string[] }
      expect(detail.dependedOnBy).toEqual([dependent.id])

      const mutationResponse = (await (
        await patchJson(`/api/workstreams/${target.id}`, { title: `${testPrefix} renamed target` })
      ).json()) as { dependedOnBy: string[] }
      expect(mutationResponse.dependedOnBy).toEqual([dependent.id])

      await dependent.update({ dependsOn: [empty.id] })
      const [updatedTarget, updatedEmpty] = await Promise.all([
        apiFetch(`/api/workstreams/${target.id}`).then(
          (response) => response.json() as Promise<{ dependedOnBy: string[] }>
        ),
        apiFetch(`/api/workstreams/${empty.id}`).then(
          (response) => response.json() as Promise<{ dependedOnBy: string[] }>
        ),
      ])
      expect(updatedTarget.dependedOnBy).toEqual([])
      expect(updatedEmpty.dependedOnBy).toEqual([dependent.id])
    })
  })

  describe('GET /api/workstreams/:id', () => {
    it('gets work stream by id', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Get test` })
      const created = await createRes.json()

      const res = await apiFetch(`/api/workstreams/${created.id}`)
      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.title).toBe(`${testPrefix} Get test`)
    })

    it('returns runtime by default', async () => {
      const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} runtime-detail` })

      const res = await apiFetch(`/api/workstreams/${created.id}`)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { runtime?: { totalMs: number; activeCount: number; computedAt: string } }
      expect(json.runtime).toBeDefined()
      expect(json.runtime!.totalMs).toBe(0)
      expect(typeof json.runtime!.computedAt).toBe('string')
    })

    it('returns 404 for non-existent', async () => {
      const res = await apiFetch('/api/workstreams/00000000-0000-0000-0000-000000000000')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/workstreams/:id', () => {
    it('updates and clears ownerAgentId through the standard update route', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} Owner patch` })

      const setRes = await patchJson(`/api/workstreams/${ws.id}`, { ownerAgentId: testAgentId.slice(0, 8) })

      expect(setRes.status).toBe(200)
      expect((await setRes.json()).ownerAgentId).toBe(testAgentId)

      const clearRes = await patchJson(`/api/workstreams/${ws.id}`, { ownerAgentId: null })

      expect(clearRes.status).toBe(200)
      expect((await clearRes.json()).ownerAgentId).toBeNull()
    })

    it('allows clearing the assignee of an active stream (idle is the surfaced alarm)', async () => {
      const created = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} active assignee guard`,
        assigneeAgentId: testAgentId,
      })

      const cleared = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: null })
      expect(cleared.status).toBe(200)
      expect((await cleared.json()).assigneeAgentId).toBeNull()
    })

    it('maps legacy status writes and rejects removed blocked/review statuses', async () => {
      const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} legacy status write` })

      // in_progress → active (one-release compat alias)
      const legacy = await patchJson(`/api/workstreams/${created.id}`, { status: 'in_progress' })
      expect(legacy.status).toBe(200)
      expect((await legacy.json()).status).toBe('active')

      // blocked/review are no longer statuses — writes are rejected with a pointer to the wait verbs
      for (const removed of ['blocked', 'review']) {
        const res = await patchJson(`/api/workstreams/${created.id}`, { status: removed })
        expect(res.status).toBe(400)
      }
    })

    it('opens a manual wait via POST /:id/request-input and surfaces it in derived state', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} To block` })
      const created = await createRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/request-input`, { message: 'Which option?' })
      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.status).toBe('active')
      expect(ws.wait.type).toBe('manual')
      expect(ws.wait.message).toBe('Which option?')
      expect(ws.wait.createdBy).toBe('operator')
      expect(ws.wait.createdByAgentId).toBeNull()
      expect(ws.wait.createdByUserId).toBe(admin.id)

      const detail = await apiFetch(`/api/workstreams/${created.id}`)
      const detailJson = await detail.json()
      expect(detailJson.derivedState).toBe('blocked')
      expect(detailJson.openWaits).toHaveLength(1)
      expect(detailJson.openWaits[0].type).toBe('manual')
    })

    it('persists nextSteps metadata when marking a work stream done', async () => {
      const created = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} Done with next steps`,
        metadata: { github: { issue: '42' } },
      })

      const res = await patchJson(`/api/workstreams/${created.id}`, {
        status: 'done',
        nextSteps: 'Create a separate work stream for cleanup.',
      })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.status).toBe('done')
      expect(ws.metadata.nextSteps).toBe('Create a separate work stream for cleanup.')
      expect(ws.metadata.github.issue).toBe('42')
    })

    it('updates typed completion and git fields without clobbering metadata', async () => {
      const created = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} Preserve metadata`,
        metadata: { github: { issue: '42' } },
      })

      const res = await patchJson(`/api/workstreams/${created.id}`, {
        completionMode: 'direct-merge',
        baseBranch: 'main',
      })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.completionMode).toBe('direct-merge')
      expect(ws.baseBranch).toBe('main')
      expect(ws.metadata.completion.mode).toBe('direct-merge')
      expect(ws.metadata.git.baseBranch).toBe('main')
      expect(ws.metadata.github.issue).toBe('42')
    })

    it('updates to pr-auto-merge completion mode', async () => {
      const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} Auto merge update` })

      const res = await patchJson(`/api/workstreams/${created.id}`, { completionMode: 'pr-auto-merge' })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.completionMode).toBe('pr-auto-merge')
      expect(ws.metadata.completion.mode).toBe('pr-auto-merge')
    })

    it('rejects invalid completion mode updates', async () => {
      const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} Reject update` })

      const res = await patchJson(`/api/workstreams/${created.id}`, { completionMode: 'something-else' })

      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/workstreams/:id/cancel', () => {
    it('cancels a work stream', async () => {
      const created = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} cancel route`,
        assigneeAgentId: testAgentId,
      })
      await created.update({ status: 'active' })

      const res = await post(`/api/workstreams/${created.id}/cancel`)

      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe('canceled')
    })

    it('is idempotent for already canceled work streams', async () => {
      const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} cancel route twice` })
      await post(`/api/workstreams/${created.id}/cancel`)

      const res = await post(`/api/workstreams/${created.id}/cancel`)

      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe('canceled')
    })

    it('rejects completed work streams', async () => {
      const created = await storedLegacyWorkStream({ squadId: testSquadId, title: `${testPrefix} done route` })
      await created.update({ status: 'done' })

      const res = await post(`/api/workstreams/${created.id}/cancel`)

      expect(res.status).toBe(400)
    })

    it('does not stop active executions when rejecting completed work streams', async () => {
      const agent = await Agent.find(testAgentId)
      expect(agent).not.toBeNull()
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} completed with active execution`,
        agentIds: [agent!.id],
        assigneeAgentId: agent!.id,
      })
      await ws.update({ status: 'done' })
      await agent!.reload()
      const execution = await agent!.queueExecution({ message: 'working after completion' })

      const res = await post(`/api/workstreams/${ws.id}/cancel`)

      expect(res.status).toBe(400)
      const stillActive = await Execution.find(execution.id)
      expect(stillActive?.status).toBe('queued')
    })

    it('requests stop for active assigned agent executions', async () => {
      const agent = await Agent.find(testAgentId)
      expect(agent).not.toBeNull()
      const execution = await agent!.queueExecution({ message: 'working' })
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} cancel running`,
        agentIds: [agent!.id],
        assigneeAgentId: agent!.id,
      })
      await ws.update({ status: 'active' })

      const res = await post(`/api/workstreams/${ws.id}/cancel`)

      expect(res.status).toBe(200)
      const stopped = await Execution.find(execution.id)
      expect(stopped?.status).toBe('stopped')
    })
  })

  describe('POST /api/workstreams/:id/waits/:waitId/resolve', () => {
    it('clears a manual wait with a note (typed resolve happy path)', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Blocked` })
      const created = await createRes.json()

      const blockRes = await postJson(`/api/workstreams/${created.id}/request-input`, { message: 'What credentials?' })
      const { wait } = await blockRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
        resolution: 'cleared',
        note: 'Use OAuth',
      })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.status).toBe('active')
      expect(ws.wait.id).toBe(wait.id)
      expect(ws.wait.resolution).toBe('cleared')
      expect(ws.wait.resolutionNote).toBe('Use OAuth')
      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect((detail.openWaits ?? []).some((w: { type: string }) => w.type === 'manual')).toBe(false)
    })

    it('approves a review wait by id (closes the wait AND completes the stream)', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Resolve ok` })
      const created = await createRes.json()
      const reviewRes = await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'please review' })
      const { wait } = await reviewRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, { resolution: 'approved' })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.status).toBe('done')
      expect(ws.wait.resolution).toBe('approved')
    })

    it('rejects invalid resolution-vs-type combos with 400 and leaves the wait open', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Bad combo` })
      const created = await createRes.json()
      const blockRes = await postJson(`/api/workstreams/${created.id}/request-input`, { message: 'input?' })
      const { wait } = await blockRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, { resolution: 'approved' })

      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('invalid_resolution')
      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect((detail.openWaits ?? []).some((w: { id: string }) => w.id === wait.id)).toBe(true)
    })

    it('rejects sent_back without a note at the schema boundary', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} No note` })
      const created = await createRes.json()
      const reviewRes = await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'review me' })
      const { wait } = await reviewRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
        resolution: 'sent_back',
      })

      expect(res.status).toBe(400)
      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect((detail.openWaits ?? []).some((w: { id: string }) => w.id === wait.id)).toBe(true)
    })

    it('returns 404 for unknown wait ids and 409 for already-closed waits', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} 404/409` })
      const created = await createRes.json()

      const missing = await postJson(`/api/workstreams/${created.id}/waits/${crypto.randomUUID()}/resolve`, {
        resolution: 'cleared',
      })
      expect(missing.status).toBe(404)

      const blockRes = await postJson(`/api/workstreams/${created.id}/request-input`, { message: 'input?' })
      const { wait } = await blockRes.json()
      await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, { resolution: 'cleared' })
      const again = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
        resolution: 'cleared',
      })
      expect(again.status).toBe(409)
      expect((await again.json()).code).toBe('wait_already_closed')
    })

    it('returns a typed 409 when the stream is terminal at mutation time', async () => {
      const created = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} terminal wait conflict`,
      })
      const wait = await created.block({ message: 'input?' })
      await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, created.id))

      const response = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
        resolution: 'cleared',
      })

      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('work_stream_terminal')
    })

    it('legacy POST /:id/respond is gone (404)', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} No respond` })
      const created = await createRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/respond`, { response: 'Approve' })

      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/workstreams/:id/request-review and /:id/handoff split', () => {
    it('request-review opens the review wait (idempotent while open)', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Req review` })
      const created = await createRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'ready for review' })
      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.wait.type).toBe('review')
      expect(ws.wait.message).toBe('ready for review')
      expect(ws.alreadyOpen).toBe(false)
      expect(ws.status).toBe('active')

      const second = await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'again' })
      expect(second.status).toBe(200)
      expect((await second.json()).alreadyOpen).toBe(true)
    })

    it('message-only handoff no longer opens a review wait (route removed)', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Handoff` })
      const created = await createRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/handoff`, { message: 'done for now' })
      expect(res.status).toBe(404)

      // Behavioral: no review wait was opened by the attempt.
      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect((detail.openWaits ?? []).some((w: { type: string }) => w.type === 'review')).toBe(false)
    })

    it('legacy POST /:id/block is gone (404)', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} No block` })
      const created = await createRes.json()

      const res = await postJson(`/api/workstreams/${created.id}/block`, { message: 'help' })
      expect(res.status).toBe(404)
      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect(detail.openWaits ?? []).toHaveLength(0)
    })
  })

  describe('done-guard + terminal backdoor (spec §5/§6)', () => {
    it('PATCH status:done with an open wait is 409 with the open waits listed', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} guard 409` })
      ).json()
      const reviewRes = await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'review first' })
      const { wait } = await reviewRes.json()

      const res = await patchJson(`/api/workstreams/${created.id}`, { status: 'done' })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('open_waits')
      expect(body.error).toMatch(/resolve or cancel the open waits/i)
      expect(body.openWaits).toEqual([{ id: wait.id, type: 'review' }])

      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect(detail.status).toBe('active')
    })

    it('PATCH active-from-done is 409 pointing at reopen', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} backdoor 409` })
      ).json()
      expect((await patchJson(`/api/workstreams/${created.id}`, { status: 'done' })).status).toBe(200)

      const res = await patchJson(`/api/workstreams/${created.id}`, { status: 'active' })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('terminal_status')
      expect(body.error).toMatch(/reopen/i)

      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect(detail.status).toBe('done')
    })
  })

  describe('POST /api/workstreams/:id/reopen', () => {
    it('reopens a done stream back into admission (active under a free slot)', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} reopen route` })
      ).json()
      expect((await patchJson(`/api/workstreams/${created.id}`, { status: 'done' })).status).toBe(200)

      const res = await postJson(`/api/workstreams/${created.id}/reopen`, {})
      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.status).toBe('active')
      expect(ws.completedAt).toBeUndefined()
    })

    it('rejects reopening a non-terminal stream with 409', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} reopen active 409` })
      ).json()
      const res = await postJson(`/api/workstreams/${created.id}/reopen`, {})
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('not_reopenable')
    })
  })

  describe('POST /api/workstreams/:id/approve note (spec §4b)', () => {
    it('accepts an optional note, recording it on the approved wait', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} approve note route` })
      ).json()
      await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'review me' })

      const res = await postJson(`/api/workstreams/${created.id}/approve`, { note: 'approved with thanks' })
      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe('done')

      const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
      expect(detail.reviewHistory[0].resolution).toBe('approved')
      expect(detail.reviewHistory[0].resolutionNote).toBe('approved with thanks')
    })

    it('still accepts an empty body', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} approve empty body` })
      ).json()
      await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'review me' })
      const res = await postJson(`/api/workstreams/${created.id}/approve`, {})
      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe('done')
    })
  })

  describe('request-review completesOnApproval (spec §4)', () => {
    it('completesOnApproval:false opens a checkpoint review; approval leaves the stream active', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} checkpoint route` })
      ).json()
      const reviewRes = await postJson(`/api/workstreams/${created.id}/request-review`, {
        message: 'mid-work checkpoint',
        completesOnApproval: false,
      })
      expect(reviewRes.status).toBe(200)
      const { wait } = await reviewRes.json()
      expect(wait.completesOnApproval).toBe(false)

      const resolveRes = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
        resolution: 'approved',
        note: 'keep going',
      })
      expect(resolveRes.status).toBe(200)
      const resolved = await resolveRes.json()
      expect(resolved.status).toBe('active')
      expect(resolved.wait.resolution).toBe('approved')
      expect(resolved.wait.resolutionNote).toBe('keep going')
    })

    it('the default flag still completes on approval', async () => {
      const created = await (
        await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} default flag route` })
      ).json()
      const { wait } = await (
        await postJson(`/api/workstreams/${created.id}/request-review`, { message: 'final review' })
      ).json()
      expect(wait.completesOnApproval).toBe(true)

      const resolveRes = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
        resolution: 'approved',
      })
      expect(resolveRes.status).toBe(200)
      expect((await resolveRes.json()).status).toBe('done')
    })
  })

  describe('DELETE /api/workstreams/:id', () => {
    it('deletes work stream', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} To delete` })
      const created = await createRes.json()

      const deleteRes = await del(`/api/workstreams/${created.id}`)
      expect(deleteRes.status).toBe(204)
    })
  })

  describe('GET /api/workstreams/:id/ready', () => {
    it('checks if dependencies are met', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} No deps` })
      const created = await createRes.json()

      const res = await apiFetch(`/api/workstreams/${created.id}/ready`)
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.ready).toBe(true)
    })
  })

  describe('GET /api/workstreams/by-metadata', () => {
    it('finds work streams by metadata match', async () => {
      await legacyFixtureResponse({
        squadId: testSquadId,
        title: `${testPrefix} PR 42`,
        metadata: { github: { pr: { number: '42' }, repo: 'org/repo' } },
      })
      await legacyFixtureResponse({
        squadId: testSquadId,
        title: `${testPrefix} PR 99`,
        metadata: { github: { pr: { number: '99' }, repo: 'org/repo' } },
      })

      const res = await apiFetch('/api/workstreams/by-metadata?match=github.pr.number:42&match=github.repo:org/repo')
      expect(res.status).toBe(200)
      const list = await res.json()
      const ours = list.filter((ws: any) => ws.title.startsWith(testPrefix))
      expect(ours.length).toBe(1)
      expect(ours[0].title).toContain('PR 42')
    })

    it('returns empty array when no match', async () => {
      const res = await apiFetch('/api/workstreams/by-metadata?match=github.pr.number:99999')
      expect(res.status).toBe(200)
      const list = await res.json()
      expect(list).toEqual([])
    })

    it('returns 400 with no match params', async () => {
      const res = await apiFetch('/api/workstreams/by-metadata')
      expect(res.status).toBe(400)
    })

    it('returns 400 with invalid match format', async () => {
      const res = await apiFetch('/api/workstreams/by-metadata?match=invalid-no-colon')
      expect(res.status).toBe(400)
    })

    it('includes runtime on each row', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} runtime-test`,
        agentIds: [testAgentId],
      })
      const startedAt = new Date('2026-01-01T00:00:00Z')
      await db.insert(executions).values({
        agentId: testAgentId,
        status: 'completed',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 12_000),
      })

      const res = await apiFetch(`/api/workstreams?squadId=${testSquadId}`)
      expect(res.status).toBe(200)
      const rows = (await res.json()) as Array<{
        id: string
        runtime?: { totalMs: number; activeCount: number; computedAt: string }
      }>
      const row = rows.find((r) => r.id === ws.id)
      expect(row?.runtime?.totalMs).toBe(12_000)
      expect(row?.runtime?.activeCount).toBe(0)
      expect(typeof row?.runtime?.computedAt).toBe('string')
    })

    it('filters by status', async () => {
      const createRes = await legacyFixtureResponse({
        squadId: testSquadId,
        title: `${testPrefix} Active PR`,
        metadata: { github: { pr: { number: '55' }, repo: 'org/repo' } },
      })
      const created = await createRes.json()
      await patchJson(`/api/workstreams/${created.id}`, { status: 'active', assigneeAgentId: testAgentId })

      const doneRes = await legacyFixtureResponse({
        squadId: testSquadId,
        title: `${testPrefix} Done PR`,
        metadata: { github: { pr: { number: '55' }, repo: 'org/repo' } },
      })
      const done = await doneRes.json()
      await patchJson(`/api/workstreams/${done.id}`, { status: 'done' })

      // The legacy filter vocabulary maps for one release (in_progress -> active).
      for (const filter of ['active', 'in_progress']) {
        const res = await apiFetch(`/api/workstreams/by-metadata?match=github.pr.number:55&status=${filter}`)
        expect(res.status).toBe(200)
        const list = await res.json()
        const ours = list.filter((ws: any) => ws.title.startsWith(testPrefix))
        expect(ours.length).toBe(1)
        expect(ours[0].title).toContain('Active PR')
      }
    })
  })

  describe('agentIds', () => {
    it('rejects removing the active assignee from an in_progress stream', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} active removal guard`,
        agentIds: [testAgentId],
        assigneeAgentId: testAgentId,
      })
      await ws.update({ status: 'active' })

      const response = await del(`/api/workstreams/${ws.id}/agents/${testAgentId}`)
      expect(response.status).toBe(400)
      await ws.reload()
      expect(ws.agentIds).toContain(testAgentId)
      expect(ws.assigneeAgentId).toBe(testAgentId)
    })
    let secondAgentId: string

    beforeEach(async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      secondAgentId = agent.id
    })

    describe('PATCH /api/workstreams/:id with agentIds', () => {
      it('allows updating assignee to agent in existing agentIds', async () => {
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} Update allowed`,
          agentIds: [testAgentId, secondAgentId],
        })
        const created = await createRes.json()

        const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: testAgentId })

        expect(res.status).toBe(200)
        const ws = await res.json()
        expect(ws.assigneeAgentId).toBe(testAgentId)
      })

      it('rejects updating assignee to agent not in existing agentIds', async () => {
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} Update rejected`,
          agentIds: [testAgentId],
        })
        const created = await createRes.json()

        const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: secondAgentId })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('not in the agents list')
      })

      it('uses new agentIds from same request for validation', async () => {
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} New list`,
          agentIds: [testAgentId],
        })
        const created = await createRes.json()

        // Update both agentIds and assignee in same request
        const res = await patchJson(`/api/workstreams/${created.id}`, {
          agentIds: [secondAgentId],
          assigneeAgentId: secondAgentId,
        })

        expect(res.status).toBe(200)
        const ws = await res.json()
        expect(ws.assigneeAgentId).toBe(secondAgentId)
        expect(ws.agentIds).toEqual([secondAgentId])
      })

      it('allows UUID prefix matching in agentIds on update', async () => {
        const prefix = testAgentId.slice(0, 8)
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} Prefix update`,
          agentIds: [testAgentId],
        })
        const created = await createRes.json()

        const res = await patchJson(`/api/workstreams/${created.id}`, {
          agentIds: [prefix],
          assigneeAgentId: testAgentId,
        })

        expect(res.status).toBe(200)
        const ws = await res.json()
        expect(ws.assigneeAgentId).toBe(testAgentId)
      })

      it('allows clearing agentIds to permit any assignment', async () => {
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} Clear list`,
          agentIds: [testAgentId],
        })
        const created = await createRes.json()

        // Clear the list and assign to previously disallowed agent
        const res = await patchJson(`/api/workstreams/${created.id}`, {
          agentIds: null,
          assigneeAgentId: secondAgentId,
        })

        expect(res.status).toBe(200)
        const ws = await res.json()
        expect(ws.assigneeAgentId).toBe(secondAgentId)
        expect(ws.agentIds).toBeNull()
      })

      it('allows unassigning regardless of agentIds', async () => {
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} Unassign`,
          agentIds: [testAgentId],
          assigneeAgentId: testAgentId,
        })
        const created = await createRes.json()

        const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: null })

        expect(res.status).toBe(200)
        const ws = await res.json()
        expect(ws.assigneeAgentId).toBeNull()
      })

      it('allows any assignment when agentIds is empty array', async () => {
        const createRes = await legacyFixtureResponse({
          squadId: testSquadId,
          title: `${testPrefix} Empty list`,
          agentIds: [],
        })
        const created = await createRes.json()

        const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: secondAgentId })

        expect(res.status).toBe(200)
        const ws = await res.json()
        expect(ws.assigneeAgentId).toBe(secondAgentId)
      })
    })
  })

  describe('PATCH /api/workstreams/:id assignee prefix resolution', () => {
    it('resolves agent ID prefix for assignee', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Assign test` })
      const created = await createRes.json()

      // Use 8-char prefix
      const prefix = testAgentId.slice(0, 8)
      const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: prefix })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.assigneeAgentId).toBe(testAgentId)
    })

    it('returns 404 for non-existent agent prefix', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Bad assign` })
      const created = await createRes.json()

      const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: 'zzzzzzzz' })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('Agent not found')
    })

    it('accepts full UUID for assignee', async () => {
      const createRes = await legacyFixtureResponse({ squadId: testSquadId, title: `${testPrefix} Full UUID` })
      const created = await createRes.json()

      const res = await patchJson(`/api/workstreams/${created.id}`, { assigneeAgentId: testAgentId })

      expect(res.status).toBe(200)
      const ws = await res.json()
      expect(ws.assigneeAgentId).toBe(testAgentId)
    })
  })

  describe('priority, queueing and park', () => {
    it('creates with a priority, rejects invalid priorities, updates priority', async () => {
      const createRes = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} prio`,
        priority: 'high',
      })
      expect(createRes.status).toBe(201)
      const created = await createRes.json()
      expect(created.priority).toBe('high')

      const bad = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} bad prio`,
        priority: 'urgent',
      })
      expect(bad.status).toBe(400)
      const badBody = await bad.text()
      for (const level of ['critical', 'high', 'normal', 'low']) {
        expect(badBody).toContain(level)
      }

      const patched = await patchJson(`/api/workstreams/${created.id}`, { priority: 'low' })
      expect(patched.status).toBe(200)
      expect((await patched.json()).priority).toBe('low')
    })

    it('rejects a cycle-creating dependsOn PATCH with 400 naming the path', async () => {
      const aRes = await postJson('/api/workstreams', { squadId: testSquadId, title: `${testPrefix} Alpha` })
      const a = await aRes.json()
      const bRes = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} Beta`,
        dependsOn: [a.id],
      })
      const b = await bRes.json()

      const res = await patchJson(`/api/workstreams/${a.id}`, { dependsOn: [b.id] })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('cycle')
      expect(body.error).toContain(`${testPrefix} Alpha`)
      expect(body.error).toContain(`${testPrefix} Beta`)
    })

    it('surfaces a busy park distinctly', async () => {
      const stream = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} busy park`,
        agentIds: [testAgentId],
      })
      const [execution] = await db
        .insert(executions)
        .values({ agentId: testAgentId, status: 'running' })
        .returning({ id: executions.id })

      // Mutation: removing the WorkStreamBusyError mapping must lose the distinct 409/discriminator.
      const res = await post(`/api/workstreams/${stream.id}/park`)
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('WORK_STREAM_BUSY')
      expect(body.agentId).toBe(testAgentId)
      expect(body.executionId).toBe(execution.id)
      expect(body.error).toContain('--preempt-running')
      expect((await WorkStream.mustFind(stream.id)).status).toBe('active')
    })

    it('forwards explicit running preemption', async () => {
      const squad = await Squad.mustFind(testSquadId)
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const stream = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} preempt park`,
        agentIds: [testAgentId],
      })
      const waiting = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: `${testPrefix} preempt waiter`,
        priority: 'high',
      })
      await db.insert(executions).values({ agentId: testAgentId, status: 'running' })

      const res = await postJson(`/api/workstreams/${stream.id}/park`, { preemptRunning: true })
      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe('queued')
      expect((await WorkStream.mustFind(stream.id)).status).toBe('queued')
      expect((await WorkStream.mustFind(waiting.id)).status).toBe('active')
    })

    it('queues past the squad cap, annotates queue position, parks and promotes', async () => {
      const capRes = await patchJson(`/api/squads/${testSquadId}`, { maxConcurrentWorkStreams: 1 })
      expect(capRes.status).toBe(200)
      expect((await capRes.json()).maxConcurrentWorkStreams).toBe(1)

      const firstRes = await postJson('/api/workstreams', { squadId: testSquadId, title: `${testPrefix} First` })
      const first = await firstRes.json()
      expect(first.status).toBe('active')

      const secondRes = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} Second`,
        priority: 'high',
      })
      const second = await secondRes.json()
      expect(second.status).toBe('queued')

      // Detail annotation: queue position + effective priority
      const detail = await (await apiFetch(`/api/workstreams/${second.id}`)).json()
      expect(detail.queuePosition).toBe(1)
      expect(detail.effectivePriority).toBe('high')

      // List annotation
      const list = await (await apiFetch(`/api/workstreams?squadId=${testSquadId}`)).json()
      const listedSecond = list.find((w: { id: string }) => w.id === second.id)
      expect(listedSecond.queuePosition).toBe(1)

      // Park the admitted stream: it becomes queued, the higher-priority
      // queued stream takes the freed slot.
      const parkRes = await post(`/api/workstreams/${first.id}/park`)
      expect(parkRes.status).toBe(200)
      expect((await parkRes.json()).status).toBe('queued')
      expect((await (await apiFetch(`/api/workstreams/${second.id}`)).json()).status).toBe('active')

      // Parking a non-admitted (already queued) stream is a 409.
      const reparkRes = await post(`/api/workstreams/${first.id}/park`)
      expect(reparkRes.status).toBe(409)
    })

    it('annotates boosted effective priority with the dependent title', async () => {
      const blockerRes = await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} Blocker`,
        priority: 'low',
      })
      const blocker = await blockerRes.json()
      await postJson('/api/workstreams', {
        squadId: testSquadId,
        title: `${testPrefix} Feature`,
        priority: 'critical',
        dependsOn: [blocker.id],
      })

      const detail = await (await apiFetch(`/api/workstreams/${blocker.id}`)).json()
      expect(detail.priority).toBe('low')
      expect(detail.effectivePriority).toBe('critical')
      expect(detail.effectivePriorityVia).toBe(`${testPrefix} Feature`)
    })
  })
})

// ── RBAC guard tests ─────────────────────────────────────────────────────────

describe('work-streams RBAC guards', () => {
  const rbacPrefix = `ws-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let guardAdmin: TestUser
  let unprivileged: TestUser
  let squadId: string
  let otherSquadId: string
  let wsId: string

  beforeAll(async () => {
    guardAdmin = await createTestAdmin({ prefix: rbacPrefix })
    unprivileged = await createTestUser({ prefix: rbacPrefix })

    const squad = await Squad.create({ name: `${rbacPrefix} Guard Squad`, purpose: 'RBAC testing' })
    squadId = squad.id
    await AgentType.upsert({
      id: `${rbacPrefix}-worker`,
      name: 'Guard worker',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'Test',
    })
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = `${rbacPrefix}-worker`
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    const otherSquad = await Squad.create({ name: `${rbacPrefix} Other Squad`, purpose: 'cross-squad' })
    otherSquadId = otherSquad.id

    // Create a workstream owned by the main squad
    const ws = await storedLegacyWorkStream({ squadId, title: `${rbacPrefix} guard-ws` })
    wsId = ws.id
  })

  afterAll(async () => {
    await db.delete(workStreamOrderSnapshotItems)
    await db.delete(workStreamOrderSnapshots)
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(workStreams).where(eq(workStreams.squadId, otherSquadId))
    await db.delete(squads).where(like(squads.name, `${rbacPrefix}%`))
    await db.delete(agents).where(eq(agents.agentTypeId, `${rbacPrefix}-worker`))
    await db.delete(agentTypes).where(eq(agentTypes.id, `${rbacPrefix}-worker`))
    await cleanupTestRbac(rbacPrefix)
  })

  async function guardFetch(
    token: string,
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<Response> {
    const baseHeaders = authHeaders(token)
    const extraHeaders = init?.headers ?? {}
    return app.fetch(
      new Request(`http://localhost${url}`, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: { ...baseHeaders, ...extraHeaders },
      })
    )
  }

  function guardPost(token: string, url: string, body: unknown): Promise<Response> {
    return guardFetch(token, url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function guardPatch(token: string, url: string, body: unknown): Promise<Response> {
    return guardFetch(token, url, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('GET /api/workstreams → 401 without identity', async () => {
    const res = await app.fetch(new Request('http://localhost/api/workstreams'))
    expect(res.status).toBe(401)
  })

  it('GET /api/workstreams → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/workstreams')
    expect(res.status).toBe(403)
  })

  it('GET /api/workstreams → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/api/workstreams')
    expect(res.status).toBe(200)
  })

  it('rejects durable continuation after the caller accessible-squad scope changes', async () => {
    const limitedUser = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['workstreams:read'], prefix: rbacPrefix })
    await assignRole({ userId: limitedUser.id, roleId: role.id, scope: 'squad', squadId })
    await storedLegacyWorkStream({ squadId, title: `${rbacPrefix} fingerprint second` })

    const first = await guardFetch(limitedUser.token, `/api/workstreams?squadId=${squadId}&statuses=active&limit=1`)
    expect(first.status).toBe(200)
    const firstPage = await first.json()
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    await assignRole({ userId: limitedUser.id, roleId: role.id, scope: 'squad', squadId: otherSquadId })
    const changed = await guardFetch(
      limitedUser.token,
      `/api/workstreams?squadId=${squadId}&statuses=active&limit=1&cursor=${firstPage.nextCursor}`
    )
    expect(changed.status).toBe(400)
  })

  it('GET /api/workstreams/by-metadata → 401 without identity', async () => {
    const res = await app.fetch(new Request('http://localhost/api/workstreams/by-metadata?match=foo:bar'))
    expect(res.status).toBe(401)
  })

  it('GET /api/workstreams/by-metadata → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/workstreams/by-metadata?match=foo:bar')
    expect(res.status).toBe(403)
  })

  it('POST /api/workstreams → 403 for unprivileged user', async () => {
    const res = await guardPost(unprivileged.token, '/api/workstreams', {
      squadId,
      title: `${rbacPrefix} denied`,
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/workstreams → 201 for admin', async () => {
    const res = await guardPost(guardAdmin.token, '/api/workstreams', {
      squadId,
      title: `${rbacPrefix} allowed-create`,
    })
    expect(res.status).toBe(201)
  })

  it('GET /api/workstreams/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/workstreams/${wsId}`)
    expect(res.status).toBe(403)
  })

  it('GET /api/workstreams/:id → 403 when accessing other squad workstream with squad-scoped permission', async () => {
    // Create user with workstreams:read on the other squad only
    const limitedUser = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['workstreams:read'], prefix: rbacPrefix })
    await assignRole({ userId: limitedUser.id, roleId: role.id, scope: 'squad', squadId: otherSquadId })

    const res = await guardFetch(limitedUser.token, `/api/workstreams/${wsId}`)
    expect(res.status).toBe(403)
  })

  it('unauthorized queued handoff remains forbidden', async () => {
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, wsId))
    const res = await guardPatch(unprivileged.token, `/api/workstreams/${wsId}`, {
      assigneeAgentId: '00000000-0000-0000-0000-000000000000',
      handoffMessage: 'hacked',
    })
    expect(res.status).toBe(403)
    expect((await WorkStream.mustFind(wsId)).status).toBe('queued')
  })

  it('PATCH /api/workstreams/:id → 403 for unprivileged user', async () => {
    const res = await guardPatch(unprivileged.token, `/api/workstreams/${wsId}`, { title: 'hacked' })
    expect(res.status).toBe(403)
  })

  it('POST /api/workstreams/:id/cancel → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/workstreams/${wsId}/cancel`, { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('DELETE /api/workstreams/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/workstreams/${wsId}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('GET /api/workstreams/:id/ready → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/workstreams/${wsId}/ready`)
    expect(res.status).toBe(403)
  })

  it('POST /api/workstreams/:id/waits/:waitId/resolve → 403 for unprivileged user', async () => {
    const res = await guardPost(unprivileged.token, `/api/workstreams/${wsId}/waits/${crypto.randomUUID()}/resolve`, {
      resolution: 'cleared',
    })
    expect(res.status).toBe(403)
  })

  // workstreams:manage-agents granularity (design §5.2)

  it('POST /api/workstreams/:id/agents/:agentId → 403 for user with workstreams:update but not workstreams:manage-agents', async () => {
    const updateOnlyUser = await createTestUser({ prefix: rbacPrefix })
    const updateRole = await createTestRole({ permissions: ['workstreams:update'], prefix: rbacPrefix })
    await assignRole({ userId: updateOnlyUser.id, roleId: updateRole.id, scope: 'squad', squadId })

    const fakeAgentId = '00000000-0000-0000-0000-000000000000'
    const res = await guardFetch(updateOnlyUser.token, `/api/workstreams/${wsId}/agents/${fakeAgentId}`, {
      method: 'POST',
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/workstreams/:id/agents/:agentId → 200 for user with workstreams:manage-agents', async () => {
    const manageAgentsUser = await createTestUser({ prefix: rbacPrefix })
    const manageRole = await createTestRole({
      permissions: ['workstreams:manage-agents'],
      prefix: rbacPrefix,
    })
    await assignRole({ userId: manageAgentsUser.id, roleId: manageRole.id, scope: 'squad', squadId })

    // Create an agent to add
    const atId = `${rbacPrefix}-at-ma`
    await AgentType.create({
      id: atId,
      name: 'Manage Agents Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    const agent = await Agent.create({ agentTypeId: atId, squadId })

    try {
      const res = await guardFetch(manageAgentsUser.token, `/api/workstreams/${wsId}/agents/${agent.id}`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, atId))
    }
  })
})
