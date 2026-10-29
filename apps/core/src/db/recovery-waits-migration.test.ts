import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'
import { MONOREPO_ROOT } from '../lib/paths'
import { initialRecoveryState } from '../services/recovery/policy'
import { db } from './index'

type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown> }> }
const folder = join(MONOREPO_ROOT, 'apps/core/drizzle')
const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}
const entry = journal.entries.find(({ tag }) => tag.endsWith('_structured_recovery_waits'))!

test('recovery migration extends the actual canonical parent without changing existing wait history', async () => {
  expect(entry).toBeDefined()
  const prior = journal.entries[entry.idx - 1]!
  expect(entry.idx).toBe(prior.idx + 1)
  expect(entry.when).toBeGreaterThan(prior.when)
  const image = (idx: number) =>
    Bun.file(join(folder, `meta/${String(idx).padStart(4, '0')}_snapshot.json`)).json() as Promise<Snapshot>
  const parent = await image(prior.idx)
  const child = await image(entry.idx)
  expect(child.prevId).toBe(parent.id)
  expect(child.id).not.toBe(parent.id)
  expect(Object.keys(child.tables).sort()).toEqual(
    [
      ...Object.keys(parent.tables),
      'public.recovery_episodes',
      'public.recovery_attempts',
      'public.recovery_decisions',
    ].sort()
  )
  const waits = structuredClone(parent.tables['public.work_stream_waits']!)
  waits.columns.structured = { name: 'structured', type: 'jsonb', primaryKey: false, notNull: false }
  for (const [name, table] of Object.entries(parent.tables))
    expect(child.tables[name]).toEqual(name === 'public.work_stream_waits' ? waits : table)
})

test('generated recovery SQL enforces accounting fences and survives execution-log pruning in an owned namespace', async () => {
  const migration = readMigrationFiles({ migrationsFolder: folder }).find(({ sql }) =>
    sql.join('\n').includes('CREATE TABLE "recovery_episodes"')
  )!
  expect(migration).toBeDefined()
  const namespace = `recovery_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned recovery migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"; SET LOCAL search_path TO "${namespace}"`))
      for (const table of ['agents', 'users', 'work_streams', 'executions'])
        await tx.execute(sql.raw(`CREATE TABLE "${table}" (id uuid PRIMARY KEY)`))
      await tx.execute(
        sql`CREATE TABLE work_stream_waits (id uuid PRIMARY KEY, message text, actor text NOT NULL DEFAULT 'human')`
      )
      const agent = crypto.randomUUID(),
        execution = crypto.randomUUID(),
        wait = crypto.randomUUID()
      await tx.execute(sql`INSERT INTO agents VALUES (${agent})`)
      await tx.execute(sql`INSERT INTO executions VALUES (${execution})`)
      await tx.execute(sql`INSERT INTO work_stream_waits (id, message) VALUES (${wait}, 'Existing input')`)
      for (const statement of migration.sql)
        await tx.execute(sql.raw(statement.replaceAll('"public".', `"${namespace}".`)))
      expect([...(await tx.execute(sql`SELECT message, actor, structured FROM work_stream_waits`))]).toEqual([
        { message: 'Existing input', actor: 'human', structured: null },
      ])
      const state = JSON.stringify(initialRecoveryState('start the task'))
      const [record] = await tx.execute<{ id: string }>(
        sql`INSERT INTO recovery_episodes (agent_id, execution_id, operation_key, state) VALUES (${agent}, ${execution}, 'same-operation', ${state}::jsonb) RETURNING id`
      )
      await tx.execute(
        sql`INSERT INTO recovery_episodes (agent_id, execution_id, operation_key, state) VALUES (${agent}, ${execution}, 'same-operation', ${state}::jsonb) ON CONFLICT DO NOTHING`
      )
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM recovery_episodes`))[0]?.count).toBe(1)
      for (let delivery = 0; delivery < 2; delivery++) {
        await tx.execute(
          sql`INSERT INTO recovery_attempts (recovery_id, execution_id, invocation_id, outcome) VALUES (${record!.id}, ${execution}, 'one-invocation', 'unknown') ON CONFLICT DO NOTHING`
        )
        await tx.execute(
          sql`INSERT INTO recovery_decisions (recovery_id, version, action) VALUES (${record!.id}, 0, 'continue') ON CONFLICT DO NOTHING`
        )
      }
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM recovery_attempts`))[0]?.count).toBe(1)
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM recovery_decisions`))[0]?.count).toBe(1)
      await expect(
        tx.transaction(async (savepoint) => {
          await savepoint.execute(
            sql`UPDATE recovery_episodes SET state = jsonb_set(state, '{managerCycles}', '2'::jsonb)`
          )
        })
      ).rejects.toThrow()
      await tx.execute(sql`DELETE FROM executions WHERE id = ${execution}`)
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM recovery_episodes`))[0]?.count).toBe(1)
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM recovery_attempts`))[0]?.count).toBe(1)
      await tx.execute(sql`UPDATE recovery_episodes SET state = jsonb_set(state, '{state}', '"resolved"'::jsonb)`)
      await tx.execute(
        sql`INSERT INTO recovery_episodes (agent_id, execution_id, operation_key, state) VALUES (${agent}, ${execution}, 'same-operation', ${state}::jsonb)`
      )
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM recovery_episodes`))[0]?.count).toBe(2)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
