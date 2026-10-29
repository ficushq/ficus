import '../test-utils/require-test-db'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection } from './connection'
import { expectedTableColumns, findSchemaDrift, parseColumnRows } from './expected-schema'
import { applyMigrations } from './migrator'

const folder = join(MONOREPO_ROOT, 'apps/core/drizzle')
const migrations = readMigrationFiles({ migrationsFolder: folder })
const rollout = migrations.find((migration) =>
  migration.sql.some((sql) => sql.includes('CREATE TABLE "work_stream_flow_runs"'))
)!
const predecessors = migrations.filter((migration) => migration.folderMillis < rollout.folderMillis)
const finalOriginalTimestamp = 1788986460108

test('consolidated rollout retains the original thirteen SQL migrations and final timestamp', () => {
  // Hash of the ordered original SQL files (0169–0181), separated by Drizzle
  // breakpoints. Preserve this history rather than substituting a net-schema diff.
  expect(
    createHash('sha256')
      .update(readFileSync(join(folder, '0169_workflow_integration_rollout.sql')))
      .digest('hex')
  ).toBe('27e03c7a96b36e038b500fba244de8e6285fd35f50de64d3f013278c90324212')
  expect(rollout.folderMillis).toBe(finalOriginalTimestamp)
})

async function withDatabase(run: (connection: postgres.ReservedSql) => Promise<void>, startup = false) {
  const name = `workflow_rollout_${crypto.randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env.DATABASE_URL!)
  const admin = createPostgresConnection(url.toString(), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    url.pathname = `/${name}`
    client = createPostgresConnection(url.toString(), { max: 1, onnotice: () => {} })
    if (startup) drizzle(client)
    const connection = await client.reserve()
    try {
      await run(connection)
    } finally {
      connection.release()
    }
  } finally {
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.end()
  }
}

async function assertFinalSchema(connection: postgres.ReservedSql) {
  const columns = await connection<{ name: string }[]>`
    SELECT table_name || '|' || column_name AS name FROM information_schema.columns WHERE table_schema='public'`
  const actual = parseColumnRows(columns.map((row) => row.name).join('\n'))
  expect(findSchemaDrift(expectedTableColumns(), actual)).toEqual({ missingTables: [], missingColumns: [] })
  expect(actual.has('squad_types')).toBe(false)
  expect(actual.has('work_styles')).toBe(false)
  expect(actual.has('work_style_bindings')).toBe(false)
  expect(actual.get('agent_types')!.has('flow_prompt')).toBe(false)
  const indexes = await connection<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
      ('idx_workflow_binding_key','idx_work_stream_flow_transition_version','uq_integration_assignments_default')`
  expect(indexes).toHaveLength(3)
}

test('fresh installation runs the consolidated DDL and backfills in dependency order', async () => {
  await withDatabase(async (connection) => {
    await applyMigrations(connection, migrations)
    await assertFinalSchema(connection)
  })
})

for (const startup of [false, true]) {
  test(`main upgrade preserves squad data, rolls back failure, and retries (${startup ? 'Drizzle startup' : 'standalone'})`, async () => {
    await withDatabase(async (connection) => {
      await applyMigrations(connection, predecessors)
      const id = crypto.randomUUID()
      await connection`INSERT INTO squad_types (id,name,manager_instructions,worker_instructions)
        VALUES ('rollout','Rollout','Coordinate carefully.','{"all":"Retired instructions"}')`
      await connection`INSERT INTO squads (id,name,purpose,squad_type_id) VALUES (${id},'Migration fixture','Verify upgrade','rollout')`
      // A failure after all three hooks must roll back both their data writes
      // and every new table, with no successful rollout ledger entry.
      await expect(
        applyMigrations(connection, { ...rollout, sql: [...rollout.sql, 'SELECT * FROM missing_rollout_relation'] })
      ).rejects.toThrow()
      expect((await connection`SELECT to_regclass('public.work_stream_flow_runs') AS table`)[0]!.table).toBeNull()
      expect((await connection`SELECT metadata FROM squads WHERE id=${id}`)[0]!.metadata).toEqual({})
      await applyMigrations(connection, rollout)
      await applyMigrations(
        connection,
        migrations.filter((migration) => migration.folderMillis > rollout.folderMillis)
      )
      await assertFinalSchema(connection)
      const [squad] = await connection`SELECT squad_preset_id,type_context FROM squads WHERE id=${id}`
      expect(squad).toMatchObject({ squad_preset_id: 'rollout', type_context: { manager: 'Coordinate carefully.' } })
      await applyMigrations(connection, rollout)
      expect(
        (
          await connection`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at=${finalOriginalTimestamp}`
        )[0]!.count
      ).toBe(1)
    }, startup)
  })
}

test('fully adopted original rollout skips the consolidated SQL despite the new hash', async () => {
  await withDatabase(async (connection) => {
    await applyMigrations(connection, [])
    // Existing smoke has the former final ledger timestamp and a different
    // SQL hash. No schema or ledger rewrite is needed for it to skip the batch.
    await connection`INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ('original-0181-hash',${finalOriginalTimestamp})`
    await applyMigrations(connection, rollout)
    expect((await connection`SELECT to_regclass('public.work_stream_flow_runs') AS table`)[0]!.table).toBeNull()
    expect((await connection`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)[0]!.count).toBe(1)
  })
})
