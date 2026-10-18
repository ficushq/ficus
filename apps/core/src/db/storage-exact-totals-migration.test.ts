import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

// Apply the generated migration's own SQL to an isolated pre-migration copy of the storage tables,
// never to the shared ones.
const migration = await Bun.file(new URL('../../drizzle/0225_storage_exact_home_totals.sql', import.meta.url)).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())

test('exact-totals migration leaves old results unknown, drops home growth samples, and allows total items', async () => {
  const namespace = `storage_exact_totals_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  const pass = crypto.randomUUID()
  const home = '/home/box_aaaaaaaaaaaa'
  try {
    await db.transaction(async (tx) => {
      const run = (statement: string) => tx.execute(sql.raw(statement))
      await run(`CREATE SCHEMA "${namespace}"`)
      await run(`SET LOCAL search_path TO "${namespace}", public`)
      // The tables as 0223 created them (columns this migration touches).
      await run(`CREATE TABLE "storage_scan_items" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "pass_id" uuid NOT NULL, "home" text NOT NULL,
        "path" text NOT NULL, "state" varchar(16) DEFAULT 'pending' NOT NULL,
        CONSTRAINT "storage_scan_items_path" UNIQUE("pass_id","path"))`)
      await run(`CREATE TABLE "storage_home_results" ("machine_id" uuid NOT NULL, "home" text NOT NULL,
        "bytes" bigint, PRIMARY KEY ("machine_id","home"))`)
      await run(`CREATE TABLE "storage_scan_passes" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL)`)
      await run(`CREATE TABLE "storage_usage_samples" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "machine_id" uuid NOT NULL, "subject" text NOT NULL, "bytes" bigint NOT NULL)`)
      const machine = crypto.randomUUID()
      await run(`INSERT INTO "storage_scan_items" ("pass_id","home","path") VALUES ('${pass}','${home}','${home}')`)
      await run(`INSERT INTO "storage_home_results" VALUES ('${machine}','${home}',27)`)
      await run(`INSERT INTO "storage_usage_samples" ("machine_id","subject","bytes")
        VALUES ('${machine}','host',100), ('${machine}','${home}',27)`)

      for (const statement of statements) await run(statement)

      const select = async (query: string) => [...(await run(query))]
      expect(await select(`SELECT "subject", "bytes" FROM "${namespace}"."storage_usage_samples"`)).toEqual([
        { subject: 'host', bytes: '100' },
      ])
      expect(await select(`SELECT "bytes", "total_exact" FROM "${namespace}"."storage_home_results"`)).toEqual([
        { bytes: '27', total_exact: null },
      ])
      expect(await select(`SELECT "kind" FROM "${namespace}"."storage_scan_items"`)).toEqual([{ kind: 'tree' }])
      // A home's total item shares its path with the home's tree item; a second tree item still conflicts.
      await run(`INSERT INTO "storage_scan_items" ("pass_id","home","path","kind")
        VALUES ('${pass}','${home}','${home}','total')`)
      const duplicate = await run(`INSERT INTO "storage_scan_items" ("pass_id","home","path")
        VALUES ('${pass}','${home}','${home}') ON CONFLICT DO NOTHING RETURNING "id"`)
      expect([...duplicate]).toEqual([])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
