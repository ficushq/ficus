import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) =>
  migration.sql.join('\n').includes('SET "model_override" = NULL, "updated_at" = now()\nFROM "workflow_bindings"')
)!
const predecessors = migrations.filter((migration) => migration.folderMillis < target.folderMillis)
const urlFor = (name: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('flow worker snapshot model backfill', () => {
  const databaseName = `flow_worker_models_${crypto.randomUUID().replaceAll('-', '')}`
  const squadId = crypto.randomUUID()
  const streamId = crypto.randomUUID()
  const copied = crypto.randomUUID()
  const changed = crypto.randomUUID()
  const tiered = crypto.randomUUID()
  const outside = crypto.randomUUID()
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    client = createPostgresConnection(urlFor(databaseName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection`INSERT INTO squads (id,name,purpose) VALUES (${squadId},'Squad','test')`
    await connection`INSERT INTO work_streams (id,squad_id,title) VALUES (${streamId},${squadId},'Stream')`
    const rows: Array<[string, string, string | null]> = [
      // A non-tiered worker created with the snapshot model copied into its override.
      [
        copied,
        'anthropic:claude-sonnet-4-5',
        JSON.stringify({ id: 'engineer', model: 'anthropic:claude-sonnet-4-5', tier: null }),
      ],
      // Someone changed the override since: it stays.
      [
        changed,
        'anthropic:claude-opus-4-5',
        JSON.stringify({ id: 'engineer', model: 'anthropic:claude-sonnet-4-5', tier: null }),
      ],
      // A tiered worker never carried a copy; a later person-set override stays.
      [tiered, 'anthropic:claude-haiku-4-5', JSON.stringify({ id: 'engineer', model: '', tier: 'deep' })],
      // Not a workflow worker.
      [outside, 'anthropic:claude-sonnet-4-5', null],
    ]
    for (const [id, modelOverride, snapshot] of rows) {
      await connection`INSERT INTO agents (id,agent_type_id,squad_id,model_override) VALUES (${id},'engineer',${squadId},${modelOverride})`
      if (snapshot)
        await connection`INSERT INTO workflow_bindings (agent_id,work_stream_id,participant_id,binding_key,agent_snapshot)
          VALUES (${id},${streamId},'builder',${id},${snapshot}::text::jsonb)`
    }
  }, 30_000)

  afterAll(async () => {
    connection?.release()
    await client?.end()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  })

  test('clears only overrides that are an unchanged copy of a non-tiered snapshot model', async () => {
    await applyMigrations(connection, [target])
    const rows = await connection<{ id: string; model_override: string | null }[]>`
      SELECT id, model_override FROM agents ORDER BY id`
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.model_override]))
    expect(byId).toEqual({
      [copied]: null,
      [changed]: 'anthropic:claude-opus-4-5',
      [tiered]: 'anthropic:claude-haiku-4-5',
      [outside]: 'anthropic:claude-sonnet-4-5',
    })
  })
})
