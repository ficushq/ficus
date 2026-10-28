import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

interface JournalEntry {
  idx: number
  when: number
  tag: string
}
interface Snapshot {
  id: string
  prevId: string
  tables: Record<string, { columns: Record<string, unknown> }>
}

const journal = (await Bun.file(new URL('../../drizzle/meta/_journal.json', import.meta.url)).json()) as {
  entries: JournalEntry[]
}
function rawMigration() {
  const entry = journal.entries.find((entry) => entry.tag.endsWith('_github_raw_feedback_freshness'))
  expect(entry).toBeDefined()
  return entry!
}

// Compare the full generated image, not just selected new tables: parallel migrations must
// keep their actual predecessor's removals, indexes and metadata as well as its UUID.
test('raw feedback migration follows canonical exposure retirement and retains its full snapshot', async () => {
  const entry = rawMigration()
  const prior = journal.entries[entry.idx - 1]!
  expect(prior.tag).toBe('0233_retire_secret_exposure')
  expect(entry.idx).toBe(prior.idx + 1)
  expect(entry.when).toBeGreaterThan(prior.when)
  const parent = (await Bun.file(
    new URL(`../../drizzle/meta/${String(prior.idx).padStart(4, '0')}_snapshot.json`, import.meta.url)
  ).json()) as Snapshot
  const successor = (await Bun.file(
    new URL(`../../drizzle/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`, import.meta.url)
  ).json()) as Snapshot
  expect(successor.id).not.toBe(parent.id)
  expect(successor.prevId).toBe(parent.id)
  expect(successor.tables['public.sandbox_exposure_cleanup']).toBeDefined()
  for (const name of ['agent_secret_exposures', 'global_secret_exposures', 'squad_secret_exposures'])
    expect(successor.tables[`public.${name}`]).toBeUndefined()
  const expected = structuredClone(parent)
  expected.id = successor.id
  expected.prevId = parent.id
  expected.tables['public.github_feedback_sources']!.columns.unfiltered = {
    name: 'unfiltered',
    type: 'boolean',
    primaryKey: false,
    notNull: true,
    default: false,
  }
  expect(successor).toEqual(expected)
})

test('raw feedback SQL defaults historical associations to filtered without rewriting provenance or replaying', async () => {
  const entry = rawMigration()
  const migration = await Bun.file(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url)).text()
  expect(migration.trim()).toBe(
    'ALTER TABLE "github_feedback_sources" ADD COLUMN "unfiltered" boolean DEFAULT false NOT NULL;'
  )
  const namespace = `raw_feedback_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned raw migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}"`))
      await tx.execute(
        sql.raw('CREATE TABLE "github_feedback_sources" (event_id text PRIMARY KEY, authority jsonb NOT NULL)')
      )
      await tx.execute(
        sql`INSERT INTO "github_feedback_sources" VALUES ('historical', '{"native":"unchanged"}'::jsonb)`
      )
      await tx.execute(sql.raw(migration))
      await tx.execute(
        sql`INSERT INTO "github_feedback_sources" (event_id, authority) VALUES ('new-default', '{}'::jsonb)`
      )
      await tx.execute(
        sql`INSERT INTO "github_feedback_sources" (event_id, authority, unfiltered) VALUES ('native-off', '{}'::jsonb, true)`
      )
      const rows = await tx.execute(
        sql`SELECT event_id, authority, unfiltered FROM "github_feedback_sources" ORDER BY event_id`
      )
      expect([...rows]).toEqual([
        { event_id: 'historical', authority: { native: 'unchanged' }, unfiltered: false },
        { event_id: 'native-off', authority: {}, unfiltered: true },
        { event_id: 'new-default', authority: {}, unfiltered: false },
      ])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
