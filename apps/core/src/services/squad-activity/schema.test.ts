import { afterEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { squadActivity, squads } from '../../db/schema'
import { ensureQueryIndex } from '../../test-utils/message-query-indexes'

const squadIds: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})
const values = (squadId: string) => ({
  squadId,
  lane: 70,
  rowId: crypto.randomUUID(),
  sourceFamily: 'github-pr',
  sourceGroupId: crypto.randomUUID(),
  at: new Date(),
  agentId: null,
  workStreamId: null,
  agentTypeId: null,
  kind: 'pr' as const,
  summary: '[PR #1 closed]',
  ref: { type: 'pr' as const, url: 'https://github.com/acme/widgets/pull/1' },
  quietEligible: true,
  accessScope: 'workstreams' as const,
  inboxRecipientId: null,
  payloadHash: 'a'.repeat(64),
})

describe('squad_activity schema', () => {
  test('rejects noncanonical lane-kind, lane-scope, and recipient combinations', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-schema-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const rejected = async (query: PromiseLike<unknown>) => {
      try {
        await query
        return false
      } catch {
        return true
      }
    }
    expect(await rejected(db.insert(squadActivity).values({ ...values(squad.id), kind: 'message' }))).toBe(true)
    expect(await rejected(db.insert(squadActivity).values({ ...values(squad.id), accessScope: 'agents' }))).toBe(true)
    expect(
      await rejected(db.insert(squadActivity).values({ ...values(squad.id), inboxRecipientId: crypto.randomUUID() }))
    ).toBe(true)
  })

  test('admits lane 71 issue rows only with the issue kind and the workstreams scope', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-schema-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const issueRow = {
      ...values(squad.id),
      lane: 71,
      sourceFamily: 'github-issue',
      kind: 'issue' as const,
      summary: '[Issue #1 closed]',
      ref: { type: 'issue' as const, url: 'https://github.com/acme/widgets/issues/1' },
    }
    const rejected = async (query: PromiseLike<unknown>) => {
      try {
        await query
        return false
      } catch {
        return true
      }
    }
    await db.insert(squadActivity).values(issueRow)
    // Lane 71 is the issue lane: no other kind, no other scope, and no issue row on the PR lane.
    expect(
      await rejected(db.insert(squadActivity).values({ ...issueRow, rowId: crypto.randomUUID(), kind: 'pr' }))
    ).toBe(true)
    expect(
      await rejected(
        db.insert(squadActivity).values({ ...issueRow, rowId: crypto.randomUUID(), accessScope: 'agents' })
      )
    ).toBe(true)
    expect(await rejected(db.insert(squadActivity).values({ ...issueRow, rowId: crypto.randomUUID(), lane: 70 }))).toBe(
      true
    )
  })

  test('feed, kind, agent, and own-inbox shapes use their projection indexes', async () => {
    // drizzle-kit push intentionally skips concurrent/index extras in the shared
    // test schema; install the generated migration definitions before EXPLAIN.
    await ensureQueryIndex('idx_squad_activity_feed')
    await ensureQueryIndex('idx_squad_activity_kind')
    await ensureQueryIndex('idx_squad_activity_agent')
    await ensureQueryIndex('idx_squad_activity_inbox')
    const squadId = crypto.randomUUID()
    const agentId = crypto.randomUUID()
    // Seed real statistics for THIS squad before EXPLAINing. On an empty table
    // the narrower projection indexes and the feed index are cost ties, and the
    // planner's tie-break flips with whatever else the shared test DB
    // accumulated — a flake, not a schema regression. With mixed kinds, agents,
    // and recipients ANALYZEd, each predicate's projection index is strictly
    // cheaper than the feed index, so every assertion below is deterministic.
    const seeded: Array<typeof squadActivity.$inferInsert> = []
    for (let i = 0; i < 10; i += 1) {
      seeded.push({
        ...values(squadId),
        rowId: crypto.randomUUID(),
        at: new Date(Date.now() - i * 1_000),
        lane: 40,
        kind: 'wait',
        sourceFamily: 'wait',
        sourceGroupId: crypto.randomUUID(),
        workStreamId: crypto.randomUUID(),
        ref: { type: 'workstream', workStreamId: crypto.randomUUID() },
      })
      seeded.push({
        ...values(squadId),
        rowId: crypto.randomUUID(),
        at: new Date(Date.now() - i * 1_000 - 500),
      })
      seeded.push({
        ...values(squadId),
        rowId: crypto.randomUUID(),
        at: new Date(Date.now() - i * 1_000 - 250),
        lane: 60,
        kind: 'execution',
        sourceFamily: 'execution',
        sourceGroupId: crypto.randomUUID(),
        accessScope: 'agents',
        agentId,
        agentTypeId: crypto.randomUUID(),
        ref: { type: 'agent', agentId, view: 'chat' },
      })
      seeded.push({
        ...values(squadId),
        rowId: crypto.randomUUID(),
        at: new Date(Date.now() - i * 1_000 - 125),
        lane: 20,
        kind: 'message',
        sourceFamily: 'inbox',
        sourceGroupId: crypto.randomUUID(),
        accessScope: 'inbox',
        inboxRecipientId: agentId,
        agentId,
        agentTypeId: crypto.randomUUID(),
        ref: { type: 'agent', agentId, view: 'inbox' },
      })
    }
    await db.insert(squadActivity).values(seeded)
    squadIds.push(squadId)
    await db.execute(sql`ANALYZE squad_activity`)
    const explain = async (predicate: ReturnType<typeof sql>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan=off`)
        await tx.execute(sql`SET LOCAL enable_sort=off`)
        const rows = await tx.execute<any>(sql`EXPLAIN (FORMAT JSON) SELECT * FROM squad_activity
          WHERE squad_id=${squadId}::uuid AND ${predicate}
          ORDER BY at DESC NULLS LAST,lane DESC NULLS LAST,row_id DESC NULLS LAST LIMIT 51`)
        return JSON.stringify(rows)
      })
    expect(await explain(sql`TRUE`)).toContain('idx_squad_activity_feed')
    expect(await explain(sql`kind='wait'`)).toContain('idx_squad_activity_kind')
    expect(await explain(sql`agent_id=${agentId}::uuid`)).toContain('idx_squad_activity_agent')
    expect(await explain(sql`inbox_recipient_id=${agentId}::uuid`)).toContain('idx_squad_activity_inbox')
  })
})
