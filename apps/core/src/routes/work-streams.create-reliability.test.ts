/**
 * POST /api/workstreams under load: idempotency keys, Bun's per-request idle
 * timer and per-phase timing (services/work-streams/create-*.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createBlankWorkflow } from '@ficus/shared'
import { readFileSync } from 'node:fs'
import { eq, like, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { squads, workStreamCreateRequests, workStreams } from '../db/schema'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import * as createTiming from '../services/work-streams/create-timing'
import * as repositorySetup from '../services/work-streams/repository-setup'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'
import { workStreamsRouter } from './work-streams'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/workstreams', workStreamsRouter)

const rbacPrefix = `ws-create-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix })
  // The test database is push-built and push can omit indexes (docs/wiki/database.md);
  // establish the migration's uniqueness fence exactly, as production has it.
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "uq_work_stream_create_requests_key" ON "work_stream_create_requests" USING btree ("squad_id","requester_key","idempotency_key")`
  )
})

it('ships the uniqueness fence the claims rely on in its migration', () => {
  const migration = readFileSync(new URL('../../drizzle/0275_work_stream_create_requests.sql', import.meta.url), 'utf8')
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "uq_work_stream_create_requests_key" ON "work_stream_create_requests" USING btree ("squad_id","requester_key","idempotency_key")'
  )
})
afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('work stream create reliability', () => {
  let prefix: string
  let squadId: string
  let setup: ReturnType<typeof spyOn<typeof repositorySetup, 'setupWorkStreamRepository'>>
  let setupDelayMs = 0

  beforeEach(async () => {
    prefix = `rt-create-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const agentTypeId = `${prefix}-agent-type`
    await AgentType.upsert({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test',
      systemPrompt: 'Test',
    })
    const squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'Create reliability' })
    squadId = squad.id
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = agentTypeId
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    setupDelayMs = 0
    // Stands in for the squad box: records each provisioning and spends time in a timed phase.
    setup = spyOn(repositorySetup, 'setupWorkStreamRepository').mockImplementation(
      async (_squadId, _input, key, metadata, _record, options) => {
        const provision = () => Bun.sleep(setupDelayMs)
        if (options?.timing) await options.timing.time('repository-worktree-add', provision)
        else await provision()
        return { ...metadata, git: { worktree: `/workspace/worktrees/${key}`, branch: `work/${key}` } }
      }
    )
  })

  afterEach(async () => {
    setup.mockRestore()
    await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squadId))
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
  })

  const post = (
    body: unknown,
    key?: string,
    init: { fetch?: (request: Request) => Response | Promise<Response> } = {}
  ) =>
    (init.fetch ?? ((request: Request) => app.fetch(request)))(
      new Request('http://localhost/api/workstreams', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          ...authHeaders(admin.token),
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
      })
    )
  const streamCount = async () =>
    (await db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.squadId, squadId))).length

  it('returns the first stream for a repeated key instead of creating a second stream or worktree', async () => {
    const body = { squadId, title: `${prefix} sequential`, repository: 'repo' }
    const first = await post(body, 'key-sequential')
    expect(first.status).toBe(201)
    const created = (await first.json()) as { id: string }

    const again = await post({ repository: 'repo', title: body.title, squadId }, 'key-sequential')
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ id: created.id, reusedFromIdempotencyKey: true })
    expect(setup).toHaveBeenCalledTimes(1)
    expect(await streamCount()).toBe(1)
  })

  it('serializes concurrent creates with one key into one stream and one worktree', async () => {
    setupDelayMs = 400
    const body = { squadId, title: `${prefix} concurrent`, repository: 'repo' }
    const responses = await Promise.all([post(body, 'key-concurrent'), post(body, 'key-concurrent')])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
    const [a, b] = (await Promise.all(responses.map((response) => response.json()))) as Array<{ id: string }>
    expect(a.id).toBe(b.id)
    expect(setup).toHaveBeenCalledTimes(1)
    expect(await streamCount()).toBe(1)
  })

  it('refuses a key reused for a different request', async () => {
    expect((await post({ squadId, title: `${prefix} one` }, 'key-conflict')).status).toBe(201)
    const other = await post({ squadId, title: `${prefix} two` }, 'key-conflict')
    expect(other.status).toBe(409)
    expect(await other.json()).toMatchObject({ code: 'idempotency_key_conflict' })
    expect(await streamCount()).toBe(1)
  })

  it('frees the key when the create fails, so a retry creates the stream', async () => {
    setup.mockImplementationOnce(async () => {
      throw new repositorySetup.RepositorySetupError('Repository setup failed: box unavailable')
    })
    const body = { squadId, title: `${prefix} retry`, repository: 'repo' }
    expect((await post(body, 'key-retry')).status).toBe(400)
    expect(await streamCount()).toBe(0)
    expect(
      await db.select().from(workStreamCreateRequests).where(eq(workStreamCreateRequests.squadId, squadId))
    ).toHaveLength(0)
    expect((await post(body, 'key-retry')).status).toBe(201)
    expect(await streamCount()).toBe(1)
  })

  it('keeps creates without a key unchanged, and rejects a malformed key', async () => {
    const body = { squadId, title: `${prefix} no key` }
    expect((await post(body)).status).toBe(201)
    expect((await post(body)).status).toBe(201)
    expect(await streamCount()).toBe(2)
    const malformed = await post(body, 'has spaces')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ code: 'invalid_idempotency_key' })
  })

  it('logs one timing line per create, naming the slow phase', async () => {
    setupDelayMs = 1_500
    const logged = spyOn(createTiming, 'logWorkStreamCreateTiming')
    try {
      const response = await post({ squadId, title: `${prefix} timed`, repository: 'repo' })
      expect(response.status).toBe(201)
      const { id } = (await response.json()) as { id: string }
      expect(logged).toHaveBeenCalledTimes(1)
      const [timer, context] = logged.mock.calls[0]!
      expect(context).toEqual({ outcome: 'created', squadId, workStreamId: id })
      const line = createTiming.formatWorkStreamCreateTiming(timer, context)
      expect(line).toContain('slowest=repository-worktree-add')
      expect(timer.phases['repository-worktree-add'].ms).toBeGreaterThanOrEqual(1_400)
      expect(timer.phases['squad-lock-wait'].count).toBe(1)
      expect(timer.phases.transaction.count).toBe(1)
      expect(timer.phases.dispatch.count).toBe(1)
      expect(timer.phases.notify.count).toBe(1)
    } finally {
      logged.mockRestore()
    }
  })

  // Core's listener runs Bun.serve({ idleTimeout: 30 }). On Bun 1.4.2 that timer closes bodyless
  // requests but not a JSON POST, so a real-listener test could not fail without the fix. Instead,
  // the route must disable its own per-request timer (Bun's server.timeout(request, 0)) before any
  // slow phase starts; a fake env server records that, as routes/squads-sandbox-paths.test.ts does.
  it('disables its per-request idle timer before a slow phase, and answers with the real result', async () => {
    const calls: Array<{ request: Request; seconds: number }> = []
    const server = { timeout: (request: Request, seconds: number) => calls.push({ request, seconds }) }
    let callsWhenSlowPhaseStarted = -1
    setup.mockImplementationOnce(async (_squadId, _input, key, metadata, _record, options) => {
      callsWhenSlowPhaseStarted = calls.length
      await options!.timing!.time('repository-worktree-add', () => Bun.sleep(300))
      return { ...metadata, git: { worktree: `/workspace/worktrees/${key}`, branch: `work/${key}` } }
    })
    const response = await post({ squadId, title: `${prefix} slow`, repository: 'repo' }, 'key-slow', {
      fetch: (request) => app.fetch(request, server),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ title: `${prefix} slow` })
    expect(calls.map((call) => call.seconds)).toEqual([0])
    expect(callsWhenSlowPhaseStarted).toBe(1)

    // Refused requests never get the exemption: an unauthorized client cannot hold a socket open.
    calls.length = 0
    const refused = await app.fetch(
      new Request('http://localhost/api/workstreams', {
        method: 'POST',
        body: JSON.stringify({ squadId, title: `${prefix} anonymous` }),
        headers: { 'Content-Type': 'application/json' },
      }),
      server
    )
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(calls).toEqual([])
  })

  it('returns the same stream when a re-run only restamps its source links', async () => {
    const body = (addedAt: string) => ({
      squadId,
      title: `${prefix} sourced`,
      repository: 'repo',
      metadata: {
        sources: [
          { kind: 'url', url: 'https://example.com/spec', addedAt },
          { kind: 'slack_thread', url: 'https://example.slack.com/archives/C1/p1', addedAt },
        ],
      },
    })
    const first = await post(body('2026-11-27T10:00:00.000Z'), 'key-sourced')
    expect(first.status).toBe(201)
    const { id } = (await first.json()) as { id: string }
    const rerun = await post(body('2026-11-27T10:05:00.000Z'), 'key-sourced')
    expect(rerun.status).toBe(200)
    expect(await rerun.json()).toMatchObject({ id, reusedFromIdempotencyKey: true })
    expect(setup).toHaveBeenCalledTimes(1)
    expect(await streamCount()).toBe(1)

    // A different source is still a different request.
    const changed = body('2026-11-27T10:05:00.000Z')
    changed.metadata.sources[0]!.url = 'https://example.com/other'
    const conflict = await post(changed, 'key-sourced')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' })
  })
})
