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

  test('renames exposures of swept rows, drops duplicates, and orphans nothing', async () => {
    await withMigratedPredecessors(async (connection) => {
      const [first] = await connection.unsafe<{ id: string }[]>(
        "INSERT INTO squads (name, purpose) VALUES ('one', 'p') RETURNING id"
      )
      const [second] = await connection.unsafe<{ id: string }[]>(
        "INSERT INTO squads (name, purpose) VALUES ('two', 'p') RETURNING id"
      )
      await insertRow(connection, 'TAU_X', 'custom-x')
      await insertRow(connection, 'TAU_PASSWORD', 'pw')
      await insertRow(connection, 'FICUS_PASSWORD', 'pw')
      await insertRow(connection, 'TAU_DIFFER', 'differ-old')
      await insertRow(connection, 'FICUS_DIFFER', 'differ-new')
      const exposeSquad = (squadId: string, key: string) =>
        connection.unsafe('INSERT INTO squad_secret_exposures (squad_id, secret_key) VALUES ($1, $2)', [squadId, key])
      const exposeGlobal = (key: string) =>
        connection.unsafe('INSERT INTO global_secret_exposures (secret_key) VALUES ($1)', [key])
      // Squad one exposes the custom key under the old name only; squad two already exposes both names.
      await exposeSquad(first.id, 'TAU_X')
      await exposeSquad(second.id, 'TAU_X')
      await exposeSquad(second.id, 'FICUS_X')
      await exposeSquad(first.id, 'TAU_PASSWORD')
      await exposeSquad(first.id, 'TAU_DIFFER')
      await exposeSquad(first.id, 'TAU_NEVER_SET')
      await exposeSquad(first.id, 'TAUX_KEEP')
      await exposeGlobal('TAU_X')
      await exposeGlobal('TAU_PASSWORD')
      await exposeGlobal('FICUS_PASSWORD')
      await exposeGlobal('TAU_DIFFER')

      await applyMigrations(connection, [...predecessors, target!])
      for (const statement of target!.sql) await connection.unsafe(statement)

      const squadRows = await connection.unsafe<{ squad_id: string; secret_key: string }[]>(
        'SELECT squad_id, secret_key FROM squad_secret_exposures ORDER BY secret_key'
      )
      const exposed = (squadId: string) =>
        squadRows
          .filter((row) => row.squad_id === squadId)
          .map((row) => row.secret_key)
          .sort()
      expect(exposed(first.id)).toEqual(['FICUS_NEVER_SET', 'FICUS_PASSWORD', 'FICUS_X', 'TAUX_KEEP', 'TAU_DIFFER'])
      expect(exposed(second.id)).toEqual(['FICUS_X'])
      const globalRows = await connection.unsafe<{ secret_key: string }[]>(
        'SELECT secret_key FROM global_secret_exposures ORDER BY secret_key'
      )
      expect(globalRows.map((row) => row.secret_key).sort()).toEqual(['FICUS_PASSWORD', 'FICUS_X', 'TAU_DIFFER'])

      // No exposure names a key the sweep removed.
      const orphans = await connection.unsafe<{ secret_key: string }[]>(
        `SELECT secret_key FROM squad_secret_exposures e WHERE e.secret_key LIKE 'TAU\\_%' ESCAPE '\\'
           AND NOT EXISTS (SELECT 1 FROM secrets s WHERE s.key = e.secret_key)
         UNION ALL
         SELECT secret_key FROM global_secret_exposures e WHERE e.secret_key LIKE 'TAU\\_%' ESCAPE '\\'
           AND NOT EXISTS (SELECT 1 FROM secrets s WHERE s.key = e.secret_key)`
      )
      expect(orphans.map((row) => row.secret_key)).toEqual([])
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
