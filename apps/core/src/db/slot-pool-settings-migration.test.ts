import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = `ALTER TYPE "public"."slot_notification_kind" ADD VALUE 'pool_disabled'`
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `slot_settings_migration_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const SQUAD = '10000000-0000-4000-8000-000000000001'
const POOL = '20000000-0000-4000-8000-000000000001'
const CLAIM = '30000000-0000-4000-8000-000000000001'
const WAITER = '40000000-0000-4000-8000-000000000001'
const AGENT = '50000000-0000-4000-8000-000000000001'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('slot pool usage and disable migration', () => {
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
    // Live state from before the migration must survive it unchanged.
    await connection.unsafe(`
      INSERT INTO squads (id, name, purpose) VALUES ('${SQUAD}', 'slot settings migration', 'test');
      INSERT INTO slot_pools (id, squad_id, key, capacity, created_by) VALUES ('${POOL}', '${SQUAD}', 'tests', 2, 'test');
      INSERT INTO slot_claims (id, pool_id, owner_agent_id, expires_at)
      VALUES ('${CLAIM}', '${POOL}', '${AGENT}', now() + interval '1 hour');
      INSERT INTO slot_waiters (id, pool_id, owner_agent_id) VALUES ('${WAITER}', '${POOL}', '${AGENT}');
      INSERT INTO slot_notifications (pool_id, claim_id, recipient_agent_id, kind, idempotency_key)
      VALUES ('${POOL}', '${CLAIM}', '${AGENT}', 'granted', 'legacy-grant');
    `)
    await applyMigrations(connection, target!)
  }, 120_000)

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  async function sqlError(statement: string): Promise<unknown> {
    try {
      await connection.unsafe(statement)
    } catch (error) {
      return error
    }
    return undefined
  }

  test('existing pools become enabled pools without guidance; existing notices keep their claim', async () => {
    const [pool] = await connection.unsafe<{ usage: string | null; disabled_at: Date | null; capacity: number }[]>(
      `SELECT usage, disabled_at, capacity FROM slot_pools WHERE id = '${POOL}'`
    )
    expect(pool).toEqual({ usage: null, disabled_at: null, capacity: 2 })
    const [notice] = await connection.unsafe<{ claim_id: string; waiter_id: string | null }[]>(
      `SELECT claim_id, waiter_id FROM slot_notifications WHERE idempotency_key = 'legacy-grant'`
    )
    expect(notice).toEqual({ claim_id: CLAIM, waiter_id: null })
  })

  test('guidance is bounded to 1000 characters', async () => {
    await connection.unsafe(`UPDATE slot_pools SET usage = repeat('x', 1000) WHERE id = '${POOL}'`)
    expect(await sqlError(`UPDATE slot_pools SET usage = repeat('x', 1001) WHERE id = '${POOL}'`)).toMatchObject({
      code: '23514',
    })
  })

  test('pool_disabled notices name a waiter and no claim; other kinds name a claim and no waiter', async () => {
    await connection.unsafe(`
      INSERT INTO slot_notifications (pool_id, waiter_id, recipient_agent_id, kind, idempotency_key)
      VALUES ('${POOL}', '${WAITER}', '${AGENT}', 'pool_disabled', 'disabled-ok')
    `)
    for (const statement of [
      `INSERT INTO slot_notifications (pool_id, recipient_agent_id, kind, idempotency_key)
        VALUES ('${POOL}', '${AGENT}', 'pool_disabled', 'disabled-no-waiter')`,
      `INSERT INTO slot_notifications (pool_id, claim_id, waiter_id, recipient_agent_id, kind, idempotency_key)
        VALUES ('${POOL}', '${CLAIM}', '${WAITER}', '${AGENT}', 'pool_disabled', 'disabled-both')`,
      `INSERT INTO slot_notifications (pool_id, recipient_agent_id, kind, idempotency_key)
        VALUES ('${POOL}', '${AGENT}', 'granted', 'granted-no-claim')`,
      `INSERT INTO slot_notifications (pool_id, claim_id, waiter_id, recipient_agent_id, kind, idempotency_key)
        VALUES ('${POOL}', '${CLAIM}', '${WAITER}', '${AGENT}', 'expired', 'expired-both')`,
    ]) {
      expect(await sqlError(statement)).toMatchObject({ code: '23514' })
    }
  })

  // ON DELETE RESTRICT reports restrict_violation (23001), not 23503.
  test('a waiter referenced by a notice cannot be deleted', async () => {
    await connection.unsafe(`
      INSERT INTO slot_notifications (pool_id, waiter_id, recipient_agent_id, kind, idempotency_key)
      VALUES ('${POOL}', '${WAITER}', '${AGENT}', 'pool_disabled', 'disabled-fk')
    `)
    expect(await sqlError(`DELETE FROM slot_waiters WHERE id = '${WAITER}'`)).toMatchObject({ code: '23001' })
  })
})
