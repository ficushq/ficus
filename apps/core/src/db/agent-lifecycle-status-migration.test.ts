import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'Backfill final agent lifecycle status'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `agent_lifecycle_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('agent lifecycle status migration', () => {
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
      INSERT INTO agents (id, agent_type_id, status, terminated_at, metadata)
      VALUES
        ('10000000-0000-4000-8000-000000000001', 'engineer', 'idle', now(), '{"kept":"one"}'),
        ('10000000-0000-4000-8000-000000000002', 'engineer', 'active', null, '{"kept":"two"}'),
        ('10000000-0000-4000-8000-000000000003', 'engineer', 'waiting-input', null, '{"kept":"three"}');

      INSERT INTO executions (id, agent_id, status)
      VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'queued');
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('backfills only rows with terminated_at and never creates dormant rows', async () => {
    await applyMigrations(connection, target!)
    const rows = await connection.unsafe<
      { id: string; status: string; dormant_at: Date | null; metadata: Record<string, unknown> | null }[]
    >(`SELECT id, status, dormant_at, metadata FROM agents ORDER BY id`)
    expect(rows.map(({ status }) => status)).toEqual(['terminated', 'active', 'waiting-input'])
    expect(rows.every(({ dormant_at }) => dormant_at === null)).toBe(true)
    expect(rows[0]?.metadata).toMatchObject({ kept: 'one', finalCleanupPending: true })
    expect(rows[1]?.metadata).toEqual({ kept: 'two' })
    expect(rows[2]?.metadata).toEqual({ kept: 'three' })

    const enumLabels = await connection.unsafe<{ enumlabel: string }[]>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'agent_status'
      ORDER BY enumsortorder
    `)
    expect(enumLabels.map(({ enumlabel }) => enumlabel)).toEqual([
      'idle',
      'active',
      'waiting-input',
      'compacting',
      'resetting',
      'dormant',
      'terminated',
    ])

    const executions = await connection.unsafe<{ wake_eligible: boolean }[]>(`
      SELECT wake_eligible FROM executions WHERE id = '20000000-0000-4000-8000-000000000001'
    `)
    expect(executions.map(({ wake_eligible }) => wake_eligible)).toEqual([true])

    await connection.unsafe(`
      UPDATE agents
      SET status = 'dormant', dormant_at = now()
      WHERE id = '10000000-0000-4000-8000-000000000002'
    `)
    const dormant = await connection.unsafe<{ status: string; dormant_at: Date | null }[]>(`
      SELECT status, dormant_at FROM agents WHERE id = '10000000-0000-4000-8000-000000000002'
    `)
    expect(dormant[0]?.status).toBe('dormant')
    expect(dormant[0]?.dormant_at).toBeInstanceOf(Date)
  })
})
