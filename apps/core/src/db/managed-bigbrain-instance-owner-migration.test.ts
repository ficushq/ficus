import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

// Apply the generated migration's own SQL to an isolated pre-migration copy of the tables,
// never to the shared ones.
const migration = await Bun.file(
  new URL('../../drizzle/0231_managed_bigbrain_instance_owner.sql', import.meta.url)
).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())

test('instance-owner migration keeps a vault’s owner anchor when its creating user is deleted', async () => {
  const namespace = `mbb_instance_owner_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  const creator = crypto.randomUUID()
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      // The owner column as it was before: a user reference nulled when that user is deleted.
      await tx.execute(sql.raw(`CREATE TABLE "users" ("id" uuid PRIMARY KEY)`))
      await tx.execute(
        sql.raw(`CREATE TABLE "managed_bigbrain_vaults" ("id" uuid PRIMARY KEY, "owner_user_id" uuid,
          CONSTRAINT "managed_bigbrain_vaults_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id")
          REFERENCES "users"("id") ON DELETE set null)`)
      )
      await tx.execute(sql.raw(`INSERT INTO "users" VALUES ('${creator}')`))
      await tx.execute(sql.raw(`INSERT INTO "managed_bigbrain_vaults" VALUES (gen_random_uuid(), '${creator}')`))

      for (const statement of statements) await tx.execute(sql.raw(statement))

      await tx.execute(sql.raw(`DELETE FROM "users" WHERE "id" = '${creator}'`))
      const rows = await tx.execute(sql.raw(`SELECT "owner_user_id" FROM "${namespace}"."managed_bigbrain_vaults"`))
      expect(rows.map((row) => row.owner_user_id)).toEqual([creator])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
