import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { assertMigrationsMatchBuild, MIGRATION_BUILD_MISMATCH } from './migration-build-manifest'
import { applyMigrations, migrateDatabase } from './migrator'

const migrationsFolder = join(MONOREPO_ROOT, 'apps/core/drizzle')
const migrations = readMigrationFiles({ migrationsFolder })
const journalPath = (folder: string) => join(folder, 'meta/_journal.json')
const journal = JSON.parse(readFileSync(journalPath(migrationsFolder), 'utf8')) as {
  entries: { idx: number; tag: string; when: number; version: string; breakpoints: boolean }[]
}
// Self-hosted snapshot from 2026-09-10: 172 migrations applied, 20 pending together.
const snapshotTag = '0171_misty_shen'
const snapshotMillis = journal.entries.find((entry) => entry.tag === snapshotTag)!.when
const applied = migrations.filter((migration) => migration.folderMillis <= snapshotMillis)
const urlFor = (name: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('upgrading a database many migrations behind', () => {
  const databaseName = `batched_upgrade_${crypto.randomUUID().replaceAll('-', '')}`
  const squadId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const conciergeId = crypto.randomUUID()
  const managerId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  // Out of creation order, so numbering must follow created_at rather than insertion.
  const streams = Array.from({ length: 30 }, (_, i) => ({
    id: crypto.randomUUID(),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 30 - i)).toISOString(),
  }))
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    client = createPostgresConnection(urlFor(databaseName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, applied)
    await connection`INSERT INTO users (id,email) VALUES (${userId},'owner@example.com')`
    await connection`INSERT INTO squads (id,name,purpose) VALUES (${squadId},'Squad','test')`
    for (const stream of streams) {
      await connection`INSERT INTO work_streams (id,squad_id,title,created_at)
        VALUES (${stream.id},${squadId},'Existing work',${stream.createdAt})`
    }
    await connection`INSERT INTO agent_types (id,name,model,system_prompt) VALUES
      ('concierge','Concierge','model','Old prompt'), ('assistant-manager','Manager','model','Prompt')`
    await connection`INSERT INTO agents (id,agent_type_id,squad_id) VALUES
      (${conciergeId},'concierge',${squadId}), (${managerId},'assistant-manager',${squadId})`
    await connection`INSERT INTO channel_instances (id,name,provider,default_squad_id,concierge_agent_id)
      VALUES ('test-bot','Bot','telegram',${squadId},${conciergeId})`
    await connection`INSERT INTO assistant_conversations (id,owner_user_id,manager_agent_id)
      VALUES (${conversationId},${userId},${managerId})`
  }, 60_000)
  afterAll(async () => {
    connection?.release()
    await client?.end()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  })

  test('the pending batch spans 0179 and other hooked migrations', () => {
    const pending = migrations.slice(applied.length).map((migration) => migration.sql.join('\n'))
    expect(applied).toHaveLength(172)
    expect(pending.length).toBeGreaterThanOrEqual(20)
    const numberDefault = pending.findIndex((sql) => sql.includes('ALTER COLUMN "number" SET DEFAULT'))
    expect(numberDefault).toBeGreaterThan(0)
    expect(pending.findIndex((sql) => sql.includes('DROP COLUMN "concierge_agent_id"'))).toBeLessThan(numberDefault)
    expect(pending.findIndex((sql) => sql.includes('DROP COLUMN "manager_agent_id"'))).toBeLessThan(numberDefault)
  })

  test('startup migration applies every pending migration and numbers every existing work stream', async () => {
    await migrateDatabase(connection, { migrationsFolder })

    const [ledger] = await connection`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
    expect(ledger!.count).toBe(migrations.length)
    const rows = await connection`SELECT id, number FROM work_streams ORDER BY number`
    const expectedOrder = [...streams].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((s) => s.id)
    expect(rows.map((row) => row.id)).toEqual(expectedOrder)
    expect(rows.map((row) => row.number)).toEqual(streams.map((_, i) => i + 1))
    const [next] =
      await connection`INSERT INTO work_streams (squad_id,title) VALUES (${squadId},'New') RETURNING number`
    expect(next!.number).toBe(streams.length + 1)

    // Other hooks in the same batch ran before their columns were dropped.
    const [binding] = await connection`SELECT agent_id FROM assistant_conversation_agents
      WHERE conversation_id = ${conversationId}`
    expect(binding?.agent_id).toBe(managerId)
    const [concierge] = await connection`SELECT agent_type_id FROM agents WHERE id = ${conciergeId}`
    expect(concierge!.agent_type_id).toBe('consultant')
  })
})

describe('migrations that do not match the build', () => {
  let folder: string
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'migration-build-manifest-'))
    cpSync(migrationsFolder, folder, { recursive: true })
  })
  afterAll(() => rmSync(folder, { recursive: true, force: true }))
  const writeJournal = (entries: typeof journal.entries) =>
    writeFileSync(journalPath(folder), JSON.stringify({ ...journal, entries }))
  const last = journal.entries.at(-1)!
  const future = { ...last, idx: last.idx + 1, when: last.when + 1, tag: `${last.idx + 1}_future_backfill` }

  test('the checked-out migrations match this build', () => {
    expect(() => assertMigrationsMatchBuild(migrationsFolder)).not.toThrow()
  })

  test('a build older than the folder refuses in migrateDatabase before touching the database', async () => {
    writeFileSync(join(folder, `${future.tag}.sql`), 'SELECT 1')
    writeJournal([...journal.entries, future])
    let queried = false
    const connection = new Proxy({} as postgres.ReservedSql, {
      get: () => {
        queried = true
        throw new Error('the database must not be touched')
      },
    })
    await expect(migrateDatabase(connection, { migrationsFolder: folder })).rejects.toThrow(
      new RegExp(
        `^\\[${MIGRATION_BUILD_MISMATCH}\\] Refusing to migrate: .* has ${journal.entries.length} migrations .*` +
          `first differ at #${future.idx} \\(build none, folder ${future.tag}\\), so the build predates the folder\\.`
      )
    )
    expect(queried).toBe(false)
  })

  test('names the direction of the mismatch', () => {
    writeJournal(journal.entries.slice(0, -1))
    expect(() => assertMigrationsMatchBuild(folder)).toThrow(
      `(build ${last.tag}, folder none), so the build is newer than the folder.`
    )
    writeJournal(journal.entries.map((entry, i) => (i === 179 ? { ...entry, tag: `${entry.tag}_edited` } : entry)))
    expect(() => assertMigrationsMatchBuild(folder)).toThrow('first differ at #179')
    expect(() => assertMigrationsMatchBuild(folder)).toThrow('so the build and the folder have diverged.')
  })

  test('gives the remedy for the install shape without printing connection strings', () => {
    writeJournal([...journal.entries, future])
    const refusal = (context: Parameters<typeof assertMigrationsMatchBuild>[1]) => {
      try {
        assertMigrationsMatchBuild(folder, context)
      } catch (error) {
        return (error as Error).message
      }
      throw new Error('expected a refusal')
    }
    // Source run: the build list is this tree's own journal, so only the root can be wrong.
    expect(refusal({ fromSource: true, ficusRoot: '/elsewhere' })).toContain(
      'This is a source run, so ' +
        folder +
        " is not this source tree's migrations folder: check FICUS_ROOT (/elsewhere)"
    )
    // Bundle in a tree without .git: an artifact, image or Desktop install.
    const artifact = refusal({ fromSource: false, ficusRoot: undefined })
    expect(artifact).toContain('install a matching release or image, or reinstall.')
    expect(artifact).not.toContain('build:core')
    expect(artifact).not.toContain('FICUS_ROOT')
    // Bundle in a source checkout.
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'migration-build-checkout-'))
    try {
      mkdirSync(join(checkoutRoot, '.git'))
      mkdirSync(join(checkoutRoot, 'apps/core'), { recursive: true })
      cpSync(folder, join(checkoutRoot, 'apps/core/drizzle'), { recursive: true })
      let message = ''
      try {
        assertMigrationsMatchBuild(join(checkoutRoot, 'apps/core/drizzle'), {
          fromSource: false,
          ficusRoot: checkoutRoot,
        })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('In this source checkout, rebuild Core (`bun run build:core`), then restart.')
      expect(message).toContain(`FICUS_ROOT is ${checkoutRoot}; check that it points at this build's install.`)
      expect(message).not.toContain('reinstall')
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
    for (const message of [artifact, refusal({ fromSource: true })]) expect(message).not.toMatch(/postgres(ql)?:\/\//)
  })
})
