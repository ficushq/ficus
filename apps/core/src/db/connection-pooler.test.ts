import { describe, test, expect } from 'bun:test'
import postgres from 'postgres'
import { join } from 'path'
import { testDbProjectName } from '@ficus/shared/testDbPort'
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
const composeFile = join(repoRoot, 'docker-compose.test.yml')
const projectName = testDbProjectName(repoRoot)

function compose(...args: string[]): void {
  const r = Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, TEST_REPO_ROOT: repoRoot },
  })
  if (r.exitCode !== 0) throw new Error(`docker compose ${args.join(' ')} failed: ${r.stderr.toString()}`)
}

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

      compose('stop', 'pgbouncer')
      await expect(eventually(() => sql`select 1`, 3_000)).rejects.toThrow()

      compose('start', 'pgbouncer')
      const [row] = await eventually(() => sql<{ one: number }[]>`select 1 as one`, 20_000)
      expect(row.one).toBe(1)
    } finally {
      ;(sql as unknown as { __stopHealthWatchdog?: () => void }).__stopHealthWatchdog?.()
      await sql.end({ timeout: 5 }).catch(() => {})
      // Leave the service up for whatever runs next.
      compose('start', 'pgbouncer')
    }
  }, 40_000)
})
