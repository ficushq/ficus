export interface MigrationSafetyInput {
  /** DATABASE_URL as observed before loading any repository defaults. */
  explicitDatabaseUrl: string | undefined
  /** Effective DATABASE_URL after the standalone root environment load. */
  resolvedDatabaseUrl: string | undefined
  /** DATABASE_URL parsed independently from the repository root .env. */
  rootDatabaseUrl: string | undefined
  liveEnvValue: string | undefined
  argv: string[]
}

export interface MigrationSafetyResult {
  argv: string[]
}

interface DatabaseTarget {
  identity: string
  display: string
}

const OVERRIDE_REMEDIATION =
  'Supply an explicit DATABASE_URL override for a test or scratch database, or deliberately permit a live migration with FICUS_MIGRATE_LIVE=1 or pass --live.'

function parseDatabaseTarget(value: string): DatabaseTarget {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL; the supplied value was not displayed.')
  }

  if (url.protocol === 'postgresql:') url.protocol = 'postgres:'
  if (url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol; the supplied value was not displayed.')
  }

  // PostgreSQL is not a WHATWG "special" scheme, so normalize host casing and
  // its common loopback aliases explicitly.
  const parsedHostname = url.hostname.toLowerCase()
  const hostname = parsedHostname === 'localhost' || parsedHostname === '127.0.0.1' ? '127.0.0.1' : parsedHostname
  const port = url.port || '5432'
  let database: string
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    throw new Error('DATABASE_URL contains an invalid database name; the supplied value was not displayed.')
  }

  return {
    identity: JSON.stringify([hostname, port, database]),
    display: `${hostname}:${port}/${encodeURIComponent(database)}`,
  }
}

/**
 * Return the normalized database identity used by the live-target guard.
 * PostgreSQL database identity is host, port, and database name; credentials
 * and connection options can vary without changing the database being
 * targeted.
 */
export function normalizeDatabaseUrl(value: string): string {
  return parseDatabaseTarget(value).identity
}

function tryParseDatabaseTarget(value: string | undefined): DatabaseTarget | undefined {
  if (value === undefined) return undefined
  try {
    return parseDatabaseTarget(value)
  } catch {
    return undefined
  }
}

function targetSuffix(value: string | undefined): string {
  const target = tryParseDatabaseTarget(value)
  return target ? ` Refused target: ${target.display}.` : ''
}

/**
 * Fail closed unless the caller explicitly selected a non-root database or
 * supplied one of the two deliberate live-migration escape hatches.
 */
export function checkMigrationSafety(input: MigrationSafetyInput): MigrationSafetyResult {
  if (input.liveEnvValue !== undefined && input.liveEnvValue !== '1') {
    throw new Error(
      'FICUS_MIGRATE_LIVE must be exactly 1 when set. Remove it, set FICUS_MIGRATE_LIVE=1, or pass --live.'
    )
  }

  const hasLiveFlag = input.argv.includes('--live')
  const argv = input.argv.filter((argument) => argument !== '--live')
  const liveMigrationAllowed = input.liveEnvValue === '1' || hasLiveFlag

  if (!liveMigrationAllowed && input.explicitDatabaseUrl === undefined) {
    throw new Error(
      `Migration refused because no explicit DATABASE_URL override was supplied.${targetSuffix(input.resolvedDatabaseUrl)} ${OVERRIDE_REMEDIATION}`
    )
  }

  const resolvedTarget = tryParseDatabaseTarget(input.resolvedDatabaseUrl)
  const rootTarget = tryParseDatabaseTarget(input.rootDatabaseUrl)
  if (!liveMigrationAllowed && resolvedTarget !== undefined && resolvedTarget.identity === rootTarget?.identity) {
    throw new Error(
      `Migration refused because DATABASE_URL identifies the repository root database. Refused target: ${resolvedTarget.display}. ${OVERRIDE_REMEDIATION}`
    )
  }

  return { argv }
}

/**
 * Run the canonical migration module only after the safety decision succeeds.
 * Mutating the supplied argv array ensures runner-only flags are consumed
 * before downstream code observes process.argv.
 */
export async function runGuardedMigration(
  input: MigrationSafetyInput,
  loadMigrations: () => Promise<unknown>
): Promise<void> {
  const safety = checkMigrationSafety(input)
  input.argv.splice(0, input.argv.length, ...safety.argv)
  await loadMigrations()
}
