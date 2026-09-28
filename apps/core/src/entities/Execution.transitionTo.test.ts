import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { AgentStatus } from '@ficus/shared'
import { db } from '../db'
import {
  executions,
  agents,
  agentTypes,
  executionAdmissionReservations,
  instanceMaintenanceState,
  k8sProvisionAttempts,
  sandboxProvisionRecoveries,
} from '../db/schema'
import { AgentType } from './AgentType'
import { Agent } from './Agent'
import { Execution } from './Execution'
import { eventEmitter } from '../lib/infra/event-emitter'
import { concurrencyLimiter } from '../services/execution/concurrency-limiter-instance'

describe('Execution.transitionTo', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let testAgentId: string
  let ownedReservationExecutionIds: string[]
  let excludedNeighbor:
    | {
        executionId: string
        snapshot: typeof executionAdmissionReservations.$inferSelect
      }
    | undefined

  beforeEach(async () => {
    await db.delete(sandboxProvisionRecoveries)
    await db.delete(k8sProvisionAttempts)
    ownedReservationExecutionIds = []
    excludedNeighbor = undefined
    testPrefix = `transition-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId })
    testAgentId = testAgent.id
  })

  afterEach(async () => {
    const cleanupErrors: unknown[] = []
    const captureCleanup = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (ownedReservationExecutionIds.length > 0) {
      await captureCleanup(() =>
        db
          .delete(executionAdmissionReservations)
          .where(inArray(executionAdmissionReservations.executionId, ownedReservationExecutionIds))
      )
    }
    if (excludedNeighbor) {
      await captureCleanup(async () => {
        const [neighborAfter] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, excludedNeighbor!.executionId))
        expect(neighborAfter).toEqual(excludedNeighbor!.snapshot)
      })
      await captureCleanup(() =>
        db
          .delete(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, excludedNeighbor!.executionId))
      )
    }
    await captureCleanup(() => db.delete(sandboxProvisionRecoveries))
    await captureCleanup(() => db.delete(k8sProvisionAttempts))
    await captureCleanup(() => db.delete(executions).where(eq(executions.agentId, testAgentId)))
    await captureCleanup(() => db.delete(agents).where(eq(agents.id, testAgentId)))
    await captureCleanup(() => db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId)))
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Owned transition cleanup failed')
  })

  describe('admission lease fencing', () => {
    it('rejects stale runner complete, fail, stop, and requeue without changing the successor', async () => {
      await db.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
      const [maintenance] = await db
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const neighborToken = crypto.randomUUID()
      const [neighborExecution] = await db
        .insert(executions)
        .values({
          agentId: testAgentId,
          status: 'running',
          runnerClaimToken: neighborToken,
          runnerClaimGeneration: maintenance!.generation,
        })
        .returning()
      const neighborNow = new Date()
      const [neighborReservation] = await db
        .insert(executionAdmissionReservations)
        .values({
          executionId: neighborExecution.id,
          token: neighborToken,
          claimEpoch: 91n,
          ownerId: 'excluded-neighbor',
          ownerIncarnation: crypto.randomUUID(),
          admittedGeneration: maintenance!.generation,
          admittedHolderRevision: maintenance!.holderRevision,
          state: 'running',
          phase: 'none',
          leaseExpiresAt: new Date(neighborNow.getTime() + 30_000),
          lastHeartbeatAt: neighborNow,
          updatedAt: neighborNow,
        })
        .returning()
      excludedNeighbor = { executionId: neighborExecution.id, snapshot: neighborReservation }

      const outcomes = [
        { kind: 'completed' as const },
        { kind: 'failed' as const, error: 'stale failure' },
        { kind: 'stopped' as const },
        { kind: 'requeued' as const },
      ]
      for (const outcome of outcomes) {
        const staleToken = crypto.randomUUID()
        const successorToken = crypto.randomUUID()
        const staleOwnerIncarnation = crypto.randomUUID()
        const successorOwnerIncarnation = crypto.randomUUID()
        const [row] = await db
          .insert(executions)
          .values({
            agentId: testAgentId,
            status: 'running',
            runnerClaimToken: successorToken,
            runnerClaimGeneration: maintenance!.generation,
          })
          .returning()
        ownedReservationExecutionIds.push(row.id)
        const now = new Date()
        await db.insert(executionAdmissionReservations).values({
          executionId: row.id,
          token: successorToken,
          claimEpoch: 2n,
          ownerId: 'successor',
          ownerIncarnation: successorOwnerIncarnation,
          admittedGeneration: maintenance!.generation,
          admittedHolderRevision: maintenance!.holderRevision,
          state: 'running',
          phase: 'none',
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        const execution = await Execution.mustFind(row.id)
        const [executionBefore] = await db.select().from(executions).where(eq(executions.id, row.id))
        const [reservationBefore] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, row.id))

        expect(
          await execution.transitionTo(outcome, {
            admissionLease: {
              executionId: row.id,
              token: staleToken,
              claimEpoch: 1n,
              generation: maintenance!.generation,
              holderRevision: maintenance!.holderRevision,
              ownerId: 'stale',
              ownerIncarnation: staleOwnerIncarnation,
            },
          }),
          outcome.kind
        ).toBe(false)
        const [executionAfter] = await db.select().from(executions).where(eq(executions.id, row.id))
        const [reservationAfter] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, row.id))
        expect(executionAfter).toEqual(executionBefore)
        expect(reservationAfter).toEqual(reservationBefore)
      }
    })
  })

  describe('atomicity', () => {
    it('leaves both execution and agent rows unchanged when the agent write fails mid-transaction', async () => {
      const execution = await testAgent.queueExecution({ message: 'atomic' })
      await execution.start()
      expect(execution.status).toBe('running')
      await testAgent.reload()
      expect(testAgent.status).toBe('active')

      await expect(
        execution.transitionTo({
          kind: 'completed',
          agent: { status: 'not-a-real-status' as unknown as AgentStatus },
        })
      ).rejects.toThrow()

      const executionAfter = await Execution.mustFind(execution.id)
      expect(executionAfter.status).toBe('running')

      const agentAfter = await Agent.mustFind(testAgentId)
      expect(agentAfter.status).toBe('active')
    })
  })

  describe('started CAS', () => {
    it('records the successful execution claim time', async () => {
      const claimed = await testAgent.queueExecution({ message: 'claim-time' })
      const [stillQueued] = await db
        .insert(executions)
        .values({ agentId: testAgentId, message: 'still-queued' })
        .returning()
      const [beforeClaim] = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)

      expect(await claimed.transitionTo({ kind: 'started' })).toBe(true)

      const [afterClaim] = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)
      const claimedAfter = await Execution.mustFind(claimed.id)
      const queuedAfter = await Execution.mustFind(stillQueued.id)
      expect(claimedAfter.runStartedAt).toBeInstanceOf(Date)
      expect(claimedAfter.runStartedAt!.getTime()).toBeGreaterThanOrEqual(new Date(beforeClaim!.now).getTime())
      expect(claimedAfter.runStartedAt!.getTime()).toBeLessThanOrEqual(new Date(afterClaim!.now).getTime())
      expect(claimedAfter.toJson().runStartedAt).toEqual(claimedAfter.runStartedAt)
      expect(queuedAfter.runStartedAt).toBeNull()
    })

    it('returns false and leaves the agent untouched on a lost race', async () => {
      const execution = await testAgent.queueExecution({ message: 'race' })
      const first = await execution.start()
      expect(first).toBe(true)
      await testAgent.reload()
      expect(testAgent.status).toBe('active')

      const second = await execution.transitionTo({ kind: 'started' })
      expect(second).toBe(false)

      const executionAfter = await Execution.mustFind(execution.id)
      expect(executionAfter.status).toBe('running')

      const agentAfter = await Agent.mustFind(testAgentId)
      expect(agentAfter.status).toBe('active')
    })
  })

  describe('per-outcome dispositions', () => {
    it('started: execution running, agent active, execution.started emitted exactly once', async () => {
      const execution = await testAgent.queueExecution({ message: 'start' })

      const events: unknown[] = []
      const unsub = eventEmitter.on('execution.started', (data) => events.push(data))

      const started = await execution.transitionTo({ kind: 'started' })

      expect(started).toBe(true)
      expect(execution.status).toBe('running')
      expect(events.length).toBe(1)
      unsub()

      await testAgent.reload()
      expect(testAgent.status).toBe('active')
    })

    it('completed (default disposition): execution completed, agent idle', async () => {
      const execution = await testAgent.queueExecution({ message: 'complete' })
      await execution.start()

      const usage = { stats: { userMessages: 1, assistantMessages: 1, totalMessages: 2 }, context: null } as any
      const result = await execution.transitionTo({ kind: 'completed', usage })
      expect(result).toBe(true)

      expect(execution.status).toBe('completed')
      expect(execution.usage).toEqual(usage)
      expect(execution.endedAt).toBeInstanceOf(Date)

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')
    })

    /**
     * `executions.started_at` and `run_started_at` are written by Postgres, and the continuation
     * watchdog compares `run_started_at` against a trigger's `ended_at` to decide whether an agent
     * already recovered. While `ended_at` was written from the app host's `new Date()`, that
     * comparison spanned two clocks: a Core host running ahead of Postgres by more than the real
     * gap between a failure and its recovery made the watchdog miss the recovery and open a
     * spurious "continuation exhausted" wait, parking a healthy work stream until a human cleared
     * it. `setSystemTime` moves only the JS clock — Postgres is untouched — which is exactly that
     * production shape.
     */
    it('stamps endedAt from the database clock, so a host running ahead cannot invert the ordering', async () => {
      const HOST_SKEW_MS = 5_000
      const execution = await testAgent.queueExecution({ message: 'clock-skew' })
      await execution.start()

      setSystemTime(new Date(Date.now() + HOST_SKEW_MS))
      try {
        expect(await execution.transitionTo({ kind: 'completed' })).toBe(true)
      } finally {
        setSystemTime()
      }

      const [{ databaseNow }] = await db.execute<{ databaseNow: Date }>(sql`select clock_timestamp() as "databaseNow"`)
      const skewMs = execution.endedAt!.getTime() - new Date(databaseNow).getTime()
      // Written from the host, this lands ~5s in the DATABASE's future; written from the database
      // it lands at (just before) the database's now.
      expect(skewMs).toBeLessThan(HOST_SKEW_MS / 2)

      // The ordering the watchdog actually reads: an execution that started before it ended.
      const [row] = await db
        .select({ runStartedAt: executions.runStartedAt, endedAt: executions.endedAt })
        .from(executions)
        .where(eq(executions.id, execution.id))
      expect(row.runStartedAt!.getTime()).toBeLessThanOrEqual(row.endedAt!.getTime())

      // The transition returns the written row, so the in-memory entity carries the DATABASE's
      // value rather than a host timestamp that was never stored.
      expect(execution.endedAt!.getTime()).toBe(row.endedAt!.getTime())
    })

    it('completed (custom disposition): agent takes the carried status + questionData', async () => {
      const execution = await testAgent.queueExecution({ message: 'complete-custom' })
      await execution.start()

      const questionData = {
        questions: [{ id: 'custom', type: 'select' as const, question: 'Continue?', options: [{ value: 'Yes' }] }],
      }
      await execution.transitionTo({
        kind: 'completed',
        agent: { status: 'waiting-input', questionData },
      })

      expect(execution.status).toBe('completed')

      await testAgent.reload()
      expect(testAgent.status).toBe('waiting-input')
      expect(testAgent.questionData).toEqual(questionData)
    })

    it('completed (custom disposition, questionData: null): explicitly clears a prior question', async () => {
      const execution = await testAgent.queueExecution({ message: 'complete-clear' })
      await execution.start()

      const questionData = {
        questions: [{ id: 'stale', type: 'select' as const, question: 'Stale?', options: [{ value: 'Yes' }] }],
      }
      await execution.transitionTo({ kind: 'completed', agent: { status: 'waiting-input', questionData } })
      await testAgent.reload()
      expect(testAgent.questionData).toEqual(questionData)

      // A second transitionTo (e.g. a turn hook halting again without
      // carrying a question) explicitly clears the prior one via
      // questionData: null — this is a shape base.ts's completeNormally can
      // produce for a turn hook's halt result (HaltUpdates' questionData is
      // typed `QuestionData | null`, distinct from "key absent" which the
      // test above covers via the default-disposition path).
      await execution.transitionTo({ kind: 'completed', agent: { status: 'idle', questionData: null } })

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')
      expect(testAgent.questionData).toBeNull()
    })

    it('failed (generic error): execution failed, agent idle', async () => {
      const execution = await testAgent.queueExecution({ message: 'fail-generic' })
      await execution.start()

      await execution.transitionTo({ kind: 'failed', error: 'Something went wrong' })

      expect(execution.status).toBe('failed')
      expect(execution.error).toBe('Something went wrong')

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')
      expect(testAgent.questionData).toBeNull()
    })

    it('failed (rate limit): agent waiting-input with rate_limit question, message recorded before agent.waiting-input', async () => {
      const execution = await testAgent.queueExecution({ message: 'fail-rate-limit' })
      await execution.start()

      const order: string[] = []
      const unsubMsg = eventEmitter.on('message.created', () => order.push('message.created'))
      const unsubWaiting = eventEmitter.on('agent.waiting-input', () => order.push('agent.waiting-input'))

      await execution.transitionTo({ kind: 'failed', error: 'rate limit exceeded' })

      unsubMsg()
      unsubWaiting()

      expect(order).toEqual(['message.created', 'agent.waiting-input'])

      await testAgent.reload()
      expect(testAgent.status).toBe('waiting-input')
      const question = (testAgent.questionData as any).questions[0]
      expect(question.id).toBe('rate_limit')
    })

    it('failed (all providers exhausted): agent waiting-input with all_providers_exhausted question', async () => {
      const execution = await testAgent.queueExecution({ message: 'fail-exhausted' })
      await execution.start()

      const errorMsg =
        'No usable model in priority list. Attempted:\n  - anthropic:claude-sonnet-4-5: provider exhausted (in cooldown)'
      await execution.transitionTo({ kind: 'failed', error: errorMsg })

      await testAgent.reload()
      expect(testAgent.status).toBe('waiting-input')
      const question = (testAgent.questionData as any).questions[0]
      expect(question.id).toBe('all_providers_exhausted')
    })

    it('stopped: execution stopped, agent idle', async () => {
      const execution = await testAgent.queueExecution({ message: 'stop' })
      await execution.start()

      await execution.transitionTo({ kind: 'stopped' })

      expect(execution.status).toBe('stopped')
      expect(execution.endedAt).toBeInstanceOf(Date)

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')
    })

    it('force-stopped: execution failed with default reason, agent idle', async () => {
      const execution = await testAgent.queueExecution({ message: 'force-stop' })
      await execution.start()

      await execution.transitionTo({ kind: 'force-stopped' })

      expect(execution.status).toBe('failed')
      expect(execution.error).toBe('Force-stopped from running state')

      await testAgent.reload()
      expect(testAgent.status).toBe('idle')
    })

    it('force-stopped: honors a custom reason', async () => {
      const execution = await testAgent.queueExecution({ message: 'force-stop-reason' })
      await execution.start()

      await execution.transitionTo({ kind: 'force-stopped', reason: 'worker unresponsive' })

      expect(execution.error).toBe('worker unresponsive')
    })

    it('superseded: execution completed, agent untouched', async () => {
      const execution = await testAgent.queueExecution({ message: 'supersede' })
      await execution.start()
      await testAgent.reload()
      expect(testAgent.status).toBe('active')

      await execution.transitionTo({ kind: 'superseded' })

      expect(execution.status).toBe('completed')
      await testAgent.reload()
      expect(testAgent.status).toBe('active')
    })

    it('requeued: execution queued, agent untouched, imageIds carried, execution.queued emitted when leaving a non-queued status', async () => {
      const execution = await testAgent.queueExecution({ message: 'requeue' })
      await execution.start()
      await testAgent.reload()
      expect(testAgent.status).toBe('active')

      const events: unknown[] = []
      const unsub = eventEmitter.on('execution.queued', (data) => events.push(data))

      const imageId = crypto.randomUUID()
      await execution.transitionTo({ kind: 'requeued', imageIds: [imageId] })

      unsub()
      expect(execution.status).toBe('queued')
      expect(execution.imageIds).toEqual([imageId])
      expect(events.length).toBe(1)

      await testAgent.reload()
      expect(testAgent.status).toBe('active')
    })

    it('requeued: does not re-emit execution.queued when already queued', async () => {
      const execution = await testAgent.queueExecution({ message: 'requeue-already-queued' })
      expect(execution.status).toBe('queued')

      const events: unknown[] = []
      const unsub = eventEmitter.on('execution.queued', (data) => events.push(data))

      await execution.transitionTo({ kind: 'requeued' })

      unsub()
      expect(execution.status).toBe('queued')
      expect(events.length).toBe(0)
    })
  })

  describe('concurrency slot release', () => {
    it('releases the slot for completed | failed | stopped | force-stopped | requeued, but not started | superseded', async () => {
      const cases: Array<{
        setup: () => Promise<Execution>
        run: (e: Execution) => Promise<unknown>
        released: boolean
      }> = [
        {
          setup: async () => testAgent.queueExecution({ message: 'slot-started' }),
          run: (e) => e.transitionTo({ kind: 'started' }),
          released: false,
        },
        {
          setup: async () => {
            const e = await testAgent.queueExecution({ message: 'slot-completed' })
            await e.start()
            return e
          },
          run: (e) => e.transitionTo({ kind: 'completed' }),
          released: true,
        },
      ]

      for (const { setup, run, released } of cases) {
        const execution = await setup()
        const releaseSpy = spyOn(concurrencyLimiter, 'release')
        await run(execution)
        if (released) {
          expect(releaseSpy).toHaveBeenCalledWith(execution.id)
        } else {
          expect(releaseSpy).not.toHaveBeenCalled()
        }
        releaseSpy.mockRestore()
        // Settle this agent back to idle so the next case's queueExecution succeeds.
        if (execution.status !== 'completed' && execution.status !== 'failed' && execution.status !== 'stopped') {
          await execution.transitionTo({ kind: 'stopped' })
        }
      }
    })

    it('releases the slot for failed, stopped, force-stopped, and requeued individually', async () => {
      const scenarios: Array<[string, (e: Execution) => Promise<unknown>]> = [
        ['failed', (e) => e.transitionTo({ kind: 'failed', error: 'boom' })],
        ['stopped', (e) => e.transitionTo({ kind: 'stopped' })],
        ['force-stopped', (e) => e.transitionTo({ kind: 'force-stopped' })],
        ['requeued', (e) => e.transitionTo({ kind: 'requeued' })],
      ]

      for (const [, run] of scenarios) {
        const execution = await testAgent.queueExecution({ message: 'slot-scenario' })
        await execution.start()

        const releaseSpy = spyOn(concurrencyLimiter, 'release')
        await run(execution)
        expect(releaseSpy).toHaveBeenCalledWith(execution.id)
        releaseSpy.mockRestore()

        // Settle back to idle for the next iteration's queueExecution.
        await testAgent.reload()
        if (testAgent.status !== 'idle') {
          const active = await testAgent.getActiveExecution()
          if (active) await active.transitionTo({ kind: 'stopped' })
        }
      }
    })

    it('does not release the slot for superseded', async () => {
      const execution = await testAgent.queueExecution({ message: 'slot-superseded' })
      await execution.start()

      const releaseSpy = spyOn(concurrencyLimiter, 'release')
      await execution.transitionTo({ kind: 'superseded' })
      expect(releaseSpy).not.toHaveBeenCalled()
      releaseSpy.mockRestore()
    })
  })

  describe('sandbox recovery transitions', () => {
    const recovery = () => ({
      scope: 'scope',
      sandboxKey: 'box',
      circuitVersion: 3,
      refusalId: crypto.randomUUID(),
      errorCode: 'SANDBOX_PROVISION_UNAVAILABLE' as const,
      reasonCode: 'unschedulable_capacity' as const,
      nextAttemptAt: new Date(Date.now() + 5_000),
      deadlineAt: new Date(Date.now() + 60_000),
    })

    it('atomically suspends and resumes the same execution with lease fencing', async () => {
      const execution = await testAgent.queueExecution({ message: 'preserve me' })
      await execution.start()
      const input = recovery()

      expect(await execution.transitionTo({ kind: 'waiting-sandbox', recovery: input })).toBe(true)
      expect(execution.status).toBe('waiting-sandbox')
      expect((await Agent.mustFind(testAgent.id)).status).toBe('idle')
      const [row] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(row).toMatchObject({ refusalId: input.refusalId, generation: 1, status: 'waiting' })

      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'worker', claimKind: 'ordinary' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(
        await execution.transitionTo({
          kind: 'sandbox-recovered',
          generation: 1,
          leaseOwner: 'worker',
          claimKind: 'ordinary',
        })
      ).toBe(true)
      expect(execution.status).toBe('queued')
      const [resumed] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(resumed).toMatchObject({ status: 'resumed', attemptCount: 1 })
    })

    it('uses durable generation and attempt state for stable growing retry timing', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      const firstNow = new Date('2026-08-09T00:00:00Z')
      const deadlineAt = new Date(firstNow.getTime() + 15 * 60_000)
      await execution.transitionTo({
        kind: 'waiting-sandbox',
        recovery: {
          scope: 'scope',
          sandboxKey: 'box',
          refusalId: crypto.randomUUID(),
          errorCode: 'SANDBOX_PROVISION_BUSY',
          now: firstNow,
          deadlineAt,
        },
      })
      let [row] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      const firstDelay = row.nextAttemptAt.getTime() - firstNow.getTime()
      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'worker', claimKind: 'ordinary' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      await execution.transitionTo({
        kind: 'sandbox-recovered',
        generation: 1,
        leaseOwner: 'worker',
        claimKind: 'ordinary',
      })
      await execution.start()
      const secondNow = new Date(firstNow.getTime() + 1_000)
      await execution.transitionTo({
        kind: 'waiting-sandbox',
        recovery: {
          scope: 'scope',
          sandboxKey: 'box',
          refusalId: crypto.randomUUID(),
          errorCode: 'SANDBOX_PROVISION_BUSY',
          now: secondNow,
        },
      })
      ;[row] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      const secondDelay = row.nextAttemptAt.getTime() - secondNow.getTime()
      expect(row.generation).toBe(2)
      expect(row.attemptCount).toBe(1)
      expect(secondDelay).toBeGreaterThan(firstDelay)
      expect(row.deadlineAt).toEqual(deadlineAt)

      const duplicate = {
        scope: 'scope',
        sandboxKey: 'box',
        refusalId: row.refusalId,
        errorCode: 'SANDBOX_PROVISION_BUSY' as const,
        now: secondNow,
      }
      expect(await execution.transitionTo({ kind: 'waiting-sandbox', recovery: duplicate })).toBe(true)
      const [stable] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(stable.nextAttemptAt).toEqual(row.nextAttemptAt)

      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'worker-2', claimKind: 'ordinary' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      await execution.transitionTo({
        kind: 'sandbox-recovered',
        generation: 2,
        leaseOwner: 'worker-2',
        claimKind: 'ordinary',
      })
      await execution.start()
      const thirdNow = new Date(secondNow.getTime() + 1_000)
      await execution.transitionTo({
        kind: 'waiting-sandbox',
        recovery: {
          scope: 'scope',
          sandboxKey: 'box',
          refusalId: crypto.randomUUID(),
          errorCode: 'SANDBOX_PROVISION_BUSY',
          retryAfterMs: 40_000,
          now: thirdNow,
        },
      })
      const [floored] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(floored.nextAttemptAt.getTime() - thirdNow.getTime()).toBeGreaterThanOrEqual(40_000)
      expect(floored.deadlineAt).toEqual(deadlineAt)
    })

    it('releases the provider slot without emitting duplicate events on same-refusal retry', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      const input = recovery()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: input })
      const releaseSpy = spyOn(concurrencyLimiter, 'release')
      const events: unknown[] = []
      const unsub = eventEmitter.on('execution.updated', (event) => events.push(event))

      expect(await execution.transitionTo({ kind: 'waiting-sandbox', recovery: input })).toBe(true)

      unsub()
      expect(releaseSpy).toHaveBeenCalledTimes(1)
      expect(events).toHaveLength(0)
      releaseSpy.mockRestore()
    })

    it('rejects stale recovery generation and lease owner fences', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() })
      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'current-owner', claimKind: 'ordinary' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))

      expect(
        await execution.transitionTo({
          kind: 'sandbox-recovered',
          generation: 999,
          leaseOwner: 'current-owner',
          claimKind: 'ordinary',
        })
      ).toBe(false)
      expect(
        await execution.transitionTo({
          kind: 'sandbox-recovered',
          generation: 1,
          leaseOwner: 'stale-owner',
          claimKind: 'ordinary',
        })
      ).toBe(false)
      expect((await Execution.mustFind(execution.id)).status).toBe('waiting-sandbox')
    })

    it('rejects a mismatched persisted claim kind without changing execution status', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() })
      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'worker', claimKind: 'half_open_probe' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))

      expect(
        await execution.transitionTo({
          kind: 'sandbox-recovered',
          generation: 1,
          leaseOwner: 'worker',
          claimKind: 'ordinary',
        })
      ).toBe(false)
      expect((await Execution.mustFind(execution.id)).status).toBe('waiting-sandbox')
    })

    it('defers only an expired half-open probe lease and loses safely to pickup', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() })
      const now = new Date()
      await db
        .update(sandboxProvisionRecoveries)
        .set({
          status: 'leased',
          leaseOwner: 'worker',
          claimKind: 'half_open_probe',
          leaseExpiresAt: new Date(now.getTime() + 1_000),
        })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      await db.update(executions).set({ status: 'queued' }).where(eq(executions.id, execution.id))

      expect(
        await execution.transitionTo({
          kind: 'sandbox-retry-deferred',
          generation: 1,
          leaseOwner: 'worker',
          nextAttemptAt: new Date(now.getTime() + 5_000),
          now,
        })
      ).toBe(false)
      await db
        .update(sandboxProvisionRecoveries)
        .set({ leaseExpiresAt: now })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(
        await execution.transitionTo({
          kind: 'sandbox-retry-deferred',
          generation: 1,
          leaseOwner: 'worker',
          nextAttemptAt: new Date(now.getTime() + 5_000),
          now,
        })
      ).toBe(true)
      await db.update(executions).set({ status: 'running' }).where(eq(executions.id, execution.id))
      expect(
        await execution.transitionTo({
          kind: 'sandbox-retry-deferred',
          generation: 1,
          leaseOwner: 'worker',
          nextAttemptAt: new Date(now.getTime() + 5_000),
          now,
        })
      ).toBe(false)
    })

    it('does not treat a terminal execution as an idempotent suspension', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      const input = recovery()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: input })
      await execution.transitionTo({ kind: 'stopped' })

      expect(await execution.transitionTo({ kind: 'waiting-sandbox', recovery: input })).toBe(false)
      expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
    })

    it('does not deadlock when suspension races stop', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await Promise.race([
        Promise.all([
          execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() }),
          execution.transitionTo({ kind: 'stopped' }),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('transition race timed out')), 2_000)),
      ])

      expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
      const [row] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      if (row) expect(row.status).toBe('cancelled')
    })

    it('does not deadlock when a leased resume races stop', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() })
      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'worker', claimKind: 'ordinary' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))

      await Promise.race([
        Promise.all([
          execution.transitionTo({
            kind: 'sandbox-recovered',
            generation: 1,
            leaseOwner: 'worker',
            claimKind: 'ordinary',
          }),
          execution.transitionTo({ kind: 'stopped' }),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('transition race timed out')), 2_000)),
      ])
      expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
    })

    it('fences concurrent resume and exhaustion to one durable outcome', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() })
      await db
        .update(sandboxProvisionRecoveries)
        .set({ status: 'leased', leaseOwner: 'worker', claimKind: 'ordinary' })
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))

      await Promise.all([
        execution.transitionTo({
          kind: 'sandbox-recovered',
          generation: 1,
          leaseOwner: 'worker',
          claimKind: 'ordinary',
        }),
        execution.transitionTo({
          kind: 'sandbox-recovery-exhausted',
          generation: 1,
          leaseOwner: 'worker',
          error: 'deadline',
        }),
      ])

      const terminal = await Execution.mustFind(execution.id)
      const [row] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect([
        ['queued', 'resumed'],
        ['failed', 'exhausted'],
      ]).toContainEqual([terminal.status, row.status])
    })

    it('cancels a live recovery row on a terminal transition', async () => {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.transitionTo({ kind: 'waiting-sandbox', recovery: recovery() })

      await execution.transitionTo({ kind: 'stopped' })

      const [row] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(row.status).toBe('cancelled')
    })
  })

  describe('single execution.started emit site (via either wrapper path)', () => {
    it('start() wrapper emits execution.started exactly once', async () => {
      const execution = await testAgent.queueExecution({ message: 'wrapper-start' })
      const events: unknown[] = []
      const unsub = eventEmitter.on('execution.started', (data) => events.push(data))

      await execution.start()

      unsub()
      expect(events.length).toBe(1)
    })

    it('transitionTo({kind:"started"}) emits execution.started exactly once', async () => {
      const execution = await testAgent.queueExecution({ message: 'direct-start' })
      const events: unknown[] = []
      const unsub = eventEmitter.on('execution.started', (data) => events.push(data))

      await execution.transitionTo({ kind: 'started' })

      unsub()
      expect(events.length).toBe(1)
    })
  })
})
