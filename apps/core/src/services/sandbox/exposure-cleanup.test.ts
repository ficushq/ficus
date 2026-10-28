import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'exposure-cleanup-'))
  dirs.push(dir)
  return dir
}

async function api() {
  return import('./exposure-cleanup')
}

test('retirement deletes private and archived plaintext while preserving custom files', async () => {
  const { cleanLegacyPrivateDirectory } = await api()
  const root = temp()
  mkdirSync(join(root, '.ficus'))
  writeFileSync(join(root, '.ficus/agent-secrets.env'), 'SYNTH_TOKEN=synthetic-retired')
  writeFileSync(join(root, '.ficus/env.user'), 'CUSTOM=synthetic-custom')
  writeFileSync(join(root, 'scratch'), 'keep')
  await cleanLegacyPrivateDirectory(root)
  await cleanLegacyPrivateDirectory(root)
  expect(existsSync(join(root, '.ficus/agent-secrets.env'))).toBe(false)
  expect(readFileSync(join(root, '.ficus/env.user'), 'utf8')).toBe('CUSTOM=synthetic-custom')
  expect(readFileSync(join(root, 'scratch'), 'utf8')).toBe('keep')
})

test('conflicting settings directory fails safely without following a symlink', async () => {
  const { cleanLegacyPrivateDirectory } = await api()
  const root = temp(),
    target = temp()
  writeFileSync(join(target, 'agent-secrets.env'), 'synthetic-not-owned')
  symlinkSync(target, join(root, '.ficus'))
  await expect(cleanLegacyPrivateDirectory(root)).rejects.toThrow('settings dir')
  expect(readFileSync(join(target, 'agent-secrets.env'), 'utf8')).toBe('synthetic-not-owned')
})

test('offline VM remains pending, persisted state survives restart and reconnect acknowledges both effects', async () => {
  const { runCleanupTarget } = await api()
  let stored: any = { targetId: 'vm:agent_test', kind: 'vm', sourceId: 'agent_test', squadId: null, status: 'pending' }
  const writes: any[] = []
  const save = async (patch: any) => {
    stored = { ...stored, ...patch }
    writes.push(patch)
  }
  const now = new Date('2026-10-28T00:00:00Z')
  await runCleanupTarget(stored, { now: () => now, save, clean: async () => false, log: () => {} })
  expect(stored.status).toBe('pending')
  expect(stored.reason).toContain('unreachable')
  expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime())
  // A new service invocation has no process-local completion marker to trust.
  const restarted = JSON.parse(JSON.stringify(stored))
  const effects: string[] = []
  await runCleanupTarget(restarted, {
    now: () => now,
    save,
    clean: async () => {
      effects.push('env-ack', 'delete-ack')
      return true
    },
    log: () => {},
  })
  expect(effects).toEqual(['env-ack', 'delete-ack'])
  expect(stored.status).toBe('done')
  expect(stored.reason).toBeNull()
})

test('cleanup errors record a safe failed reason and delayed retry, never success', async () => {
  const { runCleanupTarget } = await api()
  const changes: any[] = []
  await runCleanupTarget(
    { targetId: 'squad:test', kind: 'squad', sourceId: 'test', squadId: 'test' },
    {
      now: () => new Date(0),
      save: async (value: any) => {
        changes.push(value)
      },
      clean: async () => {
        throw new Error('command stderr could contain synthetic-sensitive-data')
      },
      log: () => {},
    }
  )
  expect(changes.at(-1).status).toBe('failed')
  expect(changes.at(-1).reason).not.toContain('synthetic-sensitive-data')
  expect(changes.at(-1).nextAttemptAt.getTime()).toBeGreaterThan(0)
})

test('VM archive sanitation removes retired files without extracting or changing custom content', async () => {
  const { cleanLegacyArchive } = await api()
  const root = temp()
  mkdirSync(join(root, '.private/.ficus'), { recursive: true })
  mkdirSync(join(root, 'workspace/.ficus'), { recursive: true })
  writeFileSync(join(root, '.private/.ficus/agent-secrets.env'), 'SYNTH_TOKEN=retired')
  writeFileSync(join(root, '.private/.ficus/env.user'), 'CUSTOM=keep')
  writeFileSync(join(root, 'workspace/.ficus/.env'), 'OLD_TOKEN=retired')
  writeFileSync(join(root, 'workspace/.ficus/env.user'), 'SQUAD_CUSTOM=keep')
  const archive = join(root, 'private.tar.gz')
  expect(Bun.spawnSync(['tar', 'czf', archive, '-C', root, '.private', 'workspace']).exitCode).toBe(0)
  await cleanLegacyArchive(archive)
  await cleanLegacyArchive(archive)
  const listing = Bun.spawnSync(['tar', 'tzf', archive]).stdout.toString()
  expect(listing).not.toContain('agent-secrets.env')
  expect(listing).not.toContain('workspace/.ficus/.env')
  expect(Bun.spawnSync(['tar', 'xOzf', archive, '.private/.ficus/env.user']).stdout.toString()).toBe('CUSTOM=keep')
  expect(Bun.spawnSync(['tar', 'xOzf', archive, 'workspace/.ficus/env.user']).stdout.toString()).toBe(
    'SQUAD_CUSTOM=keep'
  )
})

test('durable DB retry after restart and failure backoff do not depend on in-memory markers', async () => {
  const { runExposureCleanupSweep } = await api()
  const { db, sandboxExposureCleanup } = await import('../../db')
  const { eq } = await import('drizzle-orm')
  const id = `private:cleanup-test-${crypto.randomUUID()}`
  const target = { targetId: id, kind: 'private' as const, sourceId: id.slice(8), squadId: null }
  try {
    await runExposureCleanupSweep({ discover: async () => [target], clean: async () => false })
    let [row] = await db.select().from(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, id))
    expect(row.status).toBe('pending')
    let attempts = 0
    await runExposureCleanupSweep({
      discover: async () => [target],
      clean: async () => {
        attempts++
        return true
      },
    })
    expect(attempts).toBe(0)
    await db
      .update(sandboxExposureCleanup)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(sandboxExposureCleanup.targetId, id))
    // Fresh invocation/dependencies, exactly as a restarted worker loading the durable row.
    await runExposureCleanupSweep({
      discover: async () => [target],
      clean: async () => {
        attempts++
        return true
      },
    })
    ;[row] = await db.select().from(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, id))
    expect(attempts).toBe(1)
    expect(row.status).toBe('done')
  } finally {
    await db.delete(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, id))
  }
})

test('startup sweep cleans existing shared-mount directories and records settings conflicts', async () => {
  const { runExposureCleanupSweep } = await api()
  const { db, sandboxExposureCleanup } = await import('../../db')
  const { inArray } = await import('drizzle-orm')
  const home = temp(),
    previous = process.env.HOME_DIR
  const names = [`test-clean-${crypto.randomUUID()}`, `test-conflict-${crypto.randomUUID()}`]
  const targets = names.map((sourceId) => ({
    targetId: `private:${sourceId}`,
    sourceId,
    kind: 'private' as const,
    squadId: null,
  }))
  process.env.HOME_DIR = home
  try {
    mkdirSync(join(home, 'private', names[0], '.ficus'), { recursive: true })
    writeFileSync(join(home, 'private', names[0], '.ficus/agent-secrets.env'), 'SYNTH_TOKEN=retired')
    mkdirSync(join(home, 'private', names[1]), { recursive: true })
    writeFileSync(join(home, 'private', names[1], '.ficus'), 'custom-conflict')
    await runExposureCleanupSweep()
    expect(existsSync(join(home, 'private', names[0], '.ficus/agent-secrets.env'))).toBe(false)
    const rows = await db
      .select()
      .from(sandboxExposureCleanup)
      .where(
        inArray(
          sandboxExposureCleanup.targetId,
          targets.map((t) => t.targetId)
        )
      )
    expect(rows.find((r) => r.sourceId === names[0])?.status).toBe('done')
    expect(rows.find((r) => r.sourceId === names[1])?.status).toBe('failed')
    expect(rows.find((r) => r.sourceId === names[1])?.reason).toContain('settings dir')
    expect(readFileSync(join(home, 'private', names[1], '.ficus'), 'utf8')).toBe('custom-conflict')
  } finally {
    if (previous === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = previous
    await db.delete(sandboxExposureCleanup).where(
      inArray(
        sandboxExposureCleanup.targetId,
        targets.map((t) => t.targetId)
      )
    )
  }
})

test('status never reports clean when a required target acknowledgement is missing', async () => {
  const { getExposureCleanupStatus } = await api()
  const { db, sandboxExposureCleanup } = await import('../../db')
  const { eq } = await import('drizzle-orm')
  const sourceId = `agent_${crypto.randomUUID()}`,
    squadId = crypto.randomUUID()
  const targetId = `vm:${sourceId}`
  const runtime = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  try {
    await db.insert(sandboxExposureCleanup).values({ targetId, sourceId, kind: 'vm', squadId, status: 'done' })
    expect((await getExposureCleanupStatus(sourceId, squadId)).status).toBe('pending')
  } finally {
    if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = runtime
    await db.delete(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, targetId))
  }
})

test('a pending offline VM is cleaned on reconnect, with durable acknowledgement after remote effects', async () => {
  const { cleanupExposureOnContact, runExposureCleanupSweep } = await api()
  const { db, sandboxExposureCleanup } = await import('../../db')
  const { eq } = await import('drizzle-orm')
  const { EventEmitter } = await import('node:events')
  const id = `agent_${crypto.randomUUID()}`
  const target = { targetId: `vm:${id}`, kind: 'vm' as const, sourceId: id, squadId: null }
  const effects: string[] = []
  const client = {
    bash(request: { command: string }) {
      const stream = new EventEmitter()
      effects.push(request.command)
      queueMicrotask(() => {
        stream.emit('data', { exitCode: 0 })
        stream.emit('end')
      })
      return stream
    },
  }
  try {
    await runExposureCleanupSweep({ discover: async () => [target], clean: async () => false })
    expect(
      (await db.select().from(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, target.targetId)))[0]
        .status
    ).toBe('pending')
    await cleanupExposureOnContact(id, client)
    expect(effects.join('\n')).toContain('agent-secrets.env')
    expect(effects.join('\n')).toContain('workspace/.ficus/.env')
    expect(
      (await db.select().from(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, target.targetId)))[0]
        .status
    ).toBe('done')
  } finally {
    await db.delete(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.targetId, target.targetId))
  }
})

test('local first contact repairs the squad env too, not only the mounted private file', async () => {
  const { cleanupExposureOnContact } = await api()
  const { db, sandboxExposureCleanup } = await import('../../db')
  const { eq } = await import('drizzle-orm')
  const { getSquadWorkspacePath } = await import('../squad/workspace')
  const home = temp(),
    previous = process.env.HOME_DIR,
    id = crypto.randomUUID()
  process.env.HOME_DIR = home
  try {
    const dot = join(getSquadWorkspacePath(id), '.ficus')
    mkdirSync(dot, { recursive: true })
    writeFileSync(join(dot, 'env.user'), 'CUSTOM=keep')
    writeFileSync(
      join(dot, '.env'),
      '# Generated from Ficus Secret Store allowlist. Do not edit values here.\nOLD_TOKEN=synthetic-retired'
    )
    await cleanupExposureOnContact(`squad_${id}`)
    expect(readFileSync(join(dot, '.env'), 'utf8')).not.toContain('synthetic-retired')
    expect(readFileSync(join(dot, '.env'), 'utf8')).toContain('CUSTOM=keep')
    const [row] = await db
      .select()
      .from(sandboxExposureCleanup)
      .where(eq(sandboxExposureCleanup.targetId, `squad:${id}`))
    expect(row?.status).toBe('done')
  } finally {
    if (previous === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = previous
    await db.delete(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.sourceId, id))
    await db.delete(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.sourceId, `squad_${id}`))
  }
})

test('status retains outstanding VM copy acknowledgements after switching runtime', async () => {
  const { getExposureCleanupStatus } = await api()
  const { db, sandboxExposureCleanup } = await import('../../db')
  const { eq } = await import('drizzle-orm')
  const id = `agent_${crypto.randomUUID()}`,
    previous = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_SANDBOX_RUNTIME = 'host'
  try {
    await db.insert(sandboxExposureCleanup).values([
      { targetId: `private:${id}`, sourceId: id, kind: 'private', squadId: null, status: 'done' },
      {
        targetId: `vm:${id}`,
        sourceId: id,
        kind: 'vm',
        squadId: null,
        status: 'pending',
        reason: 'Sandbox unreachable; automatic cleanup will retry.',
      },
    ])
    const result = await getExposureCleanupStatus(id)
    expect(result.status).toBe('pending')
    expect(result.targets?.some((row) => row.targetId === `vm:${id}`)).toBe(true)
  } finally {
    await db.delete(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.sourceId, id))
    if (previous === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = previous
  }
})
