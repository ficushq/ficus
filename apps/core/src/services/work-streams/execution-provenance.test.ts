import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, inbox, messages, squads, workStreams } from '../../db/schema'
import { listTrustedContinuationExecutionIds, listTrustedWorkStreamOriginsForExecution } from './execution-provenance'

describe('trusted work stream execution provenance', () => {
  let agentId: string
  let executionId: string
  let squadId: string
  beforeEach(async () => {
    const agentTypeId = `provenance-${crypto.randomUUID()}`
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: 'Provenance agent',
      model: 'test:model',
      systemPrompt: 'test',
    })
    const [squad] = await db.insert(squads).values({ name: 'Provenance squad', purpose: 'test' }).returning()
    squadId = squad.id
    const [agent] = await db.insert(agents).values({ agentTypeId, squadId }).returning()
    agentId = agent.id
    const [execution] = await db.insert(executions).values({ agentId, status: 'running' }).returning()
    executionId = execution.id
  })

  afterEach(async () => {
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  async function createWorkStream(associated = true): Promise<string> {
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId,
        title: 'Origin',
        assigneeAgentId: associated ? agentId : null,
        agentIds: associated ? [agentId] : [],
      })
      .returning()
    return stream.id
  }

  test('returns deterministic canonical direct and system-inbox origins', async () => {
    const directStreamId = await createWorkStream()
    const inboxStreamId = await createWorkStream()
    const [direct] = await db
      .insert(messages)
      .values({
        agentId,
        role: 'human',
        content: 'Continue',
        pending: false,
        metadata: { source: 'work-stream-continuation', workStreamId: directStreamId, executionId },
      })
      .returning()
    const [inboxRow] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'Assigned',
        metadata: { event: 'assigned', workStreamId: inboxStreamId },
      })
      .returning()
    const [delivery] = await db
      .insert(messages)
      .values({
        agentId,
        role: 'human',
        content: 'Assigned',
        pending: false,
        metadata: { source: 'inbox', inboxMessageIds: [inboxRow.id], executionId },
      })
      .returning()

    expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual(
      [
        { workStreamId: directStreamId, messageIds: [direct.id] },
        { workStreamId: inboxStreamId, messageIds: [delivery.id] },
      ].sort((a, b) => a.workStreamId.localeCompare(b.workStreamId))
    )
  })

  test.each(['recovery-decision', 'recovery-retry', 'workflow-wait-resolution'])(
    'keeps a consumed %s receipt as task provenance, not fresh retry authority',
    async (source) => {
      const workStreamId = await createWorkStream()
      const [receipt] = await db
        .insert(inbox)
        .values({
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          content: 'Continue the retained task',
          metadata: { source, recoveryId: crypto.randomUUID(), workStreamId },
        })
        .returning()
      const [message] = await db
        .insert(messages)
        .values({
          agentId,
          role: 'human',
          content: receipt!.content,
          pending: false,
          metadata: { source: 'inbox', inboxMessageIds: [receipt!.id], executionId },
        })
        .returning()
      expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual([
        { workStreamId, messageIds: [message!.id] },
      ])
      await db.update(inbox).set({ senderType: 'agent', senderId: agentId }).where(eq(inbox.id, receipt!.id))
      expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual([])
    }
  )

  test('pins follow-up questions to the server-owned workflow execution context', async () => {
    const workStreamId = await createWorkStream()
    await db
      .update(executions)
      .set({ flowContext: { workStreamId, attemptId: 2, stepId: 'review' } })
      .where(eq(executions.id, executionId))
    const [message] = await db
      .insert(messages)
      .values({
        agentId,
        role: 'human',
        content: 'Please clarify the answer',
        pending: false,
        metadata: { source: 'user_chat', executionId },
      })
      .returning()
    expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual([
      { workStreamId, messageIds: [message!.id] },
    ])
    await db.update(executions).set({ flowContext: null }).where(eq(executions.id, executionId))
    expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual([])
  })

  test('classifies continuation executions set-wise without treating assignments as watchdogs', async () => {
    const continuationStreamId = await createWorkStream()
    const assignedStreamId = await createWorkStream()
    const [watchdogExecution, assignmentExecution] = await db
      .insert(executions)
      .values([
        { agentId, status: 'completed' },
        { agentId, status: 'completed' },
      ])
      .returning()
    const [continuationInbox, assignmentInbox] = await db
      .insert(inbox)
      .values([
        {
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          content: 'Continue',
          metadata: { source: 'work-stream-continuation', workStreamId: continuationStreamId },
        },
        {
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          content: 'Assigned',
          metadata: { event: 'assigned', workStreamId: assignedStreamId },
        },
      ])
      .returning()
    await db.insert(messages).values([
      {
        agentId,
        role: 'human',
        content: 'Continue',
        pending: false,
        metadata: { source: 'inbox', inboxMessageIds: [continuationInbox.id], executionId: watchdogExecution.id },
      },
      {
        agentId,
        role: 'human',
        content: 'Assigned',
        pending: false,
        metadata: { source: 'inbox', inboxMessageIds: [assignmentInbox.id], executionId: assignmentExecution.id },
      },
    ])

    expect(
      await listTrustedContinuationExecutionIds(db, [
        { agentId, executionId: watchdogExecution.id },
        { agentId, executionId: assignmentExecution.id },
      ])
    ).toEqual(new Set([watchdogExecution.id]))
  })

  test('rejects copied, foreign, malformed, and unrelated provenance', async () => {
    const relatedStreamId = await createWorkStream()
    const unrelatedStreamId = await createWorkStream(false)
    const wrongExecution = crypto.randomUUID()
    const wrongAgent = crypto.randomUUID()
    await db.insert(messages).values([
      {
        agentId,
        role: 'human',
        content: 'copied metadata',
        pending: false,
        metadata: { workStreamId: relatedStreamId, executionId },
      },
      {
        agentId,
        role: 'human',
        content: 'wrong execution',
        pending: false,
        metadata: { source: 'work-stream-continuation', workStreamId: relatedStreamId, executionId: wrongExecution },
      },
      {
        agentId,
        role: 'human',
        content: 'wrong agent marker',
        pending: false,
        metadata: { source: 'work-stream-continuation', workStreamId: unrelatedStreamId, executionId },
      },
      {
        agentId,
        role: 'human',
        content: 'malformed',
        pending: false,
        metadata: { source: 'work-stream-continuation', workStreamId: 'not-a-uuid', executionId },
      },
      {
        agentId,
        role: 'human',
        content: 'foreign recipient',
        pending: false,
        metadata: { source: 'inbox', inboxMessageIds: [wrongAgent], executionId },
      },
    ])

    expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual([])
  })

  test('requires system-authored inbox rows addressed to the exact agent', async () => {
    const streamId = await createWorkStream()
    const rows = await db
      .insert(inbox)
      .values([
        {
          recipientType: 'agent',
          recipientId: crypto.randomUUID(),
          senderType: 'system',
          content: 'wrong recipient',
          metadata: { event: 'assigned', workStreamId: streamId },
        },
        {
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'agent',
          senderId: agentId,
          content: 'agent authored',
          metadata: { event: 'assigned', workStreamId: streamId },
        },
      ])
      .returning()
    await db.insert(messages).values({
      agentId,
      role: 'human',
      content: 'forged inbox summary',
      pending: false,
      metadata: { source: 'inbox', inboxMessageIds: rows.map((row) => row.id), executionId },
    })

    expect(await listTrustedWorkStreamOriginsForExecution(db, { agentId, executionId })).toEqual([])
  })
})
