import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

const journal = await Bun.file(new URL('../../drizzle/meta/_journal.json', import.meta.url)).json()
const entry = journal.entries.find((entry: { tag: string }) => entry.tag.endsWith('_feed_completion_exposure'))
// The migration is generated on the canonical schema parent, not on a parallel draft journal.
const migration = entry ? await Bun.file(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url)).text() : ''

test('migration freezes the legacy boundary once and keeps exact, account-scoped receipts', async () => {
  expect(migration).toContain('feed_updates_after')
  const namespace = `feed_exposure_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('rollback fixture')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"; SET LOCAL search_path TO "${namespace}"`))
      await tx.execute(
        sql.raw(
          'CREATE TABLE users (id uuid PRIMARY KEY, last_feed_visit_at timestamptz); CREATE TABLE work_streams (id uuid PRIMARY KEY)'
        )
      )
      const user = crypto.randomUUID()
      const work = crypto.randomUUID()
      await tx.execute(sql`INSERT INTO users VALUES (${user}, '2026-01-01T00:00:00Z')`)
      await tx.execute(sql`INSERT INTO work_streams VALUES (${work})`)
      await tx.execute(sql.raw(migration.replaceAll('"public".', `"${namespace}".`)))
      await tx.execute(sql`UPDATE users SET last_feed_visit_at = '2026-02-01T00:00:00Z'`)
      const rows = await tx.execute(
        sql`SELECT to_char(feed_updates_after AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS boundary FROM users`
      )
      expect(rows[0]?.boundary).toBe('2026-01-01')
      await tx.execute(
        sql`INSERT INTO feed_completion_views (user_id, work_stream_id, completed_at) VALUES (${user}, ${work}, '2026-01-02T00:00:00Z') ON CONFLICT DO NOTHING`
      )
      await tx.execute(
        sql`INSERT INTO feed_completion_views (user_id, work_stream_id, completed_at) VALUES (${user}, ${work}, '2026-01-02T00:00:00Z') ON CONFLICT DO NOTHING`
      )
      const count = await tx.execute(sql`SELECT count(*)::int AS count FROM feed_completion_views`)
      expect(count[0]?.count).toBe(1)
      await tx.execute(sql`DELETE FROM users WHERE id = ${user}`)
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM feed_completion_views`))[0]?.count).toBe(0)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
