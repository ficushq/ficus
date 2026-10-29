import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { applyMigrations } from './migrator'
import { createPostgresConnection, getConnectionString } from './connection'

/**
 * Spec test 7: seed a database in the PRE-consolidation shape with every old
 * status (including a blocked stream with a reason message and a review
 * stream), run the REAL migration, and assert statuses + wait records. The
 * full 0000→0109 chain builds the old shape so the seed uses the genuine old
 * schema, and 0110 is applied by the same runner production uses. (The
 * 0000→HEAD chain-proof on a fresh DB is exercised implicitly: pre + target
 * here IS the whole chain.)
 */

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
// The consolidation migration is identified by its unique backfill marker.
const target = migrations.find((m) => m.sql.join('\n').includes('_ws_blocked_park'))
const pre = target ? migrations.filter((m) => m.folderMillis < target.folderMillis) : []

const dbName = `ws_waits_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function adminUrl(): string {
  const url = new URL(getConnectionString())
  url.pathname = '/postgres'
  return url.toString()
}

function scratchUrl(): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${dbName}`
  return url.toString()
}

describe('ws-status-waits migration backfill (real runner, fresh DB)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  beforeAll(async () => {
    admin = createPostgresConnection(adminUrl(), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(scratchUrl(), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  it('migrates every legacy status and backfills typed waits', async () => {
    expect(target).toBeDefined()
    expect(pre.length).toBeGreaterThan(100)

    // Build the OLD schema with the real runner.
    await applyMigrations(connection, pre)

    // Old shape sanity: the legacy enum + prompt columns exist.
    const [enumCheck] = await connection.unsafe<{ labels: string[] }[]>(
      `SELECT array_agg(enumlabel ORDER BY enumsortorder)::text[] AS labels
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'work_stream_status'`
    )
    expect(enumCheck.labels).toContain('in_progress')
    expect(enumCheck.labels).toContain('blocked')

    // Seed: one squad (grace 30 via NULL default) + every legacy status.
    const [squad] = await connection.unsafe<{ id: string }[]>(
      `INSERT INTO squads (name, purpose, status) VALUES ('mig-seed', 'seed', 'active') RETURNING id`
    )
    const insert = async (title: string, status: string, extra = '', extraCols = ''): Promise<string> => {
      const [row] = await connection.unsafe<{ id: string }[]>(
        `INSERT INTO work_streams (squad_id, title, status${extraCols}) VALUES ('${squad.id}', '${title}', '${status}'${extra}) RETURNING id`
      )
      return row.id
    }

    const pendingId = await insert('was-pending', 'pending')
    const queuedId = await insert('was-queued', 'queued')
    const inProgressId = await insert('was-in-progress', 'in_progress')
    const doneId = await insert('was-done', 'done')
    const canceledId = await insert('was-canceled', 'canceled')
    // Blocked with a reason message, out of grace (updated 45 min ago).
    const blockedOldId = await insert(
      'was-blocked-old',
      'blocked',
      `, '{"type":"text","message":"waiting on prod credentials"}'::jsonb, now() - interval '45 minutes'`,
      ', blocked_prompt, updated_at'
    )
    // Blocked with a reason, WITHIN grace (updated 5 min ago).
    const blockedFreshId = await insert(
      'was-blocked-fresh',
      'blocked',
      `, '{"type":"text","message":"quick question"}'::jsonb, now() - interval '5 minutes'`,
      ', blocked_prompt, updated_at'
    )
    // Blocked because of an unsatisfied dependency -> dependency waits, not manual.
    const blockedDepId = await insert(
      'was-blocked-dep',
      'blocked',
      `, '{${inProgressId}}'::uuid[], now() - interval '45 minutes'`,
      ', depends_on, updated_at'
    )
    // Review stream with a review prompt.
    const reviewId = await insert(
      'was-review',
      'review',
      `, '{"type":"select","message":"please review the PR"}'::jsonb`,
      ', review_prompt'
    )
    // A queued stream with an unsatisfied dependency (system dep-wait backfill
    // covers ALL non-terminal streams, not just blocked ones).
    const queuedDepId = await insert('was-queued-dep', 'queued', `, '{${inProgressId}}'::uuid[]`, ', depends_on')

    // Run the REAL consolidation migration.
    await applyMigrations(connection, target!)

    const statusOf = async (id: string): Promise<string> => {
      const [row] = await connection.unsafe<{ status: string }[]>(
        `SELECT status::text AS status FROM work_streams WHERE id = '${id}'`
      )
      return row.status
    }
    const waitsOf = async (id: string) =>
      connection.unsafe<
        {
          type: string
          message: string | null
          resolution: string | null
          closed_at: string | null
          reference_id: string | null
        }[]
      >(
        `SELECT type::text AS type, message, resolution, closed_at, reference_id FROM work_stream_waits WHERE work_stream_id = '${id}' ORDER BY type`
      )

    // Status mapping.
    expect(await statusOf(pendingId)).toBe('queued')
    expect(await statusOf(queuedId)).toBe('queued')
    expect(await statusOf(inProgressId)).toBe('active')
    expect(await statusOf(doneId)).toBe('done')
    expect(await statusOf(canceledId)).toBe('canceled')
    // blocked: within grace -> active; out of grace -> queued (parked).
    expect(await statusOf(blockedFreshId)).toBe('active')
    expect(await statusOf(blockedOldId)).toBe('queued')
    expect(await statusOf(blockedDepId)).toBe('queued')
    expect(await statusOf(reviewId)).toBe('active')

    // Wait records: open (resolution null, closed_at null), correct types + messages.
    const blockedOldWaits = await waitsOf(blockedOldId)
    expect(blockedOldWaits).toHaveLength(1)
    expect(blockedOldWaits[0].type).toBe('manual')
    expect(blockedOldWaits[0].message).toBe('waiting on prod credentials')
    expect(blockedOldWaits[0].resolution).toBeNull()
    expect(blockedOldWaits[0].closed_at).toBeNull()

    const blockedFreshWaits = await waitsOf(blockedFreshId)
    expect(blockedFreshWaits).toHaveLength(1)
    expect(blockedFreshWaits[0].type).toBe('manual')
    expect(blockedFreshWaits[0].message).toBe('quick question')

    // dependency-blocked: dependency wait referencing the dep, NO manual wait.
    const blockedDepWaits = await waitsOf(blockedDepId)
    expect(blockedDepWaits).toHaveLength(1)
    expect(blockedDepWaits[0].type).toBe('dependency')
    expect(blockedDepWaits[0].reference_id).toBe(inProgressId)
    expect(blockedDepWaits[0].resolution).toBeNull()

    // review: the wait is OPEN and carries the prompt message.
    const reviewWaits = await waitsOf(reviewId)
    expect(reviewWaits).toHaveLength(1)
    expect(reviewWaits[0].type).toBe('review')
    expect(reviewWaits[0].message).toBe('please review the PR')
    expect(reviewWaits[0].closed_at).toBeNull()

    // queued stream with unsatisfied dep also gets its projection wait.
    const queuedDepWaits = await waitsOf(queuedDepId)
    expect(queuedDepWaits).toHaveLength(1)
    expect(queuedDepWaits[0].type).toBe('dependency')

    // Terminal + plain streams get no waits.
    for (const id of [pendingId, queuedId, inProgressId, doneId, canceledId]) {
      expect(await waitsOf(id)).toHaveLength(0)
    }

    // Prompt columns are gone; the enum is the 4-value set; default is active.
    const cols = await connection.unsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'work_streams' AND column_name IN ('blocked_prompt', 'review_prompt')`
    )
    expect(cols).toHaveLength(0)
    const [postEnum] = await connection.unsafe<{ labels: string[] }[]>(
      `SELECT array_agg(enumlabel ORDER BY enumsortorder)::text[] AS labels
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'work_stream_status'`
    )
    expect(postEnum.labels).toEqual(['queued', 'active', 'done', 'canceled'])
    const [def] = await connection.unsafe<{ column_default: string }[]>(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'work_streams' AND column_name = 'status'`
    )
    expect(def.column_default).toContain('active')
  }, 240_000)
})
