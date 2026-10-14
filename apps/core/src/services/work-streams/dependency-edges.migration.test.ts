import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db, squads, workStreams } from '../../db'
import { WorkStream } from '../../entities/WorkStream'

const migrationPath = new URL('../../../drizzle/0206_real_molly_hayes.sql', import.meta.url)
let squadId: string

beforeAll(async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `dependency-edges-migration-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadId = squad!.id
})
afterAll(async () => {
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

test('the migration only adds a defaulted column: existing rows are not rewritten', async () => {
  const migration = await Bun.file(migrationPath).text()
  expect(migration.trim()).toBe(
    `ALTER TABLE "work_streams" ADD COLUMN "dependency_edges" jsonb DEFAULT '{}'::jsonb NOT NULL;`
  )
  expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\b/i)
})

test('a row written without the column, as existing rows were, reads as plain done dependencies', async () => {
  const [dependency] = await db.insert(workStreams).values({ squadId, title: 'dependency' }).returning()
  // Raw SQL naming only pre-existing columns: exactly what a pre-migration row carries.
  const [inserted] = await db.execute<{ id: string }>(
    sql`INSERT INTO work_streams (squad_id, title, status, depends_on) VALUES (${squadId}, 'existing dependent', 'queued', ARRAY[${dependency!.id}]::uuid[]) RETURNING id`
  )
  const existing = await WorkStream.mustFind(inserted!.id)
  expect(existing.dependsOn).toEqual([dependency!.id])
  expect(existing.dependencyEdges).toEqual({})
  expect(existing.toJson().dependencies).toEqual([
    { workStreamId: dependency!.id, condition: 'done', satisfied: false },
  ])
})
