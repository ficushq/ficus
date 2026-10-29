import '../test-utils/require-test-db'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const name = `work_numbers_${crypto.randomUUID().replaceAll('-', '')}`
const urlFor = (database: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${database}`
  return url.toString()
}
let admin: ReturnType<typeof createPostgresConnection>
let client: ReturnType<typeof createPostgresConnection>
let connection: postgres.ReservedSql
beforeAll(async () => {
  admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  client = createPostgresConnection(urlFor(name), { max: 1, onnotice: () => {} })
  connection = await client.reserve()
})
afterAll(async () => {
  connection?.release()
  await client?.end()
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.end()
  }
})
test('one generated migration deterministically backfill, survive re-entry and allocate above existing references', async () => {
  await connection`CREATE TABLE work_streams (id uuid PRIMARY KEY, created_at timestamp NOT NULL)`
  await connection`CREATE TABLE user_notification_preferences (user_id uuid PRIMARY KEY)`
  const userId = crypto.randomUUID()
  await connection`INSERT INTO user_notification_preferences VALUES (${userId})`
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
  for (const id of [...ids].reverse()) await connection`INSERT INTO work_streams VALUES (${id}, '2020-01-01')`
  const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).filter((m) =>
    m.sql.some((sql) => /work_streams" (ADD COLUMN "number"|ALTER COLUMN "number")/.test(sql))
  )
  expect(migrations.length).toBe(1)
  await applyMigrations(connection, migrations)
  expect((await connection`SELECT id, number FROM work_streams ORDER BY number`).map((row) => row.id)).toEqual(ids)
  expect((await connection`SELECT show_previews FROM user_notification_preferences`)[0]!.show_previews).toBe(true)
  await connection`UPDATE user_notification_preferences SET show_previews = false`
  await applyMigrations(connection, migrations)
  expect((await connection`SELECT show_previews FROM user_notification_preferences`)[0]!.show_previews).toBe(false)
  const [next] =
    await connection`INSERT INTO work_streams (id,created_at) VALUES (${crypto.randomUUID()},now()) RETURNING number`
  expect(next!.number).toBe(4)
  await connection`DELETE FROM work_streams WHERE number = 4`
  const [later] =
    await connection`INSERT INTO work_streams (id,created_at) VALUES (${crypto.randomUUID()},now()) RETURNING number`
  expect(later!.number).toBe(5)
})
