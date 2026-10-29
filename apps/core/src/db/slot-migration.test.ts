import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TYPE "public"."slot_claim_status"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `slot_migration_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('slot persistence migration', () => {
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
    await applyMigrations(connection, target!)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('real SQL installs all partial uniqueness fences and enforces their predicates', async () => {
    const indexes = await connection.unsafe<{ indexname: string; indexdef: string }[]>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE indexname IN (
        'idx_slot_pools_active_key_unique',
        'idx_slot_claims_active_owner_unique',
        'idx_slot_waiters_queued_owner_unique'
      )
      ORDER BY indexname
    `)
    expect(indexes.map((index) => index.indexname)).toEqual([
      'idx_slot_claims_active_owner_unique',
      'idx_slot_pools_active_key_unique',
      'idx_slot_waiters_queued_owner_unique',
    ])
    expect(indexes.every((index) => index.indexdef.includes('UNIQUE') && index.indexdef.includes('WHERE'))).toBe(true)

    await connection.unsafe(`
      INSERT INTO squads (id, name, purpose)
      VALUES ('10000000-0000-4000-8000-000000000001', 'slot migration', 'test');
      INSERT INTO slot_pools (id, squad_id, key, created_by)
      VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'tests', 'test');
      INSERT INTO slot_claims (pool_id, owner_agent_id, expires_at)
      VALUES ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', now() + interval '1 hour');
      INSERT INTO slot_waiters (pool_id, owner_agent_id)
      VALUES ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001');
    `)

    const expectUniqueViolation = async (statement: string) => {
      let caught: unknown
      try {
        await connection.unsafe(statement)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: '23505' })
    }
    await expectUniqueViolation(`INSERT INTO slot_pools (squad_id, key, created_by)
      VALUES ('10000000-0000-4000-8000-000000000001', 'tests', 'test')`)
    await expectUniqueViolation(`INSERT INTO slot_claims (pool_id, owner_agent_id, expires_at)
      VALUES ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', now() + interval '1 hour')`)
    await expectUniqueViolation(`INSERT INTO slot_waiters (pool_id, owner_agent_id)
      VALUES ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001')`)

    await connection.unsafe(`
      UPDATE slot_pools SET unregistered_at = now() WHERE id = '20000000-0000-4000-8000-000000000001';
      INSERT INTO slot_pools (squad_id, key, created_by)
      VALUES ('10000000-0000-4000-8000-000000000001', 'tests', 'test');
      UPDATE slot_claims SET status = 'released' WHERE pool_id = '20000000-0000-4000-8000-000000000001';
      INSERT INTO slot_claims (pool_id, owner_agent_id, expires_at)
      VALUES ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', now() + interval '1 hour');
      UPDATE slot_waiters SET status = 'canceled' WHERE pool_id = '20000000-0000-4000-8000-000000000001';
      INSERT INTO slot_waiters (pool_id, owner_agent_id)
      VALUES ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001');
    `)
  }, 120_000)
})
