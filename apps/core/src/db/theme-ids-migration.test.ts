import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

// Migration history: the retired theme ids and format marker below are the values this migration rewrites.
const marker = `jsonb_set("theme", '{themeId}', '"ficus"')`
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `theme_ids_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const user = (n: number) => `50000000-0000-4000-8000-00000000010${n}`
const selection = (themeId: string, customTheme: Record<string, unknown> | null = null) => ({
  themeId,
  appearance: 'dark',
  customTheme,
  presetId: null,
  presetOwnerId: null,
})
const doc = (base: string, format: string) => ({
  format,
  version: 2,
  name: 'Mine',
  base,
  palette: { primary: '#0ea5e9' },
  variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
})

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('theme ids migration (real runner, isolated database)', () => {
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

  test('moves tau and forest to ficus in selections, custom snapshots and presets; leaves iris and custom ids', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)

    const preferences: Array<[string, ReturnType<typeof selection>]> = [
      [user(1), selection('tau')],
      [user(2), selection('forest')],
      [user(3), selection('iris')],
      [user(4), selection('my-own-theme')],
      [user(5), selection('tau', doc('tau', 'tau-custom-theme'))],
      [user(6), selection('harbor', doc('harbor', 'tau-custom-theme'))],
      [user(7), selection('iris', doc('iris', 'ficus-custom-theme'))],
    ]
    for (const [id] of preferences)
      await connection.unsafe('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`])
    for (const [id, theme] of preferences)
      await connection.unsafe('INSERT INTO user_preferences (user_id, theme) VALUES ($1, $2::text::jsonb)', [
        id,
        JSON.stringify(theme),
      ])
    const presets: Array<[string, ReturnType<typeof doc>]> = [
      ['60000000-0000-4000-8000-000000000001', doc('tau', 'tau-custom-theme')],
      ['60000000-0000-4000-8000-000000000002', doc('forest', 'ficus-custom-theme')],
      ['60000000-0000-4000-8000-000000000003', doc('harbor', 'tau-custom-theme')],
      ['60000000-0000-4000-8000-000000000004', doc('iris', 'ficus-custom-theme')],
    ]
    for (const [id, document] of presets)
      await connection.unsafe(
        'INSERT INTO theme_presets (id, owner_user_id, document) VALUES ($1, $2, $3::text::jsonb)',
        [id, user(1), JSON.stringify(document)]
      )

    await applyMigrations(connection, [...predecessors, target!])
    await applyMigrations(connection, [...predecessors, target!])

    const themes = Object.fromEntries(
      (
        await connection.unsafe<{ user_id: string; theme: ReturnType<typeof selection> }[]>(
          'SELECT user_id, theme FROM user_preferences'
        )
      ).map((row) => [row.user_id, row.theme])
    )
    expect(themes[user(1)]).toEqual(selection('ficus'))
    expect(themes[user(2)]).toEqual(selection('ficus'))
    expect(themes[user(3)]).toEqual(selection('iris'))
    expect(themes[user(4)]).toEqual(selection('my-own-theme'))
    expect(themes[user(5)]).toEqual(selection('ficus', doc('ficus', 'ficus-custom-theme')))
    expect(themes[user(6)]).toEqual(selection('harbor', doc('harbor', 'ficus-custom-theme')))
    expect(themes[user(7)]).toEqual(selection('iris', doc('iris', 'ficus-custom-theme')))

    const documents = Object.fromEntries(
      (
        await connection.unsafe<{ id: string; document: ReturnType<typeof doc> }[]>(
          'SELECT id, document FROM theme_presets'
        )
      ).map((row) => [row.id, row.document])
    )
    expect(documents[presets[0]![0]]).toEqual(doc('ficus', 'ficus-custom-theme'))
    expect(documents[presets[1]![0]]).toEqual(doc('ficus', 'ficus-custom-theme'))
    expect(documents[presets[2]![0]]).toEqual(doc('harbor', 'ficus-custom-theme'))
    expect(documents[presets[3]![0]]).toEqual(doc('iris', 'ficus-custom-theme'))
  })
})
