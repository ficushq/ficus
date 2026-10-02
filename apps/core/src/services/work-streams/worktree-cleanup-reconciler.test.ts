import { beforeEach, afterEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, squads, workStreams, workStreamWorktrees, worktreeCleanupJobs } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { prepareRepository, type WorktreeOwnership } from './repository-setup'
import { claimWorktreeCleanup } from './worktree-cleanup-store'
import * as reconciler from './worktree-cleanup-reconciler'
import { WorktreeDeliveryUnprovenError } from './worktree-cleanup-delivery'
let root: string, squadId: string, streamId: string, head: string
let ownership: WorktreeOwnership
let metadata: Record<string, unknown>
const exec = async (args: string[]) => {
  const child = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Child ${code}: ${err || out}`)
  return out
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-cleanup-reconcile-')))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await exec(['git', 'init', '-b', 'main', repo])
  await writeFile(join(repo, 'README'), 'delivered\n')
  await exec(['git', '-C', repo, 'add', '.'])
  await exec([
    'git',
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial',
  ])
  await exec(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
  head = (await exec(['git', '-C', repo, 'rev-parse', 'HEAD'])).trim()
  metadata = await prepareRepository(
    exec,
    root,
    { repository: repo, baseBranch: 'main', baseSource: 'local', branch: 'feature' },
    'owned',
    {},
    (value) => {
      ownership = value
    }
  )
  const [squad] = await db.insert(squads).values({ name: 'cleanup-reconcile-fixture', purpose: 'test' }).returning()
  squadId = squad.id
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'delivered', status: 'done', autoCleanupWorktree: true, metadata })
    .returning()
  streamId = stream.id
  await db.insert(workStreamWorktrees).values({ squadId, workStreamId: streamId, ownership })
  await db
    .insert(worktreeCleanupJobs)
    .values({ workStreamId: streamId, deliveredHead: head, deliveryMetadata: metadata })
})
afterEach(async () => {
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await rm(root, { recursive: true, force: true })
})
const job = async () =>
  (await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId)))[0]!
const deps = () => ({ execForSquad: async () => exec, verify: async () => head, notify: async () => {} })
const processJob = async (overrides = {}) => {
  expect(reconciler.processWorktreeCleanup).toBeDefined()
  return reconciler.processWorktreeCleanup(streamId, { ...deps(), ...overrides })
}

test('reconciles a durable intent into actual removal without changing delivered status or provenance', async () => {
  await processJob()
  expect((await job()).status).toBe('succeeded')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(false)
  expect((await WorkStream.mustFind(streamId)).toJson()).toMatchObject({ status: 'done', metadata })
  await processJob()
  expect((await job()).status).toBe('succeeded')
})

test('lost remote response remains fenced and restart recovers the immutable receipt', async () => {
  await processJob({
    execForSquad: async () => async (args: string[]) => {
      const result = await exec(args)
      if (args[3] === 'tau-worktree-cleanup') throw new Error('lost response')
      return result
    },
  })
  expect((await job()).status).toBe('removing')
  await expect((await WorkStream.mustFind(streamId)).reopen()).rejects.toThrow(/cleanup|removal/i)
  await processJob()
  expect((await job()).status).toBe('succeeded')
})

test('restart redelivers the exact persisted operation after a crash before dispatch', async () => {
  const input = await claimWorktreeCleanup(streamId, {
    generation: (await job()).generation,
    ownership,
    head,
    metadata,
  })
  expect(input).not.toBeNull()
  await processJob()
  expect(await job()).toMatchObject({ status: 'succeeded', operationId: input!.operationId })
})

test('an interrupted active operation without terminal proof is never taken over', async () => {
  const input = await claimWorktreeCleanup(streamId, {
    generation: (await job()).generation,
    ownership,
    head,
    metadata,
  })
  await mkdir(join(ownership.commonDirectory, 'tau-worktree-cleanup', input!.operationId), { recursive: true })
  await processJob()
  expect((await job()).status).toBe('removing')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('opt-out and unavailable delivery preserve the directory without dispatch', async () => {
  await db.update(workStreams).set({ autoCleanupWorktree: false }).where(eq(workStreams.id, streamId))
  await processJob({
    execForSquad: async () => {
      throw new Error('must not contact runtime')
    },
  })
  expect((await job()).status).toBe('skipped')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('transient delivery errors back off without changing done or acquiring a removal fence', async () => {
  await processJob({
    verify: async () => {
      throw new Error('provider unavailable')
    },
  })
  expect(await job()).toMatchObject({ status: 'deferred', operationId: null })
  expect((await WorkStream.mustFind(streamId)).status).toBe('done')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('public detail reports cleanup status without exposing private operation inputs', async () => {
  await processJob()
  const json = (await WorkStream.mustFind(streamId)).toJson()
  expect(json).toHaveProperty('worktreeCleanup.status', 'succeeded')
  expect(json.worktreeCleanup).not.toHaveProperty('removalInput')
})

test('explicit opt-in after delivery revives a skipped intent without sweeping other streams', async () => {
  await db.update(worktreeCleanupJobs).set({ status: 'skipped' }).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  const stream = await WorkStream.mustFind(streamId)
  await stream.update({ autoCleanupWorktree: true })
  expect((await job()).status).toBe('pending')
})

test('terminal partial failures keep their operation fence and use capped backoff on recovery', async () => {
  const { createHash } = await import('node:crypto')
  const input = (await claimWorktreeCleanup(streamId, {
    generation: (await job()).generation,
    ownership,
    head,
    metadata,
  }))!
  const active = join(ownership.commonDirectory, 'tau-worktree-cleanup', input.operationId)
  await mkdir(active, { recursive: true })
  const serialized = JSON.stringify({
    head,
    operationId: input.operationId,
    ownership: Object.fromEntries(Object.entries(ownership).sort(([a], [b]) => a.localeCompare(b))),
  })
  await writeFile(
    join(active, 'receipt.json'),
    JSON.stringify({
      status: 'failed',
      reason: 'Partial removal requires inspection',
      operationId: input.operationId,
      digest: createHash('sha256').update(serialized).digest('hex'),
    })
  )
  await processJob()
  await processJob()
  expect(await job()).toMatchObject({ status: 'error', operationId: input.operationId, attempts: 3 })
  expect((await job()).nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(59_000)
  expect(reconciler.cleanupRetryDelay(100)).toBe(3_600_000)
  await expect((await WorkStream.mustFind(streamId)).update({ autoCleanupWorktree: false })).rejects.toThrow(
    /cleanup|removal/i
  )
})

for (const key of ['worktree', 'repository']) {
  test(`registered ${key} symlink alias blocks cleanup while unrelated canonical bindings do not`, async () => {
    const alias = join(root, 'alias')
    await symlink(ownership.worktree, alias)
    const [other] = await db
      .insert(workStreams)
      .values({ squadId, title: 'registered alias', metadata: { git: { [key]: alias } } })
      .returning()
    await processJob()
    expect((await job()).status).toBe('deferred')
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
    await db
      .update(workStreams)
      .set({ metadata: { git: { worktree: join(root, 'unrelated') } } })
      .where(eq(workStreams.id, other.id))
    await processJob()
    expect((await job()).status).toBe('succeeded')
  })
}

test('metadata-only alias binding updates cannot race an already claimed removal', async () => {
  const ensure = await import('../sandbox/ensure')
  const factory = await import('../sandbox/factory')
  const alias = join(root, 'alias')
  await symlink(ownership.worktree, alias)
  const [other] = await db.insert(workStreams).values({ squadId, title: 'new alias binding' }).returning()
  await claimWorktreeCleanup(streamId, { generation: (await job()).generation, ownership, head, metadata })
  const ensureSpy = spyOn(ensure, 'ensureSquadSandbox').mockResolvedValue(root)
  const managerSpy = spyOn(factory, 'getSandboxManager').mockReturnValue({
    exec: async (_id: string, args: string[]) => exec(args),
  } as any)
  try {
    await expect(
      (await WorkStream.mustFind(other.id)).update({ metadata: { git: { worktree: alias } } })
    ).rejects.toThrow(/cleanup|attachment|worktree/i)
    expect((await WorkStream.mustFind(other.id)).metadata).toEqual({})
  } finally {
    ensureSpy.mockRestore()
    managerSpy.mockRestore()
  }
})

test('redelivery re-arms a skipped intent with fresh proof and preserves same-transition idempotence', async () => {
  const stream = await WorkStream.mustFind(streamId)
  await stream.reopen()
  await processJob()
  expect((await job()).status).toBe('skipped')
  const newHead = 'b'.repeat(40)
  await stream.update(
    {
      status: 'done',
      metadata: { ...metadata, git: { ...(metadata.git as Record<string, unknown>), baseBranch: 'release' } },
    },
    { flowCompletion: { version: 0, metadataHash: 'fixture', deliveredHead: newHead } }
  )
  const refreshed = await job()
  expect(refreshed.deliveryMetadata).toMatchObject({ git: { baseBranch: 'release' } })
  expect(refreshed).toMatchObject({ status: 'pending', deliveredHead: newHead, attempts: 0, operationId: null })
  await stream.update({ status: 'done' })
  expect(await job()).toEqual(refreshed)
})

test('a stale disabled snapshot cannot skip a successfully committed opt-in', async () => {
  await db.update(workStreams).set({ autoCleanupWorktree: false }).where(eq(workStreams.id, streamId))
  const original = WorkStream.find.bind(WorkStream)
  let enabled = false
  const find = spyOn(WorkStream, 'find').mockImplementation(async (id) => {
    const snapshot = await original(id)
    if (id === streamId && !enabled) {
      enabled = true
      await (await original(streamId))!.update({ autoCleanupWorktree: true })
    }
    return snapshot
  })
  try {
    await processJob()
  } finally {
    find.mockRestore()
  }
  expect((await WorkStream.mustFind(streamId)).autoCleanupWorktree).toBe(true)
  expect((await job()).status).toBe('pending')
  await processJob()
  expect((await job()).status).toBe('succeeded')
})

test('a stale prior-delivery failure cannot overwrite the new delivery generation', async () => {
  const newHead = 'c'.repeat(40)
  await processJob({
    verify: async () => {
      const stream = await WorkStream.mustFind(streamId)
      await stream.reopen()
      await stream.update(
        { status: 'done' },
        { flowCompletion: { version: 0, metadataHash: 'fixture', deliveredHead: newHead } }
      )
      throw Error('old delivery verification failed')
    },
  })
  expect(await job()).toMatchObject({ status: 'pending', deliveredHead: newHead, attempts: 0 })
})

test('stale verification cannot claim or defer a newer delivery generation', async () => {
  const newHead = 'd'.repeat(40)
  await processJob({
    verify: async () => {
      const stream = await WorkStream.mustFind(streamId)
      await stream.reopen()
      await stream.update(
        { status: 'done' },
        { flowCompletion: { version: 0, metadataHash: 'fixture', deliveredHead: newHead } }
      )
      return { head, metadata }
    },
  })
  expect(await job()).toMatchObject({ status: 'pending', deliveredHead: newHead, attempts: 0, operationId: null })
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('new delivery intent never resets removing, uncertain, or succeeded resources', async () => {
  const { enqueueWorktreeCleanup } = await import('./worktree-cleanup-store')
  for (const state of [
    { status: 'removing' as const, operationId: null },
    { status: 'removing' as const, operationId: crypto.randomUUID() },
    { status: 'error' as const, operationId: crypto.randomUUID() },
    { status: 'succeeded' as const, operationId: crypto.randomUUID() },
  ]) {
    await db.update(worktreeCleanupJobs).set(state).where(eq(worktreeCleanupJobs.workStreamId, streamId))
    const before = await job()
    await db.transaction((tx) => enqueueWorktreeCleanup(tx, streamId, metadata, 'e'.repeat(40)))
    expect(await job()).toEqual(before)
  }
})

test('binding mismatches defer before provider or sandbox calls and report recovery commands', async () => {
  await db
    .update(workStreams)
    .set({ metadata: { ...metadata, git: { ...(metadata.git as object), worktree: '/manual' } } })
    .where(eq(workStreams.id, streamId))
  let calls = 0
  await processJob({
    execForSquad: async () => {
      calls++
      throw Error('must not start runtime')
    },
  })
  expect(calls).toBe(0)
  expect(await job()).toMatchObject({ status: 'deferred', operationId: null })
  expect((await job()).reason).toContain('cleanup inspect')
})

test('a delivery refusal persists its sanitized reason and keeps the worktree; unexpected errors stay generic', async () => {
  const notified: string[] = []
  await processJob({
    verify: async () => {
      throw new WorktreeDeliveryUnprovenError('Exact remote recovery reference is unavailable')
    },
    notify: async (id: string) => {
      notified.push(id)
    },
  })
  expect(await job()).toMatchObject({
    status: 'deferred',
    operationId: null,
    attempts: 1,
    reason:
      'Delivery is not proven: Exact remote recovery reference is unavailable. No removal was dispatched; cleanup will retry.',
  })
  expect(notified).toEqual([streamId])
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)

  // Raw errors (remote output, credentials) never reach the persisted reason.
  await db
    .update(worktreeCleanupJobs)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(worktreeCleanupJobs.workStreamId, streamId))
  await processJob({
    verify: async () => {
      throw new Error('fatal: could not read Username; token ghp_secret')
    },
  })
  const generic = await job()
  expect(generic).toMatchObject({ status: 'deferred', operationId: null, attempts: 2 })
  expect(generic.reason).toBe(
    'Delivery or runtime verification is unavailable. No removal was dispatched; cleanup will retry.'
  )
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})
