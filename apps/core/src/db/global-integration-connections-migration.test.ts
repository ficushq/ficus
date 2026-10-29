import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "integration_connection_assignments"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `global_integrations_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const squadA = '10000000-0000-4000-8000-000000000001'
const squadB = '10000000-0000-4000-8000-000000000002'
const enabledA = '20000000-0000-4000-8000-000000000001'
const enabledB = '20000000-0000-4000-8000-000000000002'
const disabledA = '20000000-0000-4000-8000-000000000003'
const userId = '30000000-0000-4000-8000-000000000001'
const agentId = '40000000-0000-4000-8000-000000000001'
const consentId = '50000000-0000-4000-8000-000000000001'
const cursorId = '60000000-0000-4000-8000-000000000001'
const batchId = '70000000-0000-4000-8000-000000000001'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('global integration connections migration (real runner, isolated database)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  let connectionBefore: Record<string, unknown>
  let consentBefore: Record<string, unknown>
  let cursorBefore: Record<string, unknown>
  let batchBefore: Record<string, unknown>

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO squads (id,name,purpose) VALUES
        ('${squadA}','Alpha Squad','test'),
        ('${squadB}','Beta Squad','test');
      INSERT INTO users (id,email) VALUES ('${userId}','migration@example.com');
      INSERT INTO agents (id,agent_type_id,squad_id) VALUES ('${agentId}','engineer','${squadA}');
      INSERT INTO integration_connections
        (id,squad_id,provider_key,adapter_version,display_name,configuration,credential_ref,enabled,
         auth_state,health_state,granted_scopes,material_revision,validated_revision,validated_at,
         validation_expires_at,health_checked_at,last_healthy_at,next_validation_at,
         validation_failure_count,last_error_code,created_by_user_id,updated_by_user_id,created_at,updated_at)
      VALUES
        ('${enabledA}','${squadA}','bigbrain',7,'Shared Brain','{"apiBase":"https://a.example"}'::jsonb,
         'secret:a',true,'authenticated','healthy',ARRAY['export'],
         '21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001',
         '2026-08-20','2026-09-20','2026-08-20','2026-08-20','2026-09-01',2,'legacy_code',
         '${userId}','${userId}','2026-08-01','2026-08-20'),
        ('${enabledB}','${squadB}','bigbrain',7,'Shared Brain','{"apiBase":"https://b.example"}'::jsonb,
         'secret:b',true,'authenticated','healthy',ARRAY['export'],
         '21000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000002',
         '2026-08-20','2026-09-20','2026-08-20','2026-08-20','2026-09-01',0,NULL,
         '${userId}','${userId}','2026-08-01','2026-08-20'),
        ('${disabledA}','${squadA}','bigbrain',7,'Disabled Brain','{"apiBase":"https://disabled.example"}'::jsonb,
         'secret:disabled',false,'pending','unknown',ARRAY[]::text[],
         '21000000-0000-4000-8000-000000000003',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,
         '${userId}','${userId}','2026-08-01','2026-08-20');
      INSERT INTO integration_export_consents
        (id,connection_id,agent_id,consented_by_user_id,adopted_enqueue_order)
      VALUES ('${consentId}','${enabledA}','${agentId}','${userId}',42);
      INSERT INTO integration_export_cursors (id,consent_id,last_delivered_enqueue_order)
      VALUES ('${cursorId}','${consentId}',41);
      INSERT INTO integration_export_batches
        (id,cursor_id,first_enqueue_order,last_enqueue_order,record_count,byte_count,encrypted_payload,payload_iv)
      VALUES ('${batchId}','${cursorId}',42,43,2,128,'opaque-ciphertext','opaque-iv');
    `)
    ;[connectionBefore] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_connections WHERE id=$1`,
      [enabledA]
    )
    ;[consentBefore] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_export_consents WHERE id=$1`,
      [consentId]
    )
    ;[cursorBefore] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_export_cursors WHERE id=$1`,
      [cursorId]
    )
    ;[batchBefore] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_export_batches WHERE id=$1`,
      [batchId]
    )
    await applyMigrations(connection, target!)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('preserves each effective connection and assigns only enabled legacy rows', async () => {
    const assignments = await connection.unsafe<{ squad_id: string; provider_key: string; connection_id: string }[]>(
      `SELECT squad_id,provider_key,connection_id FROM integration_connection_assignments ORDER BY squad_id`
    )
    expect([...assignments]).toEqual([
      { squad_id: squadA, provider_key: 'bigbrain', connection_id: enabledA },
      { squad_id: squadB, provider_key: 'bigbrain', connection_id: enabledB },
    ])

    const [connectionAfter] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_connections WHERE id=$1`,
      [enabledA]
    )
    const { display_name: beforeName, ...preservedBefore } = connectionBefore
    const { display_name: afterName, ...preservedAfter } = connectionAfter!
    expect(beforeName).toBe('Shared Brain')
    expect(afterName).toBe('Shared Brain (Alpha Squad 20000000)')
    expect(preservedAfter).toEqual(preservedBefore)

    const names = await connection.unsafe<{ display_name: string }[]>(
      `SELECT display_name FROM integration_connections WHERE id IN ($1,$2) ORDER BY id`,
      [enabledA, enabledB]
    )
    expect(new Set(names.map((row) => row.display_name)).size).toBe(2)
    expect(
      await connection.unsafe(`SELECT 1 FROM integration_connection_assignments WHERE connection_id=$1`, [disabledA])
    ).toHaveLength(0)
  })

  test('preserves consent, cursor, and encrypted batch bytes', async () => {
    const [consentAfter] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_export_consents WHERE id=$1`,
      [consentId]
    )
    const [cursorAfter] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_export_cursors WHERE id=$1`,
      [cursorId]
    )
    const [batchAfter] = await connection.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM integration_export_batches WHERE id=$1`,
      [batchId]
    )
    expect(consentAfter).toEqual(consentBefore)
    expect(cursorAfter).toEqual(cursorBefore)
    expect(batchAfter).toEqual(batchBefore)
  })

  test('origin squad deletion removes its assignment but leaves the global connection', async () => {
    await connection.unsafe(`DELETE FROM squads WHERE id=$1`, [squadB])
    expect(
      await connection.unsafe(`SELECT 1 FROM integration_connection_assignments WHERE squad_id=$1`, [squadB])
    ).toHaveLength(0)
    const [remaining] = await connection.unsafe<{ squad_id: string | null }[]>(
      `SELECT squad_id FROM integration_connections WHERE id=$1`,
      [enabledB]
    )
    expect(remaining).toEqual({ squad_id: null })
  })

  test('installs global uniqueness and provider-safe assignment constraints', async () => {
    const indexes = await connection.unsafe<{ indexname: string }[]>(`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
        ('uq_integration_connections_enabled_provider','uq_integration_connections_provider_display_name',
         'idx_integration_connection_assignments_connection') ORDER BY indexname`)
    expect(indexes.map((row) => row.indexname)).toEqual([
      'idx_integration_connection_assignments_connection',
      'uq_integration_connections_provider_display_name',
    ])
    const constraints = await connection.unsafe<{ conname: string; confdeltype: string }[]>(`
      SELECT conname,confdeltype::text FROM pg_constraint WHERE conname IN
        ('integration_connection_assignments_connection_provider_fk',
         'integration_connections_squad_id_squads_id_fk','integration_audit_events_squad_id_squads_id_fk')
      ORDER BY conname`)
    expect([...constraints]).toEqual([
      { conname: 'integration_audit_events_squad_id_squads_id_fk', confdeltype: 'n' },
      { conname: 'integration_connection_assignments_connection_provider_fk', confdeltype: 'c' },
      { conname: 'integration_connections_squad_id_squads_id_fk', confdeltype: 'n' },
    ])
  })
})
