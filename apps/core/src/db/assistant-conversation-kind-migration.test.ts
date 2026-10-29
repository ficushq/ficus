import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { backfillAssistantConversationKinds } from './assistant-conversation-kind-backfill'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'ALTER TABLE "assistant_conversations" ADD COLUMN "kind"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `assistant_kind_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

const owner = '30000000-0000-4000-8000-000000000001'
const chat = '20000000-0000-4000-8000-000000000001'
const editor = '20000000-0000-4000-8000-000000000002'
const closedEditor = '20000000-0000-4000-8000-000000000003'

describe('assistant conversation kind migration', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO users (id, email, display_name) VALUES ('${owner}', 'owner@example.test', 'Owner');
      INSERT INTO assistant_conversations (id, owner_user_id, title, editor) VALUES
        ('${chat}', '${owner}', 'Ordinary chat', NULL),
        ('${editor}', '${owner}', 'Design a workflow', '{"kind":"workflow","target":{},"revision":0,"document":{}}'),
        ('${closedEditor}', '${owner}', 'Design a workflow', '{"kind":"workflow","target":{},"revision":2,"document":{},"closed":true}');
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('existing page-editor drafts become page-editor conversations; everything else stays assistant', async () => {
    await applyMigrations(connection, target!)
    const kinds = async () =>
      Object.fromEntries(
        (
          await connection.unsafe<{ id: string; kind: string }[]>(
            `SELECT id, kind FROM assistant_conversations ORDER BY id`
          )
        ).map((row) => [row.id, row.kind])
      )
    expect(await kinds()).toEqual({ [chat]: 'assistant', [editor]: 'page-editor', [closedEditor]: 'page-editor' })
    await backfillAssistantConversationKinds(connection)
    expect(await kinds()).toEqual({ [chat]: 'assistant', [editor]: 'page-editor', [closedEditor]: 'page-editor' })
  })
})
