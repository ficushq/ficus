import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

// Synthetic fixture rows only, in a throwaway database.
const folder = join(MONOREPO_ROOT, 'apps/core/drizzle')
const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}
const entry = journal.entries.find(({ tag }) => tag.endsWith('_retained_asset_cleanup_backoff'))!
const migrations = readMigrationFiles({ migrationsFolder: folder })
const target = migrations.find((migration) =>
  migration.sql.join('\n').includes('ADD COLUMN "cleanup_attempts" integer DEFAULT 0 NOT NULL')
)
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `retained_cleanup_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

type Snapshot = { id: string; prevId: string }

test('the cleanup backoff migration follows the attachment revision migration in the journal and snapshot chain', async () => {
  expect(entry).toBeDefined()
  const prior = journal.entries[entry.idx - 1]!
  expect(prior.tag).toBe('0243_workflow-attachment-revisions')
  expect(entry.tag).toBe('0244_retained_asset_cleanup_backoff')
  expect(entry.when).toBeGreaterThan(prior.when)
  const image = (idx: number) =>
    Bun.file(join(folder, `meta/${String(idx).padStart(4, '0')}_snapshot.json`)).json() as Promise<Snapshot>
  expect((await image(entry.idx)).prevId).toBe((await image(prior.idx)).id)
})

describe('cleanup backoff migration on a fresh database', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    // Every earlier migration in order, through 0242 (stored assets) and 0243 (attachment revisions).
    await applyMigrations(connection, predecessors)
  }, 120_000)

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('existing retained assets start with no failed cleanups and nothing scheduled', async () => {
    const [revision] = await connection.unsafe<{ c: string }[]>(
      `SELECT count(*)::text AS c FROM information_schema.columns
        WHERE table_name = 'workflow_attempt_attachments' AND column_name = 'revision'`
    )
    expect(revision?.c).toBe('1')
    const id = crypto.randomUUID()
    await connection.unsafe(`
      INSERT INTO retained_assets (id, source_kind, source_id, blob_owner, filename, content_type, byte_size, sha256)
        VALUES ('${id}', 'image', '${id}', '${id}.png', '${id}.png', 'image/png', 1, '${'0'.repeat(64)}')
    `)
    await applyMigrations(connection, target!)
    const rows = await connection.unsafe<
      { cleanup_attempts: number; cleanup_retry_at: Date | null; cleanup_failed_at: Date | null; cleanup_error: null }[]
    >(`SELECT cleanup_attempts, cleanup_retry_at, cleanup_failed_at, cleanup_error FROM retained_assets`)
    expect(rows).toEqual([
      { cleanup_attempts: 0, cleanup_retry_at: null, cleanup_failed_at: null, cleanup_error: null },
    ])
  }, 60_000)
})
