import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'
import { MONOREPO_ROOT } from '../lib/paths'
import { db } from './index'

const folder = join(MONOREPO_ROOT, 'apps/core/drizzle')
type Snapshot = { id: string; prevId: string; tables: Record<string, unknown> }

test('provision flight migration extends the canonical credential detection snapshot without other schema changes', async () => {
  const { entries } = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
    entries: Array<{ idx: number; tag: string; when: number }>
  }
  const current = entries.find((e) => e.tag.endsWith('_vm_box_provision_attempts'))!
  expect(current).toBeDefined()
  const previous = entries[current.idx - 1]!
  expect(previous.tag).toBe('0235_credential_detection_authority')
  expect(current.idx).toBe(previous.idx + 1)
  expect(current.when).toBeGreaterThan(previous.when)
  const read = (index: number): Promise<Snapshot> =>
    Bun.file(join(folder, `meta/${String(index).padStart(4, '0')}_snapshot.json`)).json()
  const before = await read(previous.idx)
  const after = await read(current.idx)
  expect(after.prevId).toBe(before.id)
  expect(after.id).not.toBe(before.id)
  expect(Object.keys(after.tables).sort()).toEqual(
    [...Object.keys(before.tables), 'public.vm_box_provision_attempts'].sort()
  )
  for (const [name, table] of Object.entries(before.tables)) expect(after.tables[name]).toEqual(table)
})

test('generated flight SQL replays in an owned namespace and gives monotonically ordered results without a box FK', async () => {
  const migration = readMigrationFiles({ migrationsFolder: folder }).find((m) =>
    m.sql.join('\n').includes('CREATE TABLE "vm_box_provision_attempts"')
  )!
  expect(migration).toBeDefined()
  const namespace = `provision_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('synthetic migration rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}"`))
      for (const statement of migration.sql) await tx.execute(sql.raw(statement))
      // New boxes do not yet have a machine_boxes row; ownership/results must
      // work before placement/bind and survive row/machine deletion.
      const first = await tx.execute(
        sql`INSERT INTO vm_box_provision_attempts (sandbox_id) VALUES ('synthetic-unbound-box') RETURNING id, status`
      )
      const second = await tx.execute(
        sql`INSERT INTO vm_box_provision_attempts (sandbox_id, status, completed_at) VALUES ('synthetic-unbound-box', 'succeeded', now()) RETURNING id`
      )
      expect(first[0]!.status).toBe('running')
      expect(Number(second[0]!.id)).toBeGreaterThan(Number(first[0]!.id))
      const columns = await tx.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${namespace} AND table_name = 'vm_box_provision_attempts' ORDER BY ordinal_position`
      )
      expect(columns.map((c) => c.column_name)).toEqual([
        'id',
        'sandbox_id',
        'status',
        'failure_class',
        'failure_count',
        'retry_at',
        'created_at',
        'completed_at',
      ])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
