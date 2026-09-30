import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BashInvocationRegistry,
  InvocationActiveError,
  InvocationQuarantinedError,
  type BashInvocationRecord,
} from './bash-invocation-registry'
const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))
async function registry(reconcile: (record: BashInvocationRecord) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bash-registry-'))
  dirs.push(dir)
  return { dir, value: new BashInvocationRegistry({ runtimeDir: dir, reconcile }) }
}
describe('BashInvocationRegistry', () => {
  test('failed admission maintenance never strands a processless active reservation', async () => {
    const { dir, value } = await registry(async () => {
      throw new Error('prior invocation ownership is ambiguous')
    })
    await writeFile(join(dir, 'terminal'), 'unavailable storage')
    await expect(value.acquire('setup-file-sync', 'digest')).rejects.toThrow()
    expect(value.hasActiveInvocations()).toBe(false)
    await rm(join(dir, 'terminal'))
    const retry = await value.acquire('setup-file-sync', 'digest')
    await retry.complete('success')
    expect(value.hasActiveInvocations()).toBe(false)
  })

  test('failed terminal persistence keeps cleanup proof alive and can retry completion', async () => {
    const { dir, value } = await registry()
    const lease = await value.acquire('setup-file-sync', 'digest')
    await writeFile(join(dir, 'generations'), 'unavailable storage')
    await expect(lease.complete('failed')).rejects.toThrow()
    expect(value.hasActiveInvocations()).toBe(true)
    await rm(join(dir, 'generations'))
    await lease.complete('failed')
    expect(value.hasActiveInvocations()).toBe(false)
    expect((await value.acquire('setup-file-sync', 'digest')).generation).toBe(1)
  })

  test('cancellation persists known completion after storage recovery without inventing process ownership', async () => {
    let reconciliations = 0
    const { dir, value } = await registry(async () => {
      reconciliations += 1
      throw new Error('prior invocation ownership is ambiguous')
    })
    const lease = await value.acquire('setup-file-sync', 'digest')
    await writeFile(join(dir, 'generations'), 'unavailable storage')
    await expect(lease.complete('failed')).rejects.toThrow()
    await rm(join(dir, 'generations'))
    await expect(value.terminate('setup-file-sync')).resolves.toEqual({ remainingPids: [] })
    expect(reconciliations).toBe(0)
    expect(value.hasActiveInvocations()).toBe(false)
    expect((await value.acquire('setup-file-sync', 'digest')).generation).toBe(1)
  })

  test('a partial disk-full write never publishes corrupt immutable completion proof', async () => {
    const { dir } = await registry()
    let diskFull = false
    const value = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {
        throw new Error('no process ownership')
      },
      writeRecord: async (file, contents) => {
        if (diskFull) {
          await file.writeFile(contents.slice(0, 12))
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        }
        await file.writeFile(contents)
      },
    })
    const lease = await value.acquire('file-sync', 'digest')
    diskFull = true
    await expect(lease.complete('failed')).rejects.toThrow('disk full')
    expect(value.hasActiveInvocations()).toBe(true)
    expect(await readdir(join(dir, 'terminal'))).toEqual([])
    diskFull = false
    await value.terminate('file-sync')
    expect(value.hasActiveInvocations()).toBe(false)
    const restarted = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {
        throw new Error('no process ownership')
      },
    })
    expect((await restarted.acquire('file-sync', 'digest')).generation).toBe(1)
  })

  test('a fresh registry still refuses a processless record without completion proof', async () => {
    const { dir, value } = await registry()
    await value.acquire('unknown-start', 'digest')
    const restarted = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {
        throw new Error('prior invocation ownership is ambiguous')
      },
    })
    await expect(restarted.terminate('unknown-start')).rejects.toThrow('prior invocation ownership is ambiguous')
    await expect(restarted.acquire('unknown-start', 'digest')).rejects.toThrow(
      'prior invocation ownership is ambiguous'
    )
    expect(value.hasActiveInvocations()).toBe(true)
  })

  test('fences an active duplicate and advances generation only after terminal proof', async () => {
    const { value } = await registry()
    const first = await value.acquire('same-id', 'digest')
    await first.markRunning({ pid: 42, pgid: 42, sid: 42, startToken: 'linux:9' })
    await expect(value.acquire('same-id', 'digest')).rejects.toBeInstanceOf(InvocationActiveError)
    await first.complete('success')
    const retry = await value.acquire('same-id', 'digest')
    expect(first.generation).toBe(0)
    expect(retry.generation).toBe(1)
  })
  test('supersedes a terminal previous record whose command changed instead of deadlocking', async () => {
    // Stable setup invocation ids (git_config, devbox_install) are reused across
    // retries and across core upgrades that change the exact command string. A
    // terminal previous record with a DIFFERENT command digest must be superseded,
    // not rejected — the old INVOCATION_COMMAND_MISMATCH throw wedged the id forever
    // and deadlocked the sandbox setup retry loop.
    const { value } = await registry()
    const first = await value.acquire('git_config', 'old-command')
    await first.complete('failed')
    const retry = await value.acquire('git_config', 'new-command')
    expect(retry.generation).toBe(1)
    await retry.complete('success')
  })
  test('supersedes a zombie (non-terminal) previous record whose command changed', async () => {
    // A starting/running record left on disk by a died worker (no active in-process
    // invocation — active.has already guards that) is a zombie; a new command on the
    // same id reconciles+terminates it and proceeds, regardless of digest.
    const { dir } = await registry()
    const key = createHash('sha256').update('devbox_install').digest('hex')
    await mkdir(join(dir, 'active'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(dir, 'active', `${key}.json`),
      JSON.stringify({
        version: 1,
        invocationIdHash: key,
        generation: 4,
        commandDigest: 'stale-command',
        state: 'starting',
        startedAt: '2026-08-16T00:00:00.000Z',
      }),
      { mode: 0o600 }
    )
    const fresh = new BashInvocationRegistry({ runtimeDir: dir, reconcile: async () => {} })
    const lease = await fresh.acquire('devbox_install', 'fresh-command')
    expect(lease.generation).toBe(5)
    await lease.complete('success')
  })
  test('explicit cancellation waits for exact cleanup and permits the next generation', async () => {
    const cleaned: number[] = []
    const { value } = await registry(async (record) => {
      cleaned.push(record.sid!)
    })
    const first = await value.acquire('cancel-me', 'digest')
    await first.markRunning({ pid: 70, pgid: 70, sid: 70, startToken: 'linux:4' })
    await value.terminate('cancel-me')
    expect(cleaned).toEqual([70])
    expect((await value.acquire('cancel-me', 'digest')).generation).toBe(1)
  })
  test('persists safe atomic records with restrictive modes', async () => {
    const { dir, value } = await registry()
    const lease = await value.acquire('raw secret id', 'command-digest')
    const files = await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(dir, 'active') }))
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('raw secret id')
    const recordPath = join(dir, 'active', files[0]!)
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    expect(record).toMatchObject({ generation: 0, state: 'starting', commandDigest: 'command-digest' })
    expect(JSON.stringify(record)).not.toContain('raw secret id')
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600)
    await lease.complete('failed')
  })
  test('reconciles a nonterminal durable owner before allowing retry', async () => {
    const first = await registry()
    const lease = await first.value.acquire('replay', 'digest')
    await lease.markRunning({ pid: 55, pgid: 55, sid: 55, startToken: 'linux:2' })
    const calls: number[] = []
    const restarted = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async (record) => {
        calls.push(record.sid!)
      },
    })
    const retry = await restarted.acquire('replay', 'digest')
    expect(calls).toEqual([55])
    expect(retry.generation).toBe(1)
  })
  test('startup reconciliation clears every durable nonterminal owner before admission', async () => {
    const first = await registry()
    const a = await first.value.acquire('a', 'digest-a')
    await a.markRunning({ pid: 81, pgid: 81, sid: 81, startToken: 'linux:5' })
    const b = await first.value.acquire('b', 'digest-b')
    await b.markRunning({ pid: 82, pgid: 82, sid: 82, startToken: 'linux:6' })
    const cleaned: number[] = []
    const restarted = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async (record) => {
        cleaned.push(record.sid!)
      },
    })
    await restarted.reconcileAll()
    expect(cleaned.sort()).toEqual([81, 82])
  })
  test('fails closed when durable reconciliation cannot prove cleanup', async () => {
    const first = await registry()
    const lease = await first.value.acquire('replay', 'digest')
    await lease.markRunning({ pid: 66, pgid: 66, sid: 66, startToken: 'linux:3' })
    const restarted = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async () => {
        throw new Error('ambiguous owner')
      },
    })
    await expect(restarted.acquire('replay', 'digest')).rejects.toThrow('ambiguous owner')
  })
})
describe('quarantine and retention', () => {
  test('quarantines one ambiguous key while unrelated acquisition continues', async () => {
    const first = await registry()
    const blocked = await first.value.acquire('blocked', 'digest')
    await blocked.markRunning({ pid: 90, pgid: 90, sid: 90, startToken: 'linux:7' })
    const restarted = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async () => {
        throw new Error('ambiguous')
      },
    })
    const report = await restarted.reconcileAll()
    expect(report.quarantined).toHaveLength(1)
    await expect(restarted.acquire('blocked', 'digest')).rejects.toBeInstanceOf(InvocationQuarantinedError)
    await expect(restarted.acquire('unrelated', 'other')).resolves.toBeDefined()
  })
  test('allows only one of two crash-lock recoverers into the same key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-registry-'))
    dirs.push(dir)
    const lockDir = join(dir, 'locks')
    await mkdir(lockDir)
    const shard = createHash('sha256').update('same').digest('hex').slice(0, 2)
    await writeFile(join(lockDir, `${shard}.lock`), 'stale diagnostic bytes; no kernel owner')
    let locked = false
    let active = 0
    let maxActive = 0
    let attempts = 0
    const firstEntered = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const advisoryLock = async (_fd: number, operation: 'lock' | 'unlock') => {
      if (operation === 'unlock') {
        locked = false
        active -= 1
        return true
      }
      attempts += 1
      if (locked) return false
      locked = true
      active += 1
      maxActive = Math.max(maxActive, active)
      return true
    }
    const first = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {},
      advisoryLock,
      afterFileLock: async () => {
        firstEntered.resolve()
        await releaseFirst.promise
      },
    })
    const second = new BashInvocationRegistry({ runtimeDir: dir, reconcile: async () => {}, advisoryLock })
    const firstAcquire = first.acquire('same', 'digest')
    await firstEntered.promise
    const secondAcquire = second.acquire('same', 'digest')
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFirst.resolve()
    expect((await firstAcquire).generation).toBe(0)
    expect((await secondAcquire).generation).toBe(1)
    expect(attempts).toBeGreaterThan(1)
    expect(maxActive).toBe(1)
    await expect(second.acquire('unrelated', 'other')).resolves.toBeDefined()
  })
  test('releases the in-memory queue even when advisory unlock reports an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-registry-'))
    dirs.push(dir)
    let locked = false
    let releases = 0
    const value = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {},
      advisoryLock: async (_fd, operation) => {
        if (operation === 'lock') {
          if (locked) return false
          locked = true
          return true
        }
        locked = false
        releases += 1
        return releases !== 1
      },
    })
    await expect(value.acquire('one', 'digest')).rejects.toThrow('FILESYSTEM_LOCK_RELEASE_FAILED')
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'lock-queue-did-not-settle'>((resolve) => {
      watchdog = setTimeout(() => resolve('lock-queue-did-not-settle'), 2_000)
    })
    const settled = value.terminate('one').then(
      () => 'done' as const,
      () => 'done' as const
    )
    const outcome = await Promise.race([settled, timeout])
    if (watchdog) clearTimeout(watchdog)
    expect(outcome).toBe('done')
    expect(locked).toBe(false)
    expect(value.hasActiveInvocations()).toBe(false)
    const retry = await value.acquire('one', 'digest')
    expect(retry.generation).toBe(1)
    await retry.complete('success')
  })
  test('treats a concurrent prune unlink ENOENT as benign across registry instances', async () => {
    const first = await registry()
    const lease = await first.value.acquire('old', 'digest')
    await lease.complete('success')
    const overlapping = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async () => {},
      maxTerminalRecords: 0,
      minRecentTerminalRecords: 0,
      unlink: async (path) => {
        await unlink(path)
        throw Object.assign(new Error('concurrent prune won'), { code: 'ENOENT' })
      },
    })
    await expect(overlapping.pruneTerminalRecords()).resolves.toBe(0)
    await expect(overlapping.acquire('unrelated', 'other')).resolves.toBeDefined()
  })
  test('pruning immutable generation zero cannot delete a concurrent generation one owner', async () => {
    const first = await registry()
    const terminal = await first.value.acquire('same', 'digest')
    await terminal.complete('success')
    const validated = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pruner = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async () => {
        throw new Error('generation one ownership remains active')
      },
      maxTerminalRecords: 0,
      minRecentTerminalRecords: 0,
      beforeTerminalUnlink: async () => {
        validated.resolve()
        await release.promise
      },
    })
    const pruning = pruner.pruneTerminalRecords()
    await validated.promise
    const next = await first.value.acquire('same', 'digest')
    expect(next.generation).toBe(1)
    release.resolve()
    await expect(pruning).resolves.toBe(1)
    await expect(pruner.acquire('same', 'digest')).rejects.toThrow('generation one ownership remains active')
    const active = JSON.parse(
      await readFile(join(first.dir, 'active', `${createHash('sha256').update('same').digest('hex')}.json`), 'utf8')
    )
    expect(active).toMatchObject({ generation: 1, state: 'starting' })
  })
  test('quarantines a non-ENOENT prune failure per record without poisoning readiness', async () => {
    const first = await registry()
    const lease = await first.value.acquire('old', 'digest')
    await lease.complete('success')
    const overlapping = new BashInvocationRegistry({
      runtimeDir: first.dir,
      reconcile: async () => {},
      maxTerminalRecords: 0,
      minRecentTerminalRecords: 0,
      unlink: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    })
    await expect(overlapping.pruneTerminalRecords()).resolves.toBe(0)
    const records = await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(first.dir, 'active') }))
    const quarantined = JSON.parse(await readFile(join(first.dir, 'active', records[0]!), 'utf8'))
    expect(quarantined).toMatchObject({ state: 'quarantined', reasonCode: 'PRUNE_UNLINK_FAILED' })
    await expect(overlapping.acquire('unrelated', 'other')).resolves.toBeDefined()
  })
  test('triggers bounded count pruning during long-lived operation', async () => {
    const { dir } = await registry()
    const bounded = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {},
      maxTerminalRecords: 2,
      minRecentTerminalRecords: 1,
      terminalRetentionMs: Number.MAX_SAFE_INTEGER,
      pruneEveryOperations: 1000,
      pruneAtRecordCount: 3,
    })
    for (const id of ['one', 'two', 'three']) {
      const lease = await bounded.acquire(id, id)
      await lease.complete('success')
    }
    expect(await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(dir, 'terminal') }))).toHaveLength(2)
  })
  test('quarantines malformed JSON, invalid schema/state, and ambiguous ownership independently', async () => {
    const { dir } = await registry()
    const key = (id: string) => createHash('sha256').update(id).digest('hex')
    const malformedKey = key('malformed')
    const schemaKey = key('schema')
    const ambiguousKey = key('ambiguous')
    const unknownStateKey = key('unknown-state')
    await writeFile(join(dir, `${malformedKey}.json`), '{')
    await writeFile(
      join(dir, `${schemaKey}.json`),
      JSON.stringify({
        version: 1,
        invocationIdHash: 'wrong',
        generation: 0,
        commandDigest: 'd',
        state: 'running',
        startedAt: 'now',
      })
    )
    await writeFile(
      join(dir, `${unknownStateKey}.json`),
      JSON.stringify({
        version: 1,
        invocationIdHash: unknownStateKey,
        generation: 0,
        commandDigest: 'd',
        state: 'unknown',
        startedAt: '2026-08-16T00:00:00.000Z',
      })
    )
    await writeFile(
      join(dir, `${ambiguousKey}.json`),
      JSON.stringify({
        version: 1,
        invocationIdHash: ambiguousKey,
        generation: 0,
        commandDigest: 'd',
        state: 'running',
        startedAt: '2026-08-16T00:00:00.000Z',
        pid: 90,
        pgid: 90,
        sid: 90,
        startToken: 'linux:7',
      })
    )
    const restarted = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {
        throw new Error('ambiguous owner')
      },
    })
    const report = await restarted.reconcileAll()
    expect(report.quarantined.sort()).toEqual([ambiguousKey, malformedKey, schemaKey, unknownStateKey].sort())
    for (const id of ['malformed', 'schema', 'ambiguous', 'unknown-state']) {
      await expect(restarted.acquire(id, id === 'ambiguous' ? 'd' : 'other')).rejects.toBeInstanceOf(
        InvocationQuarantinedError
      )
    }
    await expect(restarted.acquire('unrelated', 'other')).resolves.toBeDefined()
  })
  test('bounds backward-compatible legacy terminal migration per startup', async () => {
    const { dir } = await registry()
    for (let index = 0; index < 11; index += 1) await writeFile(join(dir, `foreign-${index}.tmp`), 'stale')
    const symlinkKey = createHash('sha256').update('symlink-poison').digest('hex')
    await symlink('foreign-0.tmp', join(dir, `${symlinkKey}.json`))
    for (let index = 0; index < 50; index += 1) {
      const id = `legacy-${index}`
      const hash = createHash('sha256').update(id).digest('hex')
      await writeFile(
        join(dir, `${hash}.json`),
        JSON.stringify({
          version: 1,
          invocationIdHash: hash,
          generation: 0,
          commandDigest: id,
          state: 'success',
          startedAt: '2026-08-16T00:00:00.000Z',
          terminalAt: '2026-08-16T00:00:01.000Z',
        })
      )
    }
    const batches: number[] = []
    const bounded = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {
        throw new Error('terminal history must not reconcile')
      },
      legacyMigrationBatchSize: 5,
      pruneEveryOperations: 1,
      maxTerminalRecords: 2000,
      onLegacyBatch: (count) => batches.push(count),
    })
    await bounded.reconcileAll()
    expect(batches[0]).toBeLessThanOrEqual(13)
    const initialRoot = await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: dir }))
    const initialTerminal = await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(dir, 'terminal') }))
    expect(initialRoot.length + initialTerminal.length).toBe(50)
    const quarantineKey = createHash('sha256').update('preserved-quarantine').digest('hex')
    await writeFile(
      join(dir, `${quarantineKey}.json`),
      JSON.stringify({
        version: 1,
        invocationIdHash: quarantineKey,
        generation: 0,
        commandDigest: 'q',
        state: 'quarantined',
        startedAt: '2026-08-16T00:00:00.000Z',
        quarantinedAt: '2026-08-16T00:00:01.000Z',
        reasonCode: 'TEST',
      })
    )
    for (let index = 0; index < 10; index += 1) {
      const lease = await bounded.acquire(`maintenance-${index}`, `maintenance-${index}`)
      await lease.complete('success')
    }
    expect(await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: dir }))).toEqual([])
    const quarantineDir = join(dir, 'quarantine')
    const evidence = await readdir(quarantineDir, { withFileTypes: true })
    expect(evidence).toHaveLength(12)
    const links = evidence.filter((entry) => entry.isSymbolicLink())
    expect(links).toHaveLength(1)
    expect((await lstat(join(quarantineDir, links[0]!.name))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(quarantineDir, links[0]!.name))).toBe('foreign-0.tmp')
    await expect(lstat(join(dir, `${symlinkKey}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    const regularEvidence = evidence.filter((entry) => entry.isFile())
    expect(regularEvidence).toHaveLength(11)
    expect(
      await Promise.all(regularEvidence.map((entry) => readFile(join(quarantineDir, entry.name), 'utf8')))
    ).toEqual(Array(11).fill('stale'))
    const active = await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(dir, 'active') }))
    expect(active).toEqual([`${quarantineKey}.json`])
    expect(batches.every((count) => count <= 13)).toBe(true)
    expect((await bounded.acquire('legacy-49', 'legacy-49')).generation).toBe(1)
  })
  test('prunes only eligible oldest terminal records at the hard cap', async () => {
    const now = new Date('2026-08-15T00:00:00.000Z')
    const { dir } = await registry()
    const bounded = new BashInvocationRegistry({
      runtimeDir: dir,
      reconcile: async () => {},
      now: () => now,
      maxTerminalRecords: 2,
      minRecentTerminalRecords: 1,
      terminalRetentionMs: Number.MAX_SAFE_INTEGER,
    })
    for (const id of ['one', 'two', 'three']) {
      const lease = await bounded.acquire(id, id)
      await lease.complete('success')
    }
    expect(await bounded.pruneTerminalRecords()).toBe(1)
    expect(await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(dir, 'terminal') }))).toHaveLength(2)
  })
  test('hasActiveInvocations tracks the starting→running→terminal lifecycle (the idle-exit gate)', async () => {
    // The socket-activated server exits when idle; this predicate is the ONLY
    // thing that stops it exiting out from under a running command.
    const { value } = await registry()
    expect(value.hasActiveInvocations()).toBe(false)
    const lease = await value.acquire('build', 'digest')
    expect(value.hasActiveInvocations()).toBe(true) // 'starting'
    await lease.markRunning({ pid: 7, pgid: 7, sid: 7, startToken: 'linux:1' })
    expect(value.hasActiveInvocations()).toBe(true) // 'running'
    await lease.complete('success')
    expect(value.hasActiveInvocations()).toBe(false)
  })
  test('hasActiveInvocations stays true across a cancellation until it is terminal', async () => {
    let observedDuringReconcile: boolean | undefined
    const { value } = await registry(async () => {
      // reconcile() runs while the record is 'cancelling' — the window in which
      // a naive "only running counts" gate would let the server exit.
      observedDuringReconcile = value.hasActiveInvocations()
    })
    const lease = await value.acquire('doomed', 'digest')
    await lease.markRunning({ pid: 9, pgid: 9, sid: 9, startToken: 'linux:2' })
    await value.terminate('doomed')
    expect(observedDuringReconcile).toBe(true)
    expect(value.hasActiveInvocations()).toBe(false)
  })
})
