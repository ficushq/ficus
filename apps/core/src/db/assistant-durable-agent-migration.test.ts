import '../test-utils/require-test-db'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) =>
  migration.sql.join('\n').includes('ALTER TABLE "assistant_conversations" ADD COLUMN "agent_id"')
)!
const predecessors = migrations.filter((migration) => migration.folderMillis < target.folderMillis)
const dbName = `assistant_durable_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const ids = Array.from({ length: 6 }, () => crypto.randomUUID())
const [owner, conversation, helper, request, update, entry] = ids
let admin: ReturnType<typeof createPostgresConnection>,
  client: ReturnType<typeof createPostgresConnection>,
  connection: postgres.ReservedSql
const urlFor = (name: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}
beforeAll(async () => {
  expect(target).toBeDefined()
  admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
  connection = await client.reserve()
  await applyMigrations(connection, predecessors)
  await connection.unsafe(`INSERT INTO users (id,email,display_name) VALUES ($1,'migration@example.test','Owner')`, [
    owner!,
  ])
  await connection.unsafe(
    `INSERT INTO agents (id,agent_type_id,owner_user_id,context) VALUES ($1,'system-manager',$2,'{}')`,
    [helper!, owner!]
  )
  await connection.unsafe(
    `INSERT INTO assistant_conversations (id,owner_user_id,title) VALUES ($1,$2,'Existing conversation')`,
    [conversation!, owner!]
  )
  await connection.unsafe(`INSERT INTO assistant_conversation_agents (conversation_id,agent_id) VALUES ($1,$2)`, [
    conversation!,
    helper!,
  ])
  await connection.unsafe(
    `INSERT INTO assistant_entries (id,conversation_id,client_id,position,entry) VALUES ($1,$2,'legacy',1,'{"id":"legacy","role":"user","text":"Keep this history","final":true}')`,
    [entry!, conversation!]
  )
  await connection.unsafe(
    `INSERT INTO inbox (id,recipient_type,recipient_id,sender_type,content) VALUES ($1,'voice_assistant',$2,'system','Keep this report')`,
    [update!, `assistant:${conversation}`]
  )
  await connection.unsafe(
    `INSERT INTO assistant_tasks (id,conversation_id,current_request_id,agent_id,kind,label,status) VALUES ($1,$2,$1,$3,'background','Existing task','needs-input')`,
    [request!, conversation!, helper!]
  )
  await connection.unsafe(
    `INSERT INTO assistant_updates (message_id,conversation_id,task_id,request_id,sequence) VALUES ($1,$2,$3,$3,1)`,
    [update!, conversation!, request!]
  )
})
afterAll(async () => {
  connection?.release()
  await client?.end()
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
  await admin?.end()
})
test('populated upgrade preserves conversation, history, helpers, task generations and pending reports', async () => {
  const snapshot = async () => ({
    entries: await connection.unsafe('SELECT id,conversation_id,client_id,position,entry FROM assistant_entries'),
    helpers: await connection.unsafe('SELECT conversation_id,agent_id,squad_id FROM assistant_conversation_agents'),
    tasks: await connection.unsafe('SELECT id,current_request_id,agent_id,status FROM assistant_tasks'),
    reports: await connection.unsafe(
      'SELECT message_id,conversation_id,task_id,request_id,sequence,processed_at,seen_at FROM assistant_updates'
    ),
  })
  const before = await snapshot()
  await applyMigrations(connection, target)
  expect(await snapshot()).toEqual(before)
  expect((await connection.unsafe('SELECT agent_id FROM assistant_conversations'))[0]!.agent_id).toBeNull()
  const [fields] = await connection.unsafe('SELECT forwarded_message_id,summarized_message_id FROM assistant_updates')
  expect(fields!.forwarded_message_id).toBeNull()
  expect(fields!.summarized_message_id).toBeNull()
  await applyMigrations(connection, target)
  expect(await snapshot()).toEqual(before)
})
