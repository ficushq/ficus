import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

// Migration history: this file pins 0194 (the Wave 3 secret-row sweep). The pre-rename key names
// below are the rows that migration exists to remove, so they are its fixtures.
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes('DELETE FROM "secrets" t'))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []

interface SecretRow {
  key: string
  encrypted_value: string
  iv: string
  updated_by: string | null
}

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

async function withMigratedPredecessors(run: (connection: postgres.ReservedSql) => Promise<void>): Promise<void> {
  const dbName = `secret_sweep_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  let connection: postgres.ReservedSql | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await run(connection)
  } finally {
    connection?.release()
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
}

async function insertRow(connection: postgres.ReservedSql, key: string, ciphertext: string): Promise<void> {
  await connection.unsafe('INSERT INTO secrets (key, encrypted_value, iv, updated_by) VALUES ($1, $2, $3, $4)', [
    key,
    ciphertext,
    `iv-${ciphertext}`,
    'admin',
  ])
}

async function selectRows(connection: postgres.ReservedSql): Promise<Map<string, SecretRow>> {
  const rows = await connection.unsafe<SecretRow[]>(
    'SELECT key, encrypted_value, iv, updated_by FROM secrets ORDER BY key'
  )
  return new Map(rows.map((row) => [row.key, { ...row }]))
}

describe('secret-row sweep migration (real runner, isolated database)', () => {
  test('is the migration after the theme-id rewrite', () => {
    expect(target).toBeDefined()
    expect(predecessors.length).toBeGreaterThan(0)
    expect(predecessors.at(-1)!.sql.join('\n')).not.toContain('DELETE FROM "secrets" t')
  })

  test('deletes the four copied rows whose twin exists, renames a custom row, and leaves a differing pair', async () => {
    await withMigratedPredecessors(async (connection) => {
      // The four rows 0190 copied, each beside its FICUS_ twin (one of them differing).
      for (const suffix of ['PASSWORD', 'PUSH_RELAY_TOKEN', 'PLATFORM_INSTANCE_TOKEN']) {
        await insertRow(connection, `TAU_${suffix}`, `old-${suffix}`)
        await insertRow(connection, `FICUS_${suffix}`, `old-${suffix}`)
      }
      await insertRow(connection, 'TAU_PLATFORM_USAGE_TOKEN', 'usage-old')
      await insertRow(connection, 'FICUS_PLATFORM_USAGE_TOKEN', 'usage-rotated')
      // A custom row nobody re-saved: renamed in place, ciphertext and IV unchanged.
      await insertRow(connection, 'TAU_X', 'custom-x')
      // A custom pair whose values differ: left for its owner.
      await insertRow(connection, 'TAU_DIFFER', 'differ-old')
      await insertRow(connection, 'FICUS_DIFFER', 'differ-new')
      // Unrelated rows, including a key that only contains the letters.
      await insertRow(connection, 'OPENAI_API_KEY', 'unrelated')
      await insertRow(connection, 'TAUX_KEEP', 'not-a-prefix')
      const before = await selectRows(connection)

      await applyMigrations(connection, [...predecessors, target!])
      // Statement-level idempotence, even if the ledger were bypassed.
      for (const statement of target!.sql) await connection.unsafe(statement)

      const after = await selectRows(connection)
      for (const suffix of ['PASSWORD', 'PUSH_RELAY_TOKEN', 'PLATFORM_INSTANCE_TOKEN', 'PLATFORM_USAGE_TOKEN']) {
        expect(after.has(`TAU_${suffix}`), suffix).toBe(false)
        expect(after.get(`FICUS_${suffix}`), suffix).toEqual(before.get(`FICUS_${suffix}`))
      }
      expect(after.has('TAU_X')).toBe(false)
      expect(after.get('FICUS_X')).toEqual({ ...before.get('TAU_X')!, key: 'FICUS_X' })
      expect(after.get('TAU_DIFFER')).toEqual(before.get('TAU_DIFFER'))
      expect(after.get('FICUS_DIFFER')).toEqual(before.get('FICUS_DIFFER'))
      expect(after.get('OPENAI_API_KEY')).toEqual(before.get('OPENAI_API_KEY'))
      expect(after.get('TAUX_KEEP')).toEqual(before.get('TAUX_KEEP'))
    })
  })

  test('keeps a copied row whose twin is missing, and renames it like a custom row', async () => {
    await withMigratedPredecessors(async (connection) => {
      await insertRow(connection, 'TAU_PUSH_RELAY_TOKEN', 'relay')
      const before = await selectRows(connection)
      await applyMigrations(connection, [...predecessors, target!])
      const after = await selectRows(connection)
      expect(after.has('TAU_PUSH_RELAY_TOKEN')).toBe(false)
      expect(after.get('FICUS_PUSH_RELAY_TOKEN')).toEqual({
        ...before.get('TAU_PUSH_RELAY_TOKEN')!,
        key: 'FICUS_PUSH_RELAY_TOKEN',
      })
    })
  })
})
