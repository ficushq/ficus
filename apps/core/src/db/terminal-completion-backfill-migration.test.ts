import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'Backfill invalid terminal completion metadata'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `terminal_completion_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

type Fixture = {
  title: string
  status: 'done' | 'canceled' | 'active'
  metadata: unknown
  updatedAt: string
  expected: unknown
  changed: boolean
}

const malformedRootFixtures: Fixture[] = [
  ['null', null],
  ['array', ['legacy']],
  ['string', 'legacy'],
  ['number', 42],
  ['boolean', false],
].map(([shape, metadata], index) => {
  const updatedAt = `2026-02-0${index + 1} 02:03:04.00${index + 1}`
  return {
    title: `malformed-${shape}-metadata-root`,
    status: 'done',
    metadata,
    updatedAt,
    expected: { completion: { completedAt: updatedAt.replace(' ', 'T') + 'Z' } },
    changed: true,
  } as Fixture
})

const fixtures: Fixture[] = [
  ...malformedRootFixtures,
  {
    title: 'missing-completion',
    status: 'done',
    metadata: { sibling: true },
    updatedAt: '2026-01-01 01:02:03.456',
    expected: { sibling: true, completion: { completedAt: '2026-01-01T01:02:03.456Z' } },
    changed: true,
  },
  {
    title: 'malformed-completion-container',
    status: 'canceled',
    metadata: { completion: ['legacy'], sibling: true },
    updatedAt: '2026-01-02 01:02:03.004',
    expected: { completion: { completedAt: '2026-01-02T01:02:03.004Z' }, sibling: true },
    changed: true,
  },
  {
    title: 'null-completion-container',
    status: 'done',
    metadata: { completion: null, sibling: true },
    updatedAt: '2026-01-02 02:03:04.005',
    expected: { completion: { completedAt: '2026-01-02T02:03:04.005Z' }, sibling: true },
    changed: true,
  },
  {
    title: 'missing-completed-at',
    status: 'done',
    metadata: { completion: { mode: 'pr-auto-merge' }, sibling: true },
    updatedAt: '2026-01-03 01:02:03.040',
    expected: {
      completion: { mode: 'pr-auto-merge', completedAt: '2026-01-03T01:02:03.040Z' },
      sibling: true,
    },
    changed: true,
  },
  {
    title: 'non-string-completed-at',
    status: 'done',
    metadata: { completion: { completedAt: 123, mode: 'manual' } },
    updatedAt: '2026-01-04 01:02:03.400',
    expected: { completion: { completedAt: '2026-01-04T01:02:03.400Z', mode: 'manual' } },
    changed: true,
  },
  {
    title: 'unparseable-completed-at',
    status: 'canceled',
    metadata: { completion: { completedAt: 'not-a-date', reason: 'legacy' } },
    updatedAt: '2026-01-05 01:02:03.000',
    expected: { completion: { completedAt: '2026-01-05T01:02:03.000Z', reason: 'legacy' } },
    changed: true,
  },
  {
    title: 'infinite-completed-at',
    status: 'done',
    metadata: { completion: { completedAt: 'infinity', mode: 'manual' } },
    updatedAt: '2026-01-06 01:02:03.789',
    expected: { completion: { completedAt: '2026-01-06T01:02:03.789Z', mode: 'manual' } },
    changed: true,
  },
  {
    title: 'negative-infinite-completed-at',
    status: 'canceled',
    metadata: { completion: { completedAt: '-infinity', mode: 'manual' } },
    updatedAt: '2026-01-06 02:03:04.890',
    expected: { completion: { completedAt: '2026-01-06T02:03:04.890Z', mode: 'manual' } },
    changed: true,
  },
  {
    title: 'valid-completed-at',
    status: 'done',
    metadata: { completion: { completedAt: '2025-12-01T03:04:05.123400+02:00', mode: 'manual' }, sibling: true },
    updatedAt: '2026-01-07 01:02:03.000',
    expected: {
      completion: { completedAt: '2025-12-01T03:04:05.123400+02:00', mode: 'manual' },
      sibling: true,
    },
    changed: false,
  },
  {
    title: 'valid-postgres-text-completed-at',
    status: 'canceled',
    metadata: { completion: { completedAt: '2025-12-01 03:04:05 UTC', mode: 'manual' } },
    updatedAt: '2026-01-07 02:03:04.000',
    expected: { completion: { completedAt: '2025-12-01 03:04:05 UTC', mode: 'manual' } },
    changed: false,
  },
  {
    title: 'valid-utc-completed-at',
    status: 'done',
    metadata: { completion: { completedAt: '2025-12-01T03:04:05.123Z' } },
    updatedAt: '2026-01-07 03:04:05.000',
    expected: { completion: { completedAt: '2025-12-01T03:04:05.123Z' } },
    changed: false,
  },
  {
    title: 'nonterminal-malformed',
    status: 'active',
    metadata: { sibling: true },
    updatedAt: '2026-01-08 01:02:03.000',
    expected: { sibling: true },
    changed: false,
  },
]

describe('terminal completion backfill migration (real runner, isolated database)', () => {
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
      `INSERT INTO squads (id, name, purpose) VALUES ('10000000-0000-4000-8000-000000000001', 'Migration test', 'Test')`
    )
    for (const fixture of fixtures) {
      await connection.unsafe(
        `INSERT INTO work_streams (squad_id, title, description, status, metadata, updated_at)
         VALUES ('10000000-0000-4000-8000-000000000001', $1, 'unchanged-description', $2, ($3::text)::jsonb, $4::timestamp)`,
        [fixture.title, fixture.status, JSON.stringify(fixture.metadata), fixture.updatedAt]
      )
    }
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('repairs only invalid terminal values from updated_at and is physically idempotent', async () => {
    const before = await connection.unsafe<{ title: string; metadata: unknown; xmin: string }[]>(
      `SELECT title, metadata, xmin::text FROM work_streams ORDER BY title`
    )
    for (const fixture of fixtures) {
      expect(before.find(({ title }) => title === fixture.title)!.metadata).toEqual(fixture.metadata)
    }
    await applyMigrations(connection, target!)

    const after = await connection.unsafe<
      { title: string; status: string; metadata: unknown; updated_at: string; description: string; xmin: string }[]
    >(`SELECT title, status, metadata, to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_at,
              description, xmin::text
       FROM work_streams ORDER BY title`)

    for (const fixture of fixtures) {
      const row = after.find(({ title }) => title === fixture.title)!
      expect(row.metadata).toEqual(fixture.expected)
      expect(row.status).toBe(fixture.status)
      expect(row.updated_at).toBe(fixture.updatedAt)
      expect(row.description).toBe('unchanged-description')
      const originalXmin = before.find(({ title }) => title === fixture.title)!.xmin
      expect(row.xmin === originalXmin).toBe(!fixture.changed)
    }

    const xminsAfterFirstRun = new Map(after.map(({ title, xmin }) => [title, xmin]))
    await connection.unsafe(target!.sql.join('\n'))
    const afterSecondRun = await connection.unsafe<{ title: string; xmin: string }[]>(
      `SELECT title, xmin::text FROM work_streams ORDER BY title`
    )
    expect(new Map(afterSecondRun.map(({ title, xmin }) => [title, xmin]))).toEqual(xminsAfterFirstRun)
  }, 240_000)
})
