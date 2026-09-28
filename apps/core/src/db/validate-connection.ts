import { createLogger } from '../lib/infra/logger'

const log = createLogger('db')

/**
 * Validates DATABASE_URL for test/production safety.
 * Call this before creating any database connection.
 */
export function validateDatabaseConnection(connectionString: string, context: string): void {
  const url = new URL(connectionString)
  const dbName = url.pathname.slice(1) // Remove leading /
  const port = url.port || '5432'

  if (process.env.FICUS_TEST_MODE === '1') {
    const isIsolatedSecretBoundaryDb =
      process.env.SECRET_BOUNDARY_REQUIRE_ISOLATED_DB === '1' && dbName === 'tau_secret_boundary_test'
    if (dbName !== 'tau_test' && !isIsolatedSecretBoundaryDb) {
      throw new Error(
        `TEST SAFETY VIOLATION in ${context}: Test mode but database is "${dbName}" instead of "tau_test". ` +
          `DATABASE_URL=${connectionString}`
      )
    }
    if (port === '5432') {
      throw new Error(
        `TEST SAFETY VIOLATION in ${context}: Test mode but port is 5432 (production). ` +
          `DATABASE_URL=${connectionString}`
      )
    }
  }

  // Warn if connecting to test DB outside test mode
  if (dbName === 'tau_test' && process.env.FICUS_TEST_MODE !== '1') {
    log.warn(`WARNING in ${context}: Connecting to tau_test database outside of test mode.`)
  }
}
