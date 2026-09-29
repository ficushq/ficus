import { ensureMessageQueryIndex } from '../../test-utils/message-query-indexes'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  integrationEventPollingDispatches,
  messages,
  squadActivity,
  inbox,
  squadSourceConfigs,
  squads,
  webhookEvents,
  workStreams,
} from '../../db/schema'
import { materializeGitHubDispatch, materializeGitHubWebhook } from './materialize'
import { DbEventPollingDispatchStore } from '../integrations/db-event-polling-dispatch-store'
import { githubPrLogicalRowId, type GitHubPrDispatchFact } from './github-pr-fact'
import { extractGitHubIssueDispatchFact } from './github-issue-fact'
import { listSourceGroupPage, loadActivitySource } from './families'
import {
  listGitHubAssociationPage,
  listGitHubIssueAssociationPage,
  loadChatSnapshot,
  loadInboxSnapshot,
} from './source-loaders'

const squadIds: string[] = []
const webhookIds: string[] = []
const dispatchKeys: string[] = []
const inboxIds: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  for (const webhookId of webhookIds.splice(0)) await db.delete(webhookEvents).where(eq(webhookEvents.id, webhookId))
  for (const inboxId of inboxIds.splice(0)) await db.delete(inbox).where(eq(inbox.id, inboxId))
  for (const eventKey of dispatchKeys.splice(0))
    await db.delete(integrationEventPollingDispatches).where(eq(integrationEventPollingDispatches.eventKey, eventKey))
})

describe('loadInboxSnapshot join keys', () => {
  // The joins cast the *text* side to uuid so agents_pkey stays usable. That
  // makes malformed join keys a correctness problem rather than a slow path:
  // `recipient_id` is varchar(200) and holds the literal 'system', so an
  // unguarded `::uuid` raises 22P02 and takes the whole feed down. Drop the
  // regex guard in uuidJoinKey and this test fails with
  // "invalid input syntax for type uuid".
  test('resolves a system-recipient message instead of raising on the cast', async () => {
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'system',
        recipientId: 'system',
        senderType: 'system',
        senderId: 'system',
        content: 'system notice',
      })
      .returning()
    inboxIds.push(message.id)

    const snapshot = await loadInboxSnapshot(db, message.id)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.recipientId).toBe('system')
    // No agent row can match a non-uuid key, exactly as under the old
    // `agents.id::text = recipient_id` form.
    expect(snapshot?.recipientSquadId).toBeNull()
    expect(snapshot?.senderAgentExists).toBe(false)
  })

  test('still resolves the agent, sender and work stream for a normal message', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-inbox-join-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [recipient] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [sender] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'architect' }).returning()
    const [stream] = await db.insert(workStreams).values({ squadId: squad.id, title: 'join key stream' }).returning()
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'hello',
        metadata: { workStreamId: stream.id },
      })
      .returning()
    inboxIds.push(message.id)

    const snapshot = await loadInboxSnapshot(db, message.id)

    expect(snapshot?.recipientSquadId).toBe(squad.id)
    expect(snapshot?.recipientAgentTypeId).toBe('engineer')
    expect(snapshot?.senderAgentExists).toBe(true)
    expect(snapshot?.senderAgentTypeId).toBe('architect')
    expect(snapshot?.workStream?.id).toBe(stream.id)
    expect(snapshot?.workStream?.title).toBe('join key stream')
  })

  test('ignores a non-uuid workStreamId in metadata rather than raising', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-inbox-badws-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [recipient] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'system',
        senderId: 'system',
        content: 'hello',
        // metadata is free-form jsonb: nothing constrains this to a uuid.
        metadata: { workStreamId: 'not-a-uuid' },
      })
      .returning()
    inboxIds.push(message.id)

    const snapshot = await loadInboxSnapshot(db, message.id)

    expect(snapshot?.recipientSquadId).toBe(squad.id)
    expect(snapshot?.workStream).toBeNull()
  })
})

describe('sparse chat execution lookup', () => {
  test('uses the execution index instead of filtering the agent history', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `sparse-chat-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'completed' }).returning()
    await db.execute(sql`INSERT INTO messages (agent_id, role, content, metadata, created_at)
      SELECT ${agent.id}::uuid, 'assistant', repeat(md5(n::text), 20),
        jsonb_build_object('executionId', CASE WHEN n = 6000 THEN ${execution.id} ELSE 'other-execution' END),
        '2026-01-01'::timestamp + n * interval '1 second'
      FROM generate_series(1, 12000) n`)
    await db.execute(sql`ANALYZE messages`)
    await ensureMessageQueryIndex('idx_messages_agent_execution')
    const queries: SQL[] = []
    const snapshot = await loadChatSnapshot(
      {
        execute: ((query: SQL) => {
          queries.push(query)
          return db.execute(query)
        }) as typeof db.execute,
      },
      execution.id
    )
    expect(snapshot?.messages).toHaveLength(1)
    const [explained] = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries[1]}`)
    const plan = (explained['QUERY PLAN'] as any)[0].Plan
    expect(JSON.stringify(plan)).toContain('idx_messages_agent_execution')
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(100)
    if (process.env.CORE_DB_PRINT_EXPLAIN === '1') console.log('sparse execution', JSON.stringify(explained))
    // Prove the regression test detects removal of the fix. Transactional DDL
    // rolls back so other tests keep the generated production index.
    const rollback = new Error('restore execution index')
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`DROP INDEX idx_messages_agent_execution`)
        const [withoutIndex] = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries[1]}`)
        const oldPlan = (withoutIndex['QUERY PLAN'] as any)[0].Plan
        expect(oldPlan['Shared Hit Blocks'] + oldPlan['Shared Read Blocks']).toBeGreaterThan(100)
        throw rollback
      })
    ).rejects.toBe(rollback)
  })
})

describe('Activity source pagination', () => {
  test('returns each chat execution once across message-heavy page boundaries', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-chat-groups-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const executionRows = await db
      .insert(executions)
      .values([
        { agentId: agent.id, status: 'completed' },
        { agentId: agent.id, status: 'completed' },
      ])
      .returning({ id: executions.id })
    await db.insert(messages).values([
      ...Array.from({ length: 3 }, (_, index) => ({
        agentId: agent.id,
        role: 'assistant' as const,
        content: `first ${index}`,
        metadata: { executionId: executionRows[0].id },
        createdAt: new Date(`2026-08-20T00:0${index}:00Z`),
      })),
      {
        agentId: agent.id,
        role: 'assistant',
        content: 'second',
        metadata: { executionId: executionRows[1].id },
        createdAt: new Date('2026-08-20T00:10:00Z'),
      },
    ])
    const collected: string[] = []
    let cursor = null
    do {
      const page = await listSourceGroupPage(
        'chat',
        new Date('2026-08-20T00:00:00Z'),
        new Date('2026-08-21T00:00:00Z'),
        cursor,
        1
      )
      collected.push(...page.groupIds)
      cursor = page.next
    } while (cursor)
    expect(collected.sort()).toEqual(executionRows.map((row) => row.id).sort())
  })

  test('continues by immutable source identity when a source timestamp changes between pages', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-source-page-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ]
    await db.insert(workStreams).values(
      ids.map((id, index) => ({
        id,
        squadId: squad.id,
        title: `immutable-${index}`,
        createdAt: new Date(`2026-08-24T00:0${index}:00Z`),
      }))
    )
    const from = new Date('2026-08-24T00:00:00Z')
    const to = new Date('2026-08-24T01:00:00Z')
    const first = await listSourceGroupPage('workstream', from, to, null, 2)
    expect(first.groupIds).toEqual(ids.slice(0, 2))
    await db
      .update(workStreams)
      .set({ createdAt: new Date('2026-08-24T00:00:30Z') })
      .where(eq(workStreams.id, ids[2]))
    const second = await listSourceGroupPage('workstream', from, to, first.next, 2)
    expect(second.groupIds).toEqual(ids.slice(2))
    expect(new Set([...first.groupIds, ...second.groupIds])).toEqual(new Set(ids))
  })

  test('limits polling association to squads recorded for that dispatch', async () => {
    const repository = `poll-owner-${crypto.randomUUID()}/widgets`
    const createdSquads: Array<{ id: string }> = []
    for (let index = 0; index < 2; index++) {
      const [squad] = await db
        .insert(squads)
        .values({ name: `activity-poll-owner-${index}-${crypto.randomUUID()}`, purpose: 'test' })
        .returning()
      squadIds.push(squad.id)
      createdSquads.push(squad)
      await db.insert(workStreams).values([
        {
          squadId: squad.id,
          title: `same poll coordinates ${index}`,
          metadata:
            index === 1
              ? { codeHost: { integration: 'github', repository, changeRequest: { number: 42 } } }
              : { github: { repo: repository, pr: { number: 42 } } },
        },
        ...(index === 0
          ? [
              {
                squadId: squad.id,
                title: 'duplicate canonical association',
                metadata: { github: { repo: repository, pr: { number: 42 } } },
              },
            ]
          : []),
      ])
    }
    const factBase = {
      eventType: 'pull_request' as const,
      action: 'closed',
      occurredAt: '2026-08-20T12:00:00.000Z',
      actorLogin: null,
      repository,
      prNumber: 42,
      nativeId: '4200',
      providerDeliveryId: null,
      url: `https://github.com/${repository}/pull/42`,
    }
    const fact: GitHubPrDispatchFact = { ...factBase, logicalRowId: githubPrLogicalRowId(factBase) }
    const activityId = crypto.randomUUID()
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId,
      activitySquadIds: [createdSquads[0].id],
      eventFact: fact,
      eventOccurredAt: new Date(fact.occurredAt),
      completedAt: new Date(),
    })
    const page = await listGitHubAssociationPage(`poll:${activityId}`, fact, null, 10)
    expect(page.groupIds).toEqual([expect.stringContaining(`:${createdSquads[0].id}`)])
    await materializeGitHubDispatch(activityId, createdSquads[0].id)
    // Squad 0 has two streams naming this PR, and each one is attributed the event.
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, createdSquads[0].id))).toHaveLength(2)

    await materializeGitHubDispatch(activityId, createdSquads[1].id)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, createdSquads[1].id))).toEqual([])
    const [dispatch] = await db
      .select({ squadIds: integrationEventPollingDispatches.activitySquadIds })
      .from(integrationEventPollingDispatches)
      .where(eq(integrationEventPollingDispatches.activityId, activityId))
    expect(dispatch.squadIds).toEqual([createdSquads[0].id])

    await new DbEventPollingDispatchStore().authorizeActivitySquad('github', eventKey, createdSquads[1].id)
    const laterPage = await listGitHubAssociationPage(`poll:${activityId}`, fact, null, 10)
    expect(laterPage.groupIds.sort()).toEqual(createdSquads.map((squad) => `poll:${activityId}:${squad.id}`).sort())
    await materializeGitHubDispatch(activityId, createdSquads[1].id)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, createdSquads[1].id))).toHaveLength(1)

    const emptyActivityId = crypto.randomUUID()
    const emptyEventKey = crypto.randomUUID()
    dispatchKeys.push(emptyEventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey: emptyEventKey,
      activityId: emptyActivityId,
      eventFact: fact,
      eventOccurredAt: new Date(fact.occurredAt),
      completedAt: new Date(),
    })
    expect((await listGitHubAssociationPage(`poll:${emptyActivityId}`, fact, null, 10)).groupIds).toEqual([])
    await materializeGitHubDispatch(emptyActivityId, createdSquads[0].id)
    expect(
      await db
        .select()
        .from(squadActivity)
        .where(eq(squadActivity.sourceGroupId, `poll:${emptyActivityId}:${createdSquads[0].id}`))
    ).toEqual([])
  })

  test('pages more than the production association page without duplicate squads', async () => {
    const repository = `large-owner-${crypto.randomUUID()}/widgets`
    const createdSquads = await db
      .insert(squads)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          name: `activity-large-owner-${index}-${crypto.randomUUID()}`,
          purpose: 'test',
        }))
      )
      .returning({ id: squads.id })
    squadIds.push(...createdSquads.map((squad) => squad.id))
    await db.insert(workStreams).values(
      createdSquads.flatMap((squad, index) => [
        {
          squadId: squad.id,
          title: `large association ${index}`,
          metadata: { github: { repo: repository, pr: { number: 42 } } },
        },
        ...(index === 0
          ? [
              {
                squadId: squad.id,
                title: 'same squad duplicate association',
                metadata: { github: { repo: repository, pr: { number: 42 } } },
              },
            ]
          : []),
      ])
    )
    const factBase = {
      eventType: 'pull_request' as const,
      action: 'closed',
      occurredAt: '2026-08-20T12:00:00.000Z',
      actorLogin: null,
      repository,
      prNumber: 42,
      nativeId: '4200',
      providerDeliveryId: null,
      url: `https://github.com/${repository}/pull/42`,
    }
    const fact: GitHubPrDispatchFact = { ...factBase, logicalRowId: githubPrLogicalRowId(factBase) }
    const activityId = crypto.randomUUID()
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId,
      activitySquadIds: createdSquads.map((squad) => squad.id),
      eventFact: fact,
      eventOccurredAt: new Date(fact.occurredAt),
      completedAt: new Date(),
    })
    const first = await listGitHubAssociationPage(`poll:${activityId}`, fact, null, 100)
    expect(first.groupIds).toHaveLength(100)
    expect(first.next).not.toBeNull()
    const second = await listGitHubAssociationPage(`poll:${activityId}`, fact, first.next, 100)
    expect(second.groupIds).toHaveLength(1)
    expect(second.next).toBeNull()
    expect(new Set([...first.groupIds, ...second.groupIds]).size).toBe(101)
  }, 30_000)

  test('uses authoritative occurrence time and bounds delayed webhook association pages', async () => {
    const from = new Date('2026-08-20T00:00:00Z')
    const to = new Date('2026-08-21T00:00:00Z')
    const scanTo = new Date('2026-08-23T00:00:00Z')
    const expectedGroups: string[] = []
    for (let index = 0; index < 9; index++) {
      const [squad] = await db
        .insert(squads)
        .values({ name: `activity-hook-page-${index}-${crypto.randomUUID()}`, purpose: 'test' })
        .returning()
      squadIds.push(squad.id)
      await db.insert(squadSourceConfigs).values({
        squadId: squad.id,
        sourceType: 'github_issue',
        enabled: true,
        policy: { version: 1, scope: { repos: ['acme/widgets'] } },
      })
      await db.insert(workStreams).values({
        squadId: squad.id,
        title: `hook-page-${index}`,
        metadata: { github: { repo: 'acme/widgets', pr: { number: 42 } } },
      })
      expectedGroups.push(squad.id)
    }
    const payload = (nativeId: number, occurredAt: string) => ({
      action: 'created',
      repository: { full_name: 'Acme/Widgets' },
      issue: { number: 42, pull_request: { html_url: 'https://github.com/acme/widgets/pull/42' } },
      comment: { id: nativeId, created_at: occurredAt, user: { login: 'bot' } },
    })
    const [outside, afterWindow, delayed] = await db
      .insert(webhookEvents)
      .values([
        {
          provider: 'github',
          eventType: 'issue_comment',
          payload: payload(9000, '2026-08-19T23:59:59Z'),
          headers: {},
          verified: true,
          activitySquadIds: expectedGroups,
          createdAt: new Date('2026-08-20T12:00:00Z'),
        },
        {
          provider: 'github',
          eventType: 'issue_comment',
          payload: payload(9001, '2026-08-21T00:00:00Z'),
          headers: {},
          verified: true,
          activitySquadIds: expectedGroups,
          createdAt: new Date('2026-08-20T13:00:00Z'),
        },
        {
          provider: 'github',
          eventType: 'issue_comment',
          payload: payload(9002, '2026-08-20T12:00:00Z'),
          headers: {},
          verified: true,
          activitySquadIds: expectedGroups,
          createdAt: new Date('2026-08-22T12:00:00Z'),
        },
      ])
      .returning()
    webhookIds.push(outside.id, afterWindow.id, delayed.id)

    const groups: string[] = []
    let cursor = null
    let pages = 0
    do {
      const page = await listSourceGroupPage('github-pr', from, to, cursor, 2, scanTo)
      groups.push(...page.groupIds)
      cursor = page.next
      pages++
      expect(pages).toBeLessThan(20)
    } while (cursor)

    expect(groups.map((group) => group.split(':').at(-1)).sort()).toEqual(expectedGroups.sort())
    expect(groups.every((group) => group.startsWith(`hook:${delayed.id}:`))).toBe(true)
    expect(pages).toBe(7)
    let active = 0
    let maximumActive = 0
    let calls = 0
    expect(
      await materializeGitHubWebhook(delayed.id, {
        pageSize: 9,
        concurrency: 4,
        materialize: async () => {
          calls++
          active++
          maximumActive = Math.max(maximumActive, active)
          await Bun.sleep(5)
          active--
          return { upserted: [], inserted: [], updated: [], deleted: [] }
        },
      })
    ).toBe(9)
    expect(calls).toBe(9)
    expect(maximumActive).toBe(4)
    expect(await materializeGitHubWebhook(delayed.id, { pageSize: 2, concurrency: 4 })).toBe(9)
    expect((await db.select().from(squadActivity)).filter((row) => expectedGroups.includes(row.squadId))).toHaveLength(
      9
    )
  })
})

describe('tracked GitHub issue source pagination', () => {
  test('pages poll and hook issue receipts and gates them on receipt ownership', async () => {
    const from = new Date('2026-09-10T00:00:00Z')
    const to = new Date('2026-09-11T00:00:00Z')
    const repository = `issue-pager-${crypto.randomUUID()}/widgets`
    const created: Array<{ id: string }> = []
    for (let index = 0; index < 2; index++) {
      const [squad] = await db
        .insert(squads)
        .values({ name: `issue-pager-${index}-${crypto.randomUUID()}`, purpose: 'test' })
        .returning()
      squadIds.push(squad.id)
      created.push(squad)
      await db.insert(workStreams).values({
        squadId: squad.id,
        title: `issue pager ${index}`,
        metadata: { tracked: [{ integration: 'github', repository, kind: 'issue', number: 12 }] },
      })
    }
    const payload = {
      action: 'closed',
      repository: { full_name: repository },
      sender: { login: 'noahsaso' },
      issue: {
        id: 9912,
        number: 12,
        title: 'Pager issue',
        closed_at: '2026-09-10T06:00:00Z',
        updated_at: '2026-09-10T06:00:00Z',
        html_url: `https://github.com/${repository}/issues/12`,
      },
    }
    const fact = extractGitHubIssueDispatchFact('github', { type: 'issues', payload, metadata: { synthetic: true } })!
    const activityId = crypto.randomUUID()
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId,
      activitySquadIds: [created[0].id],
      eventFact: fact,
      eventOccurredAt: new Date(fact.occurredAt),
      completedAt: new Date(),
    })
    const [webhook] = await db
      .insert(webhookEvents)
      .values({
        provider: 'github',
        eventType: 'issue_comment',
        payload: {
          ...payload,
          action: 'created',
          comment: { id: 5502, created_at: '2026-09-10T07:00:00Z', user: { login: 'ficusagent' } },
        },
        headers: {},
        verified: true,
        activitySquadIds: [created[1].id],
        createdAt: new Date('2026-09-10T07:00:01Z'),
      })
      .returning()
    webhookIds.push(webhook.id)

    const collect = async (family: 'github-pr' | 'github-issue') => {
      const groups: string[] = []
      let cursor = null
      let pages = 0
      do {
        const page = await listSourceGroupPage(family, from, to, cursor, 2, to)
        groups.push(...page.groupIds)
        cursor = page.next
        expect(++pages).toBeLessThan(40)
      } while (cursor)
      return groups.filter((group) => created.some((squad) => group.endsWith(`:${squad.id}`)))
    }
    expect((await collect('github-issue')).sort()).toEqual(
      [`poll:${activityId}:${created[0].id}`, `hook:${webhook.id}:${created[1].id}`].sort()
    )
    // Lane 70 never claims an issue receipt.
    expect(await collect('github-pr')).toEqual([])

    // Association is gated on the receipt's immutable owners, exactly like PRs.
    expect((await listGitHubIssueAssociationPage(`poll:${activityId}`, fact, null, 10)).groupIds).toEqual([
      `poll:${activityId}:${created[0].id}`,
    ])
    const snapshot = await loadActivitySource(db, {
      family: 'github-issue',
      groupId: `poll:${activityId}:${created[1].id}`,
    })
    expect(snapshot).toBeNull()
  })

  test('carries every stream in the squad that tracks the resource, in creation order', async () => {
    const repository = `multi-stream-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `multi-stream-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const tracked = (number: number) => ({ tracked: [{ integration: 'github', repository, kind: 'issue', number }] })
    // Explicit creation times pin the deterministic `ORDER BY created_at,id`.
    const [first] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: 'first tracker',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        metadata: tracked(12),
      })
      .returning()
    await db.insert(workStreams).values({
      squadId: squad.id,
      title: 'unrelated tracker',
      createdAt: new Date('2026-09-02T00:00:00Z'),
      metadata: tracked(99),
    })
    const [third] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: 'second tracker',
        createdAt: new Date('2026-09-03T00:00:00Z'),
        metadata: tracked(12),
      })
      .returning()

    const fact = extractGitHubIssueDispatchFact('github', {
      type: 'issues',
      payload: {
        action: 'closed',
        repository: { full_name: repository },
        sender: { login: 'noahsaso' },
        issue: {
          id: 9913,
          number: 12,
          title: 'Shared issue',
          closed_at: '2026-09-10T06:00:00Z',
          updated_at: '2026-09-10T06:00:00Z',
          html_url: `https://github.com/${repository}/issues/12`,
        },
      },
      metadata: { synthetic: true },
    })!
    const activityId = crypto.randomUUID()
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId,
      activitySquadIds: [squad.id],
      eventFact: fact,
      eventOccurredAt: new Date(fact.occurredAt),
      completedAt: new Date(),
    })
    const snapshot: any = await loadActivitySource(db, {
      family: 'github-issue',
      groupId: `poll:${activityId}:${squad.id}`,
    })
    expect(snapshot.squadId).toBe(squad.id)
    expect(snapshot.workStreamIds).toEqual([first.id, third.id])
  })
})
