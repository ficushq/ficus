import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations, classifyMigration } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const columns = migrations.find((migration) =>
  migration.sql.join('\n').includes('ADD COLUMN "resolved_by_agent_id" uuid')
)!
const index = migrations.find((migration) =>
  migration.sql.join('\n').includes('"idx_work_stream_flow_transitions_created"')
)!
const validate = migrations.find((migration) =>
  migration.sql.join('\n').includes('VALIDATE CONSTRAINT "squad_activity_lane_check"')
)!
const predecessors = migrations.filter((migration) => migration.folderMillis < columns.folderMillis)
const urlFor = (name: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}
const CONSTRAINTS = [
  'squad_activity_lane_check',
  'squad_activity_lane_kind_check',
  'squad_activity_lane_scope_check',
  'work_stream_waits_resolved_by_agent_id_agents_id_fk',
  'work_stream_waits_resolved_by_user_id_users_id_fk',
]

describe('settled-without-you migrations', () => {
  const databaseName = `settled_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const squadId = crypto.randomUUID()
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  const validated = async () =>
    Object.fromEntries(
      (
        await connection<{ conname: string; convalidated: boolean }[]>`
          SELECT conname, convalidated FROM pg_constraint WHERE conname IN ${connection(CONSTRAINTS)}`
      ).map((row) => [row.conname, row.convalidated])
    )

  beforeAll(async () => {
    expect([columns, index, validate].every(Boolean)).toBe(true)
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    client = createPostgresConnection(urlFor(databaseName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    // An existing row the re-added checks must accept.
    await connection`INSERT INTO squads (id,name,purpose) VALUES (${squadId},'Squad','test')`
    await connection`INSERT INTO squad_activity (squad_id,lane,row_id,source_family,source_group_id,at,kind,summary,
        preview,ref,quiet_eligible,access_scope,payload_hash)
      VALUES (${squadId},41,${crypto.randomUUID()},'wait','g',now(),'wait','s','[]','{}',true,'workstreams','h')`
  }, 60_000)

  afterAll(async () => {
    connection?.release()
    await client?.end()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  })

  test('adds constraints without scanning, builds the index concurrently, then validates', async () => {
    // The index runs on its own, so the validation is a separate transaction from the exclusive ALTERs.
    expect(index.folderMillis).toBeGreaterThan(columns.folderMillis)
    expect(validate.folderMillis).toBeGreaterThan(index.folderMillis)
    expect(classifyMigration(index)).toMatchObject({
      kind: 'concurrent-index',
      tableName: 'work_stream_flow_transitions',
    })
    expect(classifyMigration(columns)).toEqual({ kind: 'transactional' })

    await applyMigrations(connection, [columns])
    expect(Object.values(await validated())).toEqual(CONSTRAINTS.map(() => false))

    await applyMigrations(connection, [index, validate])
    expect(await validated()).toEqual(Object.fromEntries(CONSTRAINTS.map((name) => [name, true])))
    const [built] = await connection<{ valid: boolean }[]>`
      SELECT indisvalid valid FROM pg_index WHERE indexrelid='idx_work_stream_flow_transitions_created'::regclass`
    expect(built?.valid).toBe(true)

    // Lane 32 is a work stream row in the workstreams scope; anything else is still refused.
    await connection`INSERT INTO squad_activity (squad_id,lane,row_id,source_family,source_group_id,at,kind,summary,
        preview,ref,quiet_eligible,access_scope,payload_hash)
      VALUES (${squadId},32,${crypto.randomUUID()},'workstream','g',now(),'workstream','s','[]','{}',true,'workstreams','h')`
    await expect(
      connection`INSERT INTO squad_activity (squad_id,lane,row_id,source_family,source_group_id,at,kind,summary,
          preview,ref,quiet_eligible,access_scope,payload_hash)
        VALUES (${squadId},32,${crypto.randomUUID()},'workstream','g',now(),'wait','s','[]','{}',true,'workstreams','h')`
    ).rejects.toThrow('squad_activity_lane_kind_check')
  })
})
