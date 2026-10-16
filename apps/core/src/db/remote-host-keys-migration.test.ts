import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

// Apply the generated migration's own SQL to an isolated pre-migration copy of remote_hosts,
// never to the shared table.
const migration = await Bun.file(new URL('../../drizzle/0220_remote_host_keys.sql', import.meta.url)).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())

test('remote host keys migration marks every existing host for adoption and new hosts not', async () => {
  const namespace = `remote_host_keys_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      // remote_hosts as it was before the migration (only the columns this test needs).
      await tx.execute(
        sql.raw(`CREATE TABLE "remote_hosts" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "name" text NOT NULL)`)
      )
      await tx.execute(sql.raw(`INSERT INTO "remote_hosts" ("name") VALUES ('existing-a'), ('existing-b')`))

      for (const statement of statements) await tx.execute(sql.raw(statement))

      await tx.execute(sql.raw(`INSERT INTO "remote_hosts" ("name") VALUES ('new-host')`))
      const rows = await tx.execute(
        sql.raw(`SELECT "name", "host_key_adoption_pending" AS adopting FROM "${namespace}"."remote_hosts"`)
      )
      expect(Object.fromEntries(rows.map((row) => [row.name as string, row.adopting as boolean]))).toEqual({
        'existing-a': true,
        'existing-b': true,
        'new-host': false,
      })
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
