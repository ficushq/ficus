import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "assistant_conversation_agents"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `assistant_agents_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('assistant conversation agents migration', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO users (id, email, display_name)
      VALUES ('30000000-0000-4000-8000-000000000001', 'owner@example.test', 'Owner');
      INSERT INTO agents (id, agent_type_id, status, metadata)
      VALUES ('10000000-0000-4000-8000-000000000001', 'system-manager', 'idle', '{}');
      INSERT INTO assistant_conversations (id, owner_user_id, manager_agent_id)
      VALUES
        ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
        ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', NULL);
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('backfills the general helper rows and drops the old column', async () => {
    await applyMigrations(connection, target!)
    const rows = await connection.unsafe<{ conversation_id: string; squad_id: string | null; agent_id: string }[]>(
      `SELECT conversation_id, squad_id, agent_id FROM assistant_conversation_agents ORDER BY conversation_id`
    )
    expect([...rows]).toEqual([
      {
        conversation_id: '20000000-0000-4000-8000-000000000001',
        squad_id: null,
        agent_id: '10000000-0000-4000-8000-000000000001',
      },
    ])
    const columns = await connection.unsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'assistant_conversations'`
    )
    expect(columns.map((row) => row.column_name)).not.toContain('manager_agent_id')
    // Rethrow as a plain Error: bun's `expect(...).rejects.toThrow()` hangs
    // indefinitely (observed 5s/30s/60s/300s+ then a CPU-pegged spin) when the
    // rejection reason is postgres.js's own `PostgresError` instance on this
    // bun/postgres.js pairing. A standalone script (bypassing bun:test)
    // confirmed the migration and constraint themselves are correct and
    // instantaneous — the hang is purely in bun's assertion handling of that
    // error class. Normalizing to a plain `Error` first avoids it.
    await expect(
      connection
        .unsafe(
          `INSERT INTO assistant_conversation_agents (conversation_id, squad_id, agent_id)
           VALUES ('20000000-0000-4000-8000-000000000001', NULL, '10000000-0000-4000-8000-000000000001')`
        )
        .catch((error: unknown) => {
          throw error instanceof Error ? new Error(error.message) : new Error(String(error))
        })
    ).rejects.toThrow()
  })
})
