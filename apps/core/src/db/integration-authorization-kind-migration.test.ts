import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

// Apply the generated migration's own SQL to an isolated pre-migration copy of the table,
// never to the shared integration_connections table.
const migration = await Bun.file(
  new URL('../../drizzle/0252_integration_connection_authorization_kind.sql', import.meta.url)
).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())
const backfill = statements.filter((statement) => statement.includes('UPDATE "integration_connections"'))

test('authorization kind migration marks OAuth2-plugin and brokered Slack rows oauth2, keeps the rest manual, and is re-runnable', async () => {
  expect(backfill).toHaveLength(1)
  const namespace = `authorization_kind_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      // Only the columns the migration reads or writes, as they were before it.
      await tx.execute(
        sql.raw(
          `CREATE TABLE "integration_connections" ("display_name" text PRIMARY KEY, "provider_key" varchar(64) NOT NULL, "client_authority" varchar(32) NOT NULL DEFAULT 'local')`
        )
      )
      await tx.execute(
        sql.raw(`INSERT INTO "integration_connections" VALUES
          ('github-local', 'github', 'local'),
          ('github-broker', 'github', 'platform_broker'),
          ('notion-broker', 'notion', 'platform_broker'),
          ('slack-managed', 'slack', 'platform_broker'),
          ('slack-manual', 'slack', 'local'),
          ('linear-key', 'linear', 'local'),
          ('bigbrain-local', 'bigbrain', 'local'),
          ('telegram-local', 'telegram', 'local')`)
      )
      const rows = async () =>
        Object.fromEntries(
          (
            await tx.execute(
              sql.raw(`SELECT "display_name", "authorization_kind" FROM "${namespace}"."integration_connections"`)
            )
          ).map((row) => [row.display_name as string, row.authorization_kind as string])
        )
      const expected = {
        'github-local': 'oauth2',
        'github-broker': 'oauth2',
        'notion-broker': 'oauth2',
        'slack-managed': 'oauth2',
        'slack-manual': 'manual',
        'linear-key': 'manual',
        'bigbrain-local': 'manual',
        'telegram-local': 'manual',
      }

      for (const statement of statements) await tx.execute(sql.raw(statement))
      expect(await rows()).toEqual(expected)

      // New rows default to manual, and the check constraint rejects unknown kinds.
      await tx.execute(sql.raw(`INSERT INTO "integration_connections" VALUES ('linear-new', 'linear', 'local')`))
      expect((await rows())['linear-new']).toBe('manual')
      await tx.execute(sql.raw('SAVEPOINT invalid_kind'))
      const invalid = await tx
        .execute(
          sql.raw(
            `INSERT INTO "integration_connections" ("display_name", "provider_key", "authorization_kind") VALUES ('bad', 'linear', 'device')`
          )
        )
        .then(
          () => null,
          (error: unknown) => error
        )
      expect(String((invalid as { cause?: unknown } | null)?.cause)).toContain(
        'integration_connections_authorization_kind_check'
      )
      await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT invalid_kind'))

      // Running the backfill again changes nothing.
      for (const statement of backfill) await tx.execute(sql.raw(statement))
      expect(await rows()).toEqual({ ...expected, 'linear-new': 'manual' })
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
