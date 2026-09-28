import { drizzle } from 'drizzle-orm/postgres-js'
import { join } from 'path'
import * as schema from './schema'
import { validateDatabaseConnection } from './validate-connection'
import {
  createPostgresConnection,
  DEDICATED_CONNECTION_SESSION,
  getConnectionString,
  withDedicatedConnectionSlot,
} from './connection'
import { waitForDb } from './wait'
import { createLogger } from '../lib/infra/logger'
import { MONOREPO_ROOT } from '../lib/paths'
import { migrateDatabase } from './migrator'
import { assertMigrationsMatchBuild } from './migration-build-manifest'

const log = createLogger('db')

const connectionString = getConnectionString()
validateDatabaseConnection(connectionString, 'db/index')

type DatabaseQueryObserver = (query: string, params: unknown[]) => void
let databaseQueryObserver: DatabaseQueryObserver | undefined

/** Test seam at Drizzle's query boundary; observes main-pool queries, including transaction queries. */
export function setDatabaseQueryObserverForTest(observer: DatabaseQueryObserver | undefined): void {
  databaseQueryObserver = observer
}

const queryObserverLogger = {
  logQuery(query: string, params: unknown[]): void {
    databaseQueryObserver?.(query, params)
  },
}

const client = createPostgresConnection(
  connectionString,
  { onnotice: () => {} },
  // The main pool is the ONE connection that opts into the liveness watchdog —
  // it heals a wedged Bun+postgres.js+TLS pool. Special single-connection
  // clients (process-liveness, migrations, locks) deliberately do not; see
  // createPostgresConnection's `resilience` docs.
  { healthWatchdog: true }
)
export const db = drizzle(client, { schema, logger: queryObserverLogger })

/** The transaction handle type of the main `db` (and of dedicated clones). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Run a transaction on a DEDICATED single connection instead of the shared
 * pool.
 *
 * Use this for any transaction that performs pool work while it is open —
 * holding an advisory/row lock across calls that themselves acquire pool
 * connections (entity statics, InboxMessage.send, nested db.transaction).
 * On the shared pool that shape is hold-and-wait: each such transaction owns
 * one pool slot while waiting for another, and with DATABASE_POOL_MAX=4 a
 * handful of concurrent ones self-deadlock the entire pool (observed live:
 * the db liveness watchdog then swaps the pool and every in-flight query
 * dies). A dedicated connection removes the transaction from the pool's
 * accounting entirely; the cost is one extra connection + TLS handshake for
 * the duration of the call.
 */
export async function withDedicatedDbTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
  // Test seam: lets a unit test observe connection lifecycle (end on throw).
  createConnection: typeof createPostgresConnection = createPostgresConnection
): Promise<T> {
  return withDedicatedConnectionSlot(async () => {
    const connection = createConnection(connectionString, {
      max: 1,
      idle_timeout: 0,
      onnotice: () => {},
      connection: DEDICATED_CONNECTION_SESSION,
    })
    try {
      const dedicated = drizzle(connection, { schema })
      return await dedicated.transaction(fn)
    } finally {
      await connection.end({ timeout: 5 })
    }
  })
}

export async function waitForDbAndMigrate(): Promise<void> {
  const migrationsFolder = join(MONOREPO_ROOT, 'apps/core/drizzle')
  // A bundle older or newer than the migrations folder refuses before connecting,
  // taking the advisory lock, or opening any transaction or DDL.
  assertMigrationsMatchBuild(migrationsFolder)
  await waitForDb(() => client`SELECT 1`)

  // PostgreSQL advisory locks are session-scoped, so locking, migration, and
  // unlocking must all use the same reserved connection.
  const connection = await client.reserve()
  try {
    await connection`SELECT pg_advisory_lock(42)`
    let migrationError: unknown
    let unlockError: unknown
    try {
      await migrateDatabase(connection, { migrationsFolder })
    } catch (error) {
      migrationError = error
      throw error
    } finally {
      try {
        await connection`SELECT pg_advisory_unlock(42)`
      } catch (error) {
        if (!migrationError) unlockError = error
      }
    }
    if (unlockError) throw unlockError
    log.info('Database migrations applied')
  } finally {
    connection.release()
  }
}

export * from './schema'
export * from './prefix-match'
