import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "integration_oauth_states"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `manifest_notion_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const userId = '10000000-0000-4000-8000-000000000001'
const squadId = '20000000-0000-4000-8000-000000000001'
const connectionId = '30000000-0000-4000-8000-000000000001'
const agentId = '40000000-0000-4000-8000-000000000001'
const consentId = '50000000-0000-4000-8000-000000000001'
const materialRevision = '60000000-0000-4000-8000-000000000001'
const leaseToken = '70000000-0000-4000-8000-000000000001'
const credentialRef = '__integration-credential:migration-fixture'
const stateHash = 'a'.repeat(64)

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('manifest and Notion lifecycle migration (real runner, isolated database)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  let connectionBefore: Record<string, unknown>
  let assignmentBefore: Record<string, unknown>
  let consentBefore: Record<string, unknown>

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO users (id,email) VALUES ('${userId}','manifest-migration@example.com');
      INSERT INTO squads (id,name,purpose) VALUES ('${squadId}','Manifest Migration','test');
      INSERT INTO agents (id,agent_type_id,squad_id) VALUES ('${agentId}','engineer','${squadId}');
      INSERT INTO secrets (key,encrypted_value,iv,updated_by)
      VALUES ('${credentialRef}','opaque-ciphertext','opaque-iv','migration');
      INSERT INTO integration_connections
        (id,provider_key,adapter_version,display_name,configuration,credential_ref,enabled,auth_state,
         health_state,granted_scopes,material_revision,validated_revision,created_by_user_id,updated_by_user_id)
      VALUES
        ('${connectionId}','bigbrain',1,'Migration Brain','{"version":1,"apiBase":"https://brain.example"}'::jsonb,
         '${credentialRef}',true,'authenticated','healthy',ARRAY['inbox:write'],'${materialRevision}',
         '${materialRevision}','${userId}','${userId}');
      INSERT INTO integration_connection_assignments (squad_id,provider_key,connection_id)
      VALUES ('${squadId}','bigbrain','${connectionId}');
      INSERT INTO integration_export_consents
        (id,connection_id,agent_id,consented_by_user_id,adopted_enqueue_order)
      VALUES ('${consentId}','${connectionId}','${agentId}','${userId}',7);
    `)
    ;[connectionBefore] = await connection.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM integration_connections WHERE id=$1',
      [connectionId]
    )
    ;[assignmentBefore] = await connection.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM integration_connection_assignments WHERE connection_id=$1',
      [connectionId]
    )
    ;[consentBefore] = await connection.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM integration_export_consents WHERE id=$1',
      [consentId]
    )
    await applyMigrations(connection, target!)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('preserves Bigbrain connection, assignment, and export consent bytes', async () => {
    const [connectionAfter] = await connection.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM integration_connections WHERE id=$1',
      [connectionId]
    )
    const [assignmentAfter] = await connection.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM integration_connection_assignments WHERE connection_id=$1',
      [connectionId]
    )
    const [consentAfter] = await connection.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM integration_export_consents WHERE id=$1',
      [consentId]
    )
    expect(connectionAfter).toEqual(connectionBefore)
    expect(assignmentAfter).toEqual(assignmentBefore)
    expect(consentAfter).toEqual(consentBefore)
  })

  test('consumes a hashed OAuth state and enforces server-owned reconnect context', async () => {
    await connection.unsafe(
      `INSERT INTO integration_oauth_states
       (state_hash,provider_key,user_id,intent,connection_id,expected_material_revision,redirect_uri,return_to,expires_at)
       VALUES ($1,'bigbrain',$2,'reconnect',$3,$4,'https://tau.example/settings/integrations/oauth/callback',
               '/settings/integrations',now()+interval '10 minutes')`,
      [stateHash, userId, connectionId, materialRevision]
    )
    const consumed = await connection.unsafe<{ state_hash: string }[]>(
      'DELETE FROM integration_oauth_states WHERE state_hash=$1 AND user_id=$2 RETURNING state_hash',
      [stateHash, userId]
    )
    expect([...consumed]).toEqual([{ state_hash: stateHash }])
    expect(
      await connection.unsafe('SELECT 1 FROM integration_oauth_states WHERE state_hash=$1', [stateHash])
    ).toHaveLength(0)
    const checks = await connection.unsafe<{ conname: string }[]>(`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('integration_oauth_states_hash_format','integration_oauth_states_intent_context')
      ORDER BY conname
    `)
    expect(checks.map((row) => row.conname)).toEqual([
      'integration_oauth_states_hash_format',
      'integration_oauth_states_intent_context',
    ])
  })

  test('enforces projection and revocation lease pairs and revoke-before-cleanup retention', async () => {
    await connection.unsafe(
      `INSERT INTO integration_projection_states
       (squad_id,provider_key,generation,status,desired_fingerprint,desired_credential_revision,lease_token,lease_expires_at)
       VALUES ($1,'bigbrain',2,'installing',$2,3,$3,now()+interval '1 minute')`,
      [squadId, 'f'.repeat(64), leaseToken]
    )

    await connection.unsafe(
      `INSERT INTO integration_revocation_jobs (provider_key,adapter_version,credential_ref)
       VALUES ('bigbrain',1,$1)`,
      [credentialRef]
    )
    const constraints = await connection.unsafe<{ conname: string; confdeltype: string }[]>(`
      SELECT conname,confdeltype::text FROM pg_constraint
      WHERE conname IN ('integration_projection_states_lease_pair',
                        'integration_revocation_jobs_lease_pair',
                        'integration_revocation_jobs_credential_ref_secrets_key_fk')
      ORDER BY conname
    `)
    expect([...constraints]).toEqual([
      { conname: 'integration_projection_states_lease_pair', confdeltype: ' ' },
      { conname: 'integration_revocation_jobs_credential_ref_secrets_key_fk', confdeltype: 'r' },
      { conname: 'integration_revocation_jobs_lease_pair', confdeltype: ' ' },
    ])
    expect(
      await connection.unsafe('SELECT 1 FROM integration_revocation_jobs WHERE credential_ref=$1', [credentialRef])
    ).toHaveLength(1)
    expect(await connection.unsafe('SELECT 1 FROM secrets WHERE key=$1', [credentialRef])).toHaveLength(1)
  })

  test('adds no plaintext OAuth or provider-error columns', async () => {
    const columns = await connection.unsafe<{ table_name: string; column_name: string }[]>(`
      SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN
        ('integration_oauth_states','integration_projection_states','integration_revocation_jobs')
      ORDER BY table_name,column_name
    `)
    const names = columns.map((column) => column.column_name)
    expect(names).toContain('state_hash')
    expect(names).toContain('credential_ref')
    expect(
      names.some((name) => /(^|_)(access_token|refresh_token|client_secret|provider_body|plaintext)($|_)/.test(name))
    ).toBe(false)
  })
})
