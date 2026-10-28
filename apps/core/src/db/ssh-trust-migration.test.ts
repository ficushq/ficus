import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'

// Apply the generated migration's own SQL to isolated pre-migration copies of machines and squads,
// never to the shared tables.
const migration = await Bun.file(new URL('../../drizzle/0221_ssh_trust_keys.sql', import.meta.url)).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())

test('ssh trust migration marks every endpoint Core already connected to for adoption', async () => {
  const namespace = `ssh_trust_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      // machines and squads as they were before the migration (only the columns it reads).
      await tx.execute(
        sql.raw(`CREATE TABLE "machines" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "name" text NOT NULL, "provider" text NOT NULL,
          "ssh_host" text NOT NULL, "ssh_port" integer NOT NULL DEFAULT 22, "created_at" timestamp NOT NULL DEFAULT now())`)
      )
      await tx.execute(
        sql.raw(
          `CREATE TABLE "squads" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "metadata" jsonb NOT NULL DEFAULT '{}')`
        )
      )
      await tx.execute(
        sql.raw(`INSERT INTO "machines" ("id", "name", "provider", "ssh_host", "ssh_port") VALUES
          ('11111111-1111-4111-8111-111111111111', 'byo', 'ssh', '10.0.0.9', 2222),
          ('22222222-2222-4222-8222-222222222222', 'vm', 'exe', 'vm.exe.xyz', 22)`)
      )
      await tx.execute(
        sql.raw(`INSERT INTO "squads" ("id", "metadata") VALUES
          ('33333333-3333-4333-8333-333333333333', '{"memory":{"sync":{"providers":[
            {"type":"git","repoUrl":"git@GitHub.com:org/mem.git"},
            {"type":"git","repoUrl":"https://github.com/org/other.git"},
            {"type":"s3","bucket":"b"}]}}}'),
          ('44444444-4444-4444-8444-444444444444', '{"memory":{"sync":{"providers":"not-an-array"}}}'),
          ('55555555-5555-4555-8555-555555555555', '{}')`)
      )

      for (const statement of statements) await tx.execute(sql.raw(statement))

      const rows = await tx.execute(
        sql.raw(
          `SELECT "scope", "kind", "squad_id", "ssh_host", "ssh_port", "adoption_pending" FROM "${namespace}"."ssh_trust_targets" ORDER BY "scope"`
        )
      )
      expect(rows.map((r) => ({ ...r }))).toEqual([
        {
          scope: 'exe-api',
          kind: 'exe-api',
          squad_id: null,
          ssh_host: 'exe.dev',
          ssh_port: 22,
          adoption_pending: true,
        },
        {
          scope: 'machine:11111111-1111-4111-8111-111111111111',
          kind: 'machine',
          squad_id: null,
          ssh_host: '10.0.0.9',
          ssh_port: 2222,
          adoption_pending: true,
        },
        {
          scope: 'machine:22222222-2222-4222-8222-222222222222',
          kind: 'exe-machine',
          squad_id: null,
          ssh_host: 'vm.exe.xyz',
          ssh_port: 22,
          adoption_pending: true,
        },
        {
          scope: 'memory-git:33333333-3333-4333-8333-333333333333:github.com',
          kind: 'memory-git',
          squad_id: '33333333-3333-4333-8333-333333333333',
          ssh_host: 'github.com',
          ssh_port: 22,
          adoption_pending: true,
        },
      ])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
