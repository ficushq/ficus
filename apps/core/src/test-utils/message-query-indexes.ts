import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'path'
import { db } from '../db'
import { MONOREPO_ROOT } from '../lib/paths'

/** Schema push omits indexes; plan tests need the actual generated production DDL. */
export async function ensureMessageQueryIndex(name: string) {
  return ensureQueryIndex(name)
}

export async function ensureQueryIndex(name: string) {
  const [existing] = await db.execute(sql`SELECT to_regclass(${name}) AS index`)
  if (existing.index) return
  await db.execute(sql.raw(generatedIndexStatement(name)))
}

/**
 * The newest generated migration's CREATE INDEX statement for `name`, so a test builds the index
 * production has rather than a hand-written copy that can drift from it.
 */
export function generatedIndexStatement(name: string) {
  const statements = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).flatMap(
    (migration) => migration.sql
  )
  const statement = statements.findLast(
    (value) => /^CREATE (UNIQUE )?INDEX/.test(value.trim()) && value.includes(`"${name}" ON `)
  )
  if (!statement) throw new Error(`Missing generated index migration: ${name}`)
  // A concurrently built index is built plainly here: the test database has no concurrent writers.
  return statement.trim().replace(/^(CREATE (?:UNIQUE )?INDEX) CONCURRENTLY/, '$1')
}
