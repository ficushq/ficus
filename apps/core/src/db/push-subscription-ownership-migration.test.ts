import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'idx_push_subscriptions_endpoint_unique'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `push_ownership_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const ownerA = '10000000-0000-4000-8000-000000000001'
const ownerB = '20000000-0000-4000-8000-000000000002'
const sameWinner = '30000000-0000-4000-8000-000000000003'
const soloId = '30000000-0000-4000-8000-000000000006'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

type SubscriptionRow = {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  user_id: string
  created_at: string
}

async function rowsFor(connection: postgres.ReservedSql, endpoint: string): Promise<SubscriptionRow[]> {
  return connection.unsafe<SubscriptionRow[]>(
    `SELECT id, endpoint, p256dh, auth, user_agent, user_id,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM push_subscriptions
      WHERE endpoint = $1
      ORDER BY id`,
    [endpoint]
  )
}

describe('push subscription ownership migration (real runner, isolated database)', () => {
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
      INSERT INTO users (id, email) VALUES
        ('${ownerA}', 'owner-a@example.test'),
        ('${ownerB}', 'owner-b@example.test');
      INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, user_id, created_at) VALUES
        ('30000000-0000-4000-8000-000000000001', 'https://push.test/same',  'old',   'old',   'old-agent', '${ownerA}', '2026-01-01'),
        ('30000000-0000-4000-8000-000000000002', 'https://push.test/same',  'new-a', 'new-a', 'agent-a',   '${ownerA}', '2026-01-02'),
        ('${sameWinner}',                         'https://push.test/same',  'new-b', 'new-b', 'agent-b',   '${ownerA}', '2026-01-02'),
        ('30000000-0000-4000-8000-000000000004', 'https://push.test/cross', 'a',     'a',     NULL,        '${ownerA}', '2026-01-01'),
        ('30000000-0000-4000-8000-000000000005', 'https://push.test/cross', 'b',     'b',     NULL,        '${ownerB}', '2026-01-03'),
        ('${soloId}',                             'https://push.test/solo',  'solo',  'solo',  'unchanged', '${ownerA}', '2026-01-01');
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('locks writes and reconciles legacy duplicates before enforcing exact endpoint uniqueness', async () => {
    const sql = target!.sql.join('\n')
    expect(sql).toContain('LOCK TABLE "push_subscriptions" IN SHARE ROW EXCLUSIVE MODE')

    await applyMigrations(connection, target!)

    expect(await rowsFor(connection, 'https://push.test/same')).toEqual([
      {
        id: sameWinner,
        endpoint: 'https://push.test/same',
        p256dh: 'new-b',
        auth: 'new-b',
        user_agent: 'agent-b',
        user_id: ownerA,
        created_at: '2026-01-02 00:00:00',
      },
    ])
    expect(await rowsFor(connection, 'https://push.test/cross')).toEqual([])
    expect(await rowsFor(connection, 'https://push.test/solo')).toEqual([
      {
        id: soloId,
        endpoint: 'https://push.test/solo',
        p256dh: 'solo',
        auth: 'solo',
        user_agent: 'unchanged',
        user_id: ownerA,
        created_at: '2026-01-01 00:00:00',
      },
    ])

    await connection.unsafe(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id)
       VALUES ('https://push.test/distinct', 'new', 'new', $1)`,
      [ownerB]
    )
    const duplicateClient = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    let duplicateError: unknown
    try {
      await duplicateClient.unsafe(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id)
         VALUES ('https://push.test/solo', 'duplicate', 'duplicate', $1)`,
        [ownerB]
      )
    } catch (error) {
      duplicateError = error
    } finally {
      await duplicateClient.end()
    }
    expect(duplicateError).toMatchObject({ code: '23505' })
  }, 240_000)
})
