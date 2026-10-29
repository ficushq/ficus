import '../test-utils/require-test-db'
import { expect, test } from 'bun:test'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'

test('canonical migration drops all exposure rows, preserves encrypted operator values, and creates durable retry status', async () => {
  const target = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).find((m) =>
    m.sql.join('\n').includes('CREATE TABLE "sandbox_exposure_cleanup"')
  )
  expect(target).toBeDefined()
  const client = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
  const schema = `exposure_migration_${crypto.randomUUID().replaceAll('-', '')}`
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA "${schema}"`)
      await tx.unsafe(`SET LOCAL search_path TO "${schema}"`)
      await tx.unsafe('CREATE TABLE secrets (key text PRIMARY KEY, encrypted_value text NOT NULL, iv text NOT NULL)')
      await tx.unsafe("INSERT INTO secrets VALUES ('SYNTH_OPERATOR_TOKEN', 'synthetic-ciphertext', 'synthetic-iv')")
      for (const table of ['agent_secret_exposures', 'global_secret_exposures', 'squad_secret_exposures']) {
        await tx.unsafe(`CREATE TABLE "${table}" (secret_key text)`)
        await tx.unsafe(`INSERT INTO "${table}" VALUES ('SYNTH_OPERATOR_TOKEN')`)
      }
      for (const statement of target!.sql) await tx.unsafe(statement)
      const rows = await tx.unsafe<{ key: string; encrypted_value: string; iv: string }[]>(
        'SELECT key, encrypted_value, iv FROM secrets'
      )
      expect([...rows]).toEqual([
        { key: 'SYNTH_OPERATOR_TOKEN', encrypted_value: 'synthetic-ciphertext', iv: 'synthetic-iv' },
      ])
      const tables = await tx.unsafe('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [
        schema,
      ])
      expect(tables.map((r) => r.table_name).sort()).toEqual(['sandbox_exposure_cleanup', 'secrets'])
      await tx.unsafe(
        "INSERT INTO sandbox_exposure_cleanup (target_id, kind, source_id) VALUES ('private:synthetic', 'private', 'synthetic')"
      )
      const [status] = await tx.unsafe<{ status: string; reason: string | null; retry: boolean }[]>(
        'SELECT status, reason, next_attempt_at IS NOT NULL AS retry FROM sandbox_exposure_cleanup'
      )
      expect(status).toEqual({ status: 'pending', reason: null, retry: true })
      await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
    })
  } finally {
    await client.end()
  }
})
