import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const constraintName = 'execution_admission_reservation_nonqueue_owner_required'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(`CONSTRAINT "${constraintName}"`))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `ownerless_admission_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

describe('ownerless admission migration (real runner, isolated database)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(
      `INSERT INTO agents (id, agent_type_id) VALUES ('10000000-0000-4000-8000-000000000001', 'engineer')`
    )
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('dirty legacy data blocks atomically, then clean data gains the fail-closed invariant', async () => {
    const dirtyExecution = '20000000-0000-4000-8000-000000000001'
    await connection.unsafe(
      `INSERT INTO executions (id, agent_id) VALUES ($1, '10000000-0000-4000-8000-000000000001')`,
      [dirtyExecution]
    )
    await connection.unsafe(
      `INSERT INTO execution_admission_reservations (execution_id, state) VALUES ($1, 'provisional')`,
      [dirtyExecution]
    )

    const migrationError = await applyMigrations(connection, target!).then(
      () => undefined,
      (error) => error
    )
    expect(postgresCode(migrationError)).toBe('23514')
    const dirtyRows = await connection.unsafe<{ execution_id: string; state: string; owner_id: string | null }[]>(
      `SELECT execution_id, state, owner_id FROM execution_admission_reservations WHERE execution_id=$1`,
      [dirtyExecution]
    )
    expect(dirtyRows.map(({ execution_id, state, owner_id }) => ({ execution_id, state, owner_id }))).toEqual([
      { execution_id: dirtyExecution, state: 'provisional', owner_id: null },
    ])
    expect(
      await connection.unsafe(`SELECT conname FROM pg_constraint WHERE conname=$1`, [constraintName])
    ).toHaveLength(0)

    await connection.unsafe(`DELETE FROM execution_admission_reservations WHERE execution_id=$1`, [dirtyExecution])
    await applyMigrations(connection, target!)

    const definition = await connection.unsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=$1`,
      [constraintName]
    )
    expect(definition).toHaveLength(1)
    for (const state of ['queued', 'waiting-maintenance', 'released', 'revoked']) {
      expect(definition[0]!.definition).toContain(`'${state}'`)
    }
    expect(definition[0]!.definition).toContain('owner_id IS NOT NULL')

    const exemptStates = ['queued', 'waiting-maintenance', 'released', 'revoked']
    for (const [index, state] of exemptStates.entries()) {
      const executionId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      await connection.unsafe(
        `INSERT INTO executions (id, agent_id) VALUES ($1, '10000000-0000-4000-8000-000000000001')`,
        [executionId]
      )
      await connection.unsafe(`INSERT INTO execution_admission_reservations (execution_id, state) VALUES ($1, $2)`, [
        executionId,
        state,
      ])
    }

    for (const [index, state] of ['provisional', 'released'].entries()) {
      const ownedExecution = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      await connection.unsafe(
        `INSERT INTO executions (id, agent_id) VALUES ($1, '10000000-0000-4000-8000-000000000001')`,
        [ownedExecution]
      )
      await connection.unsafe(
        `INSERT INTO execution_admission_reservations
           (execution_id, state, token, claim_epoch, owner_id, owner_incarnation, admitted_generation,
            admitted_holder_revision, lease_expires_at, last_heartbeat_at)
         VALUES ($1, $2, $3, 1, 'worker-1', $4, 1, 1, now() + interval '1 minute', now())`,
        [
          ownedExecution,
          state,
          `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ]
      )
    }

    const partialExecution = '80000000-0000-4000-8000-000000000001'
    await connection.unsafe(
      `INSERT INTO executions (id, agent_id) VALUES ($1, '10000000-0000-4000-8000-000000000001')`,
      [partialExecution]
    )
    const partialError = await connection
      .unsafe(
        `INSERT INTO execution_admission_reservations (execution_id, state, owner_id) VALUES ($1, 'provisional', 'worker-1')`,
        [partialExecution]
      )
      .then(
        () => undefined,
        (cause) => cause
      )
    expect(postgresCode(partialError)).toBe('23514')
    expect((partialError as { constraint_name?: string }).constraint_name).toBe(
      'execution_admission_reservation_queue_owner_coherent'
    )

    for (const [index, state] of [
      'provisional',
      'requested',
      'starting',
      'waiting',
      'settling',
      'revoking',
      'future-state',
    ].entries()) {
      const executionId = `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      await connection.unsafe(
        `INSERT INTO executions (id, agent_id) VALUES ($1, '10000000-0000-4000-8000-000000000001')`,
        [executionId]
      )
      const error = await connection
        .unsafe(`INSERT INTO execution_admission_reservations (execution_id, state) VALUES ($1, $2)`, [
          executionId,
          state,
        ])
        .then(
          () => undefined,
          (cause) => cause
        )
      expect(postgresCode(error)).toBe('23514')
      expect((error as { constraint_name?: string }).constraint_name).toBe(constraintName)
    }
  }, 240_000)
})
