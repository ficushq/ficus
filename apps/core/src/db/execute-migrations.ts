import { join } from 'path'
import { createPostgresConnection, getConnectionString } from './connection'
import { migrateDatabase } from './migrator'
import { assertMigrationsMatchBuild } from './migration-build-manifest'
import { validateDatabaseConnection } from './validate-connection'
import { MONOREPO_ROOT } from '../lib/paths'

const migrationsFolder = join(MONOREPO_ROOT, 'apps/core/drizzle')
// A bundle older or newer than the migrations folder refuses before connecting,
// taking the advisory lock, or opening any transaction or DDL.
assertMigrationsMatchBuild(migrationsFolder)
const connectionString = getConnectionString()
validateDatabaseConnection(connectionString, 'db/run-migrations')
const client = createPostgresConnection(connectionString, { onnotice: () => {} })

try {
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
  } finally {
    connection.release()
  }
} finally {
  await client.end()
}
