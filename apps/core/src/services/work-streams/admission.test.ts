import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { eq, inArray, like, sql } from 'drizzle-orm'
import type postgres from 'postgres'
import { WORK_STREAM_ADMITTED_STATUSES } from '@ficus/shared'
import { db } from '../../db'
import { createPostgresConnection, getConnectionString } from '../../db/connection'
import { agentTypes, agents, executions, inbox, squads, workStreams, workStreamContinuations } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { AgentType } from '../../entities/AgentType'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { getSandboxManager } from '../sandbox'
import {
  WorkStreamBusyError,
  WorkStreamNotParkableError,
  parkWorkStream,
  promoteEligibleQueuedStreams,
  runAdmissionReconcilerOnce,
  setDemotionLockObserverForTest,
  setDemotionLockStepObserverForTest,
  stopSandboxesForDemotedStream,
} from './admission'

const lockProbeConnection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await lockProbeConnection.end()
})

describe('work-stream admission', () => {
  let testPrefix: string
  let squad: Squad
  let testAgentTypeId: string
  const createdAgentIds: string[] = []

  beforeEach(async () => {
    testPrefix = `wsadm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Admission Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    squad = await Squad.create({ name: `${testPrefix} Squad`, purpose: 'admission tests' })
  })

  afterEach(async () => {
    if (createdAgentIds.length > 0) {
      await db.delete(inbox).where(inArray(inbox.recipientId, createdAgentIds))
      await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
      createdAgentIds.length = 0
    }
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(like(agentTypes.id, `${testPrefix}%`))
  })

  async function createStream(
    title: string,
    overrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}
  ): Promise<WorkStream> {
    return storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} ${title}`, ...overrides })
  }

  async function admittedCount(): Promise<number> {
    const statuses = await db
      .select({ status: workStreams.status })
      .from(workStreams)
      .where(eq(workStreams.squadId, squad.id))
    return statuses.filter((r) => (WORK_STREAM_ADMITTED_STATUSES as string[]).includes(r.status)).length
  }

  describe('cap null (invariant 6: byte-identical activation)', () => {
    it('admits stored streams without a cap and notifies on a later assignment', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)

      const assignedEvents: string[] = []
      const unsubscribe = eventEmitter.on('workStream.assigned', ({ workStreamId }) =>
        assignedEvents.push(workStreamId)
      )
      try {
        const streams = await Promise.all(
          Array.from({ length: 5 }, (_, i) => createStream(`nolimit-${i}`, i === 0 ? { agentIds: [agent.id] } : {}))
        )
        for (const ws of streams) expect(ws.status).toBe('active')
        await streams[0]!.update({ assigneeAgentId: agent.id })
        expect(assignedEvents).toContain(streams[0].id)
      } finally {
        unsubscribe()
      }
    })
  })

  describe('creation under a finite cap', () => {
    it('queues creations beyond the cap and suppresses their assignment events', async () => {
      await squad.update({ maxConcurrentWorkStreams: 2 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)

      const assignedEvents: string[] = []
      const unsubscribe = eventEmitter.on('workStream.assigned', ({ workStreamId }) =>
        assignedEvents.push(workStreamId)
      )
      let third: WorkStream
      try {
        await createStream('first')
        await createStream('second')
        third = await createStream('third', { assigneeAgentId: agent.id, agentIds: [agent.id] })
      } finally {
        unsubscribe()
      }

      expect(third.status).toBe('queued')
      // Crew stays bound and addressable — only the slot is withheld.
      expect(third.assigneeAgentId).toBe(agent.id)
      expect(assignedEvents).not.toContain(third.id)
      expect(await admittedCount()).toBe(2)
    })
  })

  describe('promotion (invariant 4: both triggers, priority-then-created order)', () => {
    it('admits the highest effective priority first on slot release, ties by createdAt', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await createStream('holder')
      const lowOld = await createStream('low-old', { priority: 'low' })
      const lowNew = await createStream('low-new', { priority: 'low' })
      const high = await createStream('high', { priority: 'high' })
      for (const ws of [lowOld, lowNew, high]) expect(ws.status).toBe('queued')
      // Force distinct createdAt so FIFO-tie assertions never depend on insert timing.
      await db
        .update(workStreams)
        .set({ createdAt: new Date(Date.now() - 3000) })
        .where(eq(workStreams.id, lowOld.id))
      await db
        .update(workStreams)
        .set({ createdAt: new Date(Date.now() - 2000) })
        .where(eq(workStreams.id, lowNew.id))
      await db
        .update(workStreams)
        .set({ createdAt: new Date(Date.now() - 1000) })
        .where(eq(workStreams.id, high.id))

      // Slot release trigger: holder completes -> exactly one admission, the high one.
      await holder.update({ status: 'done' })
      // The done-event handler may not be registered in tests; call the controller directly.
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(high.id)).status).toBe('active')
      expect((await WorkStream.mustFind(lowOld.id)).status).toBe('queued')
      expect((await WorkStream.mustFind(lowNew.id)).status).toBe('queued')

      // Tie-break: the two lows are equal priority -> the OLDER one wins next.
      await WorkStream.update(high.id, { status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(lowOld.id)).status).toBe('active')
      expect((await WorkStream.mustFind(lowNew.id)).status).toBe('queued')
    })

    it('admits on dependency resolution and never admits with unmet or canceled deps', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const dep = await createStream('dep')
      const blockedByDep = await createStream('needs-dep', { dependsOn: [dep.id] })
      expect(blockedByDep.status).toBe('queued')

      // No free slot and unmet dep: stays queued.
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(blockedByDep.id)).status).toBe('queued')

      // Dependency resolves (which also frees the slot) -> admitted.
      await dep.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(blockedByDep.id)).status).toBe('active')
      await WorkStream.update(blockedByDep.id, { status: 'done' })

      // Canceled dependency: the slot is FREE, but the orphan stays ineligible
      // (never silently admitted) and is flagged; the eligible filler is
      // admitted around it.
      const dep2 = await createStream('dep2')
      const orphan = await createStream('needs-dep2', { dependsOn: [dep2.id] })
      const filler = await createStream('filler')
      expect(orphan.status).toBe('queued')
      expect(filler.status).toBe('queued')
      await dep2.cancel()
      await promoteEligibleQueuedStreams(squad.id)
      const orphanAfter = await WorkStream.mustFind(orphan.id)
      expect(orphanAfter.status).toBe('queued')
      const admission = orphanAfter.metadata.admission as Record<string, unknown> | undefined
      expect(typeof admission?.canceledDependencyNotifiedAt).toBe('string')
      expect((await WorkStream.mustFind(filler.id)).status).toBe('active')
    })

    it('effective priority (blocker boost) orders the queue, not stored priority alone', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await createStream('holder')
      const lowBlocker = await createStream('low-blocker', { priority: 'low' })
      const normalStream = await createStream('normal', { priority: 'normal' })
      expect(lowBlocker.status).toBe('queued')
      expect(normalStream.status).toBe('queued')
      // A critical stream depends on the low blocker -> the blocker schedules as critical.
      const criticalDependent = await createStream('critical-dependent', {
        priority: 'critical',
        dependsOn: [lowBlocker.id],
      })
      expect(criticalDependent.status).toBe('queued')

      await holder.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(lowBlocker.id)).status).toBe('active')
      expect((await WorkStream.mustFind(normalStream.id)).status).toBe('queued')
    })

    it('the reconciler is a working backstop', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await createStream('holder')
      const waiting = await createStream('waiting')
      expect(waiting.status).toBe('queued')
      // Simulate a missed promotion event: complete the holder with raw SQL (no events).
      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, holder.id))
      await runAdmissionReconcilerOnce()
      expect((await WorkStream.mustFind(waiting.id)).status).toBe('active')
    })
  })

  describe('creation-time admissibility', () => {
    // ── Creation-time admissibility ────────────────────────────────────
    //
    // Creation used to consult ONLY the concurrency cap, so a stream created
    // with an unfinished dependency was admitted on the spot: it displayed as
    // "waiting on dependency" while holding a slot, and WorkStream.create's
    // `status !== 'queued'` guard let the assignment notification through — so
    // the assignee was told the work had been handed to it and started
    // immediately on work that was supposed to be gated.

    it('queues a stream created with an unmet dependency even when slots are free', async () => {
      await squad.update({ maxConcurrentWorkStreams: 10 })
      const dep = await createStream('cap-free-dep')
      const dependent = await createStream('cap-free-dependent', { dependsOn: [dep.id] })

      expect(dependent.status).toBe('queued')
      expect((await WorkStream.mustFind(dependent.id)).status).toBe('queued')
    })

    it('queues a dependency-blocked stream under an UNLIMITED cap too', async () => {
      // The old early return (`cap === null` -> 'admitted') skipped every
      // check, so an unlimited squad was where this was worst.
      await squad.update({ maxConcurrentWorkStreams: null })
      const dep = await createStream('unlimited-dep')
      const dependent = await createStream('unlimited-dependent', { dependsOn: [dep.id] })

      expect(dependent.status).toBe('queued')
    })

    it('does not hand a dependency-blocked stream to its assignee on creation', async () => {
      await squad.update({ maxConcurrentWorkStreams: null })
      const worker = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(worker.id)
      const dep = await createStream('notify-dep')
      const dependent = await createStream('notify-dependent', {
        dependsOn: [dep.id],
        assigneeAgentId: worker.id,
        agentIds: [worker.id],
      })

      expect(dependent.status).toBe('queued')
      // The bug: a "handed off to you" message here is what made the agent
      // start working on a stream that was supposed to be gated.
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, worker.id))).toHaveLength(0)
      expect(await worker.getActiveExecution()).toBeNull()

      // Once the dependency completes, the deferred notification is delivered
      // by the promotion path and the agent starts for real.
      await dep.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(dependent.id)).status).toBe('active')
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, worker.id))).toHaveLength(1)
    })

    it('still admits a stream whose dependencies are ALREADY done', async () => {
      // syncDependencyWaits opens a wait only for a dependency that is not
      // done, so a satisfied edge must not queue anything.
      await squad.update({ maxConcurrentWorkStreams: null })
      const dep = await createStream('satisfied-dep')
      await dep.update({ status: 'done' })
      const dependent = await createStream('satisfied-dependent', { dependsOn: [dep.id] })

      expect((WORK_STREAM_ADMITTED_STATUSES as string[]).includes(dependent.status)).toBe(true)
    })
  })

  describe('parking', () => {
    it('parks an admitted stream, keeps prompts/assignee, and admits the next queued stream', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)

      const active = await createStream('active', { assigneeAgentId: agent.id, agentIds: [agent.id] })
      await active.update({ status: 'active' })
      // Higher effective priority than the parked stream, so it wins the freed
      // slot (equal priorities would tie-break on created_at, where the parked
      // stream is older — spec: no express lane, but also no demotion penalty).
      const waiting = await createStream('waiting', { priority: 'high' })
      expect(waiting.status).toBe('queued')

      const removed: string[] = []
      const { stream: parked, reAdmitted } = await parkWorkStream(active.id, {
        preemptRunning: true,
        removeSandbox: async (sandboxId) => {
          removed.push(sandboxId)
        },
      })
      expect(parked.status).toBe('queued')
      expect(reAdmitted).toBe(false)
      expect(parked.assigneeAgentId).toBe(agent.id)
      // Continuation is invalidated when parking an active stream (same
      // reset update() applies when a stream leaves active).
      const [continuation] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, active.id))
      expect(continuation?.status).toBe('idle')
      expect(continuation?.nextAttemptAt).toBeNull()
      expect(continuation?.claimedAt).toBeNull()
      // The crew's personal box was gracefully stopped (no terminate, no archive).
      expect(removed).toEqual([`agent_${agent.id}`])
      expect((await Agent.find(agent.id))?.terminatedAt ?? null).toBeNull()
      // The freed slot admitted the higher-priority waiting stream; the parked
      // one re-enters the queue at its own effective priority.
      expect((await WorkStream.mustFind(waiting.id)).status).toBe('active')
      expect((await WorkStream.mustFind(active.id)).status).toBe('queued')
    })

    it('flags a park that immediately wins its own slot back (disruptive no-op)', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const only = await createStream('only')
      const { stream, reAdmitted } = await parkWorkStream(only.id, { removeSandbox: async () => {} })
      expect(reAdmitted).toBe(true)
      expect(stream.status).toBe('active')
    })

    it('parking a stream with a running execution throws WorkStreamBusyError', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('running-member', { agentIds: [agent.id] })
      await db.insert(executions).values({ agentId: agent.id, status: 'running' })
      const removed: string[] = []

      // Mutation: removing the live-execution check must park the stream and fail these outcome assertions.
      await expect(
        parkWorkStream(active.id, {
          removeSandbox: async (sandboxId) => {
            removed.push(sandboxId)
          },
        })
      ).rejects.toBeInstanceOf(WorkStreamBusyError)
      expect((await WorkStream.mustFind(active.id)).status).toBe('active')
      expect(removed).toEqual([])
    })

    it('the refusal names the executing agent', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('named-running-agent', { agentIds: [agent.id] })
      await db.insert(executions).values({ agentId: agent.id, status: 'running' })
      const removed: string[] = []

      let error: unknown
      try {
        await parkWorkStream(active.id, {
          removeSandbox: async (sandboxId) => {
            removed.push(sandboxId)
          },
        })
      } catch (caught) {
        error = caught
      }

      // Mutation: replacing the busy message with generic text must fail the identity assertions.
      expect(error).toBeInstanceOf(WorkStreamBusyError)
      const busy = error as WorkStreamBusyError
      expect(busy.agentId).toBe(agent.id)
      expect(busy.workStreamId).toBe(active.id)
      expect(busy.workStreamTitle).toBe(active.title)
      expect(busy.message).toContain(agent.id)
      expect(busy.message).toContain('may belong to this or another work stream')
      expect(busy.executionStatus).toBe('running')
      expect((await WorkStream.mustFind(active.id)).status).toBe('active')
      expect(removed).toEqual([])
    })

    it('selects assignee, running status, then most recent execution for diagnostics', async () => {
      const assignee = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const member = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(assignee.id, member.id)
      const active = await createStream('diagnostic-order', {
        assigneeAgentId: assignee.id,
        agentIds: [member.id, assignee.id],
      })
      const base = Date.now() - 10_000
      await db.insert(executions).values([
        { agentId: member.id, status: 'running', startedAt: new Date(base + 9000) },
        { agentId: assignee.id, status: 'stopping', startedAt: new Date(base + 8000) },
        { agentId: assignee.id, status: 'running', startedAt: new Date(base + 1000) },
      ])
      const [expected] = await db
        .insert(executions)
        .values({ agentId: assignee.id, status: 'running', startedAt: new Date(base + 2000) })
        .returning({ id: executions.id })

      let error: unknown
      try {
        await parkWorkStream(active.id)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(WorkStreamBusyError)
      expect((error as WorkStreamBusyError).agentId).toBe(assignee.id)
      expect((error as WorkStreamBusyError).executionStatus).toBe('running')
      expect((error as WorkStreamBusyError).executionId).toBe(expected.id)
    })

    it('the refusal states the stop-first procedure and the --preempt-running escape', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('stop-first', { agentIds: [agent.id] })
      await db.insert(executions).values({ agentId: agent.id, status: 'running' })
      const removed: string[] = []

      let error: unknown
      try {
        await parkWorkStream(active.id, {
          removeSandbox: async (sandboxId) => {
            removed.push(sandboxId)
          },
        })
      } catch (caught) {
        error = caught
      }

      // Mutation: replacing the message with generic text must fail every procedure fragment below.
      expect(error).toBeInstanceOf(WorkStreamBusyError)
      const message = (error as WorkStreamBusyError).message
      expect(message).toContain('discard its in-flight turn and stop its sandbox')
      expect(message).toContain('asking it to stop at a safe point')
      expect(message).toContain('Wait for it to report that it has stopped')
      expect(message).toContain(`ficus workstream park ${active.id}`)
      expect(message).toContain('park a different stream')
      expect(message).toContain("lower this stream's priority")
      expect(message).toContain('--preempt-running')
      expect((await WorkStream.mustFind(active.id)).status).toBe('active')
      expect(removed).toEqual([])
    })

    it('locks every bound agent in deterministic order before the execution query', async () => {
      const first = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const second = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(first.id, second.id)
      const active = await createStream('all-agent-locks', {
        assigneeAgentId: second.id,
        agentIds: [second.id, first.id],
      })
      const observed: string[] = []
      const lockOrder: string[] = []
      setDemotionLockStepObserverForTest(async (phase, agentId) => {
        if (phase === 'after') lockOrder.push(agentId)
      })
      setDemotionLockObserverForTest(async (agentIds) => {
        expect(agentIds).toEqual([second.id, first.id])
        for (const agentId of [...agentIds].sort()) {
          const [{ acquired }] =
            await lockProbeConnection`SELECT pg_try_advisory_xact_lock(421100, hashtext(${agentId})) AS acquired`
          observed.push(`${agentId}:${acquired}`)
          if (acquired) await lockProbeConnection`SELECT pg_advisory_unlock(421100, hashtext(${agentId}))`
        }
      })
      try {
        await parkWorkStream(active.id, { removeSandbox: async () => {} })
      } finally {
        setDemotionLockObserverForTest()
        setDemotionLockStepObserverForTest()
      }
      expect(lockOrder).toEqual([first.id, second.id].sort())
      expect(observed).toEqual([first.id, second.id].sort().map((id) => `${id}:false`))
    })

    it('serializes overlapping demotions regardless of opposite membership order', async () => {
      const first = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const second = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(first.id, second.id)
      const left = await createStream('opposite-lock-left', { agentIds: [first.id, second.id] })
      const right = await createStream('opposite-lock-right', { agentIds: [second.id, first.id] })
      let firstAttempts = 0
      let releaseFirstAttempts!: () => void
      const firstAttemptBarrier = new Promise<void>((resolve) => (releaseFirstAttempts = resolve))
      setDemotionLockStepObserverForTest(async (phase) => {
        if (phase !== 'before' || firstAttempts >= 2) return
        firstAttempts += 1
        if (firstAttempts === 2) releaseFirstAttempts()
        await firstAttemptBarrier
      })
      try {
        const outcomes = await Promise.allSettled([
          parkWorkStream(left.id, { removeSandbox: async () => {} }),
          parkWorkStream(right.id, { removeSandbox: async () => {} }),
        ])
        // Mutation: input-order locking gives the overlapping transactions opposite lock order;
        // PostgreSQL aborts one as a deadlock instead of both demotions completing.
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
      } finally {
        setDemotionLockStepObserverForTest()
      }
    })

    it('serializes execution creation before deciding the manual demotion', async () => {
      const first = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const second = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(first.id, second.id)
      const [otherAgentId, agentId] = [first.id, second.id].sort()
      const active = await createStream('queue-lock-race', { agentIds: [agentId, otherAgentId] })
      const nextAttemptAt = new Date(Date.now() + 60_000)
      const claimedAt = new Date(Date.now() - 60_000)
      await db
        .update(workStreamContinuations)
        .set({ status: 'pending', nextAttemptAt, claimedAt })
        .where(eq(workStreamContinuations.workStreamId, active.id))
      const before = await db
        .select({
          status: workStreamContinuations.status,
          nextAttemptAt: workStreamContinuations.nextAttemptAt,
          claimedAt: workStreamContinuations.claimedAt,
        })
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, active.id))
      const removed: string[] = []
      let releaseInsert!: () => void
      let inserted!: () => void
      const insertedSignal = new Promise<void>((resolve) => (inserted = resolve))
      const releaseSignal = new Promise<void>((resolve) => (releaseInsert = resolve))
      let signalBefore!: () => void
      let signalAfter!: () => void
      const beforeTargetLock = new Promise<void>((resolve) => (signalBefore = resolve))
      const afterTargetLock = new Promise<void>((resolve) => (signalAfter = resolve))
      setDemotionLockStepObserverForTest(async (phase, id) => {
        if (id !== agentId) return
        if (phase === 'before') signalBefore()
        else signalAfter()
      })

      const holder = lockProbeConnection.begin(async (tx) => {
        const sql = tx as unknown as postgres.Sql
        await sql`SELECT pg_advisory_xact_lock(421100, hashtext(${agentId}))`
        await sql`INSERT INTO executions (agent_id, status) VALUES (${agentId}, 'running')`
        inserted()
        await releaseSignal
      })
      await insertedSignal

      let error: unknown
      const park = parkWorkStream(active.id, {
        removeSandbox: async (sandboxId) => {
          removed.push(sandboxId)
        },
      }).catch((caught) => {
        error = caught
      })
      try {
        await beforeTargetLock
        let acquiredWhileHolderOpen = false
        void afterTargetLock.then(() => (acquiredWhileHolderOpen = true))
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (acquiredWhileHolderOpen) {
          // Mutated omission: let the unlocked query/demotion finish while the insert is invisible.
          await park
          releaseInsert()
        } else {
          // Correct path: release the insert, then the demotion acquires the lock and observes it.
          releaseInsert()
          await holder
          await afterTargetLock
          await park
        }
        await holder
      } finally {
        releaseInsert()
        setDemotionLockStepObserverForTest()
      }
      const after = await db
        .select({
          status: workStreamContinuations.status,
          nextAttemptAt: workStreamContinuations.nextAttemptAt,
          claimedAt: workStreamContinuations.claimedAt,
        })
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, active.id))
      expect({
        busy: error instanceof WorkStreamBusyError,
        status: (await WorkStream.mustFind(active.id)).status,
        continuation: after,
        removedSandboxes: removed,
      }).toEqual({
        busy: true,
        status: 'active',
        continuation: before,
        removedSandboxes: [],
      })
    })

    it('{ preemptRunning: true } parks and emits a warn naming the execution', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('preempt-running', { agentIds: [agent.id] })
      const waiting = await createStream('preempt-waiter', { priority: 'high' })
      const [execution] = await db
        .insert(executions)
        .values({ agentId: agent.id, status: 'running' })
        .returning({ id: executions.id })
      const removed: string[] = []
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // Mutation: dropping the preemptRunning branch must refuse this call.
        const result = await parkWorkStream(active.id, {
          preemptRunning: true,
          removeSandbox: async (sandboxId) => {
            removed.push(sandboxId)
          },
        })
        expect(result.stream.status).toBe('queued')
        expect((await WorkStream.mustFind(waiting.id)).status).toBe('active')
        expect(removed).toEqual([`agent_${agent.id}`])
        const warning = warn.mock.calls.flat().join(' ')
        expect(warning).toContain(active.id)
        expect(warning).toContain(active.title)
        expect(warning).toContain(agent.id)
        expect(warning).toContain(execution.id)
      } finally {
        warn.mockRestore()
      }
    })

    it('queued pending work remains quiescent and may be parked', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('queued-execution', { agentIds: [agent.id] })
      await active.block({ message: 'waiting safely' })
      await db.insert(executions).values({ agentId: agent.id, status: 'queued' })

      await expect(parkWorkStream(active.id, { removeSandbox: async () => {} })).resolves.toBeDefined()
    })

    it('stopping work is in-flight and refuses demotion through WorkStream.update', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('stopping-update', { agentIds: [agent.id] })
      await active.block({ message: 'wait does not exempt in-flight work' })
      await db.insert(executions).values({ agentId: agent.id, status: 'stopping' })
      const nextAttemptAt = new Date(Date.now() + 60_000)
      const claimedAt = new Date(Date.now() - 60_000)
      await db
        .update(workStreamContinuations)
        .set({ status: 'pending', nextAttemptAt, claimedAt })
        .where(eq(workStreamContinuations.workStreamId, active.id))
      const before = await db
        .select({
          status: workStreamContinuations.status,
          nextAttemptAt: workStreamContinuations.nextAttemptAt,
          claimedAt: workStreamContinuations.claimedAt,
        })
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, active.id))
      const removeSandbox = spyOn(getSandboxManager(), 'removeSandbox').mockResolvedValue()
      try {
        let error: unknown
        try {
          await active.update({ status: 'queued' })
        } catch (caught) {
          error = caught
        }
        const after = await db
          .select({
            status: workStreamContinuations.status,
            nextAttemptAt: workStreamContinuations.nextAttemptAt,
            claimedAt: workStreamContinuations.claimedAt,
          })
          .from(workStreamContinuations)
          .where(eq(workStreamContinuations.workStreamId, active.id))
        expect({
          busy: error instanceof WorkStreamBusyError,
          status: (await WorkStream.mustFind(active.id)).status,
          continuation: after,
          removedSandboxes: removeSandbox.mock.calls.map(([sandboxId]) => sandboxId),
        }).toEqual({
          busy: true,
          status: 'active',
          continuation: before,
          removedSandboxes: [],
        })
      } finally {
        removeSandbox.mockRestore()
      }
    })

    it('parking a quiescent admitted stream still succeeds', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      const active = await createStream('quiescent', { agentIds: [agent.id] })
      const waiting = await createStream('quiescent-waiter', { priority: 'high' })
      const removed: string[] = []

      // Mutation: inverting the live check to refuse quiescent streams must throw here.
      const result = await parkWorkStream(active.id, {
        removeSandbox: async (sandboxId) => {
          removed.push(sandboxId)
        },
      })
      expect(result.stream.status).toBe('queued')
      expect((await WorkStream.mustFind(waiting.id)).status).toBe('active')
      expect(removed).toEqual([`agent_${agent.id}`])
    })

    it('reproduces park, queued handoff, and promotion delivery', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const sender = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const reviewer = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(sender.id, reviewer.id)
      const active = await createStream('incident-active', {
        assigneeAgentId: sender.id,
        agentIds: [sender.id, reviewer.id],
      })
      const waiter = await createStream('incident-waiter', { priority: 'high' })
      const [running] = await db
        .insert(executions)
        .values({ agentId: sender.id, status: 'running' })
        .returning({ id: executions.id })

      await parkWorkStream(active.id, { preemptRunning: true, removeSandbox: async () => {} })
      expect((await WorkStream.mustFind(active.id)).status).toBe('queued')
      await db.update(executions).set({ status: 'completed', endedAt: new Date() }).where(eq(executions.id, running.id))
      await active.update({ assigneeAgentId: reviewer.id, handoffMessage: 'Ready for review' })
      expect((await WorkStream.mustFind(active.id)).status).toBe('queued')
      expect(await reviewer.getActiveExecution()).toBeNull()
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, reviewer.id))).toHaveLength(0)

      await waiter.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(active.id)).status).toBe('active')
      expect((await reviewer.getActiveExecution())?.status).toBe('queued')
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, reviewer.id))).toHaveLength(1)
    })

    it('refuses to park a non-admitted stream', async () => {
      const done = await createStream('done-stream')
      await done.update({ status: 'done' })
      await expect(parkWorkStream(done.id)).rejects.toThrow(WorkStreamNotParkableError)
    })
  })

  describe('demotion sandbox stop scoping', () => {
    it('keeps the box of an agent that still has another admitted stream', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)
      // assignee-only binding so completing this stream cannot terminate the agent
      const admitted = await createStream('still-admitted', { assigneeAgentId: agent.id })
      const demoted = await createStream('demoted', { agentIds: [agent.id] })

      const removed: string[] = []
      await stopSandboxesForDemotedStream(demoted, {
        removeSandbox: async (sandboxId) => {
          removed.push(sandboxId)
        },
      })
      expect(removed).toEqual([])
      void admitted

      // Once the other stream closes, the same demotion stop DOES stop the box.
      await WorkStream.update(admitted.id, { status: 'done' })
      await stopSandboxesForDemotedStream(demoted, {
        removeSandbox: async (sandboxId) => {
          removed.push(sandboxId)
        },
      })
      expect(removed).toEqual([`agent_${agent.id}`])
    })
  })

  describe('priority is advisory (invariant 7)', () => {
    it('a priority edit alone never admits a queued stream or transitions a running one', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await createStream('holder')
      const waiting = await createStream('waiting')
      expect(waiting.status).toBe('queued')

      await WorkStream.update(waiting.id, { priority: 'critical' })
      expect((await WorkStream.mustFind(waiting.id)).status).toBe('queued')
      await WorkStream.update(holder.id, { priority: 'low' })
      expect((await WorkStream.mustFind(holder.id)).status).toBe('active')
    })
  })

  describe('concurrent storm (invariant 1: admitted count never exceeds cap)', () => {
    it('holds the cap under concurrent create/complete/park storms on a warm multi-backend pool', async () => {
      const CAP = 3
      await squad.update({ maxConcurrentWorkStreams: CAP })

      // Warm the pool and prove real concurrency: >1 distinct backend.
      const pids = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const rows = (await db.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as Array<{
            pid: number
          }>
          return rows[0].pid
        })
      )
      expect(new Set(pids).size).toBeGreaterThan(1)

      // Storm 1: 12 concurrent creations -> exactly CAP admitted.
      const streams = await Promise.all(Array.from({ length: 12 }, (_, i) => createStream(`storm-${i}`)))
      expect(await admittedCount()).toBe(CAP)
      expect(streams.filter((s) => s.status === 'queued').length).toBe(12 - CAP)

      // Storm 2: concurrently complete every admitted stream, park nothing yet,
      // and fire several racing promotions.
      const admitted = streams.filter((s) => s.status !== 'queued')
      await Promise.all([
        ...admitted.map((s) => WorkStream.update(s.id, { status: 'done' })),
        ...Array.from({ length: 6 }, () => promoteEligibleQueuedStreams(squad.id)),
      ])
      await promoteEligibleQueuedStreams(squad.id)
      expect(await admittedCount()).toBeLessThanOrEqual(CAP)

      // Storm 3: park admitted streams while promotions race.
      const nowAdmitted = (await WorkStream.list({ squadId: squad.id })).filter((s) =>
        (WORK_STREAM_ADMITTED_STATUSES as string[]).includes(s.status)
      )
      await Promise.all([
        ...nowAdmitted.map((s) => parkWorkStream(s.id, { removeSandbox: async () => {} }).catch(() => null)),
        ...Array.from({ length: 6 }, () => promoteEligibleQueuedStreams(squad.id)),
      ])
      await promoteEligibleQueuedStreams(squad.id)
      expect(await admittedCount()).toBeLessThanOrEqual(CAP)
      // And the cap is actually used (work continues, no deadlock/starvation).
      expect(await admittedCount()).toBeGreaterThan(0)
    })
  })

  describe('manual admission guard (no cap bypass via direct status writes)', () => {
    it('rejects queued->admitted PATCH-style writes under a full cap; stream stays queued', async () => {
      await squad.update({ maxConcurrentWorkStreams: 2 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)

      const dep = await createStream('open-dep')
      const holder = await createStream('holder')
      // dependsOn an OPEN stream so the scheduler can never auto-admit it —
      // isolates the manual path.
      const q = await createStream('q', { assigneeAgentId: agent.id, agentIds: [agent.id], dependsOn: [dep.id] })
      expect(q.status).toBe('queued')

      // Direct status write (ws update --status / PATCH) refused with a directive message.
      await expect(WorkStream.update(q.id, { status: 'active' })).rejects.toThrow(/concurrency cap/)
      // Handoff-shaped write (status + assignee) refused too.
      await expect(WorkStream.update(q.id, { status: 'active', assigneeAgentId: agent.id })).rejects.toThrow(
        /park an admitted stream/
      )
      expect((await WorkStream.mustFind(q.id)).status).toBe('queued')
      expect(await admittedCount()).toBe(2)

      // Free a slot (holder completes; q's open dep keeps the scheduler away from it).
      await WorkStream.update(holder.id, { status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(q.id)).status).toBe('queued')

      // With a free slot the manual admission is allowed (human override of
      // dependency order is a judgment call; the CAP is the invariant).
      await WorkStream.update(q.id, { status: 'active', assigneeAgentId: agent.id })
      expect((await WorkStream.mustFind(q.id)).status).toBe('active')
      expect(await admittedCount()).toBe(2)
    })

    it('cap null: park is immediately reverted by promotion, and manual un-queueing is unrestricted', async () => {
      // Under cap null there is nothing to park against — promotion re-admits
      // everything immediately (cap null admits everything, per spec).
      const ws = await createStream('parked-under-null')
      await parkWorkStream(ws.id, { removeSandbox: async () => {} })
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')

      // A stranded queued row (e.g. left over from a since-cleared cap) can be
      // un-queued manually without any guard interference.
      await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, ws.id))
      await WorkStream.update(ws.id, { status: 'active' })
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')
    })

    it('respond() on a parked (queued) stream never admits it', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      createdAgentIds.push(agent.id)

      const b = await createStream('blocked-then-parked', { assigneeAgentId: agent.id, agentIds: [agent.id] })
      await b.block({ message: 'need input' })
      // Pin b behind an open dependency so post-park promotion admits the
      // eligible d (filling the slot) instead of re-admitting b.
      const d = await createStream('slot-filler')
      expect(d.status).toBe('queued')
      await b.update({ dependsOn: [d.id] })

      const { stream: parked } = await parkWorkStream(b.id, {
        preemptRunning: true,
        removeSandbox: async () => {},
      })
      expect(parked.status).toBe('queued')
      // Parking never touches waits — the manual wait (and its message) survives.
      const parkedWaits = await parked.getOpenWaits()
      expect(parkedWaits.some((w) => w.type === 'manual' && w.message === 'need input')).toBe(true)
      // The freed slot went to d — the cap is full again.
      expect((await WorkStream.mustFind(d.id)).status).toBe('active')

      await (await WorkStream.mustFind(b.id)).unblock({ note: 'here is the answer' })
      expect((await WorkStream.mustFind(b.id)).status).toBe('queued')
      expect(await admittedCount()).toBe(1)
    })
  })

  describe('cap raising', () => {
    it('admits queued streams immediately when the cap is raised or cleared', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      await createStream('holder')
      const q1 = await createStream('q1')
      const q2 = await createStream('q2')
      expect(q1.status).toBe('queued')
      expect(q2.status).toBe('queued')

      await squad.update({ maxConcurrentWorkStreams: 2 })
      expect((await WorkStream.mustFind(q1.id)).status).toBe('active')
      expect((await WorkStream.mustFind(q2.id)).status).toBe('queued')

      await squad.update({ maxConcurrentWorkStreams: null })
      expect((await WorkStream.mustFind(q2.id)).status).toBe('active')
    })
  })

  describe('cap-change admission retry', () => {
    it('retries a transiently failing maintenance run and succeeds', async () => {
      const { runSquadAdmissionMaintenanceWithRetry } = await import('./admission')
      let calls = 0
      const result = await runSquadAdmissionMaintenanceWithRetry(squad.id, {
        run: async () => {
          calls += 1
          if (calls === 1) throw new Error('deadlock detected')
        },
        sleep: async () => {},
      })
      expect(result.succeeded).toBe(true)
      expect(calls).toBe(2)
    })

    it('gives up after the attempt budget and reports the last error', async () => {
      const { runSquadAdmissionMaintenanceWithRetry } = await import('./admission')
      let calls = 0
      const result = await runSquadAdmissionMaintenanceWithRetry(squad.id, {
        attempts: 3,
        run: async () => {
          calls += 1
          throw new Error('still deadlocked')
        },
        sleep: async () => {},
      })
      expect(result.succeeded).toBe(false)
      expect(calls).toBe(3)
      expect(String(result.lastError)).toContain('still deadlocked')
    })
  })

  describe('cap lowering', () => {
    it('never evicts admitted streams; over-cap just blocks new admissions', async () => {
      await createStream('a')
      await createStream('b')
      await createStream('c')
      await squad.update({ maxConcurrentWorkStreams: 1 })
      expect(await admittedCount()).toBe(3)
      const late = await createStream('late')
      expect(late.status).toBe('queued')
      await promoteEligibleQueuedStreams(squad.id)
      expect((await WorkStream.mustFind(late.id)).status).toBe('queued')
    })
  })
})
