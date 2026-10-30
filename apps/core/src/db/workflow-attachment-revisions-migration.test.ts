import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const folder = join(MONOREPO_ROOT, 'apps/core/drizzle')
const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}
const entry = journal.entries.find(({ tag }) => tag.endsWith('_workflow-attachment-revisions'))!
const migrations = readMigrationFiles({ migrationsFolder: folder })
const target = migrations.find((migration) =>
  migration.sql.join('\n').includes('ADD COLUMN "revision" integer DEFAULT 1 NOT NULL')
)
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `attachment_revisions_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

type Snapshot = { id: string; prevId: string }

test('the attachment revision migration follows the stored-asset migration in the journal and snapshot chain', async () => {
  expect(entry).toBeDefined()
  const prior = journal.entries[entry.idx - 1]!
  expect(prior.tag).toBe('0242_workstream_asset_attachments')
  expect(entry.tag).toBe('0243_workflow-attachment-revisions')
  expect(entry.when).toBeGreaterThan(prior.when)
  const image = (idx: number) =>
    Bun.file(join(folder, `meta/${String(idx).padStart(4, '0')}_snapshot.json`)).json() as Promise<Snapshot>
  expect((await image(entry.idx)).prevId).toBe((await image(prior.idx)).id)
})

describe('attachment revision migration on a fresh database', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    // Every earlier migration, including 0242_workstream_asset_attachments, in order.
    await applyMigrations(connection, predecessors)
  }, 120_000)

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('existing files become revision 1, and one path can hold a file per revision', async () => {
    // 0242 (stored asset references) is already applied; 0243 builds on it.
    const [asset] = await connection.unsafe<{ t: string | null }[]>(
      `SELECT to_regclass('public.work_stream_asset_attachments')::text AS t`
    )
    expect(asset?.t).toBe('work_stream_asset_attachments')
    const stream = crypto.randomUUID()
    await connection.unsafe(`
      INSERT INTO squads (id, name, purpose) VALUES ('${stream}', 'Migration fixture', 'Fixture');
      INSERT INTO work_streams (id, squad_id, title) VALUES ('${stream}', '${stream}', 'Fixture');
      INSERT INTO workflow_attempt_attachments
        (work_stream_id, attempt_id, filename, path, content_type, byte_size, sha256, storage_path, uploaded_by_agent_id)
        VALUES ('${stream}', 1, 'design.md', 'docs/design.md', 'text/markdown', 3, '${'a'.repeat(64)}', '/x', '${stream}');
    `)
    await applyMigrations(connection, target!)
    const rows = await connection.unsafe<{ revision: number }[]>(`SELECT revision FROM workflow_attempt_attachments`)
    expect(rows.map((row) => row.revision)).toEqual([1])
    const insert = (revision: number) =>
      connection.unsafe(`
        INSERT INTO workflow_attempt_attachments
          (work_stream_id, attempt_id, filename, path, content_type, byte_size, sha256, storage_path, uploaded_by_agent_id, revision)
          VALUES ('${stream}', 1, 'design.md', 'docs/design.md', 'text/markdown', 3, '${'b'.repeat(64)}', '/y', '${stream}', ${revision})`)
    await insert(2)
    let duplicate: unknown
    try {
      await insert(2)
    } catch (error) {
      duplicate = error
    }
    expect(String(duplicate)).toContain('idx_workflow_attempt_attachments_path')
  }, 60_000)
})
