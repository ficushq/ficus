import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'
import { MONOREPO_ROOT } from '../lib/paths'
import { db } from './index'

type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown> }> }
const folder = join(MONOREPO_ROOT, 'apps/core/drizzle')
const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}
const entry = () => journal.entries.find(({ tag }) => tag.endsWith('_credential_detection_authority'))

test('credential detection migration follows actual canonical main and preserves every prior table', async () => {
  const current = entry()
  expect(current).toBeDefined()
  const prior = journal.entries[current!.idx - 1]!
  expect(prior.tag).toBe('0234_github_raw_feedback_freshness')
  expect(current!.idx).toBe(prior.idx + 1)
  expect(current!.when).toBeGreaterThan(prior.when)
  const image = (idx: number) =>
    Bun.file(join(folder, `meta/${String(idx).padStart(4, '0')}_snapshot.json`)).json() as Promise<Snapshot>
  const parent = await image(prior.idx)
  const child = await image(current!.idx)
  expect(child.prevId).toBe(parent.id)
  expect(child.id).not.toBe(parent.id)
  expect(Object.keys(child.tables).sort()).toEqual(
    [...Object.keys(parent.tables), 'public.squad_env_detections', 'public.integration_credential_retirements'].sort()
  )
  const expectedSquads = structuredClone(parent.tables['public.squads']!)
  expectedSquads.columns.env_detection_bootstrapped = {
    name: 'env_detection_bootstrapped',
    type: 'boolean',
    primaryKey: false,
    notNull: true,
    default: false,
  }
  for (const [name, table] of Object.entries(parent.tables)) {
    expect(child.tables[name]).toEqual(name === 'public.squads' ? expectedSquads : table)
  }
  expect(child.tables['public.github_feedback_sources']!.columns.unfiltered).toBeDefined()
  expect(child.tables['public.sandbox_exposure_cleanup']).toBeDefined()
})

test('generated SQL marks legacy squads pending, cascades env state only and preserves encrypted credentials', async () => {
  const target = readMigrationFiles({ migrationsFolder: folder }).find(({ sql }) =>
    sql.join('\n').includes('CREATE TABLE "squad_env_detections"')
  )
  expect(target).toBeDefined()
  const namespace = `detection_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned synthetic migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}"`))
      await tx.execute(sql`CREATE TABLE squads (id uuid PRIMARY KEY)`)
      await tx.execute(
        sql`CREATE TABLE secrets (key text PRIMARY KEY, encrypted_value text NOT NULL, iv text NOT NULL)`
      )
      const id = crypto.randomUUID()
      await tx.execute(sql`INSERT INTO squads VALUES (${id})`)
      await tx.execute(sql`INSERT INTO secrets VALUES ('SYNTH_OPERATOR', 'synthetic-ciphertext', 'synthetic-iv')`)
      // Replay unmodified generated statements against this owned namespace,
      // redirecting only their explicit public-schema FK qualification.
      for (const statement of target!.sql)
        await tx.execute(sql.raw(statement.replaceAll('"public".', `"${namespace}".`)))
      expect([...(await tx.execute(sql`SELECT env_detection_bootstrapped FROM squads`))]).toEqual([
        { env_detection_bootstrapped: false },
      ])
      await tx.execute(sql`INSERT INTO squad_env_detections (squad_id, entries) VALUES (${id}, '[]'::jsonb)`)
      await tx.execute(sql`UPDATE squads SET env_detection_bootstrapped = true WHERE id = ${id}`)
      await tx.execute(sql`DELETE FROM squad_env_detections WHERE squad_id = ${id}`)
      expect([...(await tx.execute(sql`SELECT env_detection_bootstrapped FROM squads`))]).toEqual([
        { env_detection_bootstrapped: true },
      ])
      await tx.execute(sql`INSERT INTO squad_env_detections (squad_id) VALUES (${id})`)
      await tx.execute(
        sql`INSERT INTO integration_credential_retirements (credential_key, encrypted_value, iv, expires_at) VALUES ('__integration-credential:synthetic', 'synthetic-ciphertext', 'synthetic-iv', now() + interval '1 hour')`
      )
      await tx.execute(sql`DELETE FROM squads WHERE id = ${id}`)
      expect([...(await tx.execute(sql`SELECT * FROM squad_env_detections`))]).toEqual([])
      expect([...(await tx.execute(sql`SELECT credential_key FROM integration_credential_retirements`))]).toEqual([
        { credential_key: '__integration-credential:synthetic' },
      ])
      expect([...(await tx.execute(sql`SELECT * FROM secrets`))]).toEqual([
        { key: 'SYNTH_OPERATOR', encrypted_value: 'synthetic-ciphertext', iv: 'synthetic-iv' },
      ])
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
