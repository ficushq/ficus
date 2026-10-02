import { maintenanceStore } from '../maintenance/store'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { db } from '../../db'
import * as clockModule from '../../db/clock'
import { resetContinuationCycle } from './continuation-state'
import {
  agents,
  agentTypes,
  executionAdmissionReservations,
  executions,
  inbox,
  messages,
  squads,
  slotPools,
  slotClaims,
  slotWaiters,
  slotNotifications,
  workStreamContinuations,
  workStreams,
  workStreamWaits,
} from '../../db/schema'
import {
  setSlotAfterPoolLockHookForTest,
  claimSlot,
  registerPool,
  releaseSlot,
  unsubscribeSlot,
  setSlotPromptDrainEnabledForTest,
} from '../slots/store'
import { SlotNotificationNotifier } from '../slots/notifications'
import * as schema from '../../db/schema'
import { createPostgresConnection, getConnectionString } from '../../db/connection'
import {
  blockCurrentContinuation,
  continuationDelay,
  reconcileWorkStreamContinuationsOnce as reconcileContinuations,
  recordContinuationDeliveryFailure,
  reportPersistentIdleIfCurrent,
  registerWorkStreamContinuationEventHandlers,
  resolveContinuationWaitOnExecutionStarted,
  startWorkStreamContinuationSweep,
  stopWorkStreamContinuationSweep,
  transportContinuationDelay,
} from './continuation'
import { listPeriodicRunnerNames } from '../../lib/infra/PeriodicRunner'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { InboxMessage } from '../../entities/InboxMessage'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { WorkStream } from '../../entities/WorkStream'
import { deliverInboxMessagesToAgent, prepareInboxDelivery } from '../inbox/inboxDelivery'
import { listTrustedContinuationExecutionIds } from './execution-provenance'
import { MockAgentSession, TestAgentRunner, makeAgentType } from '../execution/test-helpers'
import { isSessionActive, removeSession } from '../execution/session-state'
import * as workStreamNotifications from '../squad/work-stream-notifications'

describe('work stream continuation', () => {
  let agentTypeId: string
  let squad: Squad
  let agent: Agent
  let workStream: WorkStream
  const extraAgentIds: string[] = []

  // These state-machine cases own one squad. Never reconcile unrelated rows
  // accumulated by earlier files while advancing this fixture's logical clock.
  const reconcileWorkStreamContinuationsOnce = (options: Parameters<typeof reconcileContinuations>[0] = {}) =>
    reconcileContinuations({ ...options, squadId: squad.id })

  async function createExtraAgent(): Promise<Agent> {
    const extra = await Agent.create({ agentTypeId, squadId: squad.id })
    extraAgentIds.push(extra.id)
    return extra
  }

  async function waitFor(check: () => Promise<boolean>, attempts = 100): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('Timed out waiting for continuation test condition')
  }

  async function readCycle() {
    const [cycle] = await db
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    return cycle
  }

  async function persistentIdleNotices() {
    return db
      .select()
      .from(inbox)
      .where(and(sql`${inbox.metadata}->>'workStreamId' = ${workStream.id}`, sql`${inbox.metadata}->>'event' = 'idle'`))
  }

  async function attachTrustedWorkStreamMessage(
    executionId: string,
    options: { pending?: boolean; content?: string } = {}
  ) {
    const content = options.content ?? 'Original work stream handoff'
    const [inboxRow] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content,
        metadata: { workStreamId: workStream.id, squadId: squad.id, event: 'assigned' },
        deliveryMode: 'steer',
        deliveredAt: new Date(),
      })
      .returning()
    const [message] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'human',
        content,
        pending: options.pending ?? false,
        metadata: { source: 'inbox', inboxMessageIds: [inboxRow.id], executionId },
      })
      .returning()
    return { inbox: inboxRow, message }
  }

  async function settleAgentExecutions(target: Agent, status: 'completed' | 'stopped' | 'failed', endedAt: Date) {
    const settled = await db.transaction(async (tx) => {
      const updated = await tx
        .update(executions)
        .set({ status, endedAt })
        .where(eq(executions.agentId, target.id))
        .returning()
      await tx
        .update(executionAdmissionReservations)
        .set({ state: 'released', updatedAt: endedAt })
        .where(eq(executionAdmissionReservations.agentId, target.id))
      return updated
    })
    return (
      settled.at(-1) ?? (await db.insert(executions).values({ agentId: target.id, status, endedAt }).returning())[0]
    )
  }

  beforeEach(async () => {
    agentTypeId = `continuation-test-${crypto.randomUUID()}`
    await AgentType.create({
      id: agentTypeId,
      name: 'Continuation test agent',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'Test.',
    })
    squad = await Squad.create({ name: `Continuation test ${crypto.randomUUID()}`, purpose: 'Test.' })
    agent = await Agent.create({ agentTypeId, squadId: squad.id })
    workStream = await storedLegacyWorkStream({ squadId: squad.id, title: 'Continuation test' })
  })

  afterEach(async () => {
    setSlotAfterPoolLockHookForTest(undefined)
    setSlotPromptDrainEnabledForTest(true)
    const poolIds = (await db.select({ id: slotPools.id }).from(slotPools).where(eq(slotPools.squadId, squad.id))).map(
      (row) => row.id
    )
    if (poolIds.length) {
      await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
      await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
      await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
      await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
    }
    await stopWorkStreamContinuationSweep()
    await workStream.delete()
    for (const id of extraAgentIds.splice(0)) await db.delete(agents).where(eq(agents.id, id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function contestedSlot(key = 'test-capacity') {
    setSlotPromptDrainEnabledForTest(false)
    const holder = await createExtraAgent()
    const pool = await registerPool({ squadId: squad.id, key, createdBy: 'test' })
    const held = await claimSlot(squad.id, key, holder.id)
    if (held.outcome !== 'granted') throw new Error('Fixture must own capacity')
    return { pool, holder, held, key }
  }

  async function idleSlotCandidate() {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id, ownerAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    return new Date(endedAt.getTime() + 60_000)
  }

  async function queueSlot(key = 'test-capacity') {
    const result = await claimSlot(squad.id, key, agent.id)
    if (result.outcome !== 'queued') throw new Error('Fixture must queue')
    return result.waiter.id
  }

  for (const boundary of ['before scan', 'after scan', 'before dispatch'] as const) {
    it(`suppresses slot-wait continuation queued ${boundary} without consuming a nudge`, async () => {
      await contestedSlot()
      const now = await idleSlotCandidate()
      if (boundary === 'before scan') await queueSlot()
      await reconcileWorkStreamContinuationsOnce({
        now,
        testHooks: {
          ...(boundary === 'after scan'
            ? {
                beforeCandidateSchedule: async () => {
                  await queueSlot()
                },
              }
            : {}),
          ...(boundary === 'before dispatch'
            ? {
                beforeDispatchQueue: async () => {
                  await queueSlot()
                },
              }
            : {}),
        },
      })
      expect((await readCycle()).normalAttemptCount).toBe(0)
      expect(
        await db
          .select()
          .from(executions)
          .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
      ).toHaveLength(0)
      expect(
        await db
          .select()
          .from(inbox)
          .where(and(eq(inbox.recipientId, agent.id), sql`${inbox.metadata}->>'source' = 'work-stream-continuation'`))
      ).toHaveLength(0)
    })
  }

  it('acquires maintenance before the agent queue lock for slot-fenced delivery', async () => {
    const now = await idleSlotCandidate()
    const original = maintenanceStore.readLocked.bind(maintenanceStore)
    let queueLockAlreadyHeld: boolean | undefined
    const lockSpy = spyOn(maintenanceStore, 'readLocked').mockImplementation(async (tx) => {
      if (queueLockAlreadyHeld === undefined) {
        const rows = await tx.execute(sql`SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid()
          AND locktype = 'advisory' AND classid = 421100 AND granted`)
        queueLockAlreadyHeld = rows.length > 0
      }
      return original(tx)
    })
    try {
      await reconcileWorkStreamContinuationsOnce({ now })
      expect((await readCycle()).normalAttemptCount).toBe(1)
      expect(queueLockAlreadyHeld).toBe(false)
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('serializes racing enqueue and nudge delivery on the actual agent queue lock', async () => {
    await contestedSlot()
    const now = await idleSlotCandidate()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let queued: Promise<string> | undefined
    const sweep = reconcileWorkStreamContinuationsOnce({
      now,
      testHooks: {
        beforeDispatchQueue: async () => {
          setSlotAfterPoolLockHookForTest(async () => {
            entered.resolve()
            await release.promise
          })
          queued = queueSlot()
          await entered.promise
        },
      },
    })
    try {
      await entered.promise
      // Observable lock acquisition, not a sleep: the enqueue transaction owns
      // the agent lock while the production continuation transaction waits.
      await waitFor(async () => {
        const rows = await db.execute(sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND classid = 421100 AND objid = (hashtext(${agent.id})::bigint & 4294967295) AND NOT granted`)
        return rows.length > 0
      })
    } finally {
      release.resolve()
      await queued
      await sweep
      setSlotAfterPoolLockHookForTest(undefined)
    }
    expect((await readCycle()).normalAttemptCount).toBe(0)
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(0)
  })

  it('still accepts human steering while queued and does not escalate a slot wait to a manual blocker', async () => {
    await contestedSlot()
    await idleSlotCandidate()
    await queueSlot()
    const cycle = await readCycle()
    expect(
      await blockCurrentContinuation(workStream.id, cycle.generation, agent.id, 'Unexpected exhaustion', () => true)
    ).toBe(false)
    expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, workStream.id))).toHaveLength(
      0
    )
    await agent.sendMessage('Human steering: inspect this independently', { deliveryMode: 'steer' })
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
  })

  it('defers trusted transport continuation while queued without spending its retry budget', async () => {
    await contestedSlot()
    const now = await idleSlotCandidate()
    const [trigger] = await db
      .update(executions)
      .set({ status: 'failed', failureClass: 'provider_transport' })
      .where(eq(executions.agentId, agent.id))
      .returning()
    await attachTrustedWorkStreamMessage(trigger.id)
    const waiterId = await queueSlot()
    await reconcileWorkStreamContinuationsOnce({ now })
    expect((await readCycle()).transportAttemptCount).toBe(0)
    await unsubscribeSlot(squad.id, 'test-capacity', agent.id, waiterId)
    await reconcileWorkStreamContinuationsOnce({ now })
    expect((await readCycle()).transportAttemptCount).toBe(1)
  })

  it('defers a previously scheduled nudge while any slot waiter remains and resumes after unsubscribe', async () => {
    await contestedSlot('first')
    await contestedSlot('second')
    const now = await idleSlotCandidate()
    await reconcileWorkStreamContinuationsOnce({ now: new Date(now.getTime() - 60_000) })
    expect((await readCycle()).status).toBe('pending')
    const first = await queueSlot('first')
    const second = await queueSlot('second')
    await reconcileWorkStreamContinuationsOnce({ now })
    expect((await readCycle()).normalAttemptCount).toBe(0)
    await unsubscribeSlot(squad.id, 'first', agent.id, first)
    await reconcileWorkStreamContinuationsOnce({ now: new Date(now.getTime() + 30_000) })
    expect((await readCycle()).normalAttemptCount).toBe(0)
    await unsubscribeSlot(squad.id, 'second', agent.id, second)
    await reconcileWorkStreamContinuationsOnce({ now: new Date(now.getTime() + 60_000) })
    expect((await readCycle()).status).toBe('delivered')
    expect((await readCycle()).normalAttemptCount).toBe(1)
  })

  it('allows the real slot grant wake while a different pool is still queued', async () => {
    const { holder, held, pool } = await contestedSlot()
    await contestedSlot('other-pool')
    const now = await idleSlotCandidate()
    await queueSlot()
    await queueSlot('other-pool')
    await reconcileWorkStreamContinuationsOnce({ now })
    expect((await readCycle()).normalAttemptCount).toBe(0)
    await releaseSlot(squad.id, pool.key, holder.id, held.claim.id)
    const [notification] = await db.select().from(slotNotifications).where(eq(slotNotifications.poolId, pool.id))
    await new SlotNotificationNotifier().drain({ now: notification.nextAttemptAt, notificationId: notification.id })
    const grants = (await InboxMessage.listForRecipient('agent', agent.id)).filter((message) =>
      message.subject?.startsWith('Slot granted')
    )
    expect(grants).toHaveLength(1)
    await deliverInboxMessagesToAgent(agent.id)
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
  })

  for (const state of ['canceled', 'granted', 'expired claim', 'unregistered pool'] as const) {
    it(`does not treat ${state} as a queued slot wait`, async () => {
      const { holder, held, pool } = await contestedSlot()
      const now = await idleSlotCandidate()
      const waiterId = await queueSlot()
      if (state === 'canceled') await unsubscribeSlot(squad.id, pool.key, agent.id, waiterId)
      if (state === 'granted' || state === 'expired claim') {
        await releaseSlot(squad.id, pool.key, holder.id, held.claim.id)
        if (state === 'expired claim')
          await db
            .update(slotClaims)
            .set({ expiresAt: new Date(0) })
            .where(eq(slotClaims.ownerAgentId, agent.id))
      }
      if (state === 'unregistered pool')
        await db.update(slotPools).set({ unregisteredAt: new Date() }).where(eq(slotPools.id, pool.id))
      await reconcileWorkStreamContinuationsOnce({ now })
      expect((await readCycle()).normalAttemptCount).toBe(1)
    })
  }

  it('does not send persistent idle escalation for a newly queued slot wait', async () => {
    const { endedAt } = await finishNormalContinuationForNotice()
    await contestedSlot()
    await reconcileWorkStreamContinuationsOnce({
      now: new Date(endedAt.getTime() + 60_000),
      testHooks: {
        beforeIdleNoticeCheck: async () => {
          await queueSlot()
        },
      },
    })
    expect(await persistentIdleNotices()).toHaveLength(0)
  })

  it('a scoped sweep neither schedules nor dispatches another squad', async () => {
    const otherSquad = await Squad.create({ name: `Unrelated ${crypto.randomUUID()}`, purpose: 'Scope boundary.' })
    try {
      const otherAgent = await Agent.create({ agentTypeId, squadId: otherSquad.id })
      extraAgentIds.push(otherAgent.id)
      const otherStream = await storedLegacyWorkStream({ squadId: otherSquad.id, title: 'Unrelated stream' })
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      await otherStream.update({ status: 'active', assigneeAgentId: otherAgent.id })
      const now = new Date(Date.now() + 1000)
      await settleAgentExecutions(agent, 'completed', now)
      await settleAgentExecutions(otherAgent, 'completed', now)
      const otherCycle = () =>
        db.select().from(workStreamContinuations).where(eq(workStreamContinuations.workStreamId, otherStream.id))
      const before = await otherCycle()
      await reconcileWorkStreamContinuationsOnce({ now })
      expect(await otherCycle()).toEqual(before)
      await reconcileContinuations({ now, squadId: otherSquad.id })
      const [pending] = await otherCycle()
      expect(pending!.status).toBe('pending')
      const ours = await readCycle()
      await reconcileWorkStreamContinuationsOnce({
        now: new Date(Math.max(ours.nextAttemptAt!.getTime(), pending!.nextAttemptAt!.getTime())),
      })
      expect((await readCycle()).status).toBe('delivered')
      expect(await otherCycle()).toEqual([pending])
    } finally {
      await db.delete(workStreams).where(eq(workStreams.squadId, otherSquad.id))
      await db.delete(agents).where(eq(agents.squadId, otherSquad.id))
      await db.delete(squads).where(eq(squads.id, otherSquad.id))
    }
  })

  it('uses deterministic bounded jitter for transport continuations', () => {
    const first = transportContinuationDelay(1, 'stable-seed')
    expect(first).toBe(transportContinuationDelay(1, 'stable-seed'))
    expect(first).toBeGreaterThanOrEqual(continuationDelay(1))
    expect(transportContinuationDelay(2, 'stable-seed')).toBeGreaterThanOrEqual(first)
    expect(transportContinuationDelay(99, 'stable-seed')).toBeLessThanOrEqual(5 * 60_000)
  })

  it('persists continuation ledger defaults', async () => {
    await db.insert(workStreamContinuations).values({
      workStreamId: workStream.id,
      assigneeAgentId: agent.id,
    })

    const [row] = await db
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, workStream.id))

    expect(row.generation).toBe(1)
    expect(row.status).toBe('idle')
    expect(row.normalAttemptCount).toBe(0)
    expect(row.transportAttemptCount).toBe(0)
    expect(row.deliveryAttemptCount).toBe(0)
  })

  it('schedules an eligible completed execution without consuming an attempt', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: new Date() })
      .where(eq(executions.agentId, agent.id))
    const [execution] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', endedAt })
      .returning()

    await reconcileWorkStreamContinuationsOnce({ now: endedAt })

    const [row] = await db
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    expect(row.status).toBe('pending')
    expect(row.triggerExecutionId).toBe(execution.id)
    expect(row.transportAttemptCount).toBe(0)
    expect(row.clientId).toBe(`work-stream-continuation:${workStream.id}:1:normal:1:${execution.id}`)
    expect(row.nextAttemptAt?.getTime()).toBe(endedAt.getTime() + continuationDelay(1))
  })

  it('delivers a due candidate once as a brief system-authored inbox nudge', async () => {
    const sentinel = 'SENTINEL_SECRET_NOISY_CONTEXT'
    await workStream.update({
      status: 'active',
      assigneeAgentId: agent.id,
      description: `Description containing ${sentinel}`,
      handoffMessage: `Handoff containing ${sentinel}`,
    })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)

    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const due = new Date(endedAt.getTime() + continuationDelay(1))
    await reconcileWorkStreamContinuationsOnce({ now: due })
    await reconcileWorkStreamContinuationsOnce({ now: due })

    const [row] = await db
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    expect(row.status).toBe('delivered')
    expect(row.normalAttemptCount).toBe(1)
    expect(row.transportAttemptCount).toBe(0)

    const clientId = `work-stream-continuation:${workStream.id}:1:normal:1:${row.triggerExecutionId}`
    const deliveredInbox = await db.select().from(inbox).where(eq(inbox.idempotencyKey, clientId))
    expect(deliveredInbox).toHaveLength(1)
    expect(deliveredInbox[0]).toMatchObject({
      recipientType: 'agent',
      recipientId: agent.id,
      senderType: 'system',
      senderId: null,
      deliveryMode: 'steer',
      content: `It seems like you stopped working on work stream ${workStream.id}: ${workStream.title} without handing it off. If you are intentionally waiting for an event, keep waiting; otherwise continue working.`,
    })
    expect(deliveredInbox[0]?.content).not.toContain(sentinel)
    expect(deliveredInbox[0]?.deliveredAt).toBeInstanceOf(Date)

    const deliveredMessages = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agent.id),
          sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([deliveredInbox[0]!.id])}::jsonb`
        )
      )
    expect(deliveredMessages).toHaveLength(1)
    expect(deliveredMessages[0]?.role).toBe('human')
    expect(deliveredMessages[0]?.content).toContain(
      `It seems like you stopped working on work stream ${workStream.id}: ${workStream.title} without handing it off. If you are intentionally waiting for an event, keep waiting; otherwise continue working.`
    )
    expect(deliveredMessages[0]?.content).not.toContain(sentinel)
    expect(deliveredMessages[0]?.metadata).toMatchObject({
      source: 'inbox',
      deliveryMode: 'steer',
      inboxMessageIds: [deliveredInbox[0]!.id],
    })
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
  })

  it('does not block a reset same-assignee generation from stale exhaustion', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const staleGeneration = 1

    await workStream.update({ assigneeAgentId: agent.id })
    const blocked = await blockCurrentContinuation(
      workStream.id,
      staleGeneration,
      agent.id,
      'stale block',
      (cycle) => cycle.transportAttemptCount >= 3
    )

    expect(blocked).toBe(false)
    await workStream.reload()
    expect(workStream.status).toBe('active')
  })

  it('counts concurrent delivery failures atomically and ignores stale success/reset catches', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const clientId = `work-stream-continuation:${workStream.id}:1:1`
    const claimToken = crypto.randomUUID()
    await db
      .update(workStreamContinuations)
      .set({ status: 'pending', clientId, claimToken })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const input = {
      workStreamId: workStream.id,
      generation: 1,
      assigneeAgentId: agent.id,
      clientId,
      claimToken,
      error: new Error('queue failed'),
      now: new Date(),
    }

    expect(
      new Set(await Promise.all([recordContinuationDeliveryFailure(input), recordContinuationDeliveryFailure(input)]))
    ).toEqual(new Set([1, null]))
    expect(await readCycle()).toMatchObject({
      deliveryAttemptCount: 1,
      nextAttemptAt: new Date(input.now.getTime() + continuationDelay(1)),
    })
    await db
      .update(workStreamContinuations)
      .set({ status: 'delivered' })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    expect(await recordContinuationDeliveryFailure(input)).toBeNull()

    await workStream.update({ assigneeAgentId: agent.id })
    expect(await recordContinuationDeliveryFailure(input)).toBeNull()
    await workStream.reload()
    expect(workStream.status).toBe('active')
  })

  it('recovers stopped turns but excludes the newest failed/provider-halted turn', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const stoppedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'stopped', stoppedAt)
    await reconcileWorkStreamContinuationsOnce({ now: stoppedAt })
    expect((await readCycle()).status).toBe('pending')

    await workStream.update({ assigneeAgentId: agent.id })
    const failedAt = new Date(stoppedAt.getTime() + 1_000)
    await settleAgentExecutions(agent, 'failed', failedAt)
    await db.update(agents).set({ status: 'waiting-input' }).where(eq(agents.id, agent.id))
    await reconcileWorkStreamContinuationsOnce({ now: failedAt })
    expect((await readCycle()).status).toBe('idle')
  })

  it('a stored platform_pre_tool_refusal failure consumes neither nudge budget while a voluntary stop still nudges once', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))

    // The incident shape: the platform refused admission before any output,
    // and the row now carries the structural classification.
    const refusedAt = new Date(Date.now() + 1_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      error: 'Admission effect was refused by the durable fence',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt: refusedAt,
    })
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id))

    await reconcileWorkStreamContinuationsOnce({ now: refusedAt })

    const refusedCycle = await readCycle()
    // No candidate, no settle, no attempt counters, no trigger — the refusal
    // never touches the `agent stopped` (normal) or transport budgets.
    expect(refusedCycle.status).toBe('idle')
    expect(refusedCycle.triggerExecutionId).toBeNull()
    expect(refusedCycle.normalAttemptCount).toBe(0)
    expect(refusedCycle.transportAttemptCount).toBe(0)

    // Contrast: a genuine voluntary stop (agent stopped without handoff)
    // still receives exactly one normal nudge.
    await db.delete(workStreamContinuations).where(eq(workStreamContinuations.workStreamId, workStream.id))
    const stoppedAt = new Date(refusedAt.getTime() + 1_000)
    await db.insert(executions).values({ agentId: agent.id, status: 'stopped', endedAt: stoppedAt })
    await reconcileWorkStreamContinuationsOnce({ now: stoppedAt })

    const stoppedCycle = await readCycle()
    expect(stoppedCycle.status).toBe('pending')
    expect(stoppedCycle.normalAttemptCount).toBe(0)
    expect(stoppedCycle.triggerExecutionId).toBeTruthy()
  })

  it('a stored provider_transport class behaves identically to the legacy prose sentinel', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const failedAt = new Date(Date.now() + 1_000)
    // Stored class carries the transport fact; the error prose is unmarked.
    const [failed] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        failureClass: 'provider_transport',
        failureReason: 'transport',
        endedAt: failedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failed.id)

    await reconcileWorkStreamContinuationsOnce({ now: failedAt })

    const cycle = await readCycle()
    expect(cycle.status).toBe('pending')
    expect(cycle.triggerExecutionId).toBe(failed.id)
    expect(cycle.transportAttemptCount).toBe(0)
    expect(cycle.nextAttemptAt?.getTime()).toBe(failedAt.getTime() + transportContinuationDelay(1, cycle.clientId!))

    // A legacy row (NULL class) with the same sentinel text schedules the
    // same way — the sentinel remains the fallback, not the primary.
    await db.delete(workStreamContinuations).where(eq(workStreamContinuations.workStreamId, workStream.id))
    const legacyAt = new Date(failedAt.getTime() + 1_000)
    const [legacy] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt: legacyAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(legacy.id)
    await reconcileWorkStreamContinuationsOnce({ now: legacyAt })

    const legacyCycle = await readCycle()
    expect(legacyCycle.status).toBe('pending')
    expect(legacyCycle.triggerExecutionId).toBe(legacy.id)
  })

  it('schedules only canonical failed provider transport executions', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const failedAt = new Date(Date.now() + 1_000)
    const [failed] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt: failedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failed.id)

    await reconcileWorkStreamContinuationsOnce({ now: failedAt })

    const cycle = await readCycle()
    expect(cycle.status).toBe('pending')
    expect(cycle.triggerExecutionId).toBe(failed.id)
    expect(cycle.transportAttemptCount).toBe(0)
    expect(cycle.nextAttemptAt?.getTime()).toBe(failedAt.getTime() + transportContinuationDelay(1, cycle.clientId!))
  })

  it('does not continue a canonical transport failure from an unrelated direct turn', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    const failedAt = new Date(Date.now() + 1_000)
    const [failed] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt: failedAt,
      })
      .returning()
    await db.insert(messages).values([
      {
        agentId: agent.id,
        role: 'human',
        content: 'Unrelated direct turn',
        pending: false,
        metadata: { source: 'chat', executionId: failed.id },
      },
      {
        agentId: agent.id,
        role: 'human',
        content: 'Forged inbox summary',
        pending: false,
        metadata: { source: 'inbox', inboxMessageIds: ['not-a-uuid'], executionId: failed.id },
      },
    ])

    await reconcileWorkStreamContinuationsOnce({ now: failedAt })
    expect((await readCycle()).status).toBe('idle')

    const [foreignInbox] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'Different work stream handoff',
        metadata: { workStreamId: crypto.randomUUID(), event: 'assigned' },
        deliveredAt: new Date(),
      })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'human',
      content: 'Different work stream handoff',
      pending: false,
      metadata: { source: 'inbox', inboxMessageIds: [foreignInbox.id], executionId: failed.id },
    })
    await reconcileWorkStreamContinuationsOnce({ now: failedAt })
    expect((await readCycle()).status).toBe('idle')
  })

  it('recovers the first socket-close handoff exactly once without changing the original delivery', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const failedAt = new Date(Date.now() + 1_000)
    const [failedExecution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt: failedAt,
      })
      .returning()
    const originalDeliveredAt = new Date(Date.now() - 1_000)
    const [originalInbox] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'Original work stream handoff',
        metadata: { workStreamId: workStream.id, squadId: squad.id, event: 'assigned' },
        deliveryMode: 'steer',
        deliveredAt: originalDeliveredAt,
      })
      .returning()
    const [originalMessage] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'human',
        content: 'Original work stream handoff',
        pending: true,
        metadata: { source: 'inbox', inboxMessageIds: [originalInbox.id], executionId: failedExecution.id },
      })
      .returning()

    await reconcileWorkStreamContinuationsOnce({ now: failedAt })
    const scheduled = await readCycle()
    await reconcileWorkStreamContinuationsOnce({ now: scheduled.nextAttemptAt! })
    await reconcileWorkStreamContinuationsOnce({ now: scheduled.nextAttemptAt! })
    expect(await readCycle()).toMatchObject({ status: 'delivered', transportAttemptCount: 1, lastError: null })

    const [unchangedInbox] = await db.select().from(inbox).where(eq(inbox.id, originalInbox.id))
    const [unchangedMessage] = await db.select().from(messages).where(eq(messages.id, originalMessage.id))
    expect(unchangedInbox).toMatchObject({ content: originalInbox.content, deliveredAt: originalDeliveredAt })
    expect(unchangedMessage).toMatchObject({ content: originalMessage.content, pending: false })

    const continuationInbox = await db.select().from(inbox).where(eq(inbox.idempotencyKey, scheduled.clientId!))
    expect(continuationInbox).toHaveLength(1)
    expect(continuationInbox[0]?.content).toBe(`Continue working on work stream ${workStream.id}: ${workStream.title}.`)
    expect(continuationInbox[0]?.content).not.toContain('Original work stream handoff')
    expect(
      await db
        .select()
        .from(messages)
        .where(sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([continuationInbox[0]!.id])}::jsonb`)
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
  })

  it('recovers an exact first-handoff socket close through a successful continuation execution', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await deliverInboxMessagesToAgent(agent.id)

    const assignmentInbox = (await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))).find((row) => {
      const metadata = row.metadata as Record<string, unknown>
      return metadata.workStreamId === workStream.id && metadata.event === 'assigned'
    })
    expect(assignmentInbox).toBeDefined()
    const [originalMessage] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agent.id),
          sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([assignmentInbox!.id])}::jsonb`
        )
      )
    expect(originalMessage?.pending).toBe(true)
    const firstExecutionId = (originalMessage?.metadata as { executionId?: string } | null)?.executionId
    expect(firstExecutionId).toBeDefined()
    let firstExecution = await Execution.mustFind(firstExecutionId!)
    await firstExecution.start()
    await db
      .update(executions)
      .set({ runnerClaimToken: null, runnerClaimGeneration: null })
      .where(eq(executions.id, firstExecution.id))
    firstExecution = await Execution.mustFind(firstExecution.id)

    const firstSession = new MockAgentSession()
    firstSession.pi.promptError = new Error('The socket connection was closed unexpectedly')
    const firstRunner = new TestAgentRunner(firstExecution, agent, makeAgentType({ id: agentTypeId }), firstSession)
    await firstRunner.run()
    await waitFor(async () => (await Execution.mustFind(firstExecution.id)).status === 'failed')
    const failed = await Execution.mustFind(firstExecution.id)
    expect(failed.error).toBe('Provider transport failure: The socket connection was closed unexpectedly')
    expect((await db.select().from(messages).where(eq(messages.id, originalMessage!.id)))[0]?.pending).toBe(true)

    await reconcileWorkStreamContinuationsOnce({ now: failed.endedAt! })
    const scheduled = await readCycle()
    await reconcileWorkStreamContinuationsOnce({ now: scheduled.nextAttemptAt! })
    const delivered = await readCycle()
    expect(delivered.status).toBe('delivered')
    expect(delivered.deliveryExecutionId).not.toBe(firstExecution.id)

    const [preservedInbox] = await db.select().from(inbox).where(eq(inbox.id, assignmentInbox!.id))
    const [preservedMessage] = await db.select().from(messages).where(eq(messages.id, originalMessage!.id))
    expect(preservedInbox.id).toBe(assignmentInbox!.id)
    expect(preservedMessage.id).toBe(originalMessage!.id)
    expect(preservedMessage.pending).toBe(false)

    let continuationExecution = await Execution.mustFind(delivered.deliveryExecutionId!)
    await continuationExecution.start()
    await db
      .update(executions)
      .set({ runnerClaimToken: null, runnerClaimGeneration: null })
      .where(eq(executions.id, continuationExecution.id))
    continuationExecution = await Execution.mustFind(continuationExecution.id)
    const continuationSession = new MockAgentSession()
    const continuationRunner = new TestAgentRunner(
      continuationExecution,
      agent,
      makeAgentType({ id: agentTypeId }),
      continuationSession
    )
    try {
      await continuationRunner.run()
      expect(continuationSession.pi.promptCalls).toHaveLength(1)
      expect(continuationSession.pi.promptCalls[0]?.text).toContain(
        `Continue working on work stream ${workStream.id}: ${workStream.title}.`
      )
      expect(continuationSession.pi.promptCalls[0]?.text).not.toContain('Query the work stream with')
      const pending = await agent.listPendingHumanMessages()
      expect(pending).toHaveLength(1)
      const receipt = continuationSession.pi.persistUserPrompt('continuation-user-entry')
      expect(pending[0]!.metadata?.sessionDelivery?.id).toBe(receipt.deliveryId)
      await continuationRunner.waitForPersistence()
      expect(await Agent.findMessage(pending[0]!.id)).toMatchObject({
        pending: false,
        metadata: {
          executionId: continuationExecution.id,
          sessionEntryId: receipt.entryId,
          streamGroupId: `${continuationExecution.id}:session:${receipt.entryId}:0`,
          sessionDelivery: { id: receipt.deliveryId, executionId: continuationExecution.id },
        },
      })
      expect(await agent.listPendingHumanMessages()).toHaveLength(0)
      continuationSession.pi.simulateNormalEnd('Recovered successfully')
      await continuationRunner.waitForCompletion()

      expect((await Execution.mustFind(continuationExecution.id)).status).toBe('completed')
      expect(
        await db
          .select()
          .from(executions)
          .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
      ).toHaveLength(0)
      expect(await db.select().from(inbox).where(eq(inbox.id, assignmentInbox!.id))).toHaveLength(1)
    } finally {
      if (isSessionActive(agent.id)) {
        continuationSession.pi.simulateNormalEnd('fixture cleanup')
        await continuationRunner.waitForCompletion()
      }
      removeSession(agent.id)
    }
  })

  for (const excludedError of [
    'The socket connection was closed unexpectedly',
    'Provider transport failure: authentication failed',
    'Execution session capacity reservation was refused',
    '429 insufficient_quota',
    'Operation aborted by user',
  ]) {
    it(`does not continue failed execution without canonical transport provenance: ${excludedError}`, async () => {
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      const failedAt = new Date(Date.now() + 1_000)
      await db
        .insert(executions)
        .values({ agentId: agent.id, status: 'failed', error: excludedError, endedAt: failedAt })

      await reconcileWorkStreamContinuationsOnce({ now: failedAt })

      expect((await readCycle()).status).toBe('idle')
    })
  }

  it('uses terminal endedAt ordering rather than execution start ordering', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    const laterEnd = new Date(Date.now() + 2_000)
    const [expected] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', startedAt: new Date(0), endedAt: laterEnd })
      .returning()
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'stopped',
      startedAt: new Date(Date.now() + 10_000),
      endedAt: new Date(laterEnd.getTime() - 1_000),
    })

    await reconcileWorkStreamContinuationsOnce({ now: laterEnd })
    expect((await readCycle()).triggerExecutionId).toBe(expected.id)
  })

  it('excludes owners, other bound agents, and unassigned streams', async () => {
    const owner = await createExtraAgent()
    const bound = await createExtraAgent()
    await workStream.update({
      status: 'active',
      assigneeAgentId: agent.id,
      ownerAgentId: owner.id,
      agentIds: [agent.id, owner.id, bound.id],
    })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(owner, 'completed', endedAt)
    await settleAgentExecutions(bound, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('idle')

    await db.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, workStream.id))
    await settleAgentExecutions(agent, 'completed', new Date(endedAt.getTime() + 1_000))
    await reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + 1_000) })
    expect((await readCycle()).status).toBe('idle')
  })

  it('excludes every non-active stream state AND active streams with an open wait', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    for (const status of ['queued', 'done', 'canceled'] as const) {
      await db.update(workStreams).set({ status }).where(eq(workStreams.id, workStream.id))
      await db
        .update(workStreamContinuations)
        .set({ status: 'idle', triggerExecutionId: null })
        .where(eq(workStreamContinuations.workStreamId, workStream.id))
      await reconcileWorkStreamContinuationsOnce({ now: endedAt })
      expect((await readCycle()).status).toBe('idle')
    }
    await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, workStream.id))

    // An active stream with an OPEN WAIT (review here) must not be nudged —
    // pre-consolidation this exclusion was the 'review'/'blocked' statuses.
    const [wait] = await db.insert(workStreamWaits).values({ workStreamId: workStream.id, type: 'review' }).returning()
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('idle')

    // Closing the wait re-arms the sweep for this stream.
    await db
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'sent_back', resolutionNote: 'go again' })
      .where(eq(workStreamWaits.id, wait.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('pending')
  })

  it('uses status rather than an inconsistent lifecycle audit timestamp for scheduling and dispatch', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await db
      .update(agents)
      .set({ status: 'idle', terminatedAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(agents.id, agent.id))

    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('pending')
    await reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + continuationDelay(1)) })
    expect((await readCycle()).status).toBe('delivered')
  })

  it('excludes non-idle, terminating, terminated, inactive-squad, and active-execution agents', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    for (const status of ['active', 'waiting-input', 'compacting', 'resetting'] as const) {
      await db.update(agents).set({ status }).where(eq(agents.id, agent.id))
      await reconcileWorkStreamContinuationsOnce({ now: endedAt })
      expect((await readCycle()).status).toBe('idle')
    }
    await db.update(agents).set({ status: 'idle', pendingDormancyAt: new Date() }).where(eq(agents.id, agent.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('idle')
    await db
      .update(agents)
      .set({ status: 'terminated', pendingDormancyAt: null, terminatedAt: new Date() })
      .where(eq(agents.id, agent.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('idle')
    await db.update(agents).set({ terminatedAt: null }).where(eq(agents.id, agent.id))
    await db.update(squads).set({ status: 'paused' }).where(eq(squads.id, squad.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('idle')
    await db.update(squads).set({ status: 'active' }).where(eq(squads.id, squad.id))
    await db.insert(executions).values({ agentId: agent.id, status: 'queued' })
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    expect((await readCycle()).status).toBe('idle')
  })

  it('a stale scheduler cannot restore pending after concurrent delivery', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({
      now: endedAt,
      testHooks: {
        beforeCandidateSchedule: async () => {
          await db
            .update(workStreamContinuations)
            .set({
              status: 'idle',
              normalAttemptCount: 1,
              transportAttemptCount: 0,
              triggerExecutionId: null,
              claimedAt: null,
            })
            .where(eq(workStreamContinuations.workStreamId, workStream.id))
        },
      },
    })
    const cycle = await readCycle()
    expect(cycle.status).toBe('idle')
    expect(cycle.normalAttemptCount).toBe(1)
    expect(cycle.transportAttemptCount).toBe(0)
    expect(cycle.triggerExecutionId).toBeNull()
  })

  it('does not create a zombie candidate when cancellation wins the scheduling boundary', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({
      now: endedAt,
      testHooks: { beforeCandidateSchedule: () => workStream.cancel().then(() => {}) },
    })
    let cycle = await readCycle()
    expect(cycle.status).toBe('idle')
    expect(cycle.nextAttemptAt).toBeNull()

    await reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + 600_000) })
    cycle = await readCycle()
    expect(cycle.status).toBe('idle')
    expect(cycle.nextAttemptAt).toBeNull()
  })

  it('defers a pending candidate when a wait opens before the locked delivery boundary', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const cycle = await readCycle()
    await db.insert(workStreamWaits).values({ workStreamId: workStream.id, type: 'manual' })

    await reconcileWorkStreamContinuationsOnce({ now: cycle.nextAttemptAt! })

    expect((await readCycle()).status).toBe('pending')
    expect(await db.select().from(inbox).where(eq(inbox.idempotencyKey, cycle.clientId!))).toHaveLength(0)
    expect(
      await db
        .select()
        .from(messages)
        .where(sql`${messages.metadata}->>'clientId' like ${`work-stream-continuation:${workStream.id}:%`}`)
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(0)
  })

  for (const staleKind of ['normal', 'transport'] as const) {
    it(`invalidates a stale pending ${staleKind} candidate at the final delivery boundary`, async () => {
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      const triggerEndedAt = new Date(Date.now() + 1_000)
      const trigger = await settleAgentExecutions(
        agent,
        staleKind === 'normal' ? 'completed' : 'failed',
        triggerEndedAt
      )
      if (staleKind === 'transport') {
        await db
          .update(executions)
          .set({ error: 'Provider transport failure: The socket connection was closed unexpectedly' })
          .where(eq(executions.id, trigger.id))
        await attachTrustedWorkStreamMessage(trigger.id)
      }
      await db
        .update(workStreamContinuations)
        .set({ transportAttemptCount: 1 })
        .where(eq(workStreamContinuations.workStreamId, workStream.id))
      await reconcileWorkStreamContinuationsOnce({ now: triggerEndedAt })
      const pending = await readCycle()
      expect(pending.status).toBe('pending')
      const completionStartedAt = new Date(triggerEndedAt.getTime() + 1_000)
      const completionEndedAt = new Date(completionStartedAt.getTime() + 1_000)
      let completionId: string | undefined

      await reconcileWorkStreamContinuationsOnce({
        now: pending.nextAttemptAt!,
        testHooks: {
          beforeDispatchQueue: async () => {
            const [completion] = await db
              .insert(executions)
              .values({
                agentId: agent.id,
                status: 'completed',
                runStartedAt: completionStartedAt,
                endedAt: completionEndedAt,
              })
              .returning()
            completionId = completion.id
          },
        },
      })

      expect(await readCycle()).toMatchObject({
        status: 'idle',
        normalAttemptCount: 0,
        transportAttemptCount: 0,
        progressExecutionId: completionId,
      })
      expect(await db.select().from(inbox).where(eq(inbox.idempotencyKey, pending.clientId!))).toHaveLength(0)
    })
  }

  it('defers a due candidate behind a sandbox-waiting execution without injecting a message', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const cycle = await readCycle()
    await db.insert(executions).values({ agentId: agent.id, status: 'waiting-sandbox' })
    await reconcileWorkStreamContinuationsOnce({ now: cycle.nextAttemptAt! })
    expect((await readCycle()).status).toBe('pending')
    expect(
      await db
        .select()
        .from(messages)
        .where(sql`${messages.metadata}->>'clientId' = ${cycle.clientId}`)
    ).toHaveLength(0)
  })

  it('recovers solely from persisted legacy rows after restart', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(workStreamContinuations).where(eq(workStreamContinuations.workStreamId, workStream.id))
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)

    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const cycle = await readCycle()
    expect(cycle.status).toBe('pending')
    await reconcileWorkStreamContinuationsOnce({ now: cycle.nextAttemptAt! })
    expect((await readCycle()).status).toBe('delivered')
  })

  it('reclaims an expired delivery lease without duplicating the inbox nudge or execution', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const clientId = (await readCycle()).clientId!
    const due = new Date(endedAt.getTime() + continuationDelay(1) + 120_001)
    await db
      .update(workStreamContinuations)
      .set({ claimedAt: new Date(due.getTime() - 120_001) })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    await reconcileWorkStreamContinuationsOnce({ now: due })
    await reconcileWorkStreamContinuationsOnce({ now: due })
    expect((await readCycle()).status).toBe('delivered')

    const deliveredInbox = await db.select().from(inbox).where(eq(inbox.idempotencyKey, clientId))
    expect(deliveredInbox).toHaveLength(1)
    expect(
      await db
        .select()
        .from(messages)
        .where(sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([deliveredInbox[0]!.id])}::jsonb`)
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
  })

  it('defers to a normal inbox delivery that already claimed the continuation nudge', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const cycle = await readCycle()
    const clientId = cycle.clientId!
    const executionCountBefore = (await db.select().from(executions).where(eq(executions.agentId, agent.id))).length
    const [persistedInbox] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: `It seems like you stopped working on work stream ${workStream.id}: ${workStream.title} without handing it off. If you are intentionally waiting for an event, keep waiting; otherwise continue working.`,
        deliveryMode: 'steer',
        idempotencyKey: clientId,
        metadata: {
          source: 'work-stream-continuation',
          workStreamId: workStream.id,
          generation: cycle.generation,
          kind: 'normal',
          attempt: 1,
          clientId,
        },
      })
      .returning()

    let releaseSend!: () => void
    const sendPaused = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    let sendEntered!: () => void
    const enteredSend = new Promise<void>((resolve) => {
      sendEntered = resolve
    })
    const originalSend = Agent.prototype.sendMessage
    const sendSpy = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async function (
      this: Agent,
      content,
      options
    ) {
      sendEntered()
      await sendPaused
      return originalSend.call(this, content, options)
    })
    try {
      const normalDelivery = deliverInboxMessagesToAgent(agent.id)
      await enteredSend
      await reconcileWorkStreamContinuationsOnce({ now: cycle.nextAttemptAt! })
      releaseSend()
      await normalDelivery
    } finally {
      sendSpy.mockRestore()
      releaseSend()
    }

    const normalEndedAt = new Date(cycle.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(messages)
      .set({ pending: false, injectedAt: normalEndedAt })
      .where(sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([persistedInbox!.id])}::jsonb`)
    await settleAgentExecutions(agent, 'completed', normalEndedAt)
    await reconcileWorkStreamContinuationsOnce({ now: normalEndedAt })
    await reconcileWorkStreamContinuationsOnce({ now: (await readCycle()).nextAttemptAt! })

    const deliveredMessages = await db
      .select()
      .from(messages)
      .where(sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([persistedInbox!.id])}::jsonb`)
    expect((await readCycle()).status).toBe('delivered')
    expect(await db.select().from(inbox).where(eq(inbox.idempotencyKey, clientId))).toHaveLength(1)
    expect(deliveredMessages).toHaveLength(1)
    expect(deliveredMessages[0]?.content).toContain(
      `It seems like you stopped working on work stream ${workStream.id}: ${workStream.title} without handing it off. If you are intentionally waiting for an event, keep waiting; otherwise continue working.`
    )
    expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(
      executionCountBefore + 1
    )
  })

  it('drains a persisted crash-window inbox delivery without duplicating the inbox nudge or execution', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const cycle = await readCycle()
    const clientId = cycle.clientId!
    const [persistedInbox] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: `It seems like you stopped working on work stream ${workStream.id}: ${workStream.title} without handing it off. If you are intentionally waiting for an event, keep waiting; otherwise continue working.`,
        deliveryMode: 'steer',
        idempotencyKey: clientId,
        metadata: {
          source: 'work-stream-continuation',
          workStreamId: workStream.id,
          generation: cycle.generation,
          kind: 'normal',
          attempt: 1,
          clientId,
        },
      })
      .returning()
    const canonicalDelivery = prepareInboxDelivery([new InboxMessage(persistedInbox!)], 'steer', 'steer')
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'human',
      content: canonicalDelivery.prompt,
      pending: true,
      metadata: {
        ...canonicalDelivery.metadata,
        clientId: `${clientId}:inbox`,
      },
    })

    await reconcileWorkStreamContinuationsOnce({ now: cycle.nextAttemptAt! })
    await reconcileWorkStreamContinuationsOnce({ now: cycle.nextAttemptAt! })
    expect((await readCycle()).status).toBe('delivered')
    expect(await db.select().from(inbox).where(eq(inbox.idempotencyKey, clientId))).toHaveLength(1)
    const recoveredMessages = await db
      .select()
      .from(messages)
      .where(sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([persistedInbox!.id])}::jsonb`)
    expect(recoveredMessages).toHaveLength(1)
    expect(recoveredMessages[0]?.content).toBe(canonicalDelivery.prompt)
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
  })

  it('persists queue-error backoff and blocks after five real dispatch failures', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const sentinel = 'SENTINEL_SECRET_DELIVERY_FAILURE'
    const endedAt = new Date(Date.now() + 1_000)
    const olderErrorAt = new Date(endedAt.getTime() - 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    await db
      .update(workStreamContinuations)
      .set({ cycleStartedAt: new Date(endedAt.getTime() - 2_000) })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    await db.insert(executions).values({ agentId: agent.id, status: 'stopped', endedAt: olderErrorAt, error: sentinel })
    const original = Agent.prototype.queueExecutionInTransaction
    Agent.prototype.queueExecutionInTransaction = async () => {
      throw new Error('simulated queue failure')
    }
    let now = (await readCycle()).nextAttemptAt!
    let exhaustionAt = now
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        exhaustionAt = now
        await reconcileWorkStreamContinuationsOnce({ now })
        const cycle = await readCycle()
        expect(cycle.deliveryAttemptCount).toBe(attempt)
        expect(cycle.lastError).toContain('simulated queue failure')
        now = cycle.nextAttemptAt!
      }
    } finally {
      Agent.prototype.queueExecutionInTransaction = original
    }
    await workStream.reload()
    // Exhaustion opens a system manual wait; status stays active.
    expect(workStream.status).toBe('active')
    const deliveryWaits = await workStream.getOpenWaits()
    const deliveryWait = deliveryWaits.find(
      (wait) => wait.type === 'manual' && wait.message?.includes('delivery repeatedly failed')
    )
    expect(deliveryWait).toBeDefined()
    expect(deliveryWait?.message).toContain(
      `Last error: continuation_delivery_failure at ${exhaustionAt.toISOString()}`
    )
    expect(deliveryWait?.message).not.toContain('execution_stopped')
    expect(deliveryWait?.message).not.toContain('simulated queue failure')
    expect(deliveryWait?.message).not.toContain(sentinel)
  })

  it('serializes an ordinary queue racing continuation delivery', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    await reconcileWorkStreamContinuationsOnce({
      now: (await readCycle()).nextAttemptAt!,
      testHooks: { beforeDispatchQueue: () => agent.queueExecution({ message: 'ordinary queue' }).then(() => {}) },
    })
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    ).toHaveLength(1)
    expect((await readCycle()).deliveryAttemptCount).toBe(1)
  })

  it('cancellation racing paused dispatch stops the continuation and prevents revival', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id, agentIds: [agent.id] })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    let cancellation: Promise<unknown> | undefined
    await reconcileWorkStreamContinuationsOnce({
      now: (await readCycle()).nextAttemptAt!,
      testHooks: {
        beforeDispatchQueue: async () => {
          cancellation = workStream.cancelWithSideEffects()
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
      },
    })
    await cancellation
    await reconcileWorkStreamContinuationsOnce({ now: new Date(Date.now() + 600_000) })
    await workStream.reload()
    expect(workStream.status).toBe('canceled')
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), inArray(executions.status, ['queued', 'running', 'stopping'])))
    ).toHaveLength(0)
  })

  it('rechecks a barrier-started execution before opening a wait and clears stale strikes', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const endedAt = new Date(Date.now() + 1_000)
    const [failed] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failed.id)
    let runningExecution: Execution | undefined

    await reconcileWorkStreamContinuationsOnce({
      now: endedAt,
      testHooks: {
        beforeExhaustionBlock: async () => {
          runningExecution = await agent.queueExecution({ message: 'Concurrent healthy continuation' })
          await runningExecution.start()
        },
      },
    })

    expect(runningExecution?.status).toBe('running')
    expect(await workStream.getOpenWaits()).toHaveLength(0)
    expect(await readCycle()).toMatchObject({ status: 'idle', transportAttemptCount: 0 })
  })

  it('does not open a stale wait when a barrier-started execution completes before the final check', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    // A minute back, not `new Date()`. The guard under test is
    // `runStartedAt > trigger.endedAt`, and the barrier's `runStartedAt` is written by the
    // DATABASE clock while this value is the host's. Pinning it to "now" left only the tens of
    // milliseconds between here and `execution.start()` as headroom, so a Docker VM clock lagging
    // the host by that much inverted the comparison and the test failed for a reason that had
    // nothing to do with the behavior. `cycleStartedAt` is derived from this, so the observation
    // window still contains the failed execution, and the barrier completion still ends after
    // `now` — the "completes before the final check" shape is unchanged.
    const endedAt = new Date(Date.now() - 60_000)
    const [failed] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failed.id)
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3, cycleStartedAt: new Date(endedAt.getTime() - 1_000) })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))

    await reconcileWorkStreamContinuationsOnce({
      now: endedAt,
      testHooks: {
        beforeExhaustionBlock: async () => {
          const execution = await agent.queueExecution({ message: 'Fast healthy continuation' })
          await execution.start()
          await execution.transitionTo({ kind: 'completed' })
        },
      },
    })

    expect(await workStream.getOpenWaits()).toHaveLength(0)
    expect(await readCycle()).toMatchObject({ status: 'idle', transportAttemptCount: 0 })
  })

  /**
   * The production form of the bug the test above was only accidentally exposed to. The watchdog
   * decides "did the agent already recover?" with `runStartedAt > trigger.endedAt`. While
   * `endedAt` came from the app host and `runStartedAt` from Postgres, a Core host running ahead
   * of the database put the trigger's `endedAt` in the database's future, so a recovery that
   * genuinely started first failed the comparison: the watchdog opened a "continuation exhausted"
   * manual wait on a healthy stream, which then parked after the grace period until a human
   * cleared it. `setSystemTime` skews only this process's clock, leaving Postgres alone.
   */
  it('does not open a spurious wait when the host clock runs ahead of the database', async () => {
    const HOST_SKEW_MS = 5_000
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))

    // The transport failure is RECORDED while this host is 5s ahead of the database.
    const failing = await agent.queueExecution({ message: 'Transport failure under clock skew' })
    await failing.start()
    setSystemTime(new Date(Date.now() + HOST_SKEW_MS))
    try {
      await failing.transitionTo({
        kind: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
      })
    } finally {
      setSystemTime()
    }
    await attachTrustedWorkStreamMessage(failing.id)

    const endedAt = failing.endedAt!
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3, cycleStartedAt: new Date(endedAt.getTime() - 1_000) })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))

    await reconcileWorkStreamContinuationsOnce({
      now: endedAt,
      testHooks: {
        // The agent recovers on its own, on the DATABASE's clock, before the final check.
        beforeExhaustionBlock: async () => {
          const recovery = await agent.queueExecution({ message: 'Recovered after transport failure' })
          await recovery.start()
          await recovery.transitionTo({ kind: 'completed' })
        },
      },
    })

    expect(await workStream.getOpenWaits()).toHaveLength(0)
    expect(await readCycle()).toMatchObject({ status: 'idle', transportAttemptCount: 0 })
  })

  /**
   * The high-water side of the same skew. `cycleStartedAt` marks "progress after this point is
   * new"; it is compared against `executions.ended_at`, which the database stamps. While the mark
   * was written from the app host, a host running ahead put it in the database's future, so a
   * genuine completion failed `isAfterProgressHighWater` and the stream sat there — the failure D
   * removed from the wait path, relocated to the progress path.
   */
  it('recognizes progress made after a cycle whose mark was stamped under host clock skew', async () => {
    const HOST_SKEW_MS = 5_000

    // The cycle is (re)stamped while this host runs 5s ahead of the database.
    setSystemTime(new Date(Date.now() + HOST_SKEW_MS))
    try {
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      await db.transaction(async (tx) => resetContinuationCycle(tx, workStream.id, agent.id))
    } finally {
      setSystemTime()
    }

    // The mark must be on the DATABASE's timeline, not 5s into its future.
    const cycle = await readCycle()
    const databaseNow = new Date((await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`))[0].now)
    expect(cycle.cycleStartedAt.getTime() - databaseNow.getTime()).toBeLessThan(HOST_SKEW_MS / 2)

    // ...so a completion recorded now counts as progress rather than as pre-cycle history.
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const execution = await agent.queueExecution({ message: 'Progress after a skewed reset' })
    await execution.start()
    await execution.transitionTo({ kind: 'completed' })
    await execution.reload()
    expect(execution.endedAt!.getTime()).toBeGreaterThan(cycle.cycleStartedAt.getTime())
  })

  it('production exhaustion path rejects a same-assignee reset at its block boundary', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const endedAt = new Date(Date.now() + 1_000)
    const [failed] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failed.id)
    await reconcileWorkStreamContinuationsOnce({
      now: endedAt,
      testHooks: { beforeExhaustionBlock: () => workStream.update({ assigneeAgentId: agent.id }).then(() => {}) },
    })
    await workStream.reload()
    expect(workStream.status).toBe('active')
    expect((await readCycle()).generation).toBe(2)
  })

  it('registers one idempotent continuation runner', async () => {
    startWorkStreamContinuationSweep()
    startWorkStreamContinuationSweep()
    expect(listPeriodicRunnerNames().filter((name) => name === 'work-stream-continuation')).toHaveLength(1)

    await stopWorkStreamContinuationSweep()
    expect(listPeriodicRunnerNames()).not.toContain('work-stream-continuation')
  })

  it('lets a newer direct completion reset a cycle pinned to an older stopped watchdog execution', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const firstStoppedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'stopped', firstStoppedAt)
    await reconcileWorkStreamContinuationsOnce({ now: firstStoppedAt })
    const firstPending = await readCycle()
    await reconcileWorkStreamContinuationsOnce({ now: firstPending.nextAttemptAt! })
    const delivered = await readCycle()
    expect(delivered).toMatchObject({ status: 'delivered', normalAttemptCount: 1, transportAttemptCount: 0 })

    const watchdogStoppedAt = new Date(firstPending.nextAttemptAt!.getTime() + 1_000)
    await settleAgentExecutions(agent, 'stopped', watchdogStoppedAt)
    const [directCompletion] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        endedAt: new Date(watchdogStoppedAt.getTime() + 1_000),
      })
      .returning()

    await reconcileWorkStreamContinuationsOnce({ now: directCompletion.endedAt! })

    expect(await readCycle()).toMatchObject({
      status: 'idle',
      normalAttemptCount: 1,
      transportAttemptCount: 0,
      triggerExecutionId: null,
    })
  })

  it('bounds repeated provider transport continuations at three attempts', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    let clock = Date.now() + 1_000
    const canonicalError = 'Provider transport failure: The socket connection was closed unexpectedly'
    const [initialFailure] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: canonicalError,
        endedAt: new Date(clock),
      })
      .returning()
    await attachTrustedWorkStreamMessage(initialFailure.id)

    for (let attempt = 1; attempt <= 3; attempt++) {
      await reconcileWorkStreamContinuationsOnce({ now: new Date(clock) })
      const pending = await readCycle()
      await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
      const delivered = await readCycle()
      expect(delivered.transportAttemptCount).toBe(attempt)
      clock = pending.nextAttemptAt!.getTime() + 1_000
      await db
        .update(executions)
        .set({ status: 'failed', error: canonicalError, endedAt: new Date(clock) })
        .where(eq(executions.id, delivered.deliveryExecutionId!))
      await db
        .update(executionAdmissionReservations)
        .set({ state: 'released', updatedAt: new Date(clock) })
        .where(eq(executionAdmissionReservations.agentId, agent.id))
    }

    await reconcileWorkStreamContinuationsOnce({ now: new Date(clock) })

    expect((await readCycle()).status).toBe('exhausted')
    expect(
      await db
        .select()
        .from(inbox)
        .where(sql`${inbox.idempotencyKey} like ${`work-stream-continuation:${workStream.id}:%`}`)
    ).toHaveLength(3)
    expect((await workStream.getOpenWaits()).some((wait) => wait.message?.includes('3 automatic continuation'))).toBe(
      true
    )
  })

  for (const legacyStatus of ['pending', 'delivered'] as const) {
    it(`adopts a legacy ${legacyStatus} normal continuation without consuming transport budget`, async () => {
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db
        .update(executionAdmissionReservations)
        .set({ state: 'released' })
        .where(eq(executionAdmissionReservations.agentId, agent.id))
      const triggerEndedAt = new Date(Date.now() + 1_000)
      const [trigger] = await db
        .insert(executions)
        .values({ agentId: agent.id, status: 'completed', endedAt: triggerEndedAt })
        .returning()
      const [legacyDelivery] =
        legacyStatus === 'delivered'
          ? await db
              .insert(executions)
              .values({
                agentId: agent.id,
                status: 'completed',
                endedAt: new Date(triggerEndedAt.getTime() + 1_000),
              })
              .returning()
          : [undefined]
      const legacyClientId = `work-stream-continuation:${workStream.id}:1:2`
      await db
        .update(workStreamContinuations)
        .set({
          status: legacyStatus,
          triggerExecutionId: trigger.id,
          normalAttemptCount: 0,
          transportAttemptCount: 2,
          deliveryAttemptCount: 0,
          clientId: legacyClientId,
          deliveryPrompt: `Continue working on work stream ${workStream.id}: ${workStream.title}.`,
          deliveryExecutionId: legacyDelivery?.id ?? null,
          nextAttemptAt: triggerEndedAt,
        })
        .where(eq(workStreamContinuations.workStreamId, workStream.id))

      await reconcileWorkStreamContinuationsOnce({ now: new Date(triggerEndedAt.getTime() + 1_000) })

      expect(await readCycle()).toMatchObject({
        status: 'delivered',
        normalAttemptCount: 1,
        transportAttemptCount: 0,
        clientId: legacyClientId,
      })
      expect(
        await db
          .select()
          .from(inbox)
          .where(sql`${inbox.idempotencyKey} like ${`work-stream-continuation:${workStream.id}:%`}`)
      ).toHaveLength(legacyStatus === 'pending' ? 1 : 0)
    })
  }

  async function seedPinnedNormalWithTransportDebt() {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const triggerEndedAt = new Date(Date.now() + 1_000)
    const [trigger] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', endedAt: triggerEndedAt })
      .returning()
    const deliveryEndedAt = new Date(triggerEndedAt.getTime() + 1_000)
    const [delivery] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', endedAt: deliveryEndedAt })
      .returning()
    await db
      .update(workStreamContinuations)
      .set({
        status: 'delivered',
        triggerExecutionId: trigger.id,
        normalAttemptCount: 1,
        transportAttemptCount: 1,
        clientId: `work-stream-continuation:${workStream.id}:1:normal:1:${trigger.id}`,
        deliveryExecutionId: delivery.id,
        lastDeliveredAt: triggerEndedAt,
      })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    return { deliveryEndedAt }
  }

  it('resets transport debt for a direct completion before a later trusted failure', async () => {
    const { deliveryEndedAt } = await seedPinnedNormalWithTransportDebt()
    const directStartedAt = new Date(deliveryEndedAt.getTime() + 1_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'completed',
      runStartedAt: directStartedAt,
      endedAt: new Date(directStartedAt.getTime() + 1_000),
    })
    const failureStartedAt = new Date(directStartedAt.getTime() + 3_000)
    const failureEndedAt = new Date(failureStartedAt.getTime() + 1_000)
    const [failure] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        runStartedAt: failureStartedAt,
        endedAt: failureEndedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failure.id)

    await reconcileWorkStreamContinuationsOnce({ now: failureEndedAt })

    const cycle = await readCycle()
    expect(cycle).toMatchObject({
      status: 'pending',
      normalAttemptCount: 1,
      transportAttemptCount: 0,
      triggerExecutionId: failure.id,
    })
    expect(cycle.clientId).toContain(':transport:1:')
  })

  it('consumes an exclusive equal-time progress high-water once', async () => {
    const { deliveryEndedAt } = await seedPinnedNormalWithTransportDebt()
    const completionEndedAt = new Date(deliveryEndedAt.getTime() + 2_000)
    const firstCompletionId = '00000000-0000-4000-8000-000000000001'
    const secondCompletionId = '00000000-0000-4000-8000-000000000002'
    await db.insert(executions).values({
      id: firstCompletionId,
      agentId: agent.id,
      status: 'completed',
      endedAt: completionEndedAt,
    })

    await reconcileWorkStreamContinuationsOnce({ now: completionEndedAt })
    expect(await readCycle()).toMatchObject({
      status: 'idle',
      transportAttemptCount: 0,
      cycleStartedAt: completionEndedAt,
      progressExecutionId: firstCompletionId,
    })

    await db.insert(executions).values({
      id: secondCompletionId,
      agentId: agent.id,
      status: 'completed',
      endedAt: completionEndedAt,
    })
    const secondSweepAt = new Date(completionEndedAt.getTime() + 30_000)
    await reconcileWorkStreamContinuationsOnce({ now: secondSweepAt })
    const settled = await readCycle()
    expect(settled.progressExecutionId).toBe(secondCompletionId)

    await reconcileWorkStreamContinuationsOnce({ now: new Date(secondSweepAt.getTime() + 30_000) })
    const repeated = await readCycle()
    expect(repeated.updatedAt).toEqual(settled.updatedAt)
    expect(repeated.progressExecutionId).toBe(secondCompletionId)
  })

  it('persists a direct-completion reset across a later nontransport failure', async () => {
    const { deliveryEndedAt } = await seedPinnedNormalWithTransportDebt()
    const directStartedAt = new Date(deliveryEndedAt.getTime() + 1_000)
    const directEndedAt = new Date(directStartedAt.getTime() + 1_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'completed',
      runStartedAt: directStartedAt,
      endedAt: directEndedAt,
    })
    const ignoredFailureEndedAt = new Date(directEndedAt.getTime() + 2_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      error: 'Application validation failed',
      runStartedAt: new Date(directEndedAt.getTime() + 1_000),
      endedAt: ignoredFailureEndedAt,
    })

    await reconcileWorkStreamContinuationsOnce({ now: ignoredFailureEndedAt })
    expect(await readCycle()).toMatchObject({ status: 'idle', normalAttemptCount: 1, transportAttemptCount: 0 })

    const trustedFailureEndedAt = new Date(ignoredFailureEndedAt.getTime() + 2_000)
    const [trustedFailure] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        runStartedAt: new Date(ignoredFailureEndedAt.getTime() + 1_000),
        endedAt: trustedFailureEndedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(trustedFailure.id)

    await reconcileWorkStreamContinuationsOnce({ now: trustedFailureEndedAt })
    const cycle = await readCycle()
    expect(cycle).toMatchObject({ status: 'pending', transportAttemptCount: 0, triggerExecutionId: trustedFailure.id })
    expect(cycle.clientId).toContain(':transport:1:')
  })

  it('persists a direct-completion reset across an untrusted canonical transport failure', async () => {
    const { deliveryEndedAt } = await seedPinnedNormalWithTransportDebt()
    const directStartedAt = new Date(deliveryEndedAt.getTime() + 1_000)
    const directEndedAt = new Date(directStartedAt.getTime() + 1_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'completed',
      runStartedAt: directStartedAt,
      endedAt: directEndedAt,
    })
    const ignoredFailureEndedAt = new Date(directEndedAt.getTime() + 2_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      error: 'Provider transport failure: The socket connection was closed unexpectedly',
      runStartedAt: new Date(directEndedAt.getTime() + 1_000),
      endedAt: ignoredFailureEndedAt,
    })

    await reconcileWorkStreamContinuationsOnce({ now: ignoredFailureEndedAt })
    expect(await readCycle()).toMatchObject({ status: 'idle', normalAttemptCount: 1, transportAttemptCount: 0 })

    const trustedFailureEndedAt = new Date(ignoredFailureEndedAt.getTime() + 2_000)
    const [trustedFailure] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        runStartedAt: new Date(ignoredFailureEndedAt.getTime() + 1_000),
        endedAt: trustedFailureEndedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(trustedFailure.id)

    await reconcileWorkStreamContinuationsOnce({ now: trustedFailureEndedAt })
    const cycle = await readCycle()
    expect(cycle).toMatchObject({ status: 'pending', transportAttemptCount: 0, triggerExecutionId: trustedFailure.id })
    expect(cycle.clientId).toContain(':transport:1:')
  })

  it('schedules transport attempt one after a normal delivery and later independent transport failure', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const triggerEndedAt = new Date(Date.now() + 1_000)
    await db.insert(executions).values({ agentId: agent.id, status: 'completed', endedAt: triggerEndedAt })
    await reconcileWorkStreamContinuationsOnce({ now: triggerEndedAt })
    await reconcileWorkStreamContinuationsOnce({ now: (await readCycle()).nextAttemptAt! })
    const normalDelivery = await readCycle()
    const normalEndedAt = new Date(normalDelivery.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: normalEndedAt })
      .where(eq(executions.id, normalDelivery.deliveryExecutionId!))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released', updatedAt: normalEndedAt })
      .where(eq(executionAdmissionReservations.agentId, agent.id))

    const failureStartedAt = new Date(normalEndedAt.getTime() + 1_000)
    const failureEndedAt = new Date(failureStartedAt.getTime() + 1_000)
    const [failure] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        runStartedAt: failureStartedAt,
        endedAt: failureEndedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(failure.id)

    await reconcileWorkStreamContinuationsOnce({ now: failureEndedAt })

    expect(await readCycle()).toMatchObject({
      status: 'pending',
      normalAttemptCount: 1,
      transportAttemptCount: 0,
      triggerExecutionId: failure.id,
    })
    expect((await readCycle()).clientId).toContain(':transport:1:')
  })

  it('keeps three trusted transport attempts after the one normal continuation', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    let endedAt = new Date(Date.now() + 1_000)
    const [completion] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', endedAt })
      .returning()
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    await reconcileWorkStreamContinuationsOnce({ now: (await readCycle()).nextAttemptAt! })
    let delivered = await readCycle()
    expect(delivered).toMatchObject({ normalAttemptCount: 1, transportAttemptCount: 0 })

    const canonicalError = 'Provider transport failure: The socket connection was closed unexpectedly'
    for (let attempt = 1; attempt <= 3; attempt++) {
      endedAt = new Date((delivered.nextAttemptAt ?? completion.endedAt!).getTime() + 1_000)
      await db
        .update(executions)
        .set({ status: 'failed', error: canonicalError, endedAt })
        .where(eq(executions.id, delivered.deliveryExecutionId!))
      await attachTrustedWorkStreamMessage(delivered.deliveryExecutionId!)
      await db
        .update(executionAdmissionReservations)
        .set({ state: 'released', updatedAt: endedAt })
        .where(eq(executionAdmissionReservations.agentId, agent.id))
      await reconcileWorkStreamContinuationsOnce({ now: endedAt })
      const pending = await readCycle()
      expect(pending.clientId).toContain(`:transport:${attempt}:`)
      await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
      delivered = await readCycle()
      expect(delivered).toMatchObject({ normalAttemptCount: 1, transportAttemptCount: attempt })
    }

    endedAt = new Date(delivered.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(executions)
      .set({ status: 'failed', error: canonicalError, endedAt })
      .where(eq(executions.id, delivered.deliveryExecutionId!))
    await attachTrustedWorkStreamMessage(delivered.deliveryExecutionId!)
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released', updatedAt: endedAt })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })

    expect(await readCycle()).toMatchObject({
      status: 'exhausted',
      normalAttemptCount: 1,
      transportAttemptCount: 3,
    })
    expect((await workStream.getOpenWaits())[0]?.message).toContain('trusted provider transport failures')
  })

  it('keeps the transport streak when its delivery ends normally before the normal continuation', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const canonicalError = 'Provider transport failure: The socket connection was closed unexpectedly'
    let endedAt = new Date(Date.now() + 1_000)
    const [failure] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'failed', error: canonicalError, endedAt })
      .returning()
    await attachTrustedWorkStreamMessage(failure.id)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    await reconcileWorkStreamContinuationsOnce({ now: (await readCycle()).nextAttemptAt! })
    let delivered = await readCycle()
    expect(delivered).toMatchObject({ normalAttemptCount: 0, transportAttemptCount: 1 })

    endedAt = new Date(delivered.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(executions)
      .set({ status: 'completed', error: null, endedAt })
      .where(eq(executions.id, delivered.deliveryExecutionId!))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released', updatedAt: endedAt })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    let pending = await readCycle()
    expect(pending.clientId).toContain(':normal:1:')
    await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
    delivered = await readCycle()
    expect(delivered).toMatchObject({ normalAttemptCount: 1, transportAttemptCount: 1 })

    endedAt = new Date(delivered.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(executions)
      .set({ status: 'failed', error: canonicalError, endedAt })
      .where(eq(executions.id, delivered.deliveryExecutionId!))
    await attachTrustedWorkStreamMessage(delivered.deliveryExecutionId!)
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released', updatedAt: endedAt })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    pending = await readCycle()
    expect(pending.clientId).toContain(':transport:2:')
    await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
    expect(await readCycle()).toMatchObject({ normalAttemptCount: 1, transportAttemptCount: 2 })
  })

  async function finishNormalContinuationForNotice() {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id, ownerAgentId: agent.id })
    const triggerEndedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', triggerEndedAt)
    await reconcileWorkStreamContinuationsOnce({ now: triggerEndedAt })
    const pending = await readCycle()
    await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
    const delivered = await readCycle()
    const endedAt = new Date(pending.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(executions)
      .set({ status: 'completed', endedAt })
      .where(eq(executions.id, delivered.deliveryExecutionId!))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released', updatedAt: endedAt })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    return { delivered, endedAt }
  }

  it("does not treat another stream's watchdog completion as direct progress", async () => {
    const { endedAt: deliveryEndedAt } = await finishNormalContinuationForNotice()
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 1 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const otherStream = await storedLegacyWorkStream({ squadId: squad.id, title: 'Other continuation stream' })
    await db
      .update(workStreams)
      .set({ status: 'active', assigneeAgentId: agent.id, agentIds: [agent.id] })
      .where(eq(workStreams.id, otherStream.id))
    const watchdogStartedAt = new Date(deliveryEndedAt.getTime() + 1_000)
    const watchdogEndedAt = new Date(watchdogStartedAt.getTime() + 1_000)
    const [watchdog] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        runStartedAt: watchdogStartedAt,
        endedAt: watchdogEndedAt,
      })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'human',
      content: 'Continue other stream',
      pending: false,
      metadata: {
        source: 'work-stream-continuation',
        workStreamId: otherStream.id,
        executionId: watchdog.id,
      },
    })

    expect(await listTrustedContinuationExecutionIds(db, [{ agentId: agent.id, executionId: watchdog.id }])).toEqual(
      new Set([watchdog.id])
    )
    await reconcileWorkStreamContinuationsOnce({ now: new Date(watchdogEndedAt.getTime() + 60_000) })

    expect(await readCycle()).toMatchObject({ status: 'idle', normalAttemptCount: 1, transportAttemptCount: 1 })
    expect(await persistentIdleNotices()).toHaveLength(1)
  })

  for (const exclusion of [
    'open wait',
    'reassignment',
    'inactive stream',
    'inactive squad',
    'terminating agent',
  ] as const) {
    it(`does not record a persistent idle notice after ${exclusion}`, async () => {
      const { endedAt } = await finishNormalContinuationForNotice()
      if (exclusion === 'open wait') await workStream.block({ message: 'Intentional wait' })
      if (exclusion === 'reassignment') {
        const replacement = await createExtraAgent()
        await workStream.update({ assigneeAgentId: replacement.id })
      }
      if (exclusion === 'inactive stream') await workStream.update({ status: 'queued' })
      if (exclusion === 'inactive squad') {
        await db.update(squads).set({ status: 'paused' }).where(eq(squads.id, squad.id))
      }
      if (exclusion === 'terminating agent') {
        await db.update(agents).set({ pendingDormancyAt: new Date() }).where(eq(agents.id, agent.id))
      }

      await reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + 60_000) })
      expect(await persistentIdleNotices()).toHaveLength(0)
    })
  }

  /**
   * The sweep's own `now` used to come from the app host, while everything it compares against —
   * `executions.ended_at` here — is stamped by the database. It now reads the database's clock, so
   * the idle decision sits on the same timeline as the rows it is reading. Driving that read is
   * what makes this observable: the notice is due only on the clock the sweep asks for.
   */
  it('decides the idle notice on the database clock it reads, not the host one', async () => {
    const { endedAt } = await finishNormalContinuationForNotice()
    const dueOnDatabaseClock = new Date(endedAt.getTime() + 60_000)
    const clockSpy = spyOn(clockModule, 'readDatabaseClock').mockResolvedValue(dueOnDatabaseClock)
    try {
      // No `now` argument: the sweep must source one, and it must source it from the database.
      await reconcileWorkStreamContinuationsOnce()
      expect(clockSpy).toHaveBeenCalled()
    } finally {
      clockSpy.mockRestore()
    }

    expect(await persistentIdleNotices()).toHaveLength(1)
  })

  it('does not record a persistent idle notice when later work started and completed', async () => {
    const { endedAt } = await finishNormalContinuationForNotice()
    const laterStartedAt = new Date(endedAt.getTime() + 1_000)
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'completed',
      runStartedAt: laterStartedAt,
      endedAt: new Date(laterStartedAt.getTime() + 1_000),
    })

    await reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + 60_000) })
    expect(await persistentIdleNotices()).toHaveLength(0)
  })

  it('rechecks a concurrently started execution at the idle notice boundary', async () => {
    const { endedAt } = await finishNormalContinuationForNotice()
    let started: Execution | undefined
    await reconcileWorkStreamContinuationsOnce({
      now: new Date(endedAt.getTime() + 60_000),
      testHooks: {
        beforeIdleNoticeCheck: async () => {
          started = await agent.queueExecution({ message: 'Concurrent work' })
          await started.start()
        },
      },
    })

    expect(started?.status).toBe('running')
    expect(await persistentIdleNotices()).toHaveLength(0)
  })

  it('does not report a normally completed transport retry as persistent normal idle', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id, ownerAgentId: agent.id })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released' })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const triggerEndedAt = new Date(Date.now() + 1_000)
    const [transportTrigger] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'failed',
        error: 'Provider transport failure: The socket connection was closed unexpectedly',
        endedAt: triggerEndedAt,
      })
      .returning()
    await attachTrustedWorkStreamMessage(transportTrigger.id)
    const deliveryEndedAt = new Date(triggerEndedAt.getTime() + 1_000)
    const [transportDelivery] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', endedAt: deliveryEndedAt })
      .returning()
    await db
      .update(workStreamContinuations)
      .set({
        status: 'delivered',
        triggerExecutionId: transportTrigger.id,
        normalAttemptCount: 1,
        transportAttemptCount: 1,
        clientId: `work-stream-continuation:${workStream.id}:1:transport:1:${transportTrigger.id}`,
        deliveryExecutionId: transportDelivery.id,
        lastDeliveredAt: triggerEndedAt,
      })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))

    await reconcileWorkStreamContinuationsOnce({ now: new Date(deliveryEndedAt.getTime() + 60_000) })

    expect(await persistentIdleNotices()).toHaveLength(0)
  })

  it('persists idle notice and releases execution start with a one-connection transaction', async () => {
    const { delivered, endedAt } = await finishNormalContinuationForNotice()
    const client = createPostgresConnection(getConnectionString(), { max: 1, idle_timeout: 0 })
    const singleConnectionDb = drizzle(client, { schema })
    let executionStart: Promise<boolean> | undefined
    try {
      const reported = reportPersistentIdleIfCurrent({
        workStreamId: workStream.id,
        assigneeAgentId: agent.id,
        generation: delivered.generation,
        clientId: delivered.clientId!,
        triggerExecutionId: delivered.triggerExecutionId!,
        deliveryExecutionId: delivered.deliveryExecutionId!,
        endedAt,
        now: new Date(endedAt.getTime() + 60_000),
        executor: singleConnectionDb,
        afterAgentLock: () => {
          executionStart = (async () => {
            const [queued] = await db.insert(executions).values({ agentId: agent.id, status: 'queued' }).returning()
            return new Execution(queued).setAgent(agent).start()
          })()
        },
      })
      expect(
        await Promise.race([
          reported,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('single-connection notice timed out')), 3_000)
          ),
        ])
      ).toBe(true)
      expect(await executionStart).toBe(true)
      const [notice] = await persistentIdleNotices()
      expect(notice.deliveredAt).toBeNull()
      expect((await InboxMessage.listForRecipient('agent', agent.id)).map((message) => message.id)).toContain(notice.id)
    } finally {
      await client.end({ timeout: 5 })
    }
  })

  it('isolates a persistent idle notice failure and retries the observation', async () => {
    const { endedAt } = await finishNormalContinuationForNotice()
    const noticeSpy = spyOn(
      workStreamNotifications,
      'persistWorkStreamPersistentIdleInTransaction'
    ).mockRejectedValueOnce(new Error('temporary inbox outage'))
    try {
      await expect(
        reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + 60_000) })
      ).resolves.toBeUndefined()
      expect(await persistentIdleNotices()).toHaveLength(0)
      expect(await readCycle()).toMatchObject({ status: 'delivered', normalAttemptCount: 1 })
    } finally {
      noticeSpy.mockRestore()
    }

    await reconcileWorkStreamContinuationsOnce({ now: new Date(endedAt.getTime() + 60_000) })
    expect(await persistentIdleNotices()).toHaveLength(1)
    expect(await readCycle()).toMatchObject({ status: 'idle', normalAttemptCount: 1 })
  })

  it('records one owner notice after 60 seconds of persistent idle without waking the assignee', async () => {
    await workStream.update({
      status: 'active',
      assigneeAgentId: agent.id,
      ownerAgentId: agent.id,
      agentIds: [agent.id],
    })
    const endedAt = new Date(Date.now() + 1_000)
    await settleAgentExecutions(agent, 'completed', endedAt)
    await reconcileWorkStreamContinuationsOnce({ now: endedAt })
    const pending = await readCycle()
    await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
    const delivered = await readCycle()
    const normalEndedAt = new Date(pending.nextAttemptAt!.getTime() + 1_000)
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: normalEndedAt })
      .where(eq(executions.id, delivered.deliveryExecutionId!))
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'released', updatedAt: normalEndedAt })
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    const executionCount = (await db.select().from(executions).where(eq(executions.agentId, agent.id))).length

    await reconcileWorkStreamContinuationsOnce({ now: new Date(normalEndedAt.getTime() + 59_999) })
    expect(await persistentIdleNotices()).toHaveLength(0)
    await reconcileWorkStreamContinuationsOnce({ now: new Date(normalEndedAt.getTime() + 60_000) })
    await reconcileWorkStreamContinuationsOnce({ now: new Date(normalEndedAt.getTime() + 90_000) })

    const notices = await persistentIdleNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ recipientId: agent.id, deliveredAt: null })
    expect(notices[0]?.metadata).toMatchObject({
      generation: delivered.generation,
      normalExecutionId: delivered.deliveryExecutionId,
      normalExecutionEndedAt: normalEndedAt.toISOString(),
    })
    expect(await workStream.getOpenWaits()).toHaveLength(0)
    await workStream.reload()
    expect(workStream.status).toBe('active')
    expect((await db.select().from(executions).where(eq(executions.agentId, agent.id))).length).toBe(executionCount)
  })

  for (const status of ['completed', 'stopped'] as const) {
    it(`limits ${status} evidence to one normal continuation without opening a wait`, async () => {
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db
        .update(executionAdmissionReservations)
        .set({ state: 'released' })
        .where(eq(executionAdmissionReservations.agentId, agent.id))
      const endedAt = new Date(Date.now() + 1_000)
      const [terminal] = await db.insert(executions).values({ agentId: agent.id, status, endedAt }).returning()

      await reconcileWorkStreamContinuationsOnce({ now: endedAt })
      const pending = await readCycle()
      expect(pending).toMatchObject({
        status: 'pending',
        normalAttemptCount: 0,
        transportAttemptCount: 0,
        triggerExecutionId: terminal.id,
      })
      await reconcileWorkStreamContinuationsOnce({ now: pending.nextAttemptAt! })
      const delivered = await readCycle()
      expect(delivered).toMatchObject({
        status: 'delivered',
        normalAttemptCount: 1,
        transportAttemptCount: 0,
        triggerExecutionId: terminal.id,
      })

      const watchdogEndedAt = new Date(pending.nextAttemptAt!.getTime() + 1_000)
      await db
        .update(executions)
        .set({ status, endedAt: watchdogEndedAt })
        .where(eq(executions.id, delivered.deliveryExecutionId!))
      await db
        .update(executionAdmissionReservations)
        .set({ state: 'released', updatedAt: watchdogEndedAt })
        .where(eq(executionAdmissionReservations.agentId, agent.id))
      await reconcileWorkStreamContinuationsOnce({ now: watchdogEndedAt })

      expect(
        await db
          .select()
          .from(inbox)
          .where(sql`${inbox.idempotencyKey} like ${`work-stream-continuation:${workStream.id}:%`}`)
      ).toHaveLength(1)
      expect(await workStream.getOpenWaits()).toHaveLength(0)
      await workStream.reload()
      expect(workStream.status).toBe('active')
      expect(await readCycle()).toMatchObject({ normalAttemptCount: 1, transportAttemptCount: 0 })
    })
  }

  it('an execution start immediately clears only its current assignee watchdog wait', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await settleAgentExecutions(agent, 'stopped', new Date())
    await db
      .update(workStreamContinuations)
      .set({ normalAttemptCount: 1, transportAttemptCount: 3 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const generationBeforeStart = (await readCycle()).generation
    const unrelated = await workStream.block({ message: 'Unrelated operator decision' })
    expect(
      await blockCurrentContinuation(
        workStream.id,
        (await readCycle()).generation,
        agent.id,
        'The assigned agent became idle after 3 automatic continuation attempts. Observation window: test.',
        (cycle) => cycle.transportAttemptCount === 3
      )
    ).toBe(true)
    // Worker startup registers this backstop before its first queued-execution
    // pickup; the periodic sweep starts later and must not be required here.
    registerWorkStreamContinuationEventHandlers()
    expect(listPeriodicRunnerNames()).not.toContain('work-stream-continuation')
    const assigneeInboxBeforeClear = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    const respondedEvents: string[] = []
    const updatedEvents: string[] = []
    const stopResponded = eventEmitter.on('workStream.responded', ({ workStreamId }) =>
      respondedEvents.push(workStreamId)
    )
    const stopUpdated = eventEmitter.on('workStream.updated', ({ workStreamId }) => updatedEvents.push(workStreamId))
    const execution = await agent.queueExecution({ message: 'Resume after watchdog escalation' })
    // queued-at is not the execution-start fact: prove the handler uses the
    // queued -> running transition timestamp even for an older queued row.
    await db
      .update(executions)
      .set({ startedAt: new Date(0) })
      .where(eq(executions.id, execution.id))
    try {
      expect(await execution.start()).toBe(true)
      await waitFor(async () => !(await workStream.getOpenWaits()).some((wait) => wait.id !== unrelated.id))
    } finally {
      stopResponded()
      stopUpdated()
    }

    expect(await resolveContinuationWaitOnExecutionStarted(execution.id, agent.id)).toBe(false)
    const open = await workStream.getOpenWaits()
    expect(open.map((wait) => wait.id)).toEqual([unrelated.id])
    expect(updatedEvents).toContain(workStream.id)
    expect(respondedEvents).not.toContain(workStream.id)
    const assigneeInboxAfterClear = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(assigneeInboxAfterClear).toEqual(assigneeInboxBeforeClear)
    expect(await readCycle()).toMatchObject({
      status: 'idle',
      generation: generationBeforeStart + 1,
      normalAttemptCount: 0,
      transportAttemptCount: 0,
      deliveryAttemptCount: 0,
    })
  })

  it('is idempotent when targeted operator closure wins the execution-start resolution race', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    await settleAgentExecutions(agent, 'stopped', new Date())
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const unrelated = await workStream.block({ message: 'Unrelated operator decision' })
    await blockCurrentContinuation(
      workStream.id,
      (await readCycle()).generation,
      agent.id,
      'The assigned agent became idle after 3 automatic continuation attempts. Observation window: test.',
      (cycle) => cycle.transportAttemptCount === 3
    )
    const watchdog = (await workStream.getOpenWaits()).find((wait) => wait.id !== unrelated.id)!
    const execution = await agent.queueExecution({ message: 'Concurrent close' })
    await execution.start()
    let releaseCandidate!: () => void
    const candidateReleased = new Promise<void>((resolve) => (releaseCandidate = resolve))
    let candidateObserved!: () => void
    const candidateReached = new Promise<void>((resolve) => (candidateObserved = resolve))
    const eventResolution = resolveContinuationWaitOnExecutionStarted(execution.id, agent.id, {
      beforeCandidateLock: async () => {
        candidateObserved()
        await candidateReleased
      },
    })
    await candidateReached

    await workStream.resolveWait(watchdog.id, { resolution: 'cleared' })
    releaseCandidate()

    expect(await eventResolution).toBe(false)
    expect((await workStream.getOpenWaits()).map((wait) => wait.id)).toEqual([unrelated.id])
    expect(await readCycle()).toMatchObject({ status: 'idle', transportAttemptCount: 0, generation: 2 })
  })

  it('does not create or clear a watchdog wait across execution-start and assignee races', async () => {
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    const staleTrigger = await settleAgentExecutions(agent, 'stopped', new Date())
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3 })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const cycle = await readCycle()
    const alreadyRunning = await agent.queueExecution({ message: 'Started after stale terminal observation' })
    await alreadyRunning.start()
    await alreadyRunning.transitionTo({ kind: 'completed' })
    // This case tests event ordering, not clock synchronization: start uses the
    // database clock and completion uses the host clock. Give the settled run
    // an explicit timeline after the stale trigger so either clock can lead.
    const runStartedAt = new Date(staleTrigger.endedAt!.getTime() + 1)
    await db
      .update(executions)
      .set({ runStartedAt, endedAt: new Date(runStartedAt.getTime() + 1) })
      .where(eq(executions.id, alreadyRunning.id))
    expect(
      await blockCurrentContinuation(
        workStream.id,
        cycle.generation,
        agent.id,
        'The assigned agent became idle after 3 automatic continuation attempts. Observation window: test.',
        (current) => current.transportAttemptCount === 3,
        staleTrigger.id
      )
    ).toBe(false)
    expect(await workStream.getOpenWaits()).toHaveLength(0)
    // This observation cycle starts after the completed run above. Derive the
    // boundary from that durable completion, not same-millisecond host timing.
    const [completed] = await db.select().from(executions).where(eq(executions.id, alreadyRunning.id))
    const cycleStartedAt = new Date(completed.endedAt!.getTime() + 1)
    await db
      .update(workStreamContinuations)
      .set({ transportAttemptCount: 3, cycleStartedAt })
      .where(eq(workStreamContinuations.workStreamId, workStream.id))
    const currentCycle = await readCycle()

    const [currentTrigger] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'stopped', endedAt: new Date(cycleStartedAt.getTime() + 1) })
      .returning()
    expect(
      await blockCurrentContinuation(
        workStream.id,
        currentCycle.generation,
        agent.id,
        'The assigned agent became idle after 3 automatic continuation attempts. Observation window: test.',
        (current) => current.transportAttemptCount === 3,
        currentTrigger.id,
        new Date(currentTrigger.endedAt!.getTime() + 1)
      )
    ).toBe(true)
    const replacement = await createExtraAgent()
    await db.update(workStreams).set({ assigneeAgentId: replacement.id }).where(eq(workStreams.id, workStream.id))

    expect(await resolveContinuationWaitOnExecutionStarted(alreadyRunning.id, agent.id)).toBe(false)
    expect((await workStream.getOpenWaits()).some((wait) => wait.message?.includes('Observation window'))).toBe(true)
  })
  it('keeps the pre-schedule sweep query count flat as active streams multiply', async () => {
    // The sweep used to issue 4-5 statements PER ACTIVE STREAM every 30s
    // (assignee+squad, active-execution probe, continuation cycle, latest
    // settled execution). This measures the marginal cost of four extra
    // eligible streams; with the per-stream lookups it is ~16 statements.
    await workStream.update({ status: 'active', assigneeAgentId: agent.id })
    // Build all fixtures before choosing the terminal timestamp. Under load,
    // creating four agents can exceed the old 1s offset; an execution ending
    // before its assignment is correctly ineligible, not a query-count failure.
    const extraStreams: WorkStream[] = []
    const fanoutAgents: Agent[] = []
    for (let index = 0; index < 4; index += 1) {
      const extraAgent = await createExtraAgent()
      fanoutAgents.push(extraAgent)
      const extraStream = await storedLegacyWorkStream({ squadId: squad.id, title: `Continuation fanout ${index}` })
      extraStreams.push(extraStream)
      await extraStream.update({ status: 'active', assigneeAgentId: extraAgent.id })
      await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, extraStream.id))
    }
    const endedAt = new Date(Date.now() + 1_000)
    for (const fixtureAgent of [agent, ...fanoutAgents]) await settleAgentExecutions(fixtureAgent, 'completed', endedAt)

    const selectSpy = spyOn(db, 'select')
    const distinctSpy = spyOn(db, 'selectDistinct')
    const distinctOnSpy = spyOn(db, 'selectDistinctOn')
    const readQueryCount = () =>
      selectSpy.mock.calls.length + distinctSpy.mock.calls.length + distinctOnSpy.mock.calls.length
    try {
      const measure = async () => {
        selectSpy.mockClear()
        distinctSpy.mockClear()
        distinctOnSpy.mockClear()
        await reconcileWorkStreamContinuationsOnce({ now: endedAt })
        return readQueryCount()
      }

      // Warm first. The FIRST sweep CREATES the continuation cycles, and a
      // sweep over freshly-created cycles skips the pinned-execution,
      // trigger-execution and settled-evidence lookups that a sweep over
      // existing cycles performs. Measuring the first sweep against the second
      // therefore compared two different code paths, not one stream against
      // five — which is why the delta moved under timing and tripped a bound
      // that is correct (entry 6; the bound is NOT widened).
      await reconcileWorkStreamContinuationsOnce({ now: endedAt })
      // The warm-up is load-bearing, so prove it happened rather than trusting
      // the line above to survive editing: after it, the baseline stream must
      // ALREADY have its cycle, which is what puts the measured sweeps on the
      // same branch. Deleting the warm-up fails here, deterministically,
      // instead of only showing up as a delta that drifts under CI load.
      const [warmed] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, workStream.id))
      expect(warmed?.status).toBe('pending')

      const withOneStream = await measure()

      await db
        .update(workStreams)
        .set({ status: 'active' })
        .where(
          inArray(
            workStreams.id,
            extraStreams.map((stream) => stream.id)
          )
        )

      const withFiveStreams = await measure()

      // Sanity: the extra streams really are eligible, so the sweep did the
      // work whose cost is being measured rather than skipping them.
      for (const extraStream of extraStreams) {
        const [cycle] = await db
          .select()
          .from(workStreamContinuations)
          .where(eq(workStreamContinuations.workStreamId, extraStream.id))
        expect(cycle?.status).toBe('pending')
      }
      expect(withFiveStreams - withOneStream).toBeLessThanOrEqual(2)
    } finally {
      selectSpy.mockRestore()
      distinctSpy.mockRestore()
      distinctOnSpy.mockRestore()
      for (const extraStream of extraStreams) await extraStream.delete()
    }
  })
})
