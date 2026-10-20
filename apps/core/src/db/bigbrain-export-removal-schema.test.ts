import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'
import { expect, test } from 'bun:test'
import * as schema from './schema'
test('current schema omits transcript capture while retaining history and integration lifecycle', () => {
  expect(Object.keys(schema)).not.toEqual(expect.arrayContaining(['integrationExportConsents']))
  for (const key of [
    'integrationExportConsents',
    'integrationExportCursors',
    'integrationExportBatches',
    'integrationExportBatchStateEnum',
  ])
    expect(key in schema).toBe(false)
  for (const key of [
    'messages',
    'agents',
    'integrationConnections',
    'integrationConnectionAssignments',
    'integrationProjectionStates',
  ])
    expect(key in schema).toBe(true)
})

test('canonical forward migrations drop only retired capture tables in a scratch database', async () => {
  const name = `bigbrain_removal_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const url = new URL(getConnectionString())
  url.pathname = '/postgres'
  const admin = createPostgresConnection(url.toString(), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    url.pathname = `/${name}`
    client = createPostgresConnection(url.toString(), { max: 1, onnotice: () => {} })
    const connection = await client.reserve()
    try {
      await applyMigrations(
        connection,
        readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
      )
      for (const table of ['integration_export_consents', 'integration_export_cursors', 'integration_export_batches']) {
        const [row] = await connection.unsafe('SELECT to_regclass($1) AS name', [table])
        expect(row.name).toBeNull()
      }
      for (const table of [
        'messages',
        'agents',
        'integration_connections',
        'integration_connection_assignments',
        'integration_projection_states',
      ]) {
        const [row] = await connection.unsafe('SELECT to_regclass($1) AS name', [table])
        expect(row.name).toBe(table)
      }
      expect(
        await connection.unsafe("SELECT 1 FROM pg_type WHERE typname='integration_export_batch_state'")
      ).toHaveLength(0)
    } finally {
      connection.release()
    }
  } finally {
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.end()
  }
}, 30000)
