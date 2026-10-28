import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { withDedicatedConnectionSlot } from './connection'

// Every session-scoped connection — a session advisory lock, a dedicated
// transaction, the worker's liveness session — must reach Postgres DIRECTLY
// (getDirectConnectionString), never through a transaction pooler: a pooler
// hands a backend to a client only for one transaction, so a session lock
// taken through it is gone (or on another backend) at statement end. And
// every such connection must be bounded by the dedicated-connection slot gate
// so a host's direct backends are deterministic.
//
// Two layers: a source guard over the nine sites (cheap, exhaustive) and a
// behavioural check against the test database with DATABASE_URL pointed at a
// host that cannot be reached — only a site using the direct DSN succeeds.

const SRC = join(import.meta.dir, '..')

/** Sites that must open their own direct connection, and must do so under the slot gate. */
const DIRECT_GATED_SITES = [
  'db/execute-migrations.ts',
  'services/memory/WriteService.ts',
  'services/updates/run-lock.ts',
  'services/integrations/authorization/connection-lease.ts',
  'services/machines/cli-bundle.ts',
  'services/sandbox/toolchain/state.ts',
  'services/sandbox/vm/setup-state.ts',
]

describe('session-scoped sites use the direct DSN under the slot gate (source guard)', () => {
  for (const site of DIRECT_GATED_SITES) {
    test(site, () => {
      const source = readFileSync(join(SRC, site), 'utf8')
      expect(source).toContain('getDirectConnectionString(')
      expect(source).not.toMatch(/\bgetConnectionString\(\)/)
      // Either the callback form or the acquire/release pair (run-lock holds
      // its slot across a returned handle), including bounded non-queueing
      // acquisition for signal/deadline-aware lifecycle waits.
      expect(
        /\b(?:withDedicatedConnectionSlot|acquireDedicatedConnectionSlot|tryAcquireDedicatedConnectionSlot)\(/.test(
          source
        )
      ).toBe(true)
    })
  }

  test('db/index.ts: the dedicated transaction and the migration lock go direct; the main pool stays on DATABASE_URL', () => {
    const source = readFileSync(join(SRC, 'db/index.ts'), 'utf8')
    expect(source).toContain('getDirectConnectionString(')
    // The main application pool is the one legitimate DATABASE_URL reader here.
    expect(source.match(/\bgetConnectionString\(\)/g)?.length ?? 0).toBe(1)
  })

  test('process-liveness: the permanent liveness session goes direct (deliberately outside the gate — it never releases)', () => {
    const source = readFileSync(join(SRC, 'services/maintenance/process-liveness.ts'), 'utf8')
    expect(source).toContain('getDirectConnectionString(')
    expect(source).not.toMatch(/\bgetConnectionString\(\)/)
  })
})

const dbConfigured = !!process.env.DATABASE_URL

describe.skipIf(!dbConfigured)('session-scoped sites reach the database through DATABASE_DIRECT_URL', () => {
  const priorUrl = process.env.DATABASE_URL
  const priorDirect = process.env.DATABASE_DIRECT_URL
  afterEach(() => {
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (priorDirect === undefined) delete process.env.DATABASE_DIRECT_URL
    else process.env.DATABASE_DIRECT_URL = priorDirect
  })

  /** Point DATABASE_URL somewhere unreachable and the direct DSN at the real test database. */
  function splitDsns(): void {
    process.env.DATABASE_DIRECT_URL = priorUrl
    process.env.DATABASE_URL = 'postgres://nobody:nothing@203.0.113.1:1/ficus_test?connect_timeout=1'
  }

  test('the update run-lock is taken on the direct connection', async () => {
    splitDsns()
    const { acquireUpdateRunLock } = await import('../services/updates/run-lock')
    const lock = await acquireUpdateRunLock(900_001)
    expect(lock).not.toBeNull()
    await lock!.release()
  })

  test('a dedicated transaction runs on the direct connection', async () => {
    // Import BEFORE splitting the DSNs: db/index.ts captures DATABASE_URL for
    // its main pool at import time (and is cached for every later test file
    // in this process); the dedicated helper reads the direct DSN at call time.
    const { withDedicatedDbTransaction } = await import('./index')
    splitDsns()
    const { sql } = await import('drizzle-orm')
    const rows = await withDedicatedDbTransaction(async (tx) => tx.execute(sql`select 1 as one`))
    expect(Array.isArray(rows) ? rows.length : (rows as { length?: number }).length).toBeGreaterThan(0)
  })

  test('the run-lock waits for a dedicated slot instead of opening a third direct connection', async () => {
    splitDsns()
    const { acquireUpdateRunLock } = await import('../services/updates/run-lock')
    const releasers: Array<() => void> = []
    const holders = [0, 1].map(() =>
      withDedicatedConnectionSlot(() => new Promise<void>((resolve) => releasers.push(resolve)))
    )
    // Both slots are held: the lock must not be acquired yet.
    const pending = acquireUpdateRunLock(900_002)
    const settledEarly = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 300)),
    ])
    expect(settledEarly).toBe(false)
    // Free one slot: now it goes through.
    releasers[0]()
    const lock = await pending
    expect(lock).not.toBeNull()
    await lock!.release()
    releasers[1]()
    await Promise.all(holders)
  })
})
