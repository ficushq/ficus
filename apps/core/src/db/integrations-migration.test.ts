import '../test-utils/require-test-db'
import { expect, test } from 'bun:test'
import { join } from 'path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { createPostgresConnection } from './connection'
import { applyMigrations } from './migrator'
import { MONOREPO_ROOT } from '../lib/paths'

test('checked-in integration migration upgrades a fresh prior schema with critical indexes', async () => {
  const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
  const migration0165 = migrations.find((migration) =>
    migration.sql.join('\n').includes('ALTER TABLE "integration_connections" ADD COLUMN "client_authority"')
  )
  expect(migration0165).toBeDefined()
  const predecessors = migrations.filter((migration) => migration.folderMillis < migration0165!.folderMillis)
  const source = new URL(process.env.DATABASE_URL!)
  const databaseName = `tau_integration_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
  source.pathname = `/${databaseName}`
  const target = createPostgresConnection(source.toString(), { max: 1 })
  try {
    const connection = await target.reserve()
    try {
      await applyMigrations(connection, predecessors)
      const legacyConnectionId = '10000000-0000-4000-8000-000000000165'
      const legacyRevocationId = '20000000-0000-4000-8000-000000000165'
      const legacyCredentialRef = '__integration-credential:0165-legacy'
      await connection.unsafe(
        `INSERT INTO secrets (key, encrypted_value, iv, updated_by) VALUES ($1, 'ciphertext', 'iv', 'migration-test')`,
        [legacyCredentialRef]
      )
      await connection.unsafe(
        `INSERT INTO integration_connections (id, provider_key, adapter_version, display_name, configuration, credential_ref) VALUES ($1, 'bigbrain', 1, 'Legacy local connection', '{}'::jsonb, $2)`,
        [legacyConnectionId, legacyCredentialRef]
      )
      await connection.unsafe(
        `INSERT INTO integration_revocation_jobs (id, provider_key, adapter_version, credential_ref) VALUES ($1, 'bigbrain', 1, $2)`,
        [legacyRevocationId, legacyCredentialRef]
      )
      await applyMigrations(connection, [migration0165!])
      const legacyAuthorities = await connection<
        { kind: string; clientAuthority: string; authorizationFlowId: string | null }[]
      >`
        SELECT 'connection' AS kind, client_authority AS "clientAuthority", authorization_flow_id AS "authorizationFlowId"
        FROM integration_connections WHERE id = ${legacyConnectionId}
        UNION ALL
        SELECT 'revocation' AS kind, client_authority AS "clientAuthority", authorization_flow_id AS "authorizationFlowId"
        FROM integration_revocation_jobs WHERE id = ${legacyRevocationId}
        ORDER BY kind
      `
      expect([...legacyAuthorities]).toEqual([
        { kind: 'connection', clientAuthority: 'local', authorizationFlowId: null },
        { kind: 'revocation', clientAuthority: 'local', authorizationFlowId: null },
      ])
      const indexes = await connection<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'uq_integration_connections_provider_display_name',
          'idx_integration_connection_assignments_connection',
          'uq_integration_export_batches_cursor_first_order',
          'uq_integration_export_consents_active_agent',
          'uq_integration_connections_authorization_flow',
          'uq_integration_oauth_states_local_flow'
        )
      `
      expect(indexes.map((row) => row.indexname).sort()).toEqual([
        'idx_integration_connection_assignments_connection',
        'uq_integration_connections_authorization_flow',
        'uq_integration_connections_provider_display_name',
        'uq_integration_export_batches_cursor_first_order',
        'uq_integration_export_consents_active_agent',
        'uq_integration_oauth_states_local_flow',
      ])
      expect(
        indexes.find((row) => row.indexname === 'uq_integration_connections_provider_display_name')?.indexdef
      ).toContain('(provider_key, display_name)')
      const [column] = await connection<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_types' AND column_name = 'integration_capabilities'
      `
      expect(column?.column_name).toBe('integration_capabilities')

      const authorityColumns = await connection<
        {
          table_name: string
          column_name: string
          data_type: string
          is_nullable: string
          column_default: string | null
        }[]
      >`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('integration_connections', 'authorization_flow_id'),
            ('integration_connections', 'client_authority'),
            ('integration_oauth_states', 'authority'),
            ('integration_oauth_states', 'completion_handle_hash'),
            ('integration_oauth_states', 'local_flow_id'),
            ('integration_oauth_states', 'recovery_expires_at'),
            ('integration_revocation_jobs', 'client_authority'),
            ('integration_revocation_jobs', 'terminal_at')
          )
        ORDER BY table_name, column_name
      `
      expect([...authorityColumns]).toEqual([
        expect.objectContaining({
          table_name: 'integration_connections',
          column_name: 'authorization_flow_id',
          data_type: 'uuid',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          table_name: 'integration_connections',
          column_name: 'client_authority',
          is_nullable: 'NO',
          column_default: "'local'::character varying",
        }),
        expect.objectContaining({
          table_name: 'integration_oauth_states',
          column_name: 'authority',
          is_nullable: 'NO',
          column_default: "'local'::character varying",
        }),
        expect.objectContaining({
          table_name: 'integration_oauth_states',
          column_name: 'completion_handle_hash',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          table_name: 'integration_oauth_states',
          column_name: 'local_flow_id',
          data_type: 'uuid',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          table_name: 'integration_oauth_states',
          column_name: 'recovery_expires_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          table_name: 'integration_revocation_jobs',
          column_name: 'client_authority',
          is_nullable: 'NO',
          column_default: "'local'::character varying",
        }),
        expect.objectContaining({
          table_name: 'integration_revocation_jobs',
          column_name: 'terminal_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
        }),
      ])

      const authorityChecks = await connection<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conname IN (
          'integration_connections_client_authority_check',
          'integration_oauth_states_authority_check',
          'integration_oauth_states_authority_flow_check',
          'integration_oauth_states_completion_claim_pair',
          'integration_oauth_states_completion_hash_format',
          'integration_revocation_jobs_client_authority_check'
        )
        ORDER BY conname
      `
      expect(authorityChecks.map((row) => row.conname)).toEqual([
        'integration_connections_client_authority_check',
        'integration_oauth_states_authority_check',
        'integration_oauth_states_authority_flow_check',
        'integration_oauth_states_completion_claim_pair',
        'integration_oauth_states_completion_hash_format',
        'integration_revocation_jobs_client_authority_check',
      ])

      const receiptColumns = await connection<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND (
          (table_name = 'integration_authorization_flow_receipts' AND column_name IN (
            'local_flow_id', 'artifact_credential_ref', 'completion_handle_hash', 'adapter_version',
            'install_kind', 'installed_connection_id', 'revocation_required_at', 'cleanup_required_at',
            'recovery_expires_at', 'retain_until'
          )) OR
          (table_name = 'integration_revocation_jobs' AND column_name = 'authorization_flow_id') OR
          (table_name = 'integration_credential_cleanup_jobs' AND column_name = 'authorization_flow_id')
        )
      `
      expect(receiptColumns).toHaveLength(12)
      const receiptChecks = await connection<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conname IN (
          'integration_auth_receipts_authority_check',
          'integration_auth_receipts_artifact_ref_binding',
          'integration_auth_receipts_intent_context',
          'integration_auth_receipts_handle_hash_format',
          'integration_auth_receipts_adapter_version_positive',
          'integration_auth_receipts_install_tuple',
          'integration_auth_receipts_staging_tuple',
          'integration_auth_receipts_revocation_settlement',
          'integration_auth_receipts_cleanup_settlement',
          'integration_auth_receipts_terminal_code_format',
          'integration_auth_receipts_retention_window',
          'integration_auth_receipts_install_terminal_exclusive',
          'integration_auth_receipts_obligation_disposition',
          'integration_auth_receipts_installed_undisposed'
        )
        ORDER BY conname
      `
      expect(receiptChecks.map((row) => row.conname)).toEqual([
        'integration_auth_receipts_adapter_version_positive',
        'integration_auth_receipts_artifact_ref_binding',
        'integration_auth_receipts_authority_check',
        'integration_auth_receipts_cleanup_settlement',
        'integration_auth_receipts_handle_hash_format',
        'integration_auth_receipts_install_terminal_exclusive',
        'integration_auth_receipts_install_tuple',
        'integration_auth_receipts_intent_context',
        'integration_auth_receipts_obligation_disposition',
        'integration_auth_receipts_retention_window',
        'integration_auth_receipts_revocation_settlement',
        'integration_auth_receipts_staging_tuple',
        'integration_auth_receipts_terminal_code_format',
      ])
      const receiptIndexes = await connection<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'idx_integration_auth_receipts_recovery',
          'idx_integration_auth_receipts_revocation',
          'idx_integration_auth_receipts_cleanup',
          'idx_integration_auth_receipts_retention',
          'idx_integration_revocation_jobs_flow',
          'idx_integration_credential_cleanup_flow'
        )
      `
      expect(receiptIndexes).toHaveLength(6)
      const receiptForeignKeys = await connection<{ confdeltype: string }[]>`
        SELECT confdeltype FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('integration_revocation_jobs'::regclass, 'integration_credential_cleanup_jobs'::regclass)
          AND confrelid = 'integration_authorization_flow_receipts'::regclass
      `
      expect([...receiptForeignKeys]).toEqual([{ confdeltype: 'r' }, { confdeltype: 'r' }])
      const credentialForeignKeys = await connection<
        {
          conname: string
          table_name: string
          referenced_table: string
          confdeltype: string
          columns: string[]
          referenced_columns: string[]
        }[]
      >`
        SELECT
          c.conname,
          c.conrelid::regclass::text AS table_name,
          c.confrelid::regclass::text AS referenced_table,
          c.confdeltype,
          ARRAY(
            SELECT a.attname
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            ORDER BY k.ord
          ) AS columns,
          ARRAY(
            SELECT a.attname
            FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
            ORDER BY k.ord
          ) AS referenced_columns
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conname IN (
            'integration_credential_cleanup_jobs_credential_ref_secrets_key_fk',
            'integration_revocation_jobs_credential_ref_secrets_key_fk'
          )
        ORDER BY c.conname
      `
      expect([...credentialForeignKeys]).toEqual([
        {
          conname: 'integration_credential_cleanup_jobs_credential_ref_secrets_key_',
          table_name: 'integration_credential_cleanup_jobs',
          referenced_table: 'secrets',
          confdeltype: 'r',
          columns: ['credential_ref'],
          referenced_columns: ['key'],
        },
        {
          conname: 'integration_revocation_jobs_credential_ref_secrets_key_fk',
          table_name: 'integration_revocation_jobs',
          referenced_table: 'secrets',
          confdeltype: 'r',
          columns: ['credential_ref'],
          referenced_columns: ['key'],
        },
      ])
    } finally {
      connection.release()
      await target.end()
    }
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.end()
  }
})
