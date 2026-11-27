import { afterEach, expect, test } from 'bun:test'
import { eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db'
import { agents, squadActivity, squads, inbox } from '../../db/schema'
import { ensureQueryIndex, generatedIndexStatement } from '../../test-utils/message-query-indexes'
import { relatedInboxPageSql } from './event-handlers'
import { chatSourcePageSql, listChatSourcePage } from './source-loaders'
import { workStreamRuntimesSql } from '../../entities/WorkStream'
import { workStreamLastEventsSql } from './global-presence'
import { settledCountSql } from './settled'

const squadIds: string[] = []
const recipientIds: string[] = []
afterEach(async () => {
  for (const id of recipientIds.splice(0)) await db.delete(inbox).where(eq(inbox.recipientId, id))
  for (const id of squadIds.splice(0)) {
    // squad_activity has no foreign key to squads: left behind, fixture rows look orphaned to later repair tests.
    await db.delete(squadActivity).where(eq(squadActivity.squadId, id))
    await db.delete(squads).where(eq(squads.id, id))
  }
})
async function fixtureAgent() {
  const [squad] = await db
    .insert(squads)
    .values({ name: `scan-cost-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadIds.push(squad.id)
  const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
  return agent
}
async function explain(query: SQL) {
  const [row] = await db.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`)
  return (row['QUERY PLAN'] as any)[0].Plan
}
function planNodes(plan: any): any[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)]
}
function buffers(plan: any): number {
  return plan['Shared Hit Blocks'] + plan['Shared Read Blocks']
}
async function withoutIndex(index: string, query: SQL) {
  const rollback = new Error('restore index')
  let plan: any
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql.raw(`DROP INDEX "${index}"`))
      const [row] = await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`)
      plan = (row['QUERY PLAN'] as any)[0].Plan
      throw rollback
    })
  ).rejects.toBe(rollback)
  return plan
}

test('inbox work-stream pages seek the requested stream and cursor', async () => {
  await ensureQueryIndex('idx_inbox_work_stream_id')
  const recipient = `scan-${crypto.randomUUID()}`
  recipientIds.push(recipient)
  const workStreamId = crypto.randomUUID()
  await db.execute(sql`INSERT INTO inbox(recipient_type,recipient_id,sender_type,sender_id,content,metadata)
    SELECT 'system',${recipient},'system','system',repeat(md5(n::text),20),
      jsonb_build_object('workStreamId',CASE WHEN n<=3 THEN ${workStreamId} ELSE 'unrelated' END)
    FROM generate_series(1,12000) n`)
  await db.execute(sql`ANALYZE inbox`)
  const first = await db.execute(relatedInboxPageSql(workStreamId, null, 2))
  const second = await db.execute(relatedInboxPageSql(workStreamId, String(first[1].id), 2))
  expect(first).toHaveLength(2)
  expect(second).toHaveLength(1)
  expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3)
  for (const cursor of [null, String(first[1].id)]) {
    const query = relatedInboxPageSql(workStreamId, cursor, 250)
    const plan = await explain(query)
    expect(JSON.stringify(plan)).toContain('idx_inbox_work_stream_id')
    expect(buffers(plan)).toBeLessThan(100)
    expect(buffers(await withoutIndex('idx_inbox_work_stream_id', query))).toBeGreaterThan(100)
  }
})

test('chat repair pages use an execution cursor without rescanning full message history', async () => {
  await ensureQueryIndex('idx_messages_chat_source_page')
  const agent = await fixtureAgent()
  const executionPrefix = crypto.randomUUID().slice(0, 24)
  await db.execute(sql`INSERT INTO messages(agent_id,role,content,metadata,created_at)
    SELECT ${agent.id}::uuid,'assistant',repeat(md5(n::text),20),
      jsonb_build_object('executionId',${executionPrefix} || lpad((n%10000)::text,12,'0')),
      CASE WHEN n<=16000 THEN '2098-01-01'::timestamp ELSE '2099-01-01'::timestamp END + n * interval '1 second'
    FROM generate_series(1,20000) n`)
  await db.execute(sql`VACUUM (ANALYZE) messages`)
  const from = new Date('2099-01-01T00:00:00Z')
  const to = new Date('2099-01-03T00:00:00Z')
  const first = await listChatSourcePage(from, to, null, 250)
  const second = await listChatSourcePage(from, to, first.next, 250)
  expect(first.groupIds).toHaveLength(250)
  expect(second.groupIds).toHaveLength(250)
  expect(new Set([...first.groupIds, ...second.groupIds]).size).toBe(500)
  for (const after of [null, first.next]) {
    const query = chatSourcePageSql(from, to, after, 250)
    const plan = await explain(query)
    const old = await withoutIndex('idx_messages_chat_source_page', query)
    if (process.env.CORE_DB_PRINT_EXPLAIN === '1') console.log('chat plans', JSON.stringify({ plan, old }))
    expect(JSON.stringify(plan)).toContain('idx_messages_chat_source_page')
    expect(buffers(plan)).toBeLessThan(buffers(old) / 2)
    expect(buffers(plan)).toBeLessThan(1500)
  }
})

test('runtime aggregation reads a covering index rather than wide execution rows', async () => {
  await ensureQueryIndex('idx_executions_agent_status_started_at')
  await ensureQueryIndex('idx_executions_agent_runtime')
  const agent = await fixtureAgent()
  await db.execute(sql`INSERT INTO executions(agent_id,status,started_at,ended_at,usage)
    SELECT ${agent.id}::uuid,'completed','2026-01-01'::timestamp+n*interval '1 minute',
      '2026-01-01'::timestamp+n*interval '1 minute'+interval '1 second',jsonb_build_object('test',repeat(md5(n::text),30))
    FROM generate_series(1,12000) n`)
  // Settled history becomes all-visible under normal autovacuum; model that state.
  await db.execute(sql`VACUUM (ANALYZE) executions`)
  const query = workStreamRuntimesSql([{ wsId: crypto.randomUUID(), agentId: agent.id }])
  const [total] = await db.execute(query)
  expect(Number(total.total_ms)).toBe(12000000)
  expect(Number(total.active_count)).toBe(0)
  const plan = await explain(query)
  const old = await withoutIndex('idx_executions_agent_runtime', query)
  if (process.env.CORE_DB_PRINT_EXPLAIN === '1') console.log('runtime plans', JSON.stringify({ plan, old }))
  expect(JSON.stringify(plan)).toContain('idx_executions_agent_runtime')
  expect(JSON.stringify(plan)).toContain('Index Only Scan')
  expect(buffers(plan)).toBeLessThan(buffers(old) / 3)
})

test('Active work last events probe each participant once instead of scanning its history', async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `scan-cost-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadIds.push(squad.id)
  // 40 active streams, one bound participant each, 600 retained rows per participant.
  const streams = 40
  const rowsPerAgent = 600
  const streamIds = (
    await db.execute<{ id: string }>(sql`
      WITH agent_rows AS (
        INSERT INTO agents(squad_id,agent_type_id) SELECT ${squad.id}::uuid,'engineer' FROM generate_series(1,${streams})
        RETURNING id
      ), numbered AS (SELECT id,row_number() OVER (ORDER BY id) n FROM agent_rows),
      stream_rows AS (
        INSERT INTO work_streams(squad_id,title) SELECT ${squad.id}::uuid,'Stream ' || n FROM numbered RETURNING id,title
      ), bound AS (
        INSERT INTO workflow_bindings(agent_id,work_stream_id,participant_id,binding_key,agent_snapshot)
        SELECT numbered.id,stream_rows.id,'engineer','engineer','{}'::jsonb
        FROM numbered JOIN stream_rows ON stream_rows.title='Stream ' || numbered.n
        RETURNING work_stream_id
      )
      SELECT work_stream_id id FROM bound`)
  ).map((row) => row.id)
  const query = workStreamLastEventsSql(streamIds, new Date(Date.now() - 30 * 24 * 60 * 60_000))

  // The 24,000 activity rows live in a temporary squad_activity that shadows the shared table
  // for this transaction only (pg_temp is searched first) and disappears on rollback. Inserting
  // and deleting them in the shared table would leave dead entries in its agent index and skew
  // later plan tests (schema.test.ts) toward the feed index. Its agent index is the generated
  // production DDL retargeted at the temporary table, so a change to the real index fails here.
  const agentIndex = generatedIndexStatement('idx_squad_activity_agent')
  const tempAgentIndex = agentIndex.replace(' ON "squad_activity" ', ' ON pg_temp."squad_activity" ')
  expect(tempAgentIndex).not.toBe(agentIndex)
  const rollback = new Error('discard fixture')
  let result: Array<{ last_at: Date | string }> = []
  let plan: any
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE squad_activity (LIKE public.squad_activity INCLUDING DEFAULTS) ON COMMIT DROP`
      )
      await tx.execute(sql.raw(tempAgentIndex))
      await tx.execute(sql`INSERT INTO squad_activity(squad_id,lane,row_id,source_family,source_group_id,at,agent_id,
          agent_type_id,kind,summary,preview,ref,quiet_eligible,access_scope,payload_hash)
        SELECT ${squad.id}::uuid,10,gen_random_uuid(),'chat',gen_random_uuid()::text,
          now() - (n * interval '1 minute'),b.agent_id,'engineer','message',repeat(md5(n::text),8),'[]'::jsonb,
          jsonb_build_object('type','agent','agentId',b.agent_id,'view','chat'),true,'agents',md5(n::text) || md5(b.agent_id::text)
        FROM workflow_bindings b CROSS JOIN generate_series(1,${rowsPerAgent}) n
        WHERE b.work_stream_id IN (${sql.join(
          streamIds.map((id) => sql`${id}::uuid`),
          sql`,`
        )})`)
      await tx.execute(sql`ANALYZE squad_activity`)
      result = (await tx.execute(query)) as unknown as Array<{ last_at: Date | string }>
      const [row] = await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`)
      plan = (row['QUERY PLAN'] as any)[0].Plan
      throw rollback
    })
  ).rejects.toBe(rollback)

  expect(result).toHaveLength(streams)
  // The newest row per participant is one minute old.
  for (const row of result) expect(Date.now() - new Date(row.last_at).getTime()).toBeLessThan(5 * 60_000)
  if (process.env.CORE_DB_PRINT_EXPLAIN === '1') console.log('last event plan', JSON.stringify(plan))
  // Each participant's probe stops at its newest row instead of reading (and sorting) its 600-row
  // history, which needs the ORDER BY to match the index. Sorting the 40 grouped results above the
  // probes is fine, so the assertion is on the probe itself, not on the whole plan.
  const probes = planNodes(plan).filter((node) => node['Index Name'] === 'idx_squad_activity_agent')
  expect(probes).toHaveLength(1)
  expect(probes[0]['Actual Loops']).toBe(streams)
  expect(probes[0]['Actual Rows']).toBeLessThanOrEqual(1)
  expect(buffers(plan)).toBeLessThan(streams * 6)
})

test("the Feed's settled count seeks its two row kinds instead of reading every row of the period", async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `scan-cost-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadIds.push(squad.id)
  const since = new Date(Date.now() - 2 * 60 * 60_000)
  const query = settledCountSql(
    [{ squadId: squad.id, access: { agentsRead: true, workstreamsRead: true, inbox: { mode: 'all' } } }],
    since
  )
  // Same shadowing as above: a temporary squad_activity with the generated production indexes.
  const indexes = ['idx_squad_activity_feed', 'idx_squad_activity_kind'].map((name) =>
    generatedIndexStatement(name).replace(' ON "squad_activity" ', ' ON pg_temp."squad_activity" ')
  )
  const rollback = new Error('discard fixture')
  let plan: any
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE squad_activity (LIKE public.squad_activity INCLUDING DEFAULTS) ON COMMIT DROP`
      )
      for (const index of indexes) await tx.execute(sql.raw(index))
      // 20,000 rows in the period, and a handful of wait rows the count has to look at. The other rows
      // carry thousands of distinct kinds (the temporary table has no lane/kind check), so Postgres 18's
      // skip scan cannot reach the wait rows through the kind index unless the query names the kind:
      // Postgres 16, which production compose runs, has no skip scan at all.
      await tx.execute(sql`INSERT INTO squad_activity(squad_id,lane,row_id,source_family,source_group_id,at,agent_id,
          agent_type_id,kind,summary,preview,ref,quiet_eligible,access_scope,payload_hash)
        SELECT ${squad.id}::uuid,CASE WHEN n<=5 THEN 41 ELSE 10 END,gen_random_uuid(),
          CASE WHEN n<=5 THEN 'wait' ELSE 'chat' END,gen_random_uuid()::text,
          now() - (n * interval '300 milliseconds'),NULL,'engineer',CASE WHEN n<=5 THEN 'wait' ELSE 'message-' || n END,
          repeat(md5(n::text),8),'[]'::jsonb,'{}'::jsonb,true,(CASE WHEN n<=5 THEN 'workstreams' ELSE 'agents' END)::squad_activity_access_scope,
          md5(n::text) || md5(n::text)
        FROM generate_series(1,20000) n`)
      await tx.execute(sql`ANALYZE squad_activity`)
      const [row] = await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`)
      plan = (row['QUERY PLAN'] as any)[0].Plan
      throw rollback
    })
  ).rejects.toBe(rollback)
  if (process.env.CORE_DB_PRINT_EXPLAIN === '1') console.log('settled count plan', JSON.stringify(plan))
  const indexesUsed = planNodes(plan).map((node) => node['Index Name'])
  expect(indexesUsed).toContain('idx_squad_activity_kind')
  expect(indexesUsed).not.toContain('idx_squad_activity_feed')
  expect(
    planNodes(plan).some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'squad_activity')
  ).toBe(false)
  expect(buffers(plan)).toBeLessThan(100)
})
