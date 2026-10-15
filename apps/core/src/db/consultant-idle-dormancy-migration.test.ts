import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

// Apply the generated migration's own SQL to an isolated pre-migration copy of the column,
// never to the shared squads table.
const migration = await Bun.file(
  new URL('../../drizzle/0213_consultant_idle_dormancy_default_on.sql', import.meta.url)
).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())

test('idle-consultant dormancy migration turns every unset squad on at 30 days, keeps custom values, and is re-runnable', async () => {
  const namespace = `idle_dormancy_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      // The column as 0212 created it: nullable, no default.
      await tx.execute(
        sql.raw(`CREATE TABLE "squads" ("name" text PRIMARY KEY, "consultant_idle_dormancy_days" integer)`)
      )
      await tx.execute(sql.raw(`INSERT INTO "squads" VALUES ('unset', NULL), ('custom', 90), ('short', 7)`))
      const rows = async () =>
        Object.fromEntries(
          (
            await tx.execute(
              sql.raw(`SELECT "name", "consultant_idle_dormancy_days" AS days FROM "${namespace}"."squads"`)
            )
          ).map((row) => [row.name as string, row.days as number | null])
        )

      for (const statement of statements) await tx.execute(sql.raw(statement))
      expect(await rows()).toEqual({ unset: 30, custom: 90, short: 7 })

      // New squads start on at the column default; an explicit null (turned off) is still storable.
      await tx.execute(sql.raw(`INSERT INTO "squads" ("name") VALUES ('new')`))
      await tx.execute(sql.raw(`INSERT INTO "squads" VALUES ('off', NULL)`))
      expect(await rows()).toEqual({ unset: 30, custom: 90, short: 7, new: 30, off: null })

      // Applying it twice in a row is a no-op: no error, and every set value is unchanged.
      await tx.execute(sql.raw(`DELETE FROM "squads" WHERE "name" = 'off'`))
      for (const statement of statements) await tx.execute(sql.raw(statement))
      expect(await rows()).toEqual({ unset: 30, custom: 90, short: 7, new: 30 })
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
