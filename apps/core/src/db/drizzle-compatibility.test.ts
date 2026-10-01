import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, getTableName, sql } from 'drizzle-orm'
import { alias, bigint, jsonb, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
import { db, withDedicatedDbTransaction, type DbTx } from './index'
import { getPostgresError } from './errors'
import { machines } from './schema'
import { provisionCapped } from '../services/machines/placement'
import { getMachineByName, insertMachine } from '../services/machines/queries'

// Temporary tables exercise the same column modes used by schema.ts without changing it.
const mapped = pgTable(`drizzle_compat_${randomUUID().replaceAll('-', '')}`, {
  id: uuid('id').primaryKey().defaultRandom(),
  strings: text('strings').array(),
  ids: uuid('ids').array(),
  data: jsonb('data').$type<{ nested: { value: string }; list: number[] }>(),
  at: timestamp('at'),
  order: bigint('enqueue_order', { mode: 'bigint' })
    .notNull()
    .default(sql`nextval('pg_temp.drizzle_compat_seq')`),
  embedding: vector('embedding', { dimensions: 3 }),
})

for (const [name, transaction] of [
  ['shared', (fn: (tx: DbTx) => Promise<void>) => db.transaction(fn)],
  ['dedicated', withDedicatedDbTransaction<void>],
] as const) {
  test(`${name} transactions round-trip arrays, JSONB, timestamps, bigint sequences, vectors and aliased joins`, async () => {
    await transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP SEQUENCE drizzle_compat_seq START 9007199254740993`)
      await tx.execute(sql`CREATE TEMP TABLE ${sql.identifier(getTableName(mapped))} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), strings text[], ids uuid[], data jsonb,
        at timestamp, enqueue_order bigint NOT NULL DEFAULT nextval('pg_temp.drizzle_compat_seq'), embedding vector(3)
      ) ON COMMIT DROP`)
      const id = randomUUID()
      const value = {
        id,
        strings: ['comma,value', '"quoted"', '\\slash', '', 'NULL', 'λ'],
        ids: [randomUUID()],
        data: { nested: { value: 'quote"; --' }, list: [1, 2] },
        at: new Date('2026-01-02T03:04:05.123Z'),
        embedding: [0.25, -0.5, 1],
      }
      const [inserted] = await tx.insert(mapped).values(value).returning()
      expect(inserted).toEqual({ ...value, order: 9007199254740993n })
      const [empty] = await tx
        .insert(mapped)
        .values({ strings: [], ids: [], data: null, at: null, embedding: null })
        .returning()
      expect(empty).toMatchObject({
        strings: [],
        ids: [],
        data: null,
        at: null,
        embedding: null,
        order: 9007199254740994n,
      })
      const other = alias(mapped, 'compat_alias')
      const [joined] = await tx
        .select({ left: mapped, right: other })
        .from(mapped)
        .innerJoin(other, eq(mapped.id, other.id))
        .where(eq(mapped.id, id))
      expect(joined).toEqual({ left: inserted, right: inserted })
      await tx.execute(sql`DROP SEQUENCE pg_temp.drizzle_compat_seq CASCADE`)
    })
  })

  test(`${name} transaction rolls back a write after a wrapped unique violation`, async () => {
    const machineName = `drizzle-rollback-${randomUUID()}`
    let failure: unknown
    try {
      await transaction(async (tx) => {
        const values = {
          name: machineName,
          provider: 'ssh',
          sshHost: 'localhost',
          sshUser: 'test',
          sshKeyId: 'test',
          sshPublicKey: 'test',
        }
        await tx.insert(machines).values(values)
        await tx.insert(machines).values(values)
      })
    } catch (error) {
      failure = error
    }
    try {
      expect(getPostgresError(failure)?.code).toBe('23505')
      expect(await getMachineByName(machineName)).toBeNull()
    } finally {
      await db.delete(machines).where(eq(machines.name, machineName))
    }
  })
}

test('machine placement adopts a real database race winner through a wrapped unique violation', async () => {
  const name = `drizzle-race-${randomUUID()}`
  const values = {
    name,
    provider: 'ssh',
    sshHost: 'localhost',
    sshUser: 'test',
    sshKeyId: 'test',
    sshPublicKey: 'test',
  }
  const winner = await insertMachine(values)
  let calls = 0
  try {
    const adopted = await provisionCapped(
      {
        countMachines: async () => 0,
        maxMachines: 50,
        getMachineByName,
        provisionMachine: async () => {
          calls++
          return insertMachine(values)
        },
      },
      { name, purpose: 'dedicated', scope: 'dedicated' }
    )
    expect(adopted.id).toBe(winner.id)
    expect(calls).toBe(1)
  } finally {
    await db.delete(machines).where(eq(machines.name, name))
  }
})
