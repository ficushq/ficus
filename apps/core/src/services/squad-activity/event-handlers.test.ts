import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  inbox,
  messages,
  squadActivity,
  squads,
  workStreams,
  workStreamWaits,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { registerSquadActivityEventHandlers } from './event-handlers'
import { materializeSourceGroup } from './materialize'
import { terminate } from '../agent/lifecycle'

const squadIds: string[] = []
const inboxIds: string[] = []
beforeEach(() => eventEmitter.removeAllListeners())
afterEach(async () => {
  eventEmitter.removeAllListeners()
  for (const inboxId of inboxIds.splice(0)) await db.delete(inbox).where(eq(inbox.id, inboxId))
  for (const squadId of squadIds.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

describe('Activity after-commit handlers', () => {
  test('materializes a committed source asynchronously through the shared extractor', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-handler-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const [message] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'assistant',
        content: 'Committed before projection',
        metadata: { executionId: execution.id },
      })
      .returning()
    const unsubscribe = registerSquadActivityEventHandlers()
    eventEmitter.emit('message.created', { messageId: message.id, agentId: agent.id, executionId: execution.id })
    let projected = false
    for (let attempt = 0; attempt < 50 && !projected; attempt++) {
      await Bun.sleep(10)
      const rows = await db
        .select({ rowId: squadActivity.rowId })
        .from(squadActivity)
        // A chat row is keyed by its execution (it shows the execution's latest message).
        .where(and(eq(squadActivity.squadId, squad.id), eq(squadActivity.rowId, execution.id)))
      projected = rows.length === 1
    }
    unsubscribe()
    expect(projected).toBe(true)
    expect((await db.select().from(messages).where(eq(messages.id, message.id)))[0]?.content).toBe(
      'Committed before projection'
    )
  })

  test('source commit survives a detached projection failure', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-handler-failure-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const [message] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'assistant',
        content: 'Durable source',
        metadata: { executionId: execution.id },
      })
      .returning()
    let attempted = false
    const unsubscribe = registerSquadActivityEventHandlers({
      materialize: async () => {
        attempted = true
        throw new Error('projection failed')
      },
    })
    eventEmitter.emit('message.created', { messageId: message.id, agentId: agent.id, executionId: execution.id })
    for (let attempt = 0; attempt < 50 && !attempted; attempt++) await Bun.sleep(10)
    unsubscribe()
    expect(attempted).toBe(true)
    expect(await db.select().from(messages).where(eq(messages.id, message.id))).toHaveLength(1)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])
  })

  test('reconciles more than one page at the real agent termination boundary', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-handler-agent-delete-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [sender, recipient] = await db
      .insert(agents)
      .values([
        { squadId: squad.id, agentTypeId: 'engineer' },
        { squadId: squad.id, agentTypeId: 'reviewer' },
      ])
      .returning()
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Retain the message and its recipient identity',
      })
      .returning()
    const [recipientMessage] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: sender.id,
        senderType: 'agent',
        senderId: recipient.id,
        content: 'Recipient termination must not remove this row',
      })
      .returning()
    inboxIds.push(message.id, recipientMessage.id)
    await materializeSourceGroup({ family: 'inbox', groupId: message.id })
    await materializeSourceGroup({ family: 'inbox', groupId: recipientMessage.id })
    expect((await db.select().from(squadActivity).where(eq(squadActivity.sourceGroupId, message.id)))[0].agentId).toBe(
      recipient.id
    )
    await db.insert(squadActivity).values(
      Array.from({ length: 251 }, (_, index) => {
        const rowId = crypto.randomUUID()
        return {
          squadId: squad.id,
          lane: 20,
          rowId,
          sourceFamily: 'inbox',
          sourceGroupId: rowId,
          at: new Date('2026-08-10T00:00:00Z'),
          agentId: sender.id,
          workStreamId: null,
          agentTypeId: null,
          kind: 'message' as const,
          summary: `stale deleted sender ${index}`,
          ref: { type: 'agent' as const, agentId: recipient.id, view: 'inbox' as const, messageId: rowId },
          quietEligible: true,
          accessScope: 'inbox' as const,
          inboxRecipientId: recipient.id,
          payloadHash: String(index).padStart(64, 'a'),
        }
      })
    )

    const unsubscribe = registerSquadActivityEventHandlers()
    const terminating = await Agent.mustFind(sender.id)
    await terminating.tryTerminate()
    await terminate(terminating, { finalCleanup: async () => true })
    let row = (await db.select().from(squadActivity).where(eq(squadActivity.sourceGroupId, message.id)))[0]
    let attributed = 252
    for (let attempt = 0; attempt < 500 && (row?.agentId !== recipient.id || attributed > 1); attempt++) {
      await Bun.sleep(10)
      row = (await db.select().from(squadActivity).where(eq(squadActivity.sourceGroupId, message.id)))[0]
      attributed = (
        await db
          .select({ rowId: squadActivity.rowId })
          .from(squadActivity)
          .where(and(eq(squadActivity.squadId, squad.id), eq(squadActivity.agentId, sender.id)))
      ).length
    }
    expect(row).toMatchObject({
      agentId: recipient.id,
      squadId: squad.id,
      sourceGroupId: message.id,
      summary: 'Received message from Engineer: Retain the message and its recipient identity',
      ref: { type: 'agent', agentId: recipient.id, view: 'inbox', messageId: message.id },
    })
    // Only the received row remains attributed to the terminated agent; all
    // 251 orphaned sender-attributed projections were reconciled away.
    expect(attributed).toBe(1)
    // #1241: rows whose RECIPIENT terminated survive — terminated parents'
    // inboxes are where subagent final reports live, and deleting these rows
    // was the "vanished subagent reports" regression. The row keeps its
    // recipient attribution even after that recipient terminates.
    expect(
      await db.select().from(squadActivity).where(eq(squadActivity.sourceGroupId, recipientMessage.id))
    ).toMatchObject([
      {
        agentId: sender.id,
        inboxRecipientId: sender.id,
        kind: 'message',
        summary: 'Received message from Reviewer: Recipient termination must not remove this row',
        ref: { type: 'agent', agentId: sender.id, view: 'inbox', messageId: recipientMessage.id },
      },
    ])
    expect((await Agent.mustFind(sender.id)).terminatedAt).not.toBeNull()
    // Intentional inconsistent deletion fixture: final rows are read-only to
    // production Agent.update, so move ownership directly for the hard-delete setup.
    await db.update(agents).set({ squadId: null }).where(eq(agents.id, sender.id))
    await (await Agent.mustFind(sender.id)).delete()
    unsubscribe()
    expect(await Agent.find(sender.id)).toBeNull()
  }, 15_000)

  test('removes projected waits after work-stream deletion has already cascaded the source', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-handler-delete-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [stream] = await db.insert(workStreams).values({ squadId: squad.id, title: 'Delete with wait' }).returning()
    const [wait] = await db
      .insert(workStreamWaits)
      .values({
        workStreamId: stream.id,
        type: 'manual',
        message: 'Old retained wait',
        openedAt: new Date('2026-08-10T00:00:00Z'),
      })
      .returning()
    await materializeSourceGroup({ family: 'wait', groupId: wait.id })
    await db.insert(squadActivity).values(
      Array.from({ length: 251 }, (_, index) => ({
        squadId: squad.id,
        lane: 40,
        rowId: crypto.randomUUID(),
        sourceFamily: 'wait',
        sourceGroupId: crypto.randomUUID(),
        at: new Date('2026-08-10T00:00:00Z'),
        agentId: null,
        workStreamId: stream.id,
        agentTypeId: null,
        kind: 'wait' as const,
        summary: `[ws deleted wait ${index}]`,
        ref: { type: 'workstream' as const, workStreamId: stream.id },
        quietEligible: true,
        accessScope: 'workstreams' as const,
        inboxRecipientId: null,
        payloadHash: String(index).padStart(64, '0'),
      }))
    )
    expect(await db.select().from(squadActivity).where(eq(squadActivity.workStreamId, stream.id))).toHaveLength(252)

    const unsubscribe = registerSquadActivityEventHandlers()
    await db.delete(workStreams).where(eq(workStreams.id, stream.id))
    eventEmitter.emit('workStream.deleted', { workStreamId: stream.id, squadId: squad.id })
    let remaining = 252
    for (let attempt = 0; attempt < 500 && remaining; attempt++) {
      await Bun.sleep(10)
      remaining = (await db.select().from(squadActivity).where(eq(squadActivity.workStreamId, stream.id))).length
    }
    unsubscribe()
    expect(remaining).toBe(0)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.workStreamId, stream.id))).toHaveLength(0)
  }, 15_000)
})

describe('per-source-group coalescing', () => {
  test('a burst of events for one execution collapses to a leading run plus one trailing run', async () => {
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const unsubscribe = registerSquadActivityEventHandlers({
      materialize: async (key) => {
        calls.push(`${key.family}:${key.groupId}`)
        if (first) {
          first = false
          await gate
        }
        return { upserted: [], inserted: [], updated: [] } as any
      },
    })
    try {
      const executionId = crypto.randomUUID()
      const other = crypto.randomUUID()
      for (let i = 0; i < 5; i++) {
        eventEmitter.emit('message.updated', { messageId: crypto.randomUUID(), agentId: 'a', executionId })
      }
      eventEmitter.emit('message.updated', { messageId: crypto.randomUUID(), agentId: 'a', executionId: other })
      for (let attempt = 0; attempt < 50 && calls.length < 2; attempt++) await Bun.sleep(5)
      // The blocked first run for `executionId` plus the independent group.
      expect(calls.filter((c) => c === `chat:${executionId}`)).toHaveLength(1)
      expect(calls.filter((c) => c === `chat:${other}`)).toHaveLength(1)
      release()
      for (let attempt = 0; attempt < 50 && calls.length < 3; attempt++) await Bun.sleep(5)
      await Bun.sleep(30)
      // Exactly ONE trailing rerun absorbed the other four events.
      expect(calls.filter((c) => c === `chat:${executionId}`)).toHaveLength(2)
    } finally {
      unsubscribe()
    }
  })
})

describe('remote-origin events are not materialized twice', () => {
  test('a peer-forwarded event is skipped; the originating process owns the materialization', async () => {
    const calls: string[] = []
    const unsubscribe = registerSquadActivityEventHandlers({
      materialize: async (key) => {
        calls.push(`${key.family}:${key.groupId}`)
        return { upserted: [], inserted: [], updated: [] } as any
      },
    })
    try {
      const local = crypto.randomUUID()
      const remote = crypto.randomUUID()
      eventEmitter.emit('message.created', { messageId: crypto.randomUUID(), agentId: 'a', executionId: local })
      let deliver: ((payload: string) => void) | null = null
      const stop = await eventEmitter.startListening(async (_channel, cb) => {
        deliver = cb
        return async () => {}
      })
      deliver!(
        JSON.stringify({
          event: 'message.created',
          data: { messageId: crypto.randomUUID(), agentId: 'a', executionId: remote },
          source: 'other-process',
        })
      )
      await stop()
      for (let attempt = 0; attempt < 50 && calls.length < 1; attempt++) await Bun.sleep(5)
      await Bun.sleep(30)
      expect(calls).toEqual([`chat:${local}`])
    } finally {
      unsubscribe()
    }
  })
})
