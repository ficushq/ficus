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
          'CREATE TABLE users (id uuid PRIMARY KEY, last_feed_visit_at timestamptz, created_at timestamp NOT NULL); CREATE TABLE work_streams (id uuid PRIMARY KEY)'
        )
      )
      const user = crypto.randomUUID()
      const work = crypto.randomUUID()
      const neverVisited = crypto.randomUUID()
      await tx.execute(sql`INSERT INTO users VALUES (${user}, '2026-01-01T00:00:00Z', '2025-01-01T00:00:00')`)
      await tx.execute(sql`INSERT INTO users VALUES (${neverVisited}, NULL, '2025-06-01T00:00:00')`)
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`)
      await tx.execute(sql`INSERT INTO work_streams VALUES (${work})`)
      await tx.execute(sql.raw(migration.replaceAll('"public".', `"${namespace}".`)))
      await tx.execute(sql`UPDATE users SET last_feed_visit_at = '2026-02-01T00:00:00Z'`)
      const rows = await tx.execute(
        sql`SELECT to_char(feed_updates_after AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS boundary FROM users WHERE id = ${user}`
      )
      expect(rows[0]?.boundary).toBe('2026-01-01')
      const [newcomer] = await tx.execute(
        sql`SELECT to_char(feed_updates_after AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS boundary FROM users WHERE id = ${neverVisited}`
      )
      expect(newcomer?.boundary).toBe('2025-06-01 00:00')
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

test('generated exposure snapshot follows and preserves the canonical provisioning schema', async () => {
  const parent = await Bun.file(new URL('../../drizzle/meta/0236_snapshot.json', import.meta.url)).json()
  const successor = await Bun.file(new URL('../../drizzle/meta/0237_snapshot.json', import.meta.url)).json()
  expect(successor.prevId).toBe(parent.id)
  const expected = structuredClone(parent)
  expected.id = successor.id
  expected.prevId = parent.id
  expected.tables['public.feed_completion_views'] = successor.tables['public.feed_completion_views']
  expected.tables['public.users'].columns.feed_updates_after = {
    name: 'feed_updates_after',
    type: 'timestamp with time zone',
    primaryKey: false,
    notNull: false,
  }
  expect(successor.tables['public.vm_box_provision_attempts']).toBeDefined()
  expect(successor).toEqual(expected)
})
