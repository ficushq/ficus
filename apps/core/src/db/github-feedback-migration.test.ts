import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { users } from './schema'

// Apply the generator's SQL, not a push-built table or supplemented preload index.
// Namespace-only substitutions isolate owned tables without touching other fixtures.
const migration = await Bun.file(new URL('../../drizzle/0203_github_feedback_trust.sql', import.meta.url)).text()
// The consolidated migration also widens existing integration tables; the isolated fixture below
// applies only the statements that create or constrain this feature's own github_* tables.
const ownTableStatements = migration
  .split('--> statement-breakpoint')
  .filter((statement) =>
    /^\s*(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX "[a-z_]+" ON) "github_/.test(statement)
  )

test('generated moderation migration is additive and does not grant or replay historical feedback', () => {
  expect(migration).toContain('CREATE UNIQUE INDEX "github_personal_identity_active_account"')
  expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)\s+(?:INTO|FROM|TABLE|INDEX|"github_)/i)
  expect(migration.match(/CREATE TABLE /g)).toHaveLength(8)
  expect(migration).not.toMatch(/CREATE TABLE "(?!github_)/)
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
      for (const statement of ownTableStatements) {
        await tx.execute(sql.raw(statement.replaceAll(/"public"\."(github_[a-z_]+)"/g, `"${namespace}"."$1"`)))
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

// Every generated migration this feature adds. Renumbering (e.g. after integrating main) must update
// this list, so the rollout/rollback audit below cannot silently skip a file.
const FEATURE_MIGRATIONS = ['0203_github_feedback_trust', '0204_github_author_filter', '0206_bouncy_loners']

test('feature migrations never rewrite, replay or drop pre-existing data, so rollback only drops new objects', async () => {
  const created = new Set<string>()
  for (const tag of FEATURE_MIGRATIONS) {
    const text = await Bun.file(new URL(`../../drizzle/${tag}.sql`, import.meta.url)).text()
    for (const match of text.matchAll(/CREATE TABLE "([a-z_]+)"/g)) created.add(match[1]!)
    // No backfill, replay, release or deletion of historical rows in any table.
    expect(text).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE)\b/i)
    expect(text).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|INDEX)\b|\bRENAME\b/i)
    for (const statement of text.split('--> statement-breakpoint')) {
      const table = statement.match(/ALTER TABLE "([a-z_]+)"/)?.[1]
      if (!table || created.has(table)) continue
      // Pre-existing tables: new NOT NULL columns carry a default, nullability is never tightened.
      if (/ADD COLUMN/.test(statement) && /NOT NULL/.test(statement)) expect(statement).toMatch(/DEFAULT/)
      expect(statement).not.toMatch(/SET NOT NULL|DROP NOT NULL/)
      // A dropped constraint on an existing table is re-added (widened) under the same name.
      const dropped = statement.match(/DROP CONSTRAINT "([a-z_]+)"/)?.[1]
      if (dropped) expect(text).toContain(`ADD CONSTRAINT "${dropped}"`)
    }
  }
  // Pre-existing rows satisfy every new or widened constraint with their column defaults.
  for (const table of ['integration_authorization_flow_receipts', 'integration_oauth_states']) {
    const invalid = await db.execute(
      sql.raw(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass AND contype = 'c' AND NOT convalidated`
      )
    )
    expect(invalid.map((row) => row.conname)).toEqual([])
  }
})

test('author filter migration keeps rollout squads OFF and defaults new squads ON', async () => {
  const filter = await Bun.file(new URL('../../drizzle/0204_github_author_filter.sql', import.meta.url)).text()
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

test('untrusted handling migration defaults existing and new squads to hold', async () => {
  const migration = await Bun.file(new URL('../../drizzle/0206_bouncy_loners.sql', import.meta.url)).text()
  const [statement] = migration
    .split('--> statement-breakpoint')
    .filter((part) => part.includes('"github_untrusted_handling"'))
  expect(statement).toContain(`ADD COLUMN "github_untrusted_handling" text DEFAULT 'hold' NOT NULL`)
  const namespace = `untrusted_handling_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      // An isolated stand-in resolves the migration's unqualified "squads" before public.squads.
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      await tx.execute(sql.raw(`CREATE TABLE "${namespace}"."squads" (id integer PRIMARY KEY)`))
      await tx.execute(sql.raw(`INSERT INTO "${namespace}"."squads" (id) VALUES (1)`))
      await tx.execute(sql.raw(statement!))
      await tx.execute(sql.raw(`INSERT INTO "${namespace}"."squads" (id) VALUES (2)`))
      const rows = await tx.execute(
        sql.raw(`SELECT id, github_untrusted_handling AS handling FROM "${namespace}"."squads" ORDER BY id`)
      )
      expect(rows.map((row) => [row.id, row.handling])).toEqual([
        [1, 'hold'],
        [2, 'hold'],
      ])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
