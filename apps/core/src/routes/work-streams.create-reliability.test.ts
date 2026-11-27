/**
 * POST /api/workstreams under load: idempotency keys, Bun's per-request idle
 * timer and per-phase timing (services/work-streams/create-*.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createBlankWorkflow } from '@ficus/shared'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, like, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { squads, workStreamCreateRequests, workStreams } from '../db/schema'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import * as sandboxFactory from '../services/sandbox/factory'
import type { ISandboxManager } from '../services/sandbox/types'
import * as admission from '../services/work-streams/admission'
import { rollbackCreateProvisioning } from '../services/work-streams/create-rollback'
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

  // Real Git in a temporary workspace stands in for the squad box, for both provisioning
  // (prepareRepository) and the rollback's native cleanup runner.
  describe('rolling back what an uncommitted create provisioned', () => {
    let root: string
    let repo: string
    let manager: ReturnType<typeof spyOn<typeof sandboxFactory, 'getSandboxManager'>>
    const exec: repositorySetup.RepositoryExec = async (args, options) => {
      const child = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...options?.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(`exit ${code}: ${err || out}`)
      return out
    }
    const git = (...args: string[]) => exec(['git', '-C', repo, ...args]).then((out) => out.trim())
    const branchExists = (branch: string) =>
      git('show-ref', '--verify', `refs/heads/${branch}`).then(
        () => true,
        () => false
      )
    const worktrees = async () =>
      (await git('worktree', 'list', '--porcelain'))
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
        .filter((path) => path !== repo)

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-create-rollback-route-')))
      repo = join(root, 'repo')
      await mkdir(repo)
      await exec(['git', 'init', '-b', 'main', repo])
      await writeFile(join(repo, 'README'), 'base\n')
      await git('add', '.')
      await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')
      await git('remote', 'add', 'origin', 'git@github.com:example/repo.git')
      setup.mockImplementation(async (_squadId, input, key, metadata, record) =>
        repositorySetup.prepareRepository(
          exec,
          root,
          { ...input, repository: 'repo', baseBranch: 'main', baseSource: 'local' },
          key,
          metadata,
          record
        )
      )
      manager = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
        exec: async (_sandboxId: string, args: string[], options?: { env?: Record<string, string> }) =>
          Buffer.from(await exec(args, options)),
      } as unknown as ISandboxManager)
    })
    afterEach(async () => {
      manager.mockRestore()
      await rm(root, { recursive: true, force: true })
    })

    it('removes the worktree and branch when the transaction fails, so a retry with the same branch succeeds', async () => {
      const admit = spyOn(admission, 'admitOrQueueAtCreation').mockImplementationOnce(async () => {
        throw new Error('admission unavailable')
      })
      try {
        const body = { squadId, title: `${prefix} tx failure`, repository: 'repo', branch: 'feature/tx-retry' }
        const failed = await post(body, 'key-tx-failure')
        expect(failed.status).toBeGreaterThanOrEqual(400)
        expect(await streamCount()).toBe(0)
        expect(await worktrees()).toEqual([])
        expect(await branchExists('feature/tx-retry')).toBe(false)

        manager.mockRestore()
        const retried = await post(body, 'key-tx-failure')
        expect(retried.status).toBe(201)
        const { id } = (await retried.json()) as { id: string }
        expect(await worktrees()).toEqual([join(root, 'worktrees', id)])
        expect(await branchExists('feature/tx-retry')).toBe(true)
      } finally {
        admit.mockRestore()
      }
    })

    it('removes only its own worktree and branch when it loses its claim, so a retry with the same branch succeeds', async () => {
      const kept = await post({ squadId, title: `${prefix} other stream`, repository: 'repo' }, 'key-other')
      expect(kept.status).toBe(201)
      const { id: keptId } = (await kept.json()) as { id: string }
      const keptWorktree = join(root, 'worktrees', keptId)
      expect(existsSync(keptWorktree)).toBe(true)

      // The claim disappears mid-provisioning, as when a repeat took it over and then gave it up.
      setup.mockImplementationOnce(async (_squadId, input, key, metadata, record) => {
        const result = await repositorySetup.prepareRepository(
          exec,
          root,
          { ...input, repository: 'repo', baseBranch: 'main', baseSource: 'local' },
          key,
          metadata,
          record
        )
        await db.delete(workStreamCreateRequests).where(eq(workStreamCreateRequests.idempotencyKey, 'key-lost'))
        return result
      })
      const body = { squadId, title: `${prefix} claim lost`, repository: 'repo', branch: 'feature/claim-retry' }
      const lost = await post(body, 'key-lost')
      expect(lost.status).toBe(409)
      expect(await lost.json()).toMatchObject({ code: 'create_claim_lost' })
      expect(await streamCount()).toBe(1)
      expect(await worktrees()).toEqual([keptWorktree])
      expect(await branchExists('feature/claim-retry')).toBe(false)
      expect(await branchExists(`work/${keptId}`)).toBe(true)

      manager.mockRestore()
      const retried = await post(body, 'key-lost')
      expect(retried.status).toBe(201)
      expect(await branchExists('feature/claim-retry')).toBe(true)
      expect(await streamCount()).toBe(2)
    })

    it('keeps a pre-existing branch when it rolls back', async () => {
      await git('branch', 'existing')
      const tip = await git('rev-parse', 'existing')
      const admit = spyOn(admission, 'admitOrQueueAtCreation').mockImplementationOnce(async () => {
        throw new Error('admission unavailable')
      })
      try {
        const failed = await post({ squadId, title: `${prefix} existing`, repository: 'repo', branch: 'existing' })
        expect(failed.status).toBeGreaterThanOrEqual(400)
        expect(await worktrees()).toEqual([])
        expect(await git('rev-parse', 'existing')).toBe(tip)
      } finally {
        admit.mockRestore()
      }
    })

    it('keeps an explicit worktree that the repeat which took over its claim adopted', async () => {
      const body = {
        squadId,
        title: `${prefix} explicit worktree`,
        repository: 'repo',
        worktree: 'shared/wt',
        branch: 'feature/shared',
      }
      let taker: Response | undefined
      // The claim expires mid-provisioning; a repeat with the same key takes it over,
      // adopts the worktree this request just made, and commits.
      setup.mockImplementationOnce(async (_squadId, input, key, metadata, record) => {
        const result = await repositorySetup.prepareRepository(
          exec,
          root,
          { ...input, repository: 'repo', baseBranch: 'main', baseSource: 'local' },
          key,
          metadata,
          record
        )
        await db.delete(workStreamCreateRequests).where(eq(workStreamCreateRequests.idempotencyKey, 'key-race'))
        taker = await post(body, 'key-race')
        return result
      })
      const lost = await post(body, 'key-race')
      expect(lost.status).toBe(409)
      expect(await lost.json()).toMatchObject({ code: 'create_claim_lost' })
      expect(taker!.status).toBe(201)
      expect(await streamCount()).toBe(1)
      expect(await worktrees()).toEqual([join(root, 'shared', 'wt')])
      expect(await branchExists('feature/shared')).toBe(true)
    })

    it('keeps a branch another stream is bound to, even at its own default path', async () => {
      let ownership: repositorySetup.WorktreeOwnership | undefined
      setup.mockImplementationOnce(async (_squadId, input, key, metadata, record) =>
        repositorySetup.prepareRepository(
          exec,
          root,
          { ...input, repository: 'repo', baseBranch: 'main', baseSource: 'local' },
          key,
          metadata,
          (receipt) => {
            ownership = receipt
            return record?.(receipt)
          }
        )
      )
      const created = await post({ squadId, title: `${prefix} bound`, repository: 'repo' })
      expect(created.status).toBe(201)
      const other = crypto.randomUUID()
      const result = await rollbackCreateProvisioning(
        squadId,
        other,
        { ...ownership!, worktree: join(root, 'worktrees', other) },
        { exec }
      )
      expect(result).toMatchObject({ worktree: 'retained', branch: 'retained' })
      expect(result.reason).toContain('references this worktree or branch')
      expect(existsSync(ownership!.worktree)).toBe(true)
      expect(await branchExists(ownership!.branch)).toBe(true)
    })

    it('never removes the worktree of a stream that committed', async () => {
      let ownership: repositorySetup.WorktreeOwnership | undefined
      setup.mockImplementationOnce(async (_squadId, input, key, metadata, record) =>
        repositorySetup.prepareRepository(
          exec,
          root,
          { ...input, repository: 'repo', baseBranch: 'main', baseSource: 'local' },
          key,
          metadata,
          (receipt) => {
            ownership = receipt
            return record?.(receipt)
          }
        )
      )
      const created = await post({ squadId, title: `${prefix} committed`, repository: 'repo' })
      expect(created.status).toBe(201)
      const { id } = (await created.json()) as { id: string }
      expect(await rollbackCreateProvisioning(squadId, id, ownership!, { exec })).toMatchObject({
        worktree: 'retained',
      })
      expect(existsSync(ownership!.worktree)).toBe(true)
      expect(await branchExists(ownership!.branch)).toBe(true)
    })
  })
})
