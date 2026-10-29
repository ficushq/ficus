import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'ALTER TABLE "webhook_events" ADD COLUMN "activity_squad_ids"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `webhook_owner_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const squadId = '10000000-0000-4000-8000-000000000011'
const eventId = '20000000-0000-4000-8000-000000000011'
const rowId = '30000000-0000-4000-8000-000000000011'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('webhook Activity owner migration (real runner, isolated database)', () => {
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
      INSERT INTO squads (id,name,purpose) VALUES ('${squadId}','Legacy webhook Activity','test');
      INSERT INTO webhook_events (id,provider,event_type,payload,headers,verified)
      VALUES ('${eventId}','github','pull_request','{}'::jsonb,'{}'::jsonb,true);
      INSERT INTO squad_activity
        (squad_id,lane,row_id,source_family,source_group_id,at,kind,summary,ref,quiet_eligible,access_scope,payload_hash)
      VALUES ('${squadId}',70,'${rowId}','github-pr','hook:${eventId}:${squadId}','2026-08-20','pr',
        'retained webhook PR','{"type":"url","url":"https://github.com/acme/widgets/pull/42"}'::jsonb,
        true,'workstreams',repeat('b',64));
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('defaults legacy owners empty without rewriting ingress or retained projections', async () => {
    const sql = target!.sql.join('\n')
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE)\b/i)
    await applyMigrations(connection, target!)
    expect([
      ...(await connection.unsafe<any[]>(
        `SELECT id,provider,event_type,verified,activity_squad_ids FROM webhook_events WHERE id=$1`,
        [eventId]
      )),
    ]).toEqual([
      { id: eventId, provider: 'github', event_type: 'pull_request', verified: true, activity_squad_ids: [] },
    ])
    expect([
      ...(await connection.unsafe<any[]>(
        `SELECT source_group_id,summary FROM squad_activity WHERE squad_id=$1 AND row_id=$2`,
        [squadId, rowId]
      )),
    ]).toEqual([{ source_group_id: `hook:${eventId}:${squadId}`, summary: 'retained webhook PR' }])
  }, 240_000)
})
