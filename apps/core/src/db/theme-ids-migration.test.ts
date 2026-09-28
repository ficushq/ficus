import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { validateThemePreference } from '@ficus/shared/theme-preferences'
import { validateThemePresetDocument } from '@ficus/shared/theme-preset'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

// Migration history: the retired theme ids and format marker below are the values this migration rewrites.
const marker = `jsonb_set("theme", '{themeId}'`
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `theme_ids_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

const user = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const preset = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`
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
// A v1 document (one concrete appearance plus overrides), still accepted and stored by older clients.
const v1 = (base: string, format: string) => ({
  format,
  version: 1,
  name: 'Old',
  base,
  appearance: 'dark',
  overrides: { '--color-primary': '#0ea5e9' },
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

  test('plain selections move to ficus; custom themes keep their look (purple base to iris, forest to ficus); iris and custom ids stay', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)

    // [seeded row, expected row after the migration]
    const preferences: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [user(1), selection('tau'), selection('ficus')],
      [user(2), selection('forest'), selection('ficus')],
      [user(3), selection('iris'), selection('iris')],
      [user(4), selection('my-own-theme'), selection('my-own-theme')],
      // A selection carrying a custom theme follows its base (themeId must equal customTheme.base).
      [user(5), selection('tau', doc('tau', 'tau-custom-theme')), selection('iris', doc('iris', 'ficus-custom-theme'))],
      [
        user(6),
        selection('harbor', doc('harbor', 'tau-custom-theme')),
        selection('harbor', doc('harbor', 'ficus-custom-theme')),
      ],
      [
        user(7),
        selection('iris', doc('iris', 'ficus-custom-theme')),
        selection('iris', doc('iris', 'ficus-custom-theme')),
      ],
      [
        user(8),
        selection('forest', doc('forest', 'tau-custom-theme')),
        selection('ficus', doc('ficus', 'ficus-custom-theme')),
      ],
      [user(9), selection('tau', v1('tau', 'tau-custom-theme')), selection('iris', v1('iris', 'ficus-custom-theme'))],
      // No customTheme key at all: SQL NULL, not a JSON null, takes the plain-selection branch.
      [user(10), { themeId: 'tau', appearance: 'light' }, { themeId: 'ficus', appearance: 'light' }],
    ]
    const presets: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [preset(1), doc('tau', 'tau-custom-theme'), doc('iris', 'ficus-custom-theme')],
      [preset(2), doc('forest', 'ficus-custom-theme'), doc('ficus', 'ficus-custom-theme')],
      [preset(3), doc('harbor', 'tau-custom-theme'), doc('harbor', 'ficus-custom-theme')],
      [preset(4), doc('iris', 'ficus-custom-theme'), doc('iris', 'ficus-custom-theme')],
      [preset(5), v1('tau', 'tau-custom-theme'), v1('iris', 'ficus-custom-theme')],
    ]
    for (const [id, theme] of preferences) {
      await connection.unsafe('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`])
      await connection.unsafe('INSERT INTO user_preferences (user_id, theme) VALUES ($1, $2::text::jsonb)', [
        id,
        JSON.stringify(theme),
      ])
    }
    for (const [id, document] of presets)
      await connection.unsafe(
        'INSERT INTO theme_presets (id, owner_user_id, document) VALUES ($1, $2, $3::text::jsonb)',
        [id, user(1), JSON.stringify(document)]
      )

    const verify = async () => {
      const themes = new Map(
        (
          await connection.unsafe<{ user_id: string; theme: Record<string, unknown> }[]>(
            'SELECT user_id, theme FROM user_preferences'
          )
        ).map((row) => [row.user_id, row.theme])
      )
      for (const [id, , expected] of preferences) {
        expect(themes.get(id)).toEqual(expected)
        // Every row ends in a state the current validators accept. The custom id and the missing-key row were not
        // valid before the rename either (unknown id; the contract requires customTheme), so they are only compared.
        if (id !== user(4) && id !== user(10)) expect(validateThemePreference(themes.get(id)).ok).toBe(true)
      }
      const documents = new Map(
        (
          await connection.unsafe<{ id: string; document: Record<string, unknown> }[]>(
            'SELECT id, document FROM theme_presets'
          )
        ).map((row) => [row.id, row.document])
      )
      for (const [id, , expected] of presets) {
        expect(documents.get(id)).toEqual(expected)
        expect(validateThemePresetDocument(documents.get(id)).ok).toBe(true)
      }
    }

    await applyMigrations(connection, [...predecessors, target!])
    await verify()
    // The ledger skips an applied migration, so run the SQL itself a second time: every statement is idempotent.
    for (const statement of target!.sql) if (statement.trim()) await connection.unsafe(statement)
    await verify()
  })
})
