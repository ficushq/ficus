import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { users } from './schema'

// Apply the generator's SQL, not a push-built table or supplemented preload index.
// Namespace-only substitutions isolate owned tables without touching other fixtures.
const migration = await Bun.file(new URL('../../drizzle/0201_watery_arclight.sql', import.meta.url)).text()

test('generated moderation migration is additive and does not grant or replay historical feedback', () => {
  expect(migration).toContain('CREATE UNIQUE INDEX "github_personal_identity_active_account"')
  expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)\s+(?:INTO|FROM|TABLE|INDEX|"github_)/i)
  expect(migration.match(/CREATE TABLE /g)).toHaveLength(6)
})

test('generated migration itself enforces active GitHub ownership without preload repair', async () => {
  const namespace = `feedback_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const userIds = [crypto.randomUUID(), crypto.randomUUID()]
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values(userIds.map((id) => ({ id, email: `${id}@migration.test` })))
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      const isolated = migration.replaceAll(/"public"\."(github_[a-z_]+)"/g, `"${namespace}"."$1"`)
      for (const statement of isolated.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.execute(sql.raw(statement))
      }
      const identityTable = sql.raw(`"${namespace}"."github_personal_identities"`)
      await tx.execute(
        sql`INSERT INTO ${identityTable} (user_id, account_id, login) VALUES (${userIds[0]}, '101', 'alice')`
      )
      await expect(
        tx.transaction(async (savepoint) => {
          await savepoint.execute(
            sql`INSERT INTO ${identityTable} (user_id, account_id, login) VALUES (${userIds[1]}, '101', 'renamed')`
          )
        })
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: '23505', constraint_name: 'github_personal_identity_active_account' }),
      })
      await tx.execute(
        sql`UPDATE ${identityTable} SET unlinked_at = now(), generation = generation + 1 WHERE user_id = ${userIds[0]}`
      )
      await tx.execute(
        sql`INSERT INTO ${identityTable} (user_id, account_id, login) VALUES (${userIds[1]}, '101', 'renamed')`
      )
      const result = await tx.execute(
        sql`SELECT count(*)::integer AS count FROM ${identityTable} WHERE unlinked_at IS NULL`
      )
      expect(result[0]?.count).toBe(1)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
  const [removed] = await db
    .select()
    .from(users)
    .where(sql`${users.id} = ${userIds[0]}`)
  expect(removed).toBeUndefined()
})

test('author filter migration keeps rollout squads OFF and defaults new squads ON', async () => {
  const filter = await Bun.file(new URL('../../drizzle/0208_github_author_filter.sql', import.meta.url)).text()
  const namespace = `author_filter_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      // An isolated stand-in resolves the migration's unqualified "squads" before public.squads.
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      await tx.execute(sql.raw(`CREATE TABLE "${namespace}"."squads" (id integer PRIMARY KEY)`))
      await tx.execute(sql.raw(`INSERT INTO "${namespace}"."squads" (id) VALUES (1)`))
      for (const statement of filter.split('--> statement-breakpoint'))
        if (statement.trim()) await tx.execute(sql.raw(statement))
      await tx.execute(sql.raw(`INSERT INTO "${namespace}"."squads" (id) VALUES (2)`))
      const rows = await tx.execute(
        sql.raw(`SELECT id, github_author_filter AS enabled FROM "${namespace}"."squads" ORDER BY id`)
      )
      expect(rows.map((row) => [row.id, row.enabled])).toEqual([
        [1, false],
        [2, true],
      ])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
