import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'ADD COLUMN "activity_squad_ids"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `dispatch_owner_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const squadId = '10000000-0000-4000-8000-000000000001'
const activityId = '20000000-0000-4000-8000-000000000001'
const rowId = '30000000-0000-4000-8000-000000000001'
const leaseToken = '40000000-0000-4000-8000-000000000001'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('integration dispatch owner migration (real runner, isolated database)', () => {
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
      INSERT INTO squads (id,name,purpose) VALUES ('${squadId}','Legacy Activity','test');
      INSERT INTO integration_event_polling_dispatches
        (provider_key,event_key,activity_id,event_fact,event_occurred_at,completed_at,lease_token,lease_until)
      VALUES
        ('github','completed','${activityId}', '{"occurredAt":"2026-08-20T00:00:00.000Z"}'::jsonb,
          '2026-08-20','2026-08-20',NULL,NULL),
        ('github','busy',NULL,NULL,NULL,NULL,'${leaseToken}','2099-01-01');
      INSERT INTO squad_activity
        (squad_id,lane,row_id,source_family,source_group_id,at,kind,summary,ref,quiet_eligible,access_scope,payload_hash)
      VALUES
        ('${squadId}',70,'${rowId}','github-pr','${activityId}','2026-08-20','pr','legacy retained PR',
          '{"type":"url","url":"https://github.com/acme/widgets/pull/42"}'::jsonb,true,'workstreams',
          repeat('a',64));
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('adds empty owners without rewriting dispatch state or deleting retained legacy PR rows', async () => {
    await applyMigrations(connection, target!)
    const dispatches = await connection.unsafe<any[]>(`
      SELECT event_key,activity_id,event_fact,lease_token,
             to_char(lease_until,'YYYY-MM-DD') lease_until,
             to_char(completed_at,'YYYY-MM-DD') completed_at,
             activity_squad_ids
      FROM integration_event_polling_dispatches WHERE provider_key='github' ORDER BY event_key`)
    expect([...dispatches]).toEqual([
      {
        event_key: 'busy',
        activity_id: null,
        event_fact: null,
        lease_token: leaseToken,
        lease_until: '2099-01-01',
        completed_at: null,
        activity_squad_ids: [],
      },
      {
        event_key: 'completed',
        activity_id: activityId,
        event_fact: { occurredAt: '2026-08-20T00:00:00.000Z' },
        lease_token: null,
        lease_until: null,
        completed_at: '2026-08-20',
        activity_squad_ids: [],
      },
    ])
    expect([
      ...(await connection.unsafe<any[]>(
        `SELECT source_group_id,summary FROM squad_activity WHERE squad_id=$1 AND lane=70 AND row_id=$2`,
        [squadId, rowId]
      )),
    ]).toEqual([{ source_group_id: activityId, summary: 'legacy retained PR' }])
    const [column] = await connection.unsafe<any[]>(`
      SELECT is_nullable,column_default FROM information_schema.columns
      WHERE table_name='integration_event_polling_dispatches' AND column_name='activity_squad_ids'`)
    expect(column.is_nullable).toBe('NO')
    expect(column.column_default).toContain('ARRAY[]::uuid[]')
  }, 240_000)
})
