import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => {
  const sql = migration.sql.join('\n')
  return sql.includes('created_by_user_id') && sql.includes('answer_delivery_status')
})
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `action_center_wait_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function databaseUrl(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('action center wait foundation migration', () => {
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

  it('preserves legacy rows and leaves legacy answers ineligible for replay', async () => {
    expect(target).toBeDefined()

    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO agent_types (id, name, model, system_prompt)
      VALUES ('migration-agent', 'Migration agent', 'test:model', 'test')
    `)
    const [agent] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO agents (agent_type_id) VALUES ('migration-agent') RETURNING id
    `)
    const [squad] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO squads (name, purpose) VALUES ('Migration squad', 'Migration fixture') RETURNING id
    `)
    const [stream] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO work_streams (squad_id, title) VALUES ('${squad.id}', 'Migration stream') RETURNING id
    `)
    const beforeQuestions = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(`
      INSERT INTO agent_questions (agent_id, question_data, status, answer)
      VALUES
        ('${agent.id}', '{"questions":[]}'::jsonb, 'open', NULL),
        ('${agent.id}', '{"questions":[]}'::jsonb, 'answered', 'legacy answer')
      RETURNING id, status, answer
    `)
    const [beforeWait] = await connection.unsafe<{ id: string; created_by: string }[]>(`
      INSERT INTO work_stream_waits (work_stream_id, type, created_by)
      VALUES ('${stream.id}', 'manual', 'operator')
      RETURNING id, created_by
    `)

    await applyMigrations(connection, target!)

    const legacyQuestions = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(
      `SELECT id, status, answer FROM agent_questions ORDER BY id`
    )
    expect([...legacyQuestions]).toEqual([...beforeQuestions].sort((left, right) => left.id.localeCompare(right.id)))

    const [legacyWait] = await connection.unsafe<
      { id: string; created_by: string; created_by_user_id: string | null }[]
    >(`
      SELECT id, created_by, created_by_user_id FROM work_stream_waits WHERE id = '${beforeWait.id}'
    `)
    expect(legacyWait).toEqual({ ...beforeWait, created_by_user_id: null })

    const [legacyAnswered] = await connection.unsafe<
      {
        answer_delivery_status: string | null
      }[]
    >(`SELECT answer_delivery_status FROM agent_questions WHERE status = 'answered'`)
    expect(legacyAnswered.answer_delivery_status).toBeNull()

    const dueLegacyAnswers = await connection.unsafe<{ id: string }[]>(`
      SELECT id FROM agent_questions
      WHERE status = 'answered'
        AND answer_delivery_status IN ('pending', 'delivering')
        AND (answer_delivery_next_attempt_at IS NULL OR answer_delivery_next_attempt_at <= now())
    `)
    expect(dueLegacyAnswers).toHaveLength(0)

    const columns = await connection.unsafe<{ column_name: string }[]>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('agent_questions', 'work_stream_waits')
    `)
    expect(columns.map((column) => column.column_name)).toEqual(
      expect.arrayContaining([
        'created_by_user_id',
        'answer_delivery_status',
        'answer_delivery_generation',
        'answer_delivery_attempt_count',
        'answer_delivery_next_attempt_at',
        'answer_delivery_claim_token',
        'answer_delivery_claimed_at',
        'answer_delivery_last_error',
        'answer_delivery_inbox_message_id',
        'answer_delivery_message_id',
        'answer_delivery_execution_id',
        'answer_delivered_at',
        'dismissed_at',
        'dismissal_reason',
      ])
    )
  }, 240_000)
})
