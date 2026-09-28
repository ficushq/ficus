import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { workStreamTitle } from '@ficus/shared'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as permissions from '../rbac/permissions'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, inbox, squads, users, workStreams } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { InboxMessage } from '../../entities/InboxMessage'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { subscribeToWorkStream } from '../work-streams/subscriptions'
import { subscribeToSquad } from './subscriptions'
import {
  findExistingWorkStreamInbox,
  notifyWorkStreamBlocked,
  notifyWorkStreamCanceled,
  notifyWorkStreamDependencyCanceled,
  notifyWorkStreamDone,
  notifyWorkStreamPersistentIdle,
  notifyWorkStreamOwnerOfNewStream,
  notifyWorkStreamReopened,
  notifyWorkStreamResponded,
  notifyWorkStreamReview,
  setWorkStreamNotificationBeforePersistHookForTests,
} from './work-stream-notifications'

describe('work-stream notifications', () => {
  let typeId: string
  let squadId: string
  let agentId: string
  let assigneeId: string
  let managerId: string
  let streamWatcher: TestUser
  let squadWatcher: TestUser
  let dualWatcher: TestUser

  beforeEach(async () => {
    typeId = `wsnotify-${crypto.randomUUID()}`
    await AgentType.create({
      id: typeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Notification test agent',
      systemPrompt: 'Test prompt',
    })
    agentId = (await Agent.create({ agentTypeId: typeId })).id
    assigneeId = (await Agent.create({ agentTypeId: typeId })).id
    const squad = await Squad.create({ name: typeId, purpose: typeId })
    squadId = squad.id
    managerId = squad.managerAgentId!
    streamWatcher = await createTestUser({ prefix: typeId })
    squadWatcher = await createTestUser({ prefix: typeId })
    dualWatcher = await createTestUser({ prefix: typeId })
    // Human notices are permission-gated: a watcher only hears about a stream it may read.
    const readerRole = await createTestRole({ prefix: typeId, permissions: ['workstreams:read'] })
    for (const watcher of [streamWatcher, squadWatcher, dualWatcher]) {
      await assignRole({ userId: watcher.id, roleId: readerRole.id, scope: 'squad', squadId })
    }
  })

  afterEach(async () => {
    setWorkStreamNotificationBeforePersistHookForTests()
    await db
      .delete(inbox)
      .where(
        inArray(inbox.recipientId, [agentId, assigneeId, managerId, streamWatcher.id, squadWatcher.id, dualWatcher.id])
      )
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agents).where(eq(agents.agentTypeId, typeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    await cleanupTestRbac(typeId)
  })

  it('returns false when no matching row exists', async () => {
    const exists = await findExistingWorkStreamInbox({
      recipientId: agentId,
      subject: 'nope',
      workStreamId: crypto.randomUUID(),
      event: 'blocked',
      transitionAt: new Date().toISOString(),
    })

    expect(exists).toBe(false)
  })

  it('persists the exact wait and Action Center identity for blocked inbox notifications', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} exact blocked target`,
      ownerAgentId: agentId,
    })
    const wait = await workStream.block({ message: 'Need exact input' })
    await notifyWorkStreamBlocked(workStream, {
      waitId: wait.id,
      actionId: `workstream-blocked:${workStream.id}:${wait.id}`,
    })

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    const message = rows.find((row) => String(row.subject).includes('blocked'))
    expect(message?.metadata).toMatchObject({
      workStreamId: workStream.id,
      waitId: wait.id,
      actionId: `workstream-blocked:${workStream.id}:${wait.id}`,
    })
  })

  it('delivers the operator resolution note to the assignee on unblock (not the legacy response column)', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} note stream`,
      assigneeAgentId: agentId,
      agentIds: [agentId],
    })
    await notifyWorkStreamResponded(workStream, 'manual', 'Deploy is done — resume and re-run the gate')

    // Select the UNBLOCK message specifically — the create-time notification can
    // land asynchronously at any point, so filtering (not row-order or delete
    // timing) is the only race-free way to find our message in a full-suite run.
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    const msg = rows.find((row) => String(row.subject ?? '').includes('unblocked'))
    expect(msg).toBeDefined()
    const content = String(msg!.content)
    expect(content).toContain('Deploy is done — resume and re-run the gate')
    // Regression: it must NOT be the empty "Response:" body the legacy path produced.
    expect(content).not.toMatch(/Response:\s*$/)
  })

  it('announces checkpoint approvals as approved, never as send-back feedback', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} checkpoint stream`,
      assigneeAgentId: agentId,
      agentIds: [agentId],
    })
    await notifyWorkStreamResponded(workStream, 'review', 'Ship it — gate passed', 'approved')

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    const msg = rows.find((row) => String(row.subject ?? '').includes('Checkpoint approved'))
    expect(msg).toBeDefined()
    const content = String(msg!.content)
    expect(content).toContain('APPROVED')
    expect(content).toContain('Ship it — gate passed')
    // The defect this guards: approved checkpoints previously rendered the
    // send-back branch's wording.
    expect(content).not.toContain('needs further work')
  })

  it('keeps send-back wording for review resolutions that are not approvals', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} sendback stream`,
      assigneeAgentId: agentId,
      agentIds: [agentId],
    })
    // Default (no resolution passed) must stay the send-back wording — the
    // event-fallback path calls without one.
    await notifyWorkStreamResponded(workStream, 'review', 'Fix the flaky test first')

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    const msg = rows.find((row) => String(row.subject ?? '').includes('Review feedback'))
    expect(msg).toBeDefined()
    const content = String(msg!.content)
    expect(content).toContain('needs further work')
    expect(content).toContain('Fix the flaky test first')
  })

  it('shows requester attribution at agent-facing lifecycle boundaries, not handoffs', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} attributed stream`,
      ownerAgentId: agentId,
      creatorAgentId: assigneeId,
      requestingUserId: streamWatcher.id,
      agentIds: [assigneeId],
    })

    await notifyWorkStreamOwnerOfNewStream(workStream)
    await workStream.update({
      assigneeAgentId: assigneeId,
      handoffMessage: 'Continue the implementation.',
    })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)

    const created = (await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).find(
      (row) => (row.metadata as Record<string, unknown>).event === 'created'
    )
    const assigned = (await db.select().from(inbox).where(eq(inbox.recipientId, assigneeId))).find(
      (row) => (row.metadata as Record<string, unknown>).event === 'assigned'
    )
    expect(created?.content).toContain('Requested by:')
    expect(assigned?.content).not.toContain('Requested by:')

    await notifyWorkStreamDone(workStream)
    await notifyWorkStreamCanceled(workStream, [assigneeId])

    const ownerRows = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    const done = ownerRows.find((row) => (row.metadata as Record<string, unknown>).event === 'done')
    const canceled = ownerRows.find((row) => (row.metadata as Record<string, unknown>).event === 'canceled')
    const crewCanceled = (await db.select().from(inbox).where(eq(inbox.recipientId, assigneeId))).find(
      (row) => (row.metadata as Record<string, unknown>).event === 'canceled'
    )
    const watcherDone = (await db.select().from(inbox).where(eq(inbox.recipientId, streamWatcher.id))).find(
      (row) => (row.metadata as Record<string, unknown>).event === 'done'
    )
    expect(done?.content).toContain('Requested by:')
    expect(canceled?.content).toContain('Requested by:')
    expect(crewCanceled?.content).toContain('Requested by:')
    expect(watcherDone?.content).not.toContain('Requested by:')
  })

  async function countLifecycleInbox(
    workStreamId: string,
    event: string,
    recipientType: 'user' | 'agent',
    recipientId: string
  ): Promise<number> {
    const rows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientType, recipientType),
          eq(inbox.recipientId, recipientId),
          sql`${inbox.metadata}->>'workStreamId' = ${workStreamId}`,
          sql`${inbox.metadata}->>'event' = ${event}`
        )
      )
    return rows.length
  }

  it('keeps quiet lifecycle events out of human watcher inboxes while notifying operational agents', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} quiet stream`,
      ownerAgentId: agentId,
      assigneeAgentId: assigneeId,
      agentIds: [agentId, assigneeId],
    })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)
    await subscribeToSquad(squadId, squadWatcher.id)
    await subscribeToWorkStream(workStream.id, dualWatcher.id)
    await subscribeToSquad(squadId, dualWatcher.id)

    const quietCases = [
      ['canceled', () => notifyWorkStreamCanceled(workStream, [assigneeId])],
      ['reopened', () => notifyWorkStreamReopened(workStream)],
      ['dependency_canceled', () => notifyWorkStreamDependencyCanceled(workStream)],
    ] as const

    for (const [event, notify] of quietCases) {
      await notify()
      for (const watcher of [streamWatcher, squadWatcher, dualWatcher]) {
        expect(await countLifecycleInbox(workStream.id, event, 'user', watcher.id)).toBe(0)
      }
      expect(await countLifecycleInbox(workStream.id, event, 'agent', agentId)).toBe(1)
    }
    expect(await countLifecycleInbox(workStream.id, 'canceled', 'agent', assigneeId)).toBe(1)
    expect(await countLifecycleInbox(workStream.id, 'reopened', 'agent', assigneeId)).toBe(1)

    const fallback = await storedLegacyWorkStream({ squadId, title: `${typeId} fallback stream` })
    await subscribeToWorkStream(fallback.id, streamWatcher.id)
    await subscribeToSquad(squadId, squadWatcher.id)
    await notifyWorkStreamResponded(fallback, 'manual', 'continue')
    await notifyWorkStreamResponded(fallback, 'review', 'changes')
    for (const event of ['unblocked', 'reviewed']) {
      expect(await countLifecycleInbox(fallback.id, event, 'user', streamWatcher.id)).toBe(0)
      expect(await countLifecycleInbox(fallback.id, event, 'user', squadWatcher.id)).toBe(0)
      expect(await countLifecycleInbox(fallback.id, event, 'agent', managerId)).toBe(1)
    }

    await workStream.update({ title: `${typeId} updated title` })
    const ordinaryRows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientType, 'user'),
          sql`${inbox.metadata}->>'workStreamId' = ${workStream.id}`,
          sql`${inbox.metadata}->>'event' = 'updated'`
        )
      )
    expect(ordinaryRows).toHaveLength(0)
  })

  it('notifies each human watcher and the owner exactly once for review and done', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} signal stream`,
      ownerAgentId: agentId,
      assigneeAgentId: assigneeId,
      agentIds: [agentId, assigneeId],
      metadata: { nextSteps: 'Monitor the rollout' },
    })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)
    await subscribeToSquad(squadId, squadWatcher.id)
    await subscribeToWorkStream(workStream.id, dualWatcher.id)
    await subscribeToSquad(squadId, dualWatcher.id)

    await notifyWorkStreamReview(workStream)
    await notifyWorkStreamReview(workStream)
    await notifyWorkStreamDone(workStream, { approvalNote: 'ship it' })
    await notifyWorkStreamDone(workStream, { approvalNote: 'ship it' })

    for (const watcher of [streamWatcher, squadWatcher, dualWatcher]) {
      expect(await countLifecycleInbox(workStream.id, 'review', 'user', watcher.id)).toBe(1)
      expect(await countLifecycleInbox(workStream.id, 'done', 'user', watcher.id)).toBe(1)
    }
    expect(await countLifecycleInbox(workStream.id, 'review', 'agent', agentId)).toBe(1)
    expect(await countLifecycleInbox(workStream.id, 'done', 'agent', agentId)).toBe(1)

    const [completion] = await db
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientType, 'user'),
          eq(inbox.recipientId, streamWatcher.id),
          sql`${inbox.metadata}->>'workStreamId' = ${workStream.id}`,
          sql`${inbox.metadata}->>'event' = 'done'`
        )
      )
    expect(completion.content).toContain('Approval note: ship it')
    expect((completion.metadata as Record<string, unknown>).nextSteps).toBe('Monitor the rollout')
  })

  it('gives human watcher notices phone-ready push copy while the agent copy stays as written', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: 'Validate Cloud deletion and analytics end to end',
      ownerAgentId: agentId,
      assigneeAgentId: assigneeId,
      agentIds: [agentId, assigneeId],
      metadata: { nextSteps: 'Monitor the rollout' },
    })
    await workStream.update({ handoffMessage: 'Please check the analytics export.' })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)

    await notifyWorkStreamReview(workStream)
    await notifyWorkStreamDone(workStream, { approvalNote: 'ship it' })

    const watcherRows = await db.select().from(inbox).where(eq(inbox.recipientId, streamWatcher.id))
    const metadataOf = (event: string) =>
      watcherRows.find((row) => (row.metadata as Record<string, unknown>).event === event)?.metadata as
        | Record<string, unknown>
        | undefined
    // No subtitle: the squad already groups the stack via threadKey, and a third text line
    // makes the lock-screen card cramped.
    expect(metadataOf('review')?.push).toEqual({
      title: `Ready for review: ${workStreamTitle(workStream)}`,
      body: 'Please check the analytics export.',
      collapseKey: `ws:${workStream.id}`,
      threadKey: `squad:${squadId}`,
      interruptionLevel: 'active',
    })
    expect(metadataOf('done')?.push).toEqual({
      title: `Completed: ${workStreamTitle(workStream)}`,
      body: 'ship it',
      collapseKey: `ws:${workStream.id}`,
      threadKey: `squad:${squadId}`,
      interruptionLevel: 'passive',
    })

    const ownerDone = (await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).find(
      (row) => (row.metadata as Record<string, unknown>).event === 'done'
    )
    expect(ownerDone?.subject).toBe(`Work Stream done: ${workStreamTitle(workStream)}`)
    expect((ownerDone?.metadata as Record<string, unknown>).push).toBeUndefined()
  })

  it('push bodies fall back to next steps, then the description, then a state line; never the squad name', async () => {
    const withNextSteps = await storedLegacyWorkStream({
      squadId,
      title: 'Stream with next steps',
      ownerAgentId: agentId,
      agentIds: [agentId],
      metadata: { nextSteps: 'Monitor the rollout' },
    })
    const withDescription = await storedLegacyWorkStream({
      squadId,
      title: 'Stream with description',
      description: 'Investigate named and custom UI color themes across the app.',
      ownerAgentId: agentId,
      agentIds: [agentId],
    })
    const bare = await storedLegacyWorkStream({
      squadId,
      title: 'Bare stream',
      ownerAgentId: agentId,
      agentIds: [agentId],
    })
    await subscribeToSquad(squadId, squadWatcher.id)
    await notifyWorkStreamDone(withNextSteps)
    await notifyWorkStreamDone(withDescription)
    await notifyWorkStreamDone(bare)
    await notifyWorkStreamReview(bare)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, squadWatcher.id))
    const pushFor = (id: string, event: string) =>
      (
        rows.find((row) => {
          const metadata = row.metadata as Record<string, unknown>
          return metadata.workStreamId === id && metadata.event === event
        })?.metadata as any
      )?.push
    expect(pushFor(withNextSteps.id, 'done')?.body).toBe('Monitor the rollout')
    expect(pushFor(withDescription.id, 'done')?.body).toBe(
      'Investigate named and custom UI color themes across the app.'
    )
    expect(pushFor(bare.id, 'done')?.body).toBe('Completed without notes.')
    expect(pushFor(bare.id, 'review')?.body).toBe('Awaiting your review.')
    for (const push of rows.map((row) => (row.metadata as any).push)) {
      expect(push.body).not.toBe(typeId)
      expect(push.subtitle).toBeUndefined()
    }
  })

  it('records one persistent idle notice for the owner without notifying subscribers', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} persistent idle`,
      ownerAgentId: agentId,
      assigneeAgentId: agentId,
      agentIds: [agentId],
    })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)
    await subscribeToSquad(squadId, squadWatcher.id)
    const endedAt = new Date()
    const input = { generation: 4, normalExecutionId: crypto.randomUUID(), endedAt }

    await Promise.all([
      notifyWorkStreamPersistentIdle(workStream, input),
      notifyWorkStreamPersistentIdle(workStream, input),
    ])

    const rows = await db
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientId, agentId),
          sql`${inbox.metadata}->>'workStreamId' = ${workStream.id}`,
          sql`${inbox.metadata}->>'event' = 'idle'`
        )
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      recipientType: 'agent',
      recipientId: agentId,
      senderType: 'system',
      deliveredAt: null,
    })
    expect(rows[0]?.metadata).toMatchObject({
      event: 'idle',
      workStreamId: workStream.id,
      generation: 4,
      normalExecutionId: input.normalExecutionId,
      normalExecutionEndedAt: endedAt.toISOString(),
    })
    for (const watcher of [streamWatcher, squadWatcher]) {
      expect(await countLifecycleInbox(workStream.id, 'idle', 'user', watcher.id)).toBe(0)
    }
  })

  it('falls back to the squad manager for a persistent idle notice', async () => {
    const workStream = await storedLegacyWorkStream({ squadId, title: `${typeId} manager idle fallback` })
    await notifyWorkStreamPersistentIdle(workStream, {
      generation: 2,
      normalExecutionId: crypto.randomUUID(),
      endedAt: new Date(),
    })

    expect(await countLifecycleInbox(workStream.id, 'idle', 'agent', managerId)).toBe(1)
  })

  it('atomically deduplicates concurrent lifecycle sends', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} stream`,
      assigneeAgentId: agentId,
      agentIds: [agentId],
    })
    const bothEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let entrants = 0
    setWorkStreamNotificationBeforePersistHookForTests(async () => {
      entrants += 1
      if (entrants === 2) bothEntered.resolve()
      await release.promise
    })

    const sends = Promise.all([
      notifyWorkStreamResponded(workStream, 'manual', 'continue'),
      notifyWorkStreamResponded(workStream, 'manual', 'continue'),
    ])
    await bothEntered.promise
    release.resolve()
    await sends

    const rows = await db
      .select()
      .from(inbox)
      .where(eq(inbox.subject, `Work stream unblocked: #${workStream.number} · ${workStream.title}`))
    expect(rows).toHaveLength(1)
  })
  // ── Self-notification suppression ──────────────────────────────────────
  //
  // An agent is never told about its own action. Before this, a manager that
  // cancelled five streams it owned interrupted itself five times with news it
  // already had. The rule generalizes the creation-time guard (a manager
  // opening a stream it owns is not announced to itself) to every transition.

  const inboxFor = async (recipientId: string, subjectFragment: string) => {
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, recipientId))
    return rows.filter((row) => String(row.subject ?? '').includes(subjectFragment))
  }

  it('does not tell an owner about a transition the owner itself triggered', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} self-cancel`,
      ownerAgentId: agentId,
    })
    await notifyWorkStreamCanceled(workStream, [], agentId)

    expect(await inboxFor(agentId, 'canceled')).toHaveLength(0)
  })

  it('DOES tell an owner about the same transition when another agent triggered it', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} other-cancel`,
      ownerAgentId: agentId,
    })
    await notifyWorkStreamCanceled(workStream, [], assigneeId)

    expect(await inboxFor(agentId, 'canceled')).toHaveLength(1)
  })

  it('DOES tell an owner when a user or the system triggered it (no actor)', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} operator-cancel`,
      ownerAgentId: agentId,
    })
    // Undefined actor is the historical behavior and the safe default: every
    // path that has not been taught to pass an actor keeps notifying.
    await notifyWorkStreamCanceled(workStream, [])

    expect(await inboxFor(agentId, 'canceled')).toHaveLength(1)
  })

  it('still notifies human watchers when the acting agent is the owner', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} watcher-visible`,
      ownerAgentId: agentId,
    })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)
    await notifyWorkStreamDone(workStream, { actorAgentId: agentId })

    // The agent's own copy is redundant; a human watching the stream still
    // wants to see that it completed.
    expect(await inboxFor(agentId, 'done')).toHaveLength(0)
    expect(await inboxFor(streamWatcher.id, 'done')).toHaveLength(1)
  })

  it('drops the acting agent from the cancellation crew broadcast but keeps the rest', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} crew-cancel`,
      ownerAgentId: managerId,
      agentIds: [agentId, assigneeId],
    })
    // The crew broadcast is a STEER — it interrupts mid-turn. The agent that
    // pressed cancel does not need to be interrupted and told to stop.
    await notifyWorkStreamCanceled(workStream, [agentId, assigneeId], agentId)

    expect(await inboxFor(agentId, 'Work stream canceled')).toHaveLength(0)
    expect(await inboxFor(assigneeId, 'Work stream canceled')).toHaveLength(1)
  })

  it('does not steer a wait resolution back at the assignee that resolved it', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} self-unblock`,
      assigneeAgentId: agentId,
      agentIds: [agentId],
    })
    await notifyWorkStreamResponded(workStream, 'manual', 'resuming', 'sent_back', agentId)
    expect(await inboxFor(agentId, 'unblocked')).toHaveLength(0)

    // Resolved by anyone else, the assignee must still be told.
    await notifyWorkStreamResponded(workStream, 'manual', 'resuming', 'sent_back', assigneeId)
    expect(await inboxFor(agentId, 'unblocked')).toHaveLength(1)
  })

  it('does not announce a reopen to the agent that reopened it', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} self-reopen`,
      ownerAgentId: agentId,
    })
    await notifyWorkStreamReopened(workStream, agentId)
    expect(await inboxFor(agentId, 'reopened')).toHaveLength(0)

    await notifyWorkStreamReopened(workStream, assigneeId)
    expect(await inboxFor(agentId, 'reopened')).toHaveLength(1)
  })

  it('delivers a blocked notice to decision watchers with active-interruption push copy', async () => {
    const workStream = await storedLegacyWorkStream({
      squadId,
      title: `${typeId} blocked stream`,
      ownerAgentId: agentId,
    })
    await workStream.update({ handoffMessage: 'Need the staging credentials.' })
    await subscribeToWorkStream(workStream.id, streamWatcher.id)
    await subscribeToSquad(squadId, squadWatcher.id)

    await notifyWorkStreamBlocked(workStream)

    for (const watcher of [streamWatcher, squadWatcher]) {
      expect(await countLifecycleInbox(workStream.id, 'blocked', 'user', watcher.id)).toBe(1)
    }
    const [notice] = await db
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientId, streamWatcher.id),
          sql`${inbox.metadata}->>'workStreamId' = ${workStream.id}`,
          sql`${inbox.metadata}->>'event' = 'blocked'`
        )
      )
    expect((notice.metadata as Record<string, unknown>).push).toEqual({
      title: `Blocked: ${workStreamTitle(workStream)}`,
      body: 'Need the staging credentials.',
      collapseKey: `ws:${workStream.id}`,
      threadKey: `squad:${squadId}`,
      interruptionLevel: 'active',
    })
    // The owning agent still gets its own copy.
    expect(await countLifecycleInbox(workStream.id, 'blocked', 'agent', agentId)).toBe(1)
  })

  it('routes review and blocked by decisions and done by progress', async () => {
    const workStream = await storedLegacyWorkStream({ squadId, title: `${typeId} split kinds` })
    // Decisions only: reviews and blockers, never completions.
    await subscribeToWorkStream(workStream.id, streamWatcher.id, { decisions: 'notify', progress: 'show' })
    // Progress only: completions, never decisions.
    await subscribeToWorkStream(workStream.id, squadWatcher.id, { decisions: 'mute', progress: 'notify' })

    await notifyWorkStreamReview(workStream)
    await notifyWorkStreamBlocked(workStream)
    await notifyWorkStreamDone(workStream)

    expect(await countLifecycleInbox(workStream.id, 'review', 'user', streamWatcher.id)).toBe(1)
    expect(await countLifecycleInbox(workStream.id, 'blocked', 'user', streamWatcher.id)).toBe(1)
    expect(await countLifecycleInbox(workStream.id, 'done', 'user', streamWatcher.id)).toBe(0)

    expect(await countLifecycleInbox(workStream.id, 'review', 'user', squadWatcher.id)).toBe(0)
    expect(await countLifecycleInbox(workStream.id, 'blocked', 'user', squadWatcher.id)).toBe(0)
    expect(await countLifecycleInbox(workStream.id, 'done', 'user', squadWatcher.id)).toBe(1)
  })

  it("never notifies a notify-level user who cannot read the squad's work streams", async () => {
    const loudButBlind = await createTestUser({ prefix: typeId })
    const workStream = await storedLegacyWorkStream({ squadId, title: `${typeId} permission gate` })
    // Same notify row on the same squad; only the role on the squad differs.
    await subscribeToSquad(squadId, loudButBlind.id)
    await subscribeToSquad(squadId, squadWatcher.id)

    await notifyWorkStreamBlocked(workStream)
    await notifyWorkStreamReview(workStream)
    await notifyWorkStreamDone(workStream)

    for (const event of ['blocked', 'review', 'done']) {
      expect(await countLifecycleInbox(workStream.id, event, 'user', loudButBlind.id)).toBe(0)
      expect(await countLifecycleInbox(workStream.id, event, 'user', squadWatcher.id)).toBe(1)
    }
  })

  it('never notifies a disabled account, however loud its notify row and however broad its role', async () => {
    const retired = await createTestUser({ prefix: typeId })
    const readerRole = await createTestRole({ prefix: typeId, permissions: ['workstreams:read'] })
    await assignRole({ userId: retired.id, roleId: readerRole.id, scope: 'squad', squadId })
    const workStream = await storedLegacyWorkStream({ squadId, title: `${typeId} disabled watcher` })
    // Identical notify rows on the same squad; only the account state differs.
    await subscribeToSquad(squadId, retired.id)
    await subscribeToSquad(squadId, squadWatcher.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, retired.id))

    await notifyWorkStreamBlocked(workStream)
    await notifyWorkStreamReview(workStream)
    await notifyWorkStreamDone(workStream)

    for (const event of ['blocked', 'review', 'done']) {
      expect(await countLifecycleInbox(workStream.id, event, 'user', retired.id)).toBe(0)
      expect(await countLifecycleInbox(workStream.id, event, 'user', squadWatcher.id)).toBe(1)
    }
  })

  it('keeps notifying the rest of the batch when one recipient\u2019s send throws', async () => {
    const workStream = await storedLegacyWorkStream({ squadId, title: `${typeId} partial failure` })
    await subscribeToSquad(squadId, squadWatcher.id)
    await subscribeToWorkStream(workStream.id, streamWatcher.id)

    const watchers = [squadWatcher.id, streamWatcher.id]
    const original = InboxMessage.sendOnce.bind(InboxMessage)
    // Fail whichever watcher the resolver happens to put first: the recipient order is a SET's
    // order, and a failure that only ever lands last would not prove isolation at all.
    let firstWatcher: string | undefined
    const sendOnce = spyOn(InboxMessage, 'sendOnce').mockImplementation(async (input, idempotencyKey) => {
      if (input.recipientType !== 'user' || !watchers.includes(input.recipientId))
        return original(input, idempotencyKey)
      firstWatcher ??= input.recipientId
      if (input.recipientId === firstWatcher) throw new Error('inbox write failed')
      return original(input, idempotencyKey)
    })

    try {
      // The lifecycle transition itself must still complete: the outer guard stays.
      await notifyWorkStreamReview(workStream)
    } finally {
      sendOnce.mockRestore()
    }

    expect(firstWatcher).toBeDefined()
    const survivor = watchers.find((id) => id !== firstWatcher)!
    expect(await countLifecycleInbox(workStream.id, 'review', 'user', firstWatcher!)).toBe(0)
    expect(await countLifecycleInbox(workStream.id, 'review', 'user', survivor)).toBe(1)
  })

  /**
   * The permission fan-out used to run under `Promise.all`, so one unreadable subject rejected the
   * whole batch and silenced every watcher whose check had succeeded.
   */
  it('still notifies the other watchers when one permission check throws', async () => {
    const workStream = await storedLegacyWorkStream({ squadId, title: `${typeId} permission outage` })
    await subscribeToSquad(squadId, squadWatcher.id)
    await subscribeToWorkStream(workStream.id, streamWatcher.id)

    const original = permissions.hasPermission
    const spy = spyOn(permissions, 'hasPermission').mockImplementation(async (identity, permission, scope) => {
      if (identity.type === 'user' && identity.userId === streamWatcher.id) throw new Error('role chain unreadable')
      return original(identity, permission, scope)
    })
    try {
      await notifyWorkStreamReview(workStream)
    } finally {
      spy.mockRestore()
    }

    // Fail closed for the one that threw; untouched for the one that resolved.
    expect(await countLifecycleInbox(workStream.id, 'review', 'user', streamWatcher.id)).toBe(0)
    expect(await countLifecycleInbox(workStream.id, 'review', 'user', squadWatcher.id)).toBe(1)
  })

  it('lets a stream row mute a squad the user otherwise gets notified about', async () => {
    const noisy = await storedLegacyWorkStream({ squadId, title: `${typeId} noisy stream` })
    const quiet = await storedLegacyWorkStream({ squadId, title: `${typeId} quiet stream` })
    await subscribeToSquad(squadId, dualWatcher.id)
    await subscribeToWorkStream(quiet.id, dualWatcher.id, { decisions: 'mute', progress: 'mute' })

    await notifyWorkStreamReview(noisy)
    await notifyWorkStreamReview(quiet)
    await notifyWorkStreamDone(quiet)

    expect(await countLifecycleInbox(noisy.id, 'review', 'user', dualWatcher.id)).toBe(1)
    expect(await countLifecycleInbox(quiet.id, 'review', 'user', dualWatcher.id)).toBe(0)
    expect(await countLifecycleInbox(quiet.id, 'done', 'user', dualWatcher.id)).toBe(0)
  })
})
