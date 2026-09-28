import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "theme_presets"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `theme_presets_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const userId = '50000000-0000-4000-8000-000000000002'
const document = {
  format: 'ficus-custom-theme',
  version: 2,
  name: 'Mine',
  base: 'harbor',
  variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
}

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('theme presets migration (real runner, isolated database)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('creates an empty table, defaults visibility to private and revision to 1, and cascades on user deletion', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(
      `INSERT INTO users (id, email) VALUES ('${userId}', 'theme-presets-migration@example.test')`
    )
    await applyMigrations(connection, [...predecessors, target!])
    await applyMigrations(connection, [...predecessors, target!])
    expect(await connection.unsafe('SELECT * FROM theme_presets')).toHaveLength(0)

    await connection.unsafe('INSERT INTO theme_presets (owner_user_id, document) VALUES ($1, $2::text::jsonb)', [
      userId,
      JSON.stringify(document),
    ])
    const [row] = await connection.unsafe('SELECT * FROM theme_presets')
    expect(row.document).toEqual(document)
    expect(row.visibility).toBe('private')
    expect(row.revision).toBe(1)
    expect(row.created_at).toBeInstanceOf(Date)
    expect(row.updated_at).toBeInstanceOf(Date)

    await connection.unsafe('DELETE FROM users WHERE id = $1', [userId])
    expect(await connection.unsafe('SELECT * FROM theme_presets')).toHaveLength(0)
  })
})

test('the complete generated chain installs on an empty database', async () => {
  const freshName = `theme_presets_fresh_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  let connection: postgres.ReservedSql | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${freshName}"`)
    client = createPostgresConnection(urlFor(freshName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, migrations)
    await applyMigrations(connection, migrations)
    expect(await connection.unsafe('SELECT * FROM theme_presets')).toHaveLength(0)
    const [column] = await connection.unsafe(`SELECT column_default FROM information_schema.columns
      WHERE table_name = 'theme_presets' AND column_name = 'revision'`)
    expect(column.column_default).toBe('1')
  } finally {
    connection?.release()
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${freshName}" WITH (FORCE)`)
    await admin.end()
  }
})
