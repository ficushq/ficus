import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { applyMigrations } from './migrator'
import { createPostgresConnection, getConnectionString } from './connection'
import { expectedTableColumns, findSchemaDrift } from './expected-schema'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes('work_stream_order_snapshots'))
const pre = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const post = target ? migrations.filter((migration) => migration.folderMillis > target.folderMillis) : []
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const cleanDb = `ws_order_snapshot_${suffix}`
const dirtyDb = `ws_order_dirty_${suffix}`

function databaseUrl(database: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${database}`
  return url.toString()
}

describe('work-stream order snapshot migration', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let cleanClient: ReturnType<typeof createPostgresConnection>
  let dirtyClient: ReturnType<typeof createPostgresConnection>
  let clean: postgres.ReservedSql
  let dirty: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(databaseUrl('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${cleanDb}"`)
    await admin.unsafe(`CREATE DATABASE "${dirtyDb}"`)
    cleanClient = createPostgresConnection(databaseUrl(cleanDb), { max: 1, onnotice: () => {} })
    dirtyClient = createPostgresConnection(databaseUrl(dirtyDb), { max: 1, onnotice: () => {} })
    clean = await cleanClient.reserve()
    dirty = await dirtyClient.reserve()
  })

  afterAll(async () => {
    clean?.release()
    dirty?.release()
    await cleanClient?.end()
    await dirtyClient?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${cleanDb}" WITH (FORCE)`).catch(() => {})
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dirtyDb}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  it('upgrades the real predecessor and cascades ordinal items', async () => {
    expect(target).toBeDefined()
    expect(pre.length).toBeGreaterThan(100)
    await applyMigrations(clean, pre)
    await applyMigrations(clean, target!)

    const [snapshot] = await clean.unsafe<{ id: string }[]>(
      `INSERT INTO work_stream_order_snapshots
       (owner_key, request_fingerprint, cursor_secret, expires_at, non_terminal_count)
       VALUES ('legacy', '${'a'.repeat(64)}', '${'b'.repeat(64)}', now() + interval '30 minutes', 1) RETURNING id`
    )
    await clean.unsafe(
      `INSERT INTO work_stream_order_snapshot_items (snapshot_id, ordinal, work_stream_id)
       VALUES ('${snapshot.id}', 0, gen_random_uuid())`
    )
    await clean.unsafe(`DELETE FROM work_stream_order_snapshots WHERE id = '${snapshot.id}'`)
    const [{ count }] = await clean.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM work_stream_order_snapshot_items WHERE snapshot_id = '${snapshot.id}'`
    )
    expect(count).toBe(0)

    await applyMigrations(clean, post)
    const columnRows = await clean.unsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    )
    const actual = new Map<string, Set<string>>()
    for (const row of columnRows) {
      const columns = actual.get(row.table_name) ?? new Set<string>()
      columns.add(row.column_name)
      actual.set(row.table_name, columns)
    }
    expect(findSchemaDrift(expectedTableColumns(), actual)).toEqual({ missingTables: [], missingColumns: [] })
  }, 120_000)

  it('fails closed on a dirty partial predecessor instead of recording a partial upgrade', async () => {
    expect(target).toBeDefined()
    await applyMigrations(dirty, pre)
    await dirty.unsafe(`CREATE TABLE work_stream_order_snapshots (id uuid PRIMARY KEY)`)
    await expect(applyMigrations(dirty, target!)).rejects.toThrow()
    const [{ exists }] = await dirty.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('public.work_stream_order_snapshot_items') IS NOT NULL AS exists`
    )
    expect(exists).toBe(false)
  }, 120_000)
})
