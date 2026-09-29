import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'
import { backfillStoredText, STORED_TEXT_TARGETS } from './stored-text-backfill'

// Migration history: this file pins 0196 (Task 36c). The pre-rename references and provenance marker
// below are the stored text that migration exists to rewrite, so they are its fixtures.
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes('AS "0196_ficus_stored_text"'))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []

const UUID = 'deadbeef-1234-4abc-8def-0123456789ab'
/** Assistant tool entries: verbatim tool I/O stays as it is; memory_search's own marker moves. */
const toolEntryFixture = {
  role: 'tool',
  text: '',
  final: true,
  toolName: 'squad_bash',
  toolArgs: '{"command":"grep tau:ws:42 notes.md"}',
  toolResult: 'notes.md:1: [#42](tau:ws:42)',
}
const searchEntryFixture = {
  role: 'tool',
  text: '',
  final: true,
  toolName: 'memory_search',
  toolArgs: '{"query":"tau:ws:42"}',
  toolResult: 'Found 0 result(s):\n<!--tau:memory-provenance [] -->',
}
const STAMP = '2026-01-02 03:04:05'

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

async function withMigratedPredecessors(run: (connection: postgres.ReservedSql) => Promise<void>): Promise<void> {
  const dbName = `stored_text_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  let connection: postgres.ReservedSql | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await run(connection)
  } finally {
    connection?.release()
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
}

/** One row in every target table, each holding references in the places readers parse them. */
async function seed(connection: postgres.ReservedSql) {
  const one = async <T>(query: string, params: unknown[] = []) =>
    ((await connection.unsafe(query, params as never)) as unknown as T[])[0]!
  await connection.unsafe(`INSERT INTO agent_types (id, name, model, system_prompt) VALUES ('fixture', 'F', 'm', 's')`)
  const agent = await one<{ id: string }>(`INSERT INTO agents (agent_type_id) VALUES ('fixture') RETURNING id`)
  const squad = await one<{ id: string }>(`INSERT INTO squads (name, purpose) VALUES ('S', 'P') RETURNING id`)
  const user = await one<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ('a@example.test', 'A') RETURNING id`
  )
  const message = await one<{ id: string }>(
    `INSERT INTO messages (agent_id, role, content, metadata, created_at) VALUES ($1, 'assistant', $2, $3::text::jsonb, $4)
     RETURNING id`,
    [
      agent.id,
      'See [#42](tau:ws:42) and `[#1](tau:ws:1)`',
      JSON.stringify({
        executionId: 'e1',
        big: 'BIG',
        content: [
          { type: 'text', id: 'b1', content: `Ask [Ada](tau:agent:${UUID}).` },
          {
            type: 'tool_use',
            id: 'b2',
            toolCall: {
              toolCallId: 't1',
              toolName: 'memory_search',
              args: '{}',
              result:
                'Found 1 result(s):\n```\nsnippet tau:ws:3\n```\n<!--tau:memory-provenance [{"documentId":"d1"}] -->',
              isError: false,
            },
          },
          // Verbatim tool I/O: a file read and an edit's arguments that happen to hold the old scheme.
          {
            type: 'tool_use',
            id: 'b3',
            toolCall: {
              toolCallId: 't2',
              toolName: 'read',
              args: '{"path":"src/a.ts"}',
              result: "expect(parseEntityReference('tau:ws:42'))",
              isError: false,
            },
          },
          {
            type: 'tool_use',
            id: 'b4',
            toolCall: {
              toolCallId: 't3',
              toolName: 'edit',
              args: '{"oldText":"const ref = \\"tau:agent:deadbeef\\"","newText":"x"}',
              result: 'Edited [x](tau:ws:1) <!--tau:memory-provenance [] -->',
              isError: false,
            },
          },
          { type: 'thinking', id: 'b5', content: 'Maybe tau:ws:42' },
        ],
      }).replace('"BIG"', '12345678901234567890'),
      STAMP,
    ]
  )
  const untouched = await one<{ id: string }>(
    `INSERT INTO messages (agent_id, role, content, metadata) VALUES ($1, 'human', $2, $3::text::jsonb) RETURNING id`,
    [agent.id, 'https://example.com/tau:ws:4 and tau: the letter', JSON.stringify({ note: 'x.tau:ws:5' })]
  )
  await connection.unsafe(`INSERT INTO executions (agent_id, status, message) VALUES ($1, 'completed', $2)`, [
    agent.id,
    'Continue [#42](tau:ws:42)',
  ])
  await connection.unsafe(
    `INSERT INTO inbox (recipient_type, recipient_id, sender_type, content) VALUES ('agent', $1, 'user', $2)`,
    [agent.id, 'Please look at tau:ws:42']
  )
  const stream = await one<{ id: string }>(
    `INSERT INTO work_streams (squad_id, title, description, handoff_message, updated_at)
     VALUES ($1, 'Title tau:ws:1 stays', $2, $3, $4) RETURNING id`,
    [squad.id, 'Follows [#41](tau:ws:41)', 'Hand to [Ada](tau:agent:deadbeef)', STAMP]
  )
  await connection.unsafe(
    `INSERT INTO agent_questions (agent_id, question_data, status, answer) VALUES ($1, $2::text::jsonb, 'answered', $3)`,
    [agent.id, JSON.stringify({ question: 'Merge [#42](tau:ws:42)?', options: ['yes'] }), 'Yes, see tau:ws:43']
  )
  const room = await one<{ id: string }>(`INSERT INTO farm_chat_rooms (kind, name) VALUES ('room', 'r') RETURNING id`)
  await connection.unsafe(
    `INSERT INTO farm_chat_messages (room_id, sender_user_id, body, created_at, edited_at) VALUES ($1, $2, $3, $4, $4)`,
    [room.id, user.id, 'Anyone looked at tau:ws:2? @You', STAMP]
  )
  const conversation = await one<{ id: string }>(
    `INSERT INTO assistant_conversations (owner_user_id) VALUES ($1) RETURNING id`,
    [user.id]
  )
  await connection.unsafe(
    `INSERT INTO assistant_entries (conversation_id, client_id, position, entry) VALUES ($1, 'c1', 0, $2::text::jsonb)`,
    [conversation.id, JSON.stringify({ role: 'assistant', text: 'Started [#7](tau:ws:7)' })]
  )
  for (const [position, entry] of [toolEntryFixture, searchEntryFixture].entries()) {
    await connection.unsafe(
      `INSERT INTO assistant_entries (conversation_id, client_id, position, entry) VALUES ($1, $2, $3, $4::text::jsonb)`,
      [conversation.id, `t${position}`, position + 1, JSON.stringify(entry)]
    )
  }
  await connection.unsafe(
    `INSERT INTO work_stream_waits (work_stream_id, type, message, resolution, resolution_note, closed_at)
     VALUES ($1, 'review', $2, 'sent_back', $3, now())`,
    [stream.id, 'Review [#41](tau:ws:41)', 'Redo it like [#40](tau:ws:40)']
  )
  await connection.unsafe(`UPDATE work_streams SET metadata = $2::text::jsonb WHERE id = $1`, [
    stream.id,
    JSON.stringify({ nextSteps: 'Then [#43](tau:ws:43)', other: 'tau:ws:44' }),
  ])
  await connection.unsafe(
    `INSERT INTO work_stream_flow_runs
      (work_stream_id, create_request_id, create_request_hash, source, state, created_by)
     VALUES ($1, gen_random_uuid(), repeat('c', 64), '{}'::jsonb, $2::text::jsonb, 'fixture')`,
    [
      stream.id,
      JSON.stringify({
        schemaVersion: 1,
        attempts: [
          { id: 1, stepId: 'build', status: 'completed', evidence: 'Shipped in [#41](tau:ws:41)' },
          { id: 2, stepId: 'review', status: 'running', feedback: 'tau:ws:45 stays' },
        ],
      }),
    ]
  )
  await connection.unsafe(`INSERT INTO work_stream_continuations (work_stream_id, delivery_prompt) VALUES ($1, $2)`, [
    stream.id,
    'Continue [#41](tau:ws:41)',
  ])
  await connection.unsafe(
    `INSERT INTO squad_activity
      (squad_id, lane, row_id, source_family, source_group_id, at, kind, summary, preview, ref, quiet_eligible,
       access_scope, payload_hash, updated_at)
     VALUES ($1, 10, gen_random_uuid(), 'message', 'g1', now(), 'message', 'See #241', $2::text::jsonb,
       '{"type":"agent"}'::jsonb, true, 'agents', repeat('a', 64), $3)`,
    [squad.id, JSON.stringify([{ text: 'See ' }, { text: '#241', bold: true, href: 'tau:ws:241' }]), STAMP]
  )
  await connection.unsafe(
    `INSERT INTO schedules (scope_type, scope_id, name, schedule, action, updated_at)
     VALUES ('squad', $1, 'daily', '{"cron":"0 9 * * *"}'::jsonb, $2::text::jsonb, $3)`,
    [squad.id, JSON.stringify({ type: 'message', message: 'Check [#42](tau:ws:42)' }), STAMP]
  )
  return { message: message.id, untouched: untouched.id, stream: stream.id }
}

async function snapshot(connection: postgres.ReservedSql) {
  const rows: Record<string, unknown[]> = {}
  for (const table of STORED_TEXT_TARGETS.map((target) => target.table)) {
    rows[table] = await connection.unsafe(`SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY 1`)
  }
  return JSON.stringify(rows)
}

describe('stored-text migration 0196 (real runner, isolated database)', () => {
  test('is the migration after 0195 (the secret-row sweep)', () => {
    expect(target).toBeDefined()
    expect(predecessors.at(-1)!.sql.join('\n')).toContain('DELETE FROM "secrets" t')
  })

  test('rewrites references and the provenance marker where readers parse them, and nothing else', async () => {
    await withMigratedPredecessors(async (connection) => {
      const ids = await seed(connection)
      await applyMigrations(connection, target!)

      const [message] = await connection.unsafe<{ content: string; metadata: string; created_at: string }[]>(
        `SELECT content, metadata::text, created_at::text FROM messages WHERE id = $1`,
        [ids.message]
      )
      expect(message!.content).toBe('See [#42](ficus:ws:42) and `[#1](tau:ws:1)`')
      expect(message!.created_at).toBe(STAMP)
      const metadata = JSON.parse(message!.metadata)
      expect(metadata.content[0].content).toBe(`Ask [Ada](ficus:agent:${UUID}).`)
      expect(metadata.content[1].toolCall.result).toBe(
        'Found 1 result(s):\n```\nsnippet tau:ws:3\n```\n<!--ficus:memory-provenance [{"documentId":"d1"}] -->'
      )
      // Verbatim tool I/O and thinking are untouched; only memory_search's own marker moves.
      expect(metadata.content[2].toolCall.result).toBe("expect(parseEntityReference('tau:ws:42'))")
      expect(metadata.content[3].toolCall).toMatchObject({
        args: '{"oldText":"const ref = \\"tau:agent:deadbeef\\"","newText":"x"}',
        result: 'Edited [x](tau:ws:1) <!--tau:memory-provenance [] -->',
      })
      expect(metadata.content[4].content).toBe('Maybe tau:ws:42')
      // Values the rewrite does not change keep their exact stored JSON (jsonb_set per changed string).
      expect(message!.metadata).toContain('"big": 12345678901234567890')

      const [untouched] = await connection.unsafe<{ content: string; metadata: string }[]>(
        `SELECT content, metadata::text FROM messages WHERE id = $1`,
        [ids.untouched]
      )
      expect(untouched).toEqual({
        content: 'https://example.com/tau:ws:4 and tau: the letter',
        metadata: '{"note": "x.tau:ws:5"}',
      })

      expect((await connection`SELECT message FROM executions`)[0]!.message).toBe('Continue [#42](ficus:ws:42)')
      expect((await connection`SELECT content FROM inbox`)[0]!.content).toBe('Please look at ficus:ws:42')
      expect(
        (await connection`SELECT title, description, handoff_message, updated_at::text FROM work_streams`)[0]
      ).toEqual({
        title: 'Title tau:ws:1 stays',
        description: 'Follows [#41](ficus:ws:41)',
        handoff_message: 'Hand to [Ada](ficus:agent:deadbeef)',
        updated_at: STAMP,
      })
      expect((await connection`SELECT question_data, answer FROM agent_questions`)[0]).toEqual({
        question_data: { question: 'Merge [#42](ficus:ws:42)?', options: ['yes'] },
        answer: 'Yes, see ficus:ws:43',
      })
      expect(
        (await connection`SELECT body, edited_at = ${STAMP}::timestamptz AS kept FROM farm_chat_messages`)[0]
      ).toEqual({ body: 'Anyone looked at ficus:ws:2? @You', kept: true })
      expect((await connection`SELECT entry FROM assistant_entries ORDER BY position`).map((row) => row.entry)).toEqual(
        [
          { role: 'assistant', text: 'Started [#7](ficus:ws:7)' },
          toolEntryFixture,
          { ...searchEntryFixture, toolResult: 'Found 0 result(s):\n<!--ficus:memory-provenance [] -->' },
        ]
      )
      expect((await connection`SELECT message, resolution_note FROM work_stream_waits`)[0]).toEqual({
        message: 'Review [#41](ficus:ws:41)',
        resolution_note: 'Redo it like [#40](ficus:ws:40)',
      })
      expect((await connection`SELECT metadata FROM work_streams`)[0]!.metadata).toEqual({
        nextSteps: 'Then [#43](ficus:ws:43)',
        other: 'tau:ws:44',
      })
      expect((await connection`SELECT state FROM work_stream_flow_runs`)[0]!.state.attempts).toEqual([
        { id: 1, stepId: 'build', status: 'completed', evidence: 'Shipped in [#41](ficus:ws:41)' },
        { id: 2, stepId: 'review', status: 'running', feedback: 'tau:ws:45 stays' },
      ])
      expect((await connection`SELECT delivery_prompt FROM work_stream_continuations`)[0]!.delivery_prompt).toBe(
        'Continue [#41](ficus:ws:41)'
      )
      expect(
        (await connection`SELECT preview, summary, updated_at = ${STAMP}::timestamptz AS kept FROM squad_activity`)[0]
      ).toEqual({
        preview: [{ text: 'See ' }, { text: '#241', bold: true, href: 'ficus:ws:241' }],
        summary: 'See #241',
        kept: true,
      })
      expect((await connection`SELECT action, updated_at::text FROM schedules`)[0]).toEqual({
        action: { type: 'message', message: 'Check [#42](ficus:ws:42)' },
        updated_at: STAMP,
      })
    })
  })

  test('pages through more candidates than one batch and is a no-op on a second run', async () => {
    await withMigratedPredecessors(async (connection) => {
      await connection.unsafe(`INSERT INTO agent_types (id, name, model, system_prompt) VALUES ('f', 'F', 'm', 's')`)
      const [agent] = await connection<{ id: string }[]>`INSERT INTO agents (agent_type_id) VALUES ('f') RETURNING id`
      for (let index = 1; index <= 7; index += 1) {
        await connection.unsafe(`INSERT INTO messages (agent_id, role, content) VALUES ($1, 'assistant', $2)`, [
          agent!.id,
          index % 3 === 0 ? `code only: \`tau:ws:${index}\`` : `[#${index}](tau:ws:${index})`,
        ])
      }
      // A composite key (squad_id, lane, row_id) pages by row comparison too.
      const [squad] = await connection<
        { id: string }[]
      >`INSERT INTO squads (name, purpose) VALUES ('S', 'P') RETURNING id`
      for (let index = 1; index <= 5; index += 1) {
        await connection.unsafe(
          `INSERT INTO squad_activity
            (squad_id, lane, row_id, source_family, source_group_id, at, kind, summary, preview, ref, quiet_eligible,
             access_scope, payload_hash)
           VALUES ($1, $2, gen_random_uuid(), 'message', 'g', now(), $4, 's', $3::text::jsonb,
             '{"type":"agent"}'::jsonb, true, 'agents', repeat('a', 64))`,
          [
            squad!.id,
            index % 2 ? 10 : 60,
            JSON.stringify([{ text: '#1', href: `tau:ws:${index}` }]),
            index % 2 ? 'message' : 'execution',
          ]
        )
      }
      const first = await backfillStoredText(connection, { batchSize: 2 })
      expect(first.find((result) => result.table === 'messages')!.rows).toBe(5)
      expect(first.find((result) => result.table === 'squad_activity')!.rows).toBe(5)
      expect(
        (await connection<{ href: string }[]>`SELECT preview->0->>'href' AS href FROM squad_activity`).every((row) =>
          row.href.startsWith('ficus:ws:')
        )
      ).toBe(true)
      const contents = (await connection<{ content: string }[]>`SELECT content FROM messages ORDER BY content`).map(
        (row) => row.content
      )
      expect(contents.filter((content) => content.includes('](ficus:ws:'))).toHaveLength(5)
      expect(contents.filter((content) => content.startsWith('code only'))).toHaveLength(2)

      const before = await snapshot(connection)
      const second = await backfillStoredText(connection, { batchSize: 2 })
      expect(second.every((result) => result.rows === 0)).toBe(true)
      expect(await snapshot(connection)).toBe(before)
    })
  })
})
