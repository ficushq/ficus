import '../test-utils/require-test-db'
import { describe, test, expect } from 'bun:test'
import postgres from 'postgres'
import { createPostgresConnection } from './connection'

// The pooled path, end to end against a real transaction-mode PgBouncer (the
// `pgbouncer` service in docker-compose.test.yml, exported by test-setup as
// TEST_POOLED_DATABASE_URL). Two things this pins that a unit test cannot:
//
//  1. Core keeps `prepare` ON behind the pooler. PgBouncer ≥ 1.21 tracks
//     protocol-level prepared statements across server connections
//     (max_prepared_statements); without that, a named statement reused on
//     a different backend fails with "prepared statement ... does not exist".
//     Ten clients hammering one parameterised query force backend switching.
//  2. A transaction-scoped advisory lock is held for exactly its transaction
//     and nothing more, through the pooler.

const POOLED = process.env.TEST_POOLED_DATABASE_URL
if (!POOLED) {
  console.log(
    '[core] Skipping db/pooled-queries.test.ts — TEST_POOLED_DATABASE_URL not set (pgbouncer service not up).'
  )
}

describe.skipIf(!POOLED)('queries through a transaction-mode pooler', () => {
  test('prepared statements survive backend switching across ten concurrent clients', async () => {
    const clients = Array.from({ length: 10 }, () => createPostgresConnection(POOLED!, { max: 1, prepare: true }))
    try {
      const results = await Promise.all(
        clients.map(async (sql, i) => {
          const seen: number[] = []
          for (let n = 0; n < 50; n++) {
            const [row] = await sql<{ v: number }[]>`select ${i * 100 + n}::int as v`
            seen.push(row.v)
          }
          return seen
        })
      )
      results.forEach((seen, i) => {
        expect(seen).toEqual(Array.from({ length: 50 }, (_, n) => i * 100 + n))
      })
    } finally {
      await Promise.all(clients.map((sql) => sql.end({ timeout: 5 })))
    }
  })

  test('a transaction-scoped advisory lock holds for its transaction only', async () => {
    const a = postgres(POOLED!, { max: 1, prepare: false })
    const b = postgres(POOLED!, { max: 1, prepare: false })
    try {
      let releaseA: () => void = () => {}
      const aHolds = new Promise<void>((resolve) => (releaseA = resolve))
      let aLocked: (v: boolean) => void = () => {}
      const aLockedPromise = new Promise<boolean>((resolve) => (aLocked = resolve))
      const txA = a.begin(async (tx) => {
        // The transaction handle's typings expose only .unsafe for raw text.
        const [row] = (await tx.unsafe('select pg_try_advisory_xact_lock(990001) as locked')) as unknown as {
          locked: boolean
        }[]
        aLocked(row.locked)
        await aHolds
      })
      expect(await aLockedPromise).toBe(true)
      // While A's transaction is open, B cannot take the same lock.
      const [contended] = await b<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(990_001) as locked`
      expect(contended.locked).toBe(false)
      releaseA()
      await txA
      // A's transaction ended: the lock went with it, even though A's client
      // connection is still open (through the pooler it no longer owns a backend).
      const [free] = await b<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(990_001) as locked`
      expect(free.locked).toBe(true)
    } finally {
      await a.end({ timeout: 5 })
      await b.end({ timeout: 5 })
    }
  })
})
