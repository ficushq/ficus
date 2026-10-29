import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) =>
  migration.sql.join('\n').includes('ADD COLUMN "audience" varchar(20) DEFAULT \'human\' NOT NULL')
)
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `fleet_audience_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function databaseUrl(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('fleet incident audience migration', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(databaseUrl('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(databaseUrl(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('backfills legacy deliveries without changing durable delivery state', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)

    const incidents = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO fleet_incidents
        (kind, scope_key, started_at, alert_after, last_observed_at, cause_code, cause_summary, resolved_at)
      VALUES
        ('provider_unhealthy', 'migration-pending', now() - interval '1 hour', now() - interval '45 minutes', now(), 'network', 'safe', NULL),
        ('provider_unhealthy', 'migration-delivering', now() - interval '1 hour', now() - interval '45 minutes', now(), 'network', 'safe', now()),
        ('provider_unhealthy', 'migration-delivered', now() - interval '1 hour', now() - interval '45 minutes', now(), 'network', 'safe', NULL),
        ('provider_unhealthy', 'migration-default', now() - interval '1 hour', now() - interval '45 minutes', now(), 'network', 'safe', NULL)
      RETURNING id
    `)
    const [inbox] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO inbox (recipient_type, recipient_id, sender_type, content, idempotency_key)
      VALUES ('system', 'system', 'system', 'legacy fleet alert', 'legacy-inbox-key')
      RETURNING id
    `)
    const claimToken = crypto.randomUUID()
    const seeded = await connection.unsafe<
      {
        id: string
        incident_id: string
        kind: string
        status: string
        idempotency_key: string
        claim_token: string | null
        claimed_at: Date | null
        attempts: number
        inbox_message_id: string | null
        delivered_at: Date | null
      }[]
    >(`
      INSERT INTO fleet_incident_notifications
        (incident_id, kind, status, idempotency_key, claim_token, claimed_at, attempts, inbox_message_id, delivered_at)
      VALUES
        ('${incidents[0].id}', 'alert', 'pending', 'legacy-pending', NULL, NULL, 1, NULL, NULL),
        ('${incidents[1].id}', 'recovery', 'delivering', 'legacy-delivering', '${claimToken}', now() - interval '30 seconds', 3, NULL, NULL),
        ('${incidents[2].id}', 'alert', 'delivered', 'legacy-delivered', NULL, NULL, 2, '${inbox.id}', now() - interval '10 seconds')
      RETURNING id, incident_id, kind, status, idempotency_key, claim_token, claimed_at, attempts, inbox_message_id, delivered_at
    `)
    const [{ now: migrationStartedAt }] = await connection.unsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now')

    await applyMigrations(connection, target!)

    const migrated = await connection.unsafe<
      {
        id: string
        incident_id: string
        kind: string
        audience: string
        status: string
        recipient_id: string | null
        idempotency_key: string | null
        next_attempt_at: Date
        claim_token: string | null
        claimed_at: Date | null
        attempts: number
        inbox_message_id: string | null
        delivered_at: Date | null
      }[]
    >(`SELECT * FROM fleet_incident_notifications ORDER BY id`)
    const [{ now: migrationFinishedAt }] = await connection.unsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now')
    const expected = [...seeded].sort((left, right) => left.id.localeCompare(right.id))
    expect(migrated).toHaveLength(expected.length)
    for (const [index, row] of migrated.entries()) {
      expect(row).toMatchObject({ ...expected[index], audience: 'human', recipient_id: 'system' })
      expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(migrationStartedAt.getTime())
      expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(migrationFinishedAt.getTime())
    }

    const [defaulted] = await connection.unsafe<
      {
        audience: string
        recipient_id: string
        status: string
        next_attempt_at: Date
        observed_at: Date
      }[]
    >(`
      INSERT INTO fleet_incident_notifications (incident_id, kind, idempotency_key)
      VALUES ('${incidents[3].id}', 'alert', 'legacy-old-worker-insert')
      RETURNING audience, recipient_id, status, next_attempt_at, clock_timestamp() AS observed_at
    `)
    expect(defaulted).toMatchObject({ audience: 'human', recipient_id: 'system', status: 'pending' })
    expect(defaulted.next_attempt_at.getTime()).toBeLessThanOrEqual(defaulted.observed_at.getTime())
  })
})
