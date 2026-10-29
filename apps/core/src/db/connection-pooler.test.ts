import '../test-utils/require-test-db'
import { describe, test, expect } from 'bun:test'
import postgres from 'postgres'
import { join } from 'path'
import { changeTestPoolerState, withStoppedTestPooler } from '../test-utils/test-pooler'
import { createResilientClient } from './connection'

// What happens to the main application pool when the loopback PgBouncer in
// front of it restarts (a crash, a config reload, an upgrade): the in-flight
// query fails, and the §4.2 liveness watchdog must bring the pool back on its
// own once the pooler is listening again — no process restart. Drives the
// real compose `pgbouncer` service down and up; the watchdog runs on short
// intervals here so the whole round trip fits a test.

const POOLED = process.env.TEST_POOLED_DATABASE_URL
if (!POOLED) {
  console.log(
    '[core] Skipping db/connection-pooler.test.ts — TEST_POOLED_DATABASE_URL not set (pgbouncer service not up).'
  )
}

const repoRoot = join(import.meta.dir, '../../../..')

// Locally the pooler is the compose `pgbouncer` service; on CI it is a plain
// `docker run` container named by TEST_PGBOUNCER_CONTAINER (the CI postgres
// is not a compose service either). Either way stop/start keeps the host port.
const CONTAINER = process.env.TEST_PGBOUNCER_CONTAINER

const poolerOptions = { repoRoot, container: CONTAINER }

async function eventually<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (err) {
      last = err
      await Bun.sleep(250)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

describe.skipIf(!POOLED)('the usage reporter reads SHOW POOLS from the admin console', () => {
  test('returns the pool numbers and raises no unhandled rejection', async () => {
    // The admin console speaks only the simple protocol. postgres.js's own
    // connect-time type fetch (fetch_types) uses the extended protocol, and
    // its rejection is nobody's await: on 2026-10-26 it crashed every pooled
    // worker on start ("extended query protocol not supported by admin
    // console", 08P01) through the db unhandled-rejection handler.
    const { readPoolerSample } = await import('../services/machines/usage-reporter')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const sample = await readPoolerSample(POOLED!)
      await Bun.sleep(200)
      expect(unhandled).toEqual([])
      expect(sample).not.toBeNull()
      expect(sample).toEqual({
        waitingClients: expect.any(Number),
        maxWaitMs: expect.any(Number),
        activeServers: expect.any(Number),
      })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe.skipIf(!POOLED)('the main pool survives a PgBouncer restart', () => {
  test('queries fail while the pooler is down and succeed again once it is back, without a process restart', async () => {
    const sql = createResilientClient({
      build: () => postgres(POOLED!, { max: 2, prepare: false, connect_timeout: 2, onnotice: () => {} }),
      intervalMs: 300,
      probeTimeoutMs: 800,
      failuresBeforeSwap: 2,
      baseBackoffMs: 300,
    })
    try {
      expect((await sql<{ one: number }[]>`select 1 as one`)[0].one).toBe(1)

      await withStoppedTestPooler(poolerOptions, async () => {
        await expect(eventually(() => sql`select 1`, 3_000)).rejects.toThrow()
      })
      const [row] = await eventually(() => sql<{ one: number }[]>`select 1 as one`, 20_000)
      expect(row.one).toBe(1)
    } finally {
      ;(sql as unknown as { __stopHealthWatchdog?: () => void }).__stopHealthWatchdog?.()
      await sql.end({ timeout: 5 }).catch(() => {})
      // Leave the service up for whatever runs next.
      changeTestPoolerState(poolerOptions, 'start')
    }
  }, 40_000)
})
