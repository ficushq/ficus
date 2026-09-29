import { describe, expect, test } from 'bun:test'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { createPostgresConnection } from './connection'
import { applyMigrations, classifyMigration } from './migrator'

const migration = (sql: string[]): MigrationMeta => ({ sql, hash: 'hash', folderMillis: 1, bps: true })

describe('classifyMigration', () => {
  test('keeps ordinary DDL transactional', () => {
    expect(classifyMigration(migration(['ALTER TABLE "x" ADD COLUMN "y" text']))).toEqual({
      kind: 'transactional',
    })
  })

  test('accepts one generated concurrent index statement', () => {
    expect(
      classifyMigration(migration(['CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" USING btree ("y" text_pattern_ops)']))
    ).toEqual({ kind: 'concurrent-index', indexName: 'idx_x_y', tableSchema: 'public', tableName: 'x' })
  })

  test('parses a schema-qualified target table', () => {
    expect(classifyMigration(migration(['CREATE INDEX CONCURRENTLY "idx_x_y" ON "tenant_data"."x" ("y")']))).toEqual({
      kind: 'concurrent-index',
      indexName: 'idx_x_y',
      tableSchema: 'tenant_data',
      tableName: 'x',
    })
  })

  test('ignores empty statement fragments', () => {
    expect(classifyMigration(migration(['', '  ', 'CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" ("y")']))).toEqual({
      kind: 'concurrent-index',
      indexName: 'idx_x_y',
      tableSchema: 'public',
      tableName: 'x',
    })
  })

  test('rejects unsupported concurrent index syntax', () => {
    expect(() => classifyMigration(migration(['CREATE INDEX CONCURRENTLY idx_x_y ON x (y)']))).toThrow(
      'Unsupported CREATE INDEX CONCURRENTLY statement'
    )
  })

  test('allows semicolons inside SQL literals, identifiers, comments, and dollar quotes', () => {
    expect(
      classifyMigration(
        migration([
          `CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" ((CASE WHEN "semi;colon" = ';' THEN $$;$$ END)) /* ; */`,
        ])
      )
    ).toMatchObject({ kind: 'concurrent-index', indexName: 'idx_x_y' })
  })

  test('allows escaped quotes before semicolons in PostgreSQL strings', () => {
    expect(
      classifyMigration(migration([`CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" ((E'quote\\';semicolon'))`]))
    ).toMatchObject({ kind: 'concurrent-index', indexName: 'idx_x_y' })
  })

  test('ignores line and block comments after the terminating semicolon', () => {
    for (const suffix of ['; -- generated comment', '; /* generated comment */']) {
      expect(classifyMigration(migration([`CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" ("y")${suffix}`]))).toMatchObject(
        { kind: 'concurrent-index', indexName: 'idx_x_y' }
      )
    }
  })

  test('rejects a trailing command in the same concurrent-index SQL fragment', () => {
    expect(() =>
      classifyMigration(
        migration(['CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" ("y"); ALTER TABLE "x" ADD COLUMN "z" text'])
      )
    ).toThrow('must contain exactly one CREATE INDEX CONCURRENTLY statement')
  })

  test('rejects concurrent index DDL mixed with another statement', () => {
    expect(() =>
      classifyMigration(
        migration(['CREATE INDEX CONCURRENTLY "idx_x_y" ON "x" ("y")', 'ALTER TABLE "x" ADD COLUMN "z" text'])
      )
    ).toThrow('must contain exactly one CREATE INDEX CONCURRENTLY statement')
  })
})

describe('applyMigrations', () => {
  test('batches ordinary breakpoint statements without dropping their order or comment boundaries', async () => {
    const calls: string[] = []
    const connection = {
      unsafe: async (statement: string) => {
        calls.push(statement)
        return []
      },
    } as unknown as import('postgres').ReservedSql
    await applyMigrations(
      connection,
      migration([
        'CREATE TABLE "batch_fixture" (value text) -- trailing comment',
        'INSERT INTO "batch_fixture" VALUES (\'first;value\')',
        'ALTER TABLE "batch_fixture" ADD COLUMN extra text',
      ])
    )
    const payloads = calls.filter((statement) => statement.includes('"batch_fixture"'))
    expect(payloads).toEqual([
      'CREATE TABLE "batch_fixture" (value text) -- trailing comment\n;\nINSERT INTO "batch_fixture" VALUES (\'first;value\')\n;\nALTER TABLE "batch_fixture" ADD COLUMN extra text',
    ])
    expect(calls.indexOf('BEGIN')).toBeLessThan(calls.indexOf(payloads[0]!))
    expect(calls.indexOf('COMMIT')).toBeGreaterThan(calls.indexOf(payloads[0]!))
  })

  test('applies concurrent index DDL outside a transaction', async () => {
    const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
    const connection = await client.reserve()
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const table = `migrator_probe_${suffix}`
    const index = `idx_migrator_probe_${suffix}`
    const ledgerSchema = `migrator_test_${suffix}`

    try {
      await connection.unsafe(`CREATE TABLE "${table}" ("value" text NOT NULL)`)
      await applyMigrations(
        connection,
        migration([`CREATE INDEX CONCURRENTLY "${index}" ON "${table}" USING btree ("value" text_pattern_ops)`]),
        { migrationsSchema: ledgerSchema }
      )

      const ledger = await connection.unsafe<{ created_at: string }[]>(
        `SELECT created_at FROM "${ledgerSchema}"."__drizzle_migrations"`
      )
      expect(ledger).toHaveLength(1)
      expect(Number(ledger[0]?.created_at)).toBe(1)
    } finally {
      await connection.unsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`)
      await connection.unsafe(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`)
      connection.release()
      await client.end()
    }
  })

  test('preserves pending selection and rolls back ordinary batches atomically', async () => {
    const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
    const connection = await client.reserve()
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const schema = `ordinary_${suffix}`
    const ledgerTable = `ledger_${suffix}`
    const created = `created_${suffix}`
    const rolledBack = `rolled_back_${suffix}`
    try {
      await applyMigrations(
        connection,
        { ...migration(['SELECT 1']), folderMillis: 5 },
        {
          migrationsSchema: schema,
          migrationsTable: ledgerTable,
        }
      )
      await applyMigrations(
        connection,
        [
          { ...migration(['THIS MUST BE SKIPPED']), folderMillis: 4 },
          { ...migration([`CREATE TABLE "${created}" (id integer)`]), folderMillis: 6 },
        ],
        { migrationsSchema: schema, migrationsTable: ledgerTable }
      )
      expect((await connection`SELECT to_regclass(${`public.${created}`}) AS name`)[0]?.name).not.toBeNull()

      await expect(
        applyMigrations(
          connection,
          [
            { ...migration([`CREATE TABLE "${rolledBack}" (id integer)`]), folderMillis: 7 },
            { ...migration(['SELECT * FROM table_that_does_not_exist']), folderMillis: 8 },
          ],
          { migrationsSchema: schema, migrationsTable: ledgerTable }
        )
      ).rejects.toThrow()
      expect((await connection`SELECT to_regclass(${`public.${rolledBack}`}) AS name`)[0]?.name).toBeNull()
      const ledger = await connection.unsafe<{ created_at: string }[]>(
        `SELECT created_at FROM "${schema}"."${ledgerTable}" ORDER BY created_at`
      )
      expect(ledger.map((row) => Number(row.created_at))).toEqual([5, 6])
    } finally {
      await connection.unsafe(`DROP TABLE IF EXISTS "${created}" CASCADE`)
      await connection.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      connection.release()
      await client.end()
    }
  })

  test('recovers online intents and isolates same-name indexes by schema', async () => {
    const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
    const connection = await client.reserve()
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const schema = `recovery_${suffix}`
    const other = `other_${suffix}`
    const table = `probe_${suffix}`
    const online = (name: string, folderMillis: number, unique = false): MigrationMeta => ({
      sql: [`CREATE ${unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY "${name}" ON "${table}" ("value")`],
      folderMillis,
      hash: `hash-${folderMillis}`,
      bps: true,
    })
    const recordIntent = (item: MigrationMeta, name: string) =>
      connection.unsafe(
        `INSERT INTO "${schema}"."__tau_online_migration_intents" (created_at,hash,table_schema,index_name) VALUES ($1,$2,'public',$3)`, // ficus-36c
        [item.folderMillis, item.hash, name]
      )
    try {
      await connection.unsafe(
        `CREATE TABLE "${table}" ("dropped" text, "value" text NOT NULL, "other" text, "Case" text, "case" text)`
      )
      await connection.unsafe(`ALTER TABLE "${table}" DROP COLUMN "dropped"`)
      await applyMigrations(connection, [], { migrationsSchema: schema })

      const absentName = `idx_absent_${suffix}`
      const absent = online(absentName, 10)
      await recordIntent(absent, absentName)
      await applyMigrations(connection, absent, { migrationsSchema: schema })
      expect((await connection`SELECT to_regclass(${`public.${absentName}`}) AS name`)[0]?.name).not.toBeNull()

      const validName = `idx_valid_${suffix}`
      const valid = online(validName, 20)
      await connection.unsafe(valid.sql[0])
      const before = (await connection`SELECT to_regclass(${`public.${validName}`})::oid AS oid`)[0]?.oid
      await recordIntent(valid, validName)
      await applyMigrations(connection, valid, { migrationsSchema: schema })
      const after = (await connection`SELECT to_regclass(${`public.${validName}`})::oid AS oid`)[0]?.oid
      expect(after).toBe(before)

      let wrongFolder = 21
      const rejectWrongDefinition = async (actualDefinition: string, intendedDefinition: string) => {
        const name = `idx_wrong_${wrongFolder}_${suffix}`
        const intended: MigrationMeta = {
          sql: [`CREATE INDEX CONCURRENTLY "${name}" ON "${table}" ${intendedDefinition}`],
          folderMillis: wrongFolder,
          hash: `wrong-${wrongFolder}`,
          bps: true,
        }
        const actualUnique = actualDefinition.startsWith('UNIQUE ')
        const actualTail = actualUnique ? actualDefinition.slice('UNIQUE '.length) : actualDefinition
        await connection.unsafe(`CREATE ${actualUnique ? 'UNIQUE ' : ''}INDEX "${name}" ON "${table}" ${actualTail}`)
        await recordIntent(intended, name)
        await expect(applyMigrations(connection, intended, { migrationsSchema: schema })).rejects.toThrow(
          'does not match the intended migration definition'
        )
        await connection.unsafe(`DELETE FROM "${schema}"."__tau_online_migration_intents" WHERE created_at = $1`, [
          wrongFolder,
        ])
        await connection.unsafe(`DROP INDEX "${name}"`)
        wrongFolder += 1
      }
      await rejectWrongDefinition('UNIQUE ("value")', '("value")')
      await rejectWrongDefinition('("value")', '("other")')
      await rejectWrongDefinition('("value" text_pattern_ops)', '("value")')
      await rejectWrongDefinition('(lower("value"))', '(upper("value"))')
      await rejectWrongDefinition('("value") WHERE "value" = \'A B\'', '("value") WHERE "value" = \'ab\'')
      await rejectWrongDefinition('("Case")', '("case")')

      const wrongName = `idx_wrong_${suffix}`
      const wrong = online(wrongName, 25)
      const wrongTable = `wrong_${suffix}`
      await connection.unsafe(`CREATE TABLE "${wrongTable}" ("value" text NOT NULL)`)
      await connection.unsafe(`CREATE INDEX "${wrongName}" ON "${wrongTable}" ("value")`)
      await recordIntent(wrong, wrongName)
      await expect(applyMigrations(connection, wrong, { migrationsSchema: schema })).rejects.toThrow(
        'does not match the intended migration definition'
      )
      await connection.unsafe(`DELETE FROM "${schema}"."__tau_online_migration_intents" WHERE created_at = 25`) // ficus-36c
      await connection.unsafe(`DROP TABLE "${wrongTable}" CASCADE`)

      await connection.unsafe(`CREATE SCHEMA "${other}"`)
      await connection.unsafe(`CREATE TABLE "${other}"."${table}" (value text)`)
      const localName = `idx_local_${suffix}`
      await connection.unsafe(`CREATE INDEX "${localName}" ON "${other}"."${table}" (value)`)
      await applyMigrations(connection, online(localName, 40), { migrationsSchema: schema })
      expect((await connection`SELECT to_regclass(${`${other}.${localName}`}) AS name`)[0]?.name).not.toBeNull()

      const collisionName = `idx_collision_${suffix}`
      const collision = online(collisionName, 50)
      await connection.unsafe(collision.sql[0])
      await expect(applyMigrations(connection, collision, { migrationsSchema: schema })).rejects.toThrow(
        'Unexpected existing index'
      )
    } finally {
      await connection.unsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`)
      await connection.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await connection.unsafe(`DROP SCHEMA IF EXISTS "${other}" CASCADE`)
      connection.release()
      await client.end()
    }
  })

  test('drops an invalid intended index and retries it schema-qualified', async () => {
    const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 2 })
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const schema = `invalid_${suffix}`
    const table = `invalid_probe_${suffix}`
    const index = `idx_invalid_${suffix}`
    const item: MigrationMeta = {
      sql: [`CREATE UNIQUE INDEX CONCURRENTLY "${index}" ON "${table}" ("value")`],
      folderMillis: 1,
      hash: 'invalid-hash',
      bps: true,
    }
    const connection = await client.reserve()
    try {
      await connection.unsafe(`CREATE TABLE "${table}" ("value" text NOT NULL)`)
      await connection.unsafe(`CREATE UNIQUE INDEX "${index}" ON "${table}" ("value")`)
      // A canceled/failed concurrent build is represented by these catalog flags.
      // The isolated test database runs as superuser so it can construct that crash state deterministically.
      await connection`UPDATE pg_catalog.pg_index SET indisvalid = false, indisready = false
        WHERE indexrelid = to_regclass(${`public.${index}`})`
      await applyMigrations(connection, [], { migrationsSchema: schema })
      expect(
        (await connection`SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass(${`public.${index}`})`)[0]
          ?.indisvalid
      ).toBe(false)
      await connection.unsafe(
        `INSERT INTO "${schema}"."__tau_online_migration_intents" (created_at,hash,table_schema,index_name) VALUES (1,$1,'public',$2)`, // ficus-36c
        [item.hash, index]
      )
      await applyMigrations(connection, item, { migrationsSchema: schema })
      expect(
        (
          await connection`SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass(${`public.${index}`})`
        )[0]
      ).toMatchObject({ indisvalid: true, indisready: true })
    } finally {
      await connection.unsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`)
      await connection.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      connection.release()
      await client.end()
    }
  }, 30_000)
})
