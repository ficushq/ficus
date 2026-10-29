import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'ALTER TABLE "machine_boxes" ADD COLUMN "last_listening_at"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `box_listening_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const machineId = '50000000-0000-4000-8000-000000000001'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('machine_boxes listening watermark migration (real runner, isolated database)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('adds a nullable watermark, leaving pre-existing box rows null (they simply fall back to probing)', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)

    await connection.unsafe(`
      INSERT INTO machines (id, name, provider, ssh_host, ssh_user, ssh_key_id, ssh_public_key, status)
      VALUES ('${machineId}', 'listening-mig', 'ssh', '10.0.0.9', 'tau', 'k', 'ssh-ed25519 AAAA', 'ready');
      INSERT INTO machine_boxes (sandbox_id, machine_id, unix_user, port, status)
      VALUES ('squad_legacy', '${machineId}', 'boxlegacy', 50100, 'ready')
    `)

    await applyMigrations(connection, [...predecessors, target!])

    const [row] = await connection.unsafe<{ last_listening_at: Date | null }[]>(
      `SELECT last_listening_at FROM machine_boxes WHERE sandbox_id = 'squad_legacy'`
    )
    expect(row.last_listening_at).toBeNull()

    // And the column accepts a stamp for a live box.
    await connection.unsafe(`UPDATE machine_boxes SET last_listening_at = now() WHERE sandbox_id = 'squad_legacy'`)
    const [stamped] = await connection.unsafe<{ last_listening_at: Date | null }[]>(
      `SELECT last_listening_at FROM machine_boxes WHERE sandbox_id = 'squad_legacy'`
    )
    expect(stamped.last_listening_at).toBeInstanceOf(Date)
  })
})
