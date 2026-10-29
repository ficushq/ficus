import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { backfillAssistantActivity } from './assistant-activity-backfill'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const marker = 'CREATE TABLE "assistant_tasks"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const dbName = `assistant_activity_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

const owner = '30000000-0000-4000-8000-000000000001'
const stranger = '30000000-0000-4000-8000-000000000002'
const agent = '10000000-0000-4000-8000-000000000001'
const conv = {
  answered: '20000000-0000-4000-8000-000000000001',
  unread: '20000000-0000-4000-8000-000000000002',
  silent: '20000000-0000-4000-8000-000000000003',
  chain: '20000000-0000-4000-8000-000000000004',
  orphan: '20000000-0000-4000-8000-000000000005',
  twin: '20000000-0000-4000-8000-000000000006',
}
const msg = {
  answeredRequest: '40000000-0000-4000-8000-000000000001',
  answeredReply: '40000000-0000-4000-8000-000000000002',
  unreadRequest: '40000000-0000-4000-8000-000000000003',
  unreadReply: '40000000-0000-4000-8000-000000000004',
  silentRequest: '40000000-0000-4000-8000-000000000005',
  chainRoot: '40000000-0000-4000-8000-000000000006',
  chainQuestion: '40000000-0000-4000-8000-000000000007',
  chainAnswer: '40000000-0000-4000-8000-000000000008',
  chainResult: '40000000-0000-4000-8000-000000000009',
  chainSecondRoot: '40000000-0000-4000-8000-00000000000a',
  orphanUpdate: '40000000-0000-4000-8000-00000000000b',
  twinUpdate: '40000000-0000-4000-8000-00000000000c',
  earlyUnordered: '40000000-0000-4000-8000-00000000000d',
}

function request(id: string, conversation: string, content: string, at: string, inReplyTo?: string) {
  const metadata = JSON.stringify({ source: 'assistant_inbox', ...(inReplyTo ? { inReplyTo } : {}) })
  return `INSERT INTO inbox (id, recipient_type, recipient_id, sender_type, sender_id, content, metadata, created_at)
    VALUES ('${id}', 'agent', '${agent}', 'voice_assistant', 'assistant:${conversation}', '${content}', '${metadata}', '${at}');`
}
function reply(id: string, conversation: string, content: string, at: string, inReplyTo: string, readAt?: string) {
  const metadata = JSON.stringify({ inReplyTo })
  return `INSERT INTO inbox (id, recipient_type, recipient_id, sender_type, sender_id, content, metadata, created_at, read_at)
    VALUES ('${id}', 'voice_assistant', 'assistant:${conversation}', 'agent', '${agent}', '${content}', '${metadata}', '${at}', ${readAt ? `'${readAt}'` : 'NULL'});`
}

type TaskRow = { id: string; conversation_id: string; current_request_id: string; status: string; label: string }
type UpdateRow = {
  message_id: string
  conversation_id: string
  task_id: string | null
  request_id: string | null
  sequence: number
  processed_at: Date | null
  seen_at: Date | null
}

describe('assistant activity migration', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql

  const tasks = () =>
    connection.unsafe<TaskRow[]>(
      `SELECT id, conversation_id, current_request_id, status, label FROM assistant_tasks ORDER BY conversation_id, id`
    )
  const updates = () =>
    connection.unsafe<UpdateRow[]>(
      `SELECT message_id, conversation_id, task_id, request_id, sequence, processed_at, seen_at
       FROM assistant_updates ORDER BY conversation_id, sequence`
    )

  beforeAll(async () => {
    expect(target).toBeDefined()
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO users (id, email, display_name) VALUES
        ('${owner}', 'owner@example.test', 'Owner'),
        ('${stranger}', 'stranger@example.test', 'Stranger');
      INSERT INTO agents (id, agent_type_id, status, metadata, owner_user_id)
        VALUES ('${agent}', 'system-manager', 'idle', '{}', '${owner}');
      INSERT INTO assistant_conversations (id, owner_user_id) VALUES
        ('${conv.answered}', '${owner}'), ('${conv.unread}', '${owner}'), ('${conv.silent}', '${owner}'),
        ('${conv.chain}', '${owner}'), ('${conv.orphan}', '${stranger}'), ('${conv.twin}', '${owner}');
      INSERT INTO assistant_conversation_agents (conversation_id, squad_id, agent_id)
        VALUES ('${conv.chain}', NULL, '${agent}');
      ${request(msg.answeredRequest, conv.answered, 'Summarize the backlog', '2026-01-01T00:00:00Z')}
      ${reply(msg.answeredReply, conv.answered, 'Here is an update', '2026-01-01T00:01:00Z', msg.answeredRequest, '2026-01-01T00:02:00Z')}
      ${request(msg.unreadRequest, conv.unread, 'Check the deploy', '2026-01-02T00:00:00Z')}
      ${reply(msg.unreadReply, conv.unread, 'Here is the result', '2026-01-02T00:01:00Z', msg.unreadRequest)}
      ${request(msg.silentRequest, conv.silent, 'Look into the flaky test\nwith more detail below', '2026-01-03T00:00:00Z')}
      ${request(msg.chainRoot, conv.chain, 'Compare hosting options', '2026-01-04T00:00:00Z')}
      ${reply(msg.chainQuestion, conv.chain, 'Which region?', '2026-01-04T00:01:00Z', msg.chainRoot, '2026-01-04T00:02:00Z')}
      ${request(msg.chainAnswer, conv.chain, 'us-east', '2026-01-04T00:03:00Z', msg.chainQuestion)}
      ${reply(msg.chainResult, conv.chain, 'Recommendation attached', '2026-01-04T00:04:00Z', msg.chainAnswer)}
      ${request(msg.chainSecondRoot, conv.chain, 'Also audit the budget', '2026-01-04T00:05:00Z')}
      ${reply(msg.orphanUpdate, conv.orphan, 'Cross-owner link', '2026-01-04T00:06:00Z', msg.chainRoot)}
      ${reply(msg.earlyUnordered, conv.twin, 'Arrived earlier', '2026-01-05T00:00:00Z', msg.chainRoot)}
      ${reply(msg.twinUpdate, conv.twin, 'Same timestamp as the other conversation', '2026-01-04T00:06:00Z', msg.chainRoot)}
    `)
  })

  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  test('reconstructs tasks and updates from historical inbox traffic', async () => {
    await applyMigrations(connection, target!)
    const taskRows = await tasks()
    const byConversation: Partial<Record<string, TaskRow[]>> = {}
    for (const row of taskRows) (byConversation[row.conversation_id] ??= []).push(row)
    // Historical lifecycle is unknowable; every task is `unknown`, including the one with no reply.
    expect(taskRows.every((row) => row.status === 'unknown')).toBe(true)
    expect(byConversation[conv.answered]?.map((row) => row.id)).toEqual([msg.answeredRequest])
    expect(byConversation[conv.unread]?.map((row) => row.id)).toEqual([msg.unreadRequest])
    expect(byConversation[conv.silent]).toMatchObject([{ id: msg.silentRequest, label: 'Look into the flaky test' }])
    // A question → answer → result chain is one task whose current request is the answer; a second
    // root on the same helper stays a distinct task.
    expect(byConversation[conv.chain]?.map((row) => [row.id, row.current_request_id]).sort()).toEqual(
      [
        [msg.chainRoot, msg.chainAnswer],
        [msg.chainSecondRoot, msg.chainSecondRoot],
      ].sort()
    )
    expect(byConversation[conv.orphan]).toBeUndefined()
    expect(byConversation[conv.twin]).toBeUndefined()

    const updateRows = await updates()
    const answered = updateRows.filter((row) => row.conversation_id === conv.answered)
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ task_id: msg.answeredRequest, request_id: msg.answeredRequest, sequence: 1 })
    // Previously read messages are both processed and seen; unread stay unread.
    expect(answered[0].processed_at).not.toBeNull()
    expect(answered[0].seen_at?.getTime()).toBe(answered[0].processed_at?.getTime())
    const unread = updateRows.filter((row) => row.conversation_id === conv.unread)
    expect(unread).toMatchObject([{ task_id: msg.unreadRequest, sequence: 1, processed_at: null, seen_at: null }])
    expect(updateRows.filter((row) => row.conversation_id === conv.silent)).toEqual([])
    const chain = updateRows.filter((row) => row.conversation_id === conv.chain)
    expect(chain.map((row) => [row.message_id, row.task_id, row.request_id, row.sequence])).toEqual([
      [msg.chainQuestion, msg.chainRoot, msg.chainRoot, 1],
      [msg.chainResult, msg.chainRoot, msg.chainAnswer, 2],
    ])
    // A reply link that points into another owner's conversation becomes an uncorrelated update.
    expect(updateRows.filter((row) => row.conversation_id === conv.orphan)).toMatchObject([
      { message_id: msg.orphanUpdate, task_id: null, request_id: null, sequence: 1 },
    ])
    // Equal timestamps across conversations stay independent; within one, (created_at, id) orders.
    expect(
      updateRows.filter((row) => row.conversation_id === conv.twin).map((row) => [row.message_id, row.sequence])
    ).toEqual([
      [msg.twinUpdate, 1],
      [msg.earlyUnordered, 2],
    ])

    const allocators = await connection.unsafe<{ id: string; next_update_sequence: number }[]>(
      `SELECT id, next_update_sequence FROM assistant_conversations ORDER BY id`
    )
    expect(Object.fromEntries(allocators.map((row) => [row.id, row.next_update_sequence]))).toEqual({
      [conv.answered]: 1,
      [conv.unread]: 1,
      [conv.silent]: 0,
      [conv.chain]: 2,
      [conv.orphan]: 1,
      [conv.twin]: 2,
    })
    // Requests now carry their task so post-upgrade replies correlate through the runtime path.
    const linked = await connection.unsafe<{ id: string; task: string | null }[]>(
      `SELECT id, metadata->>'assistantTaskId' AS task FROM inbox WHERE sender_type = 'voice_assistant' ORDER BY created_at`
    )
    expect(Object.fromEntries(linked.map((row) => [row.id, row.task]))).toEqual({
      [msg.answeredRequest]: msg.answeredRequest,
      [msg.unreadRequest]: msg.unreadRequest,
      [msg.silentRequest]: msg.silentRequest,
      [msg.chainRoot]: msg.chainRoot,
      [msg.chainAnswer]: msg.chainRoot,
      [msg.chainSecondRoot]: msg.chainSecondRoot,
    })
    const ledger = await connection.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at = ${target!.folderMillis}`
    )
    expect(ledger[0].count).toBe(1)
  })

  test('running the transform again changes nothing', async () => {
    const before = { tasks: await tasks(), updates: await updates() }
    await backfillAssistantActivity(connection)
    await backfillAssistantActivity(connection)
    expect(await tasks()).toEqual(before.tasks)
    expect(await updates()).toEqual(before.updates)
    const allocators = await connection.unsafe<{ next_update_sequence: number }[]>(
      `SELECT next_update_sequence FROM assistant_conversations WHERE id = '${conv.chain}'`
    )
    expect(allocators[0].next_update_sequence).toBe(2)
  })

  test('an aborted transform leaves no partial rows', async () => {
    await connection.unsafe(`
      INSERT INTO assistant_conversations (id, owner_user_id) VALUES ('20000000-0000-4000-8000-000000000007', '${owner}');
      ${request('40000000-0000-4000-8000-00000000000e', '20000000-0000-4000-8000-000000000007', 'Late arrival', '2026-01-06T00:00:00Z')}
    `)
    const countTasks = async () =>
      (await connection.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM assistant_tasks`))[0].count
    const beforeCount = await countTasks()
    await connection.unsafe('BEGIN')
    try {
      await backfillAssistantActivity(connection)
      expect(await countTasks()).toBe(beforeCount + 1)
    } finally {
      await connection.unsafe('ROLLBACK')
    }
    expect(await countTasks()).toBe(beforeCount)
  })
})
