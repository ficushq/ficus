import type { StorageWarning } from '@ficus/shared'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "user_preferences"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `theme_prefs_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const userId = '50000000-0000-4000-8000-000000000001'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('account theme migration (real runner, isolated database)', () => {
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

  test('preserves users, stores a preference document atomically, is idempotent and cascades deletes', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`INSERT INTO users (id, email) VALUES ('${userId}', 'theme-migration@example.test')`)
    await connection.unsafe("INSERT INTO storage_monitor (id, error) VALUES ('retained', 'historical reading')")
    await connection.unsafe(
      `INSERT INTO desktop_notifications (user_id, event_key, event_type, category, title, body, url)
       VALUES ($1, 'historical', 'test', 'test', 'Retained notification', 'Existing body', '/')`,
      [userId]
    )
    await applyMigrations(connection, [...predecessors, target!])
    await applyMigrations(connection, [...predecessors, target!])
    const [monitor] = await connection.unsafe<
      {
        id: string
        error: string | null
        levels: Record<string, StorageWarning>
        pending_alerts: Array<{ id: string; warning: StorageWarning }>
      }[]
    >('SELECT id, error, levels, pending_alerts FROM storage_monitor')
    expect(monitor).toEqual({ id: 'retained', error: 'historical reading', levels: {}, pending_alerts: [] })
    const [notification] = await connection.unsafe<{ title: string; created_at: Date }[]>(
      'SELECT title, created_at FROM desktop_notifications'
    )
    expect(notification.title).toBe('Retained notification')
    expect(notification.created_at).toBeInstanceOf(Date)
    expect(await connection.unsafe('SELECT * FROM user_preferences')).toHaveLength(0)
    expect(await connection.unsafe('SELECT id FROM users')).toHaveLength(1)
    const theme = { themeId: 'harbor', appearance: 'system', customTheme: null }
    await connection.unsafe('INSERT INTO user_preferences (user_id, theme) VALUES ($1, $2::text::jsonb)', [
      userId,
      JSON.stringify(theme),
    ])
    const [row] = await connection.unsafe('SELECT * FROM user_preferences')
    expect(row.theme).toEqual(theme)
    expect(row.updated_at).toBeInstanceOf(Date)
    await connection.unsafe('DELETE FROM users WHERE id = $1', [userId])
    expect(await connection.unsafe('SELECT * FROM user_preferences')).toHaveLength(0)
  })
})

test('the complete generated chain installs on an empty database', async () => {
  const freshName = `theme_fresh_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  let connection: postgres.ReservedSql | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${freshName}"`)
    client = createPostgresConnection(urlFor(freshName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, migrations)
    await applyMigrations(connection, migrations)
    expect(await connection.unsafe('SELECT * FROM user_preferences')).toHaveLength(0)
    const [column] = await connection.unsafe(`SELECT column_default FROM information_schema.columns
      WHERE table_name = 'user_preferences' AND column_name = 'updated_at'`)
    expect(column.column_default).toBe('now()')
  } finally {
    connection?.release()
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${freshName}" WITH (FORCE)`)
    await admin.end()
  }
})
